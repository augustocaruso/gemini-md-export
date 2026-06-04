import { parseChatId } from '../core/chat-id.js';
import { runConversationOperation } from './conversation-operation-runner.js';
import { matchingActiveBrowserOperationProgressAt } from './export-operation-lock.js';
import { evaluateConversationOperationWatchdog } from './export-operation-watchdog.js';
const operationSettlement = (promise) => promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
const safeNonNegativeInteger = (value, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0)
        return fallback;
    return Math.floor(numeric);
};
export const DEFAULT_WATCHDOG_RECOVERY_RETRY_LIMIT = 2;
const observedChatIdForRecoveredClient = (client) => parseChatId(client?.page?.chatId) ||
    parseChatId(client?.page?.url) ||
    parseChatId(client?.page?.pathname) ||
    parseChatId(client?.chatId) ||
    parseChatId(client?.url);
export const evaluateRecoveredBrowserTargetFsm = ({ targetChatId = null, recoveredClient = null, }) => {
    const expectedChatId = parseChatId(targetChatId);
    const observedChatId = observedChatIdForRecoveredClient(recoveredClient);
    if (!expectedChatId) {
        return {
            state: 'target_unchecked',
            ok: true,
            reason: 'target_not_requested',
            expectedChatId: null,
            observedChatId,
        };
    }
    if (observedChatId === expectedChatId) {
        return {
            state: 'target_ready',
            ok: true,
            reason: 'recovered_target_matches',
            expectedChatId,
            observedChatId,
        };
    }
    if (observedChatId) {
        return {
            state: 'wrong_target',
            ok: false,
            reason: 'recovered_target_mismatch',
            expectedChatId,
            observedChatId,
        };
    }
    return {
        state: 'target_unknown',
        ok: false,
        reason: 'recovered_target_unknown',
        expectedChatId,
        observedChatId: null,
    };
};
export const evaluateWatchdogRecoveryRetryFsm = ({ recoveryAttempted = false, recoveryOk = false, recoveredTargetState = null, retryAttempt = 0, retryLimit = DEFAULT_WATCHDOG_RECOVERY_RETRY_LIMIT, watchdogCode = null, }) => {
    const safeRetryAttempt = safeNonNegativeInteger(retryAttempt, 0);
    const safeRetryLimit = safeNonNegativeInteger(retryLimit, DEFAULT_WATCHDOG_RECOVERY_RETRY_LIMIT);
    if (watchdogCode !== 'conversation_no_progress_timeout') {
        return { state: 'record_failure', reason: 'not_no_progress_watchdog', nextAttempt: null };
    }
    if (recoveryOk) {
        if (safeRetryAttempt < safeRetryLimit) {
            const forceDirectChatUrlNavigation = recoveredTargetState === 'wrong_target' || recoveredTargetState === 'target_unknown';
            return {
                state: 'retry_same_conversation',
                reason: forceDirectChatUrlNavigation
                    ? 'recovered_tab_wrong_target_reopen_required'
                    : 'recovered_tab_ready',
                nextAttempt: safeRetryAttempt + 1,
                ...(forceDirectChatUrlNavigation ? { forceDirectChatUrlNavigation: true } : {}),
            };
        }
        return {
            state: 'record_failure',
            reason: 'retry_limit_exhausted',
            nextAttempt: null,
        };
    }
    if (recoveryAttempted) {
        return { state: 'abort_batch', reason: 'recovery_failed', nextAttempt: null };
    }
    return { state: 'record_failure', reason: 'recovery_unavailable', nextAttempt: null };
};
const drainTimedOutConversationOperation = async (settlementPromise, timeoutMs) => {
    let timer = null;
    try {
        return await Promise.race([
            settlementPromise,
            new Promise((resolveDrain) => {
                timer = setTimeout(() => resolveDrain({ status: 'timeout' }), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
};
const errorFromIntegrity = (integrity) => {
    const error = new Error(integrity.message || 'Export inválido.');
    error.code = integrity.code || 'export_integrity_failed';
    error.data = integrity;
    return error;
};
export const abortActiveConversationOperationForJob = (job, reason = 'job-cancel', deps) => {
    const controller = job?.__activeConversationAbortController;
    if (!controller || controller.signal?.aborted)
        return false;
    const error = new Error(reason);
    error.code = 'conversation_cancel_requested';
    error.operationId = job.__activeConversationOperationId || job.operationId || null;
    controller.abort(error);
    deps.appendExportJobTrace(job, 'conversation_operation_abort_requested', {
        reason,
        operationId: error.operationId,
    });
    deps.touchExportJob(job);
    return true;
};
export const createBrowserTabWatchdogRecovery = (deps) => async (job, reason = 'conversation-watchdog', context = {}) => {
    const client = deps.getClientById(job?.clientId);
    const claim = job?.tabClaimId
        ? deps.getClaimById(job.tabClaimId)
        : client
            ? deps.claimForClient(client)
            : null;
    const tabId = deps.normalizeTabId(claim?.tabId ?? client?.tabId ?? job?.tabId);
    if (!job || tabId === null) {
        deps.appendExportJobTrace(job, 'browser_operation_recovery_skipped', {
            reason,
            code: 'missing-tab-id',
            operationId: context.operationId || null,
            targetChatId: context.targetChatId || null,
        });
        return { ok: false, code: 'missing-tab-id' };
    }
    deps.appendExportJobTrace(job, 'browser_operation_recovery_requested', {
        reason,
        tabId,
        claimId: job.tabClaimId || claim?.claimId || null,
        operationId: context.operationId || null,
        targetChatId: context.targetChatId || null,
    });
    try {
        const reloadStartedAt = Date.now();
        const reload = await deps.tryNativeBrowserBrokerTabsAction('reload', {
            tabId,
            claimId: job.tabClaimId || claim?.claimId || null,
            reason: `watchdog-${reason}`,
        });
        const recoveredClient = reload?.ok
            ? await deps.waitForContinuationClient(client || { tabId }, {
                tabId,
                claimId: job.tabClaimId || claim?.claimId || null,
                sessionId: claim?.sessionId || null,
                minRuntimeSignalAt: reloadStartedAt,
                requireExpectedBrowserExtension: true,
                requireCommandReady: true,
            }, deps.recoveryWaitMs)
            : null;
        const recoveredClientReadiness = recoveredClient
            ? deps.validateRecoveredClient?.(recoveredClient) || { ok: true }
            : {
                ok: false,
                code: 'recovered_client_missing',
                message: 'Aba recarregada, mas a extensão ainda não reconectou.',
            };
        const targetReadiness = evaluateRecoveredBrowserTargetFsm({
            targetChatId: context.targetChatId || null,
            recoveredClient,
        });
        const recoveryOk = reload?.ok === true && recoveredClientReadiness.ok === true;
        const result = {
            ok: recoveryOk,
            code: recoveryOk
                ? reload?.code || null
                : recoveredClientReadiness.code || reload?.code || 'recovered_client_not_ready',
            tabId,
            reload,
            recoveredClient: recoveredClient ? deps.summarizeClient(recoveredClient) : null,
            recoveredClientReadiness,
            targetReadiness,
            requiresTargetReopen: targetReadiness.state === 'wrong_target' || targetReadiness.state === 'target_unknown',
        };
        deps.appendExportJobTrace(job, 'browser_operation_recovery_result', result);
        deps.touchExportJob(job);
        return result;
    }
    catch (err) {
        const result = {
            ok: false,
            code: err?.code || null,
            error: err?.message || String(err),
            tabId,
        };
        deps.appendExportJobTrace(job, 'browser_operation_recovery_failed', result);
        deps.touchExportJob(job);
        return result;
    }
};
const savedMediaBytes = (saved) => Array.isArray(saved.mediaFiles)
    ? saved.mediaFiles.reduce((sum, file) => sum + Number(file.bytes || 0), 0)
    : 0;
export const runRecentExportConversationOperation = async (input, deps) => {
    let { client } = input;
    const { args, conversation, failures, index, itemMetric, job, noProgressMs, operationId, successes, target, watchdogRecoveryAttempt = 0, } = input;
    const watchdogRecoveryRetryLimit = safeNonNegativeInteger(args?.conversationWatchdogRecoveryRetryLimit ?? args?.watchdogRecoveryRetryLimit, DEFAULT_WATCHDOG_RECOVERY_RETRY_LIMIT);
    let operationLastProgressAt = Date.now();
    const operationAbortController = new AbortController();
    let operationCollected = null;
    let operationDateImportReceipt = null;
    let operationSavedResult = null;
    let browserLastProgressAt = null;
    Object.defineProperties(job, {
        __activeConversationAbortController: {
            configurable: true,
            enumerable: false,
            value: operationAbortController,
            writable: true,
        },
        __activeConversationOperationId: {
            configurable: true,
            enumerable: false,
            value: operationId,
            writable: true,
        },
    });
    const markOperationProgress = (snapshot = {}) => {
        operationLastProgressAt = Number(snapshot.lastProgressAt || Date.now());
        job.current = {
            ...(job.current || {}),
            index,
            batchPosition: snapshot.batchPosition ?? target.batchPosition,
            batchTotal: snapshot.batchTotal ?? target.batchTotal,
            historyIndex: snapshot.historyIndex ?? target.historyIndex,
            operationId: snapshot.operationId || operationId,
            title: snapshot.title || target.title || conversation.title || null,
            chatId: snapshot.currentChatId || snapshot.targetChatId || target.targetChatId,
            operationPhase: snapshot.phase || null,
            operationMessage: snapshot.message || null,
        };
        job.batchPosition = job.current.batchPosition;
        job.batchTotal = job.current.batchTotal;
        job.historyIndex = job.current.historyIndex;
        job.operationId = job.current.operationId;
        deps.touchExportJob(job);
        deps.broadcastRecentChatsJobProgress(job, client, {
            phase: job.phase,
            total: job.batchTotal,
            position: job.batchPosition,
            current: job.completed,
            label: snapshot.message || undefined,
            errorCount: snapshot.errorCount ?? undefined,
        });
    };
    const latestOperationLastProgressAt = () => {
        const refreshedClient = client?.clientId ? deps.getClientById(String(client.clientId)) : null;
        const progressAt = matchingActiveBrowserOperationProgressAt(refreshedClient || client, operationId);
        if (progressAt !== null) {
            browserLastProgressAt =
                browserLastProgressAt === null ? progressAt : Math.max(browserLastProgressAt, progressAt);
            operationLastProgressAt = Math.max(operationLastProgressAt, progressAt);
        }
        return operationLastProgressAt;
    };
    const rebindRecoveredWatchdogClient = (recoveryResult) => {
        if (recoveryResult?.ok !== true)
            return;
        const recoveredClientId = recoveryResult.recoveredClient?.clientId;
        if (typeof recoveredClientId !== 'string' || !recoveredClientId)
            return;
        const recoveredClient = deps.getClientById(recoveredClientId) || recoveryResult.recoveredClient;
        if (!recoveredClient)
            return;
        client =
            deps.rebindExportJobToClient(job, recoveredClient, 'conversation-watchdog-recovery') ||
                recoveredClient ||
                client;
    };
    const recoverAfterNoProgressWatchdog = async (decision, cancelResult) => {
        if (decision.code !== 'conversation_no_progress_timeout')
            return null;
        const recoveryResult = deps.recoverBrowserTabAfterWatchdog
            ? await deps.recoverBrowserTabAfterWatchdog(job, decision.code, {
                operationId,
                targetChatId: target.targetChatId,
                cancelResult,
            })
            : null;
        rebindRecoveredWatchdogClient(recoveryResult);
        return recoveryResult;
    };
    const errorAfterFailedWatchdogRecovery = (recoveryResult) => {
        const error = new Error('Não consegui recuperar a aba do navegador depois do watchdog; interrompi o lote para evitar falhas em cascata.');
        error.code = 'operation_cancel_failed_after_watchdog';
        error.operationId = operationId;
        error.targetChatId = target.targetChatId;
        error.data = { recoveryResult: recoveryResult || null };
        return error;
    };
    const retryRecoveredWatchdogConversation = async ({ cancelResult, decision, drainTimedOut, recoveryResult, }) => {
        const retryDecision = evaluateWatchdogRecoveryRetryFsm({
            watchdogCode: decision.code,
            recoveryAttempted: recoveryResult !== null && recoveryResult !== undefined,
            recoveryOk: recoveryResult?.ok === true,
            recoveredTargetState: recoveryResult?.targetReadiness?.state || null,
            retryAttempt: watchdogRecoveryAttempt,
            retryLimit: watchdogRecoveryRetryLimit,
        });
        if (retryDecision.state === 'abort_batch') {
            throw errorAfterFailedWatchdogRecovery(recoveryResult);
        }
        if (retryDecision.state !== 'retry_same_conversation') {
            deps.appendExportJobTrace(job, 'conversation_watchdog_recovery_retry_skipped', {
                operationId,
                targetChatId: target.targetChatId,
                reason: retryDecision.reason,
                watchdogRecoveryAttempt,
                watchdogRecoveryRetryLimit,
                drainTimedOut,
                cancelOk: cancelResult?.ok === true,
                recoveryOk: recoveryResult?.ok === true,
                recoveredTargetState: recoveryResult?.targetReadiness?.state || null,
                forceDirectChatUrlNavigation: false,
            });
            return null;
        }
        deps.appendExportJobTrace(job, 'conversation_watchdog_recovered_retry', {
            operationId,
            targetChatId: target.targetChatId,
            reason: retryDecision.reason,
            watchdogRecoveryAttempt,
            nextWatchdogRecoveryAttempt: retryDecision.nextAttempt,
            watchdogRecoveryRetryLimit,
            drainTimedOut,
            cancelOk: cancelResult?.ok === true,
            recoveryOk: recoveryResult?.ok === true,
            recoveredTargetState: recoveryResult?.targetReadiness?.state || null,
            forceDirectChatUrlNavigation: retryDecision.forceDirectChatUrlNavigation === true,
            recoveredClient: recoveryResult?.recoveredClient || null,
        });
        return runRecentExportConversationOperation({
            ...input,
            args: retryDecision.forceDirectChatUrlNavigation === true
                ? { ...(input.args || {}), preferDirectChatUrlNavigation: true }
                : input.args,
            client,
            watchdogRecoveryAttempt: retryDecision.nextAttempt,
        }, deps);
    };
    try {
        const operationPromise = runConversationOperation({
            jobId: job.jobId,
            operationId,
            target,
            abortSignal: operationAbortController.signal,
            progressSink: markOperationProgress,
            deps: {
                localPhaseProgressIntervalMs: deps.localPhaseProgressIntervalMs,
                download: async () => {
                    const collected = await deps.downloadConversationItemWithRetry(job, client, conversation, {
                        ...args,
                        outputDir: job.outputDir,
                        collectOnly: true,
                        returnToOriginal: false,
                        operationId,
                        jobId: job.jobId,
                        targetChatId: target.targetChatId,
                        abortSignal: operationAbortController.signal,
                        onOperationProgress: markOperationProgress,
                    });
                    operationCollected = collected;
                    return {
                        payload: collected.result?.payload || {},
                        activeClient: collected.activeClient || null,
                        receipts: {
                            integrity: collected.integrity || null,
                            browserCommandMs: collected.browserCommandMs ?? null,
                            recovered: collected.recovered ?? null,
                        },
                    };
                },
                resolveDates: async ({ payload }) => {
                    const integrity = await deps.validateMcpExportPayload(payload, {
                        expectedChatId: target.targetChatId,
                        requestedChatId: conversation.chatId || conversation.id || conversation.url || null,
                    });
                    if (!integrity.ok)
                        throw errorFromIntegrity(integrity);
                    let batchEvidence = null;
                    let dateImport = null;
                    try {
                        if (deps.hasDateImportSource(args)) {
                            try {
                                batchEvidence = await deps.buildExportDateImportBatchEvidenceForPayloads([
                                    {
                                        key: String(integrity.snapshot?.chatId || target.targetChatId).toLowerCase(),
                                        payload,
                                        integrity,
                                    },
                                ], args);
                                job.dateImport = {
                                    ...(job.dateImport || {}),
                                    batchCandidates: batchEvidence.candidates,
                                    ...(args._exportDateImportActivitySummary
                                        ? { myActivity: args._exportDateImportActivitySummary }
                                        : {}),
                                };
                            }
                            catch (err) {
                                deps.appendExportJobTrace(job, 'date_import_batch_evidence_unavailable', {
                                    index,
                                    chatId: target.targetChatId,
                                    operationId,
                                    code: err?.code || null,
                                    error: err?.message || String(err),
                                });
                                job.dateImport = {
                                    ...(job.dateImport || {}),
                                    batchCandidates: 0,
                                    myActivity: {
                                        ...(job.dateImport?.myActivity || {}),
                                        attempted: true,
                                        error: err?.message || String(err),
                                        code: err?.code || null,
                                    },
                                };
                            }
                        }
                        dateImport = await deps.enrichExportPayloadWithDates({
                            payload,
                            integrity,
                            args: {
                                ...args,
                                _exportDateImportGroupedEvidence: batchEvidence?.groupedByKey,
                            },
                        });
                    }
                    finally {
                        delete args._exportDateImportActivitySummary;
                    }
                    operationDateImportReceipt = dateImport.receipt;
                    if (!dateImport.ok) {
                        deps.appendExportJobTrace(job, 'date_import_unresolved_saved_without_abort', {
                            index,
                            chatId: target.targetChatId,
                            operationId,
                            code: dateImport.code || null,
                            dateImport: dateImport.receipt || null,
                            evidenceCount: Array.isArray(dateImport.evidence) ? dateImport.evidence.length : null,
                        });
                        return {
                            payload: dateImport.payload || payload,
                            receipt: dateImport.receipt || { enabled: true, status: 'unresolved' },
                        };
                    }
                    return {
                        payload: dateImport.payload,
                        receipt: dateImport.receipt,
                    };
                },
                save: async ({ payload }) => {
                    const integrity = await deps.validateMcpExportPayload(payload, {
                        expectedChatId: target.targetChatId,
                        requestedChatId: conversation.chatId || conversation.id || conversation.url || null,
                    });
                    if (!integrity.ok)
                        throw errorFromIntegrity(integrity);
                    const saveStartedAt = Date.now();
                    const saved = deps.writeExportPayloadBundle(payload, { outputDir: job.outputDir });
                    const saveFilesMs = Date.now() - saveStartedAt;
                    const payloadMetrics = payload?.metrics || {};
                    const metrics = {
                        version: 1,
                        timings: {
                            browserCommandMs: operationCollected?.browserCommandMs ?? null,
                            saveFilesMs,
                            ...(payloadMetrics.timings || {}),
                        },
                        counters: {
                            ...(payloadMetrics.counters || {}),
                            mediaFileCount: saved.mediaFileCount || 0,
                            mediaFailureCount: saved.mediaFailureCount || 0,
                            savedBytes: saved.bytes || 0,
                            savedMediaBytes: savedMediaBytes(saved),
                        },
                        hydration: payload?.hydration || null,
                        navigation: payload?.hydration?.navigation || null,
                        media: payloadMetrics.media || null,
                        privateRead: payloadMetrics.privateRead || null,
                        assets: payloadMetrics.assets || null,
                    };
                    operationSavedResult = {
                        client: operationCollected?.activeClient
                            ? deps.summarizeClient(operationCollected.activeClient)
                            : null,
                        conversation: operationCollected?.result?.conversation || conversation,
                        chatId: integrity.snapshot.chatId || payload?.chatId || target.targetChatId,
                        title: integrity.snapshot.title || payload?.title || conversation.title || null,
                        turns: integrity.assistantTurnCount,
                        hydration: payload?.hydration || null,
                        returnedToOriginal: operationCollected?.result?.returnedToOriginal ?? null,
                        returnError: operationCollected?.result?.returnError || null,
                        integrity: {
                            markdownHash: integrity.markdownHash,
                            assistantTurnCount: integrity.assistantTurnCount,
                            evidence: integrity.evidence,
                            warnings: integrity.warnings,
                        },
                        dateImport: operationDateImportReceipt || null,
                        metrics,
                        receipts: {
                            download: {
                                integrity: operationCollected?.integrity || null,
                                browserCommandMs: operationCollected?.browserCommandMs ?? null,
                            },
                            dateImport: operationDateImportReceipt || null,
                            save: {
                                filePath: saved.filePath,
                                filename: saved.filename,
                                bytes: saved.bytes,
                                mediaFileCount: saved.mediaFileCount || 0,
                                mediaFailureCount: saved.mediaFailureCount || 0,
                                overwritten: saved.overwritten,
                                integrity: {
                                    markdownHash: integrity.markdownHash,
                                    assistantTurnCount: integrity.assistantTurnCount,
                                    warnings: integrity.warnings,
                                },
                            },
                        },
                        ...saved,
                    };
                    return {
                        filePath: saved.filePath,
                        bytes: saved.bytes,
                        receipt: operationSavedResult.receipts.save,
                    };
                },
            },
        });
        const operationSettlementPromise = operationSettlement(operationPromise);
        let watchdogTimer = null;
        let watchdogTriggered = false;
        const watchdogSignalPromise = new Promise((resolveWatchdog) => {
            const watchdogIntervalMs = Math.max(500, Math.min(2000, Math.floor(noProgressMs / 4)));
            watchdogTimer = setInterval(() => {
                if (watchdogTriggered)
                    return;
                const decision = job.cancelRequested === true
                    ? {
                        action: 'cancel',
                        elapsedMs: 0,
                        code: 'conversation_cancel_requested',
                        message: 'Cancelamento solicitado.',
                    }
                    : evaluateConversationOperationWatchdog({
                        operationId,
                        now: Date.now(),
                        lastProgressAt: latestOperationLastProgressAt(),
                        noProgressMs,
                        cancelRequested: false,
                    });
                if (decision.action === 'continue')
                    return;
                watchdogTriggered = true;
                if (watchdogTimer)
                    clearInterval(watchdogTimer);
                resolveWatchdog({ status: 'watchdog', decision });
            }, watchdogIntervalMs);
        });
        const downloadSettlement = (await Promise.race([
            operationSettlementPromise,
            watchdogSignalPromise,
        ]).finally(() => {
            if (watchdogTimer)
                clearInterval(watchdogTimer);
        }));
        if (downloadSettlement.status === 'watchdog') {
            const { decision } = downloadSettlement;
            const watchdogError = new Error(decision.message);
            watchdogError.code = decision.code;
            watchdogError.operationId = operationId;
            watchdogError.targetChatId = target.targetChatId;
            operationAbortController.abort(watchdogError);
            deps.appendExportJobTrace(job, decision.code === 'conversation_cancel_requested'
                ? 'conversation_cancel_requested'
                : 'conversation_no_progress_watchdog', {
                code: decision.code,
                timeoutCode: 'conversation_no_progress_timeout',
                operationId,
                targetChatId: target.targetChatId,
                elapsedMs: decision.elapsedMs,
                noProgressMs,
                lastProgressAt: new Date(operationLastProgressAt).toISOString(),
                browserLastProgressAt: browserLastProgressAt
                    ? new Date(browserLastProgressAt).toISOString()
                    : null,
            });
            const cancelResult = await deps.requestActiveBrowserOperationCancelForJob(job, decision.code);
            const drainResult = await drainTimedOutConversationOperation(operationSettlementPromise, deps.drainTimeoutMs);
            const recoveryResult = await recoverAfterNoProgressWatchdog(decision, cancelResult);
            if (drainResult.status === 'timeout') {
                deps.appendExportJobTrace(job, 'conversation_watchdog_drain_timeout', {
                    operationId,
                    targetChatId: target.targetChatId,
                    cancelOk: cancelResult?.ok === true,
                    cancelCancelled: cancelResult?.cancelled === true,
                    cancelReason: cancelResult?.reason || null,
                    cancelCode: cancelResult?.code || null,
                });
                const retryOutcome = await retryRecoveredWatchdogConversation({
                    cancelResult,
                    decision,
                    drainTimedOut: true,
                    recoveryResult,
                });
                if (retryOutcome)
                    return retryOutcome;
                if (recoveryResult?.ok === true) {
                    watchdogError.data = {
                        drainTimedOut: true,
                        cancelResult,
                        recoveryResult,
                    };
                    throw watchdogError;
                }
                if (cancelResult?.ok === true && decision.code !== 'conversation_no_progress_timeout') {
                    watchdogError.data = {
                        drainTimedOut: true,
                        cancelResult,
                    };
                    throw watchdogError;
                }
                throw errorAfterFailedWatchdogRecovery(recoveryResult);
            }
            const retryOutcome = await retryRecoveredWatchdogConversation({
                cancelResult,
                decision,
                drainTimedOut: false,
                recoveryResult,
            });
            if (retryOutcome)
                return retryOutcome;
            if (recoveryResult?.ok === true) {
                watchdogError.data = {
                    cancelResult,
                    recoveryResult,
                };
                throw watchdogError;
            }
            if (recoveryResult) {
                throw errorAfterFailedWatchdogRecovery(recoveryResult);
            }
            throw watchdogError;
        }
        if (downloadSettlement.status === 'rejected')
            throw downloadSettlement.reason;
        const operationResult = downloadSettlement.value;
        if (operationResult.status === 'failed') {
            const error = new Error(operationResult.error || 'Falha ao exportar conversa.');
            error.code = operationResult.code || 'conversation_operation_failed';
            error.data = {
                receipts: operationResult.receipts || null,
                dateImport: operationResult.receipts?.dateImport || null,
            };
            throw error;
        }
        if (operationResult.status === 'cancelled') {
            const error = new Error(operationResult.reason || 'Operação cancelada.');
            error.code = 'operation_cancelled';
            error.data = { receipts: operationResult.receipts || null };
            throw error;
        }
        const savedResult = operationSavedResult;
        if (operationResult.status !== 'saved' || !savedResult) {
            const error = new Error('Operação de exportação terminou sem arquivo salvo.');
            error.code = 'conversation_operation_not_saved';
            error.data = { receipts: operationResult.receipts || null };
            throw error;
        }
        const result = {
            ...savedResult,
            operationId,
            batchPosition: target.batchPosition,
            historyIndex: target.historyIndex,
            receipts: operationResult.receipts || savedResult.receipts || null,
        };
        const resultClient = result.client?.clientId
            ? deps.getClientById(result.client.clientId)
            : null;
        if (resultClient)
            client = deps.rebindExportJobToClient(job, resultClient, 'conversation-download') || client;
        const success = {
            ...deps.buildConversationExportSuccess({ index, conversation, result }),
            operationId,
            batchPosition: target.batchPosition,
            historyIndex: target.historyIndex,
            receipts: result.receipts || null,
        };
        deps.recordConversationExportSuccess({ job, successes, itemMetric, success, result }, deps.exportJobRecordingDeps);
    }
    catch (err) {
        const failure = {
            ...deps.buildConversationExportFailure({ index, conversation, err }),
            operationId,
            batchPosition: target.batchPosition,
            historyIndex: target.historyIndex,
            receipts: err?.data?.receipts || err?.receipts || null,
        };
        deps.recordConversationExportFailure({ job, failures, itemMetric, failure, err }, deps.exportJobRecordingDeps);
        if (err?.code === 'operation_cancel_failed_after_watchdog') {
            throw err;
        }
    }
    finally {
        if (job.__activeConversationOperationId === operationId) {
            delete job.__activeConversationAbortController;
            delete job.__activeConversationOperationId;
        }
    }
    return { client };
};
