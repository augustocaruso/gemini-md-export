import { basename } from 'node:path';
import { outputDirForDirectReexportItem } from './direct-reexport-selection.js';
import { buildExportDateImportActivityScanCandidates, buildExportDateImportBatchEvidence, createExportDateImportContext, enrichExportPayloadWithMetadataDates, mergeExportDateImportBatchEvidenceWithMatches, summarizeExportDateImportContext, } from './export-metadata.js';
export const DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS = 45_000;
export const DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS = 8_000;
const RECOVERABLE_ACTIVITY_DATE_IMPORT_ERRORS = new Set([
    'activity_client_missing',
    'activity_client_version_mismatch',
    'activity_scan_timeout',
    'activity_tab_activation_failed',
    'activity_companion_not_ready',
    'command_timeout',
    'tab_operation_in_progress',
]);
const noActivityScanRetryEffects = {
    retry: false,
    clearActivityTabId: false,
    clearCompanionAffinity: false,
};
const activityScanErrorCodeIsRecoverable = (code) => {
    const normalized = String(code || '');
    if (normalized === 'operation_cancelled' || normalized === 'AbortError')
        return false;
    if (RECOVERABLE_ACTIVITY_DATE_IMPORT_ERRORS.has(normalized))
        return true;
    return Boolean(normalized && normalized.startsWith('activity_'));
};
export const transitionActivityScanFallbackFsm = (state, event) => {
    if (state !== 'initial_scan_failed') {
        return { state, effects: noActivityScanRetryEffects };
    }
    if (activityScanErrorCodeIsRecoverable(event.errorCode) &&
        event.pinnedByCompanion &&
        !event.explicitActivityTabId &&
        event.retryCount === 0) {
        return {
            state: 'retry_without_companion_affinity',
            effects: {
                retry: true,
                clearActivityTabId: true,
                clearCompanionAffinity: true,
            },
        };
    }
    return { state: 'fallback_exhausted', effects: noActivityScanRetryEffects };
};
const isRecoverableActivityDateImportError = (err) => {
    if (err?.code === 'operation_cancelled' || err?.name === 'AbortError')
        return false;
    if (RECOVERABLE_ACTIVITY_DATE_IMPORT_ERRORS.has(String(err?.code || '')))
        return true;
    return Boolean(err?.code && String(err.code).startsWith('activity_'));
};
const normalizePositiveTimeoutMs = (value, fallback, max = 120_000) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.min(Math.floor(parsed), max);
};
const dateImportActivityWaitMs = (args = {}) => normalizePositiveTimeoutMs(args.activityWaitMs ?? args.myActivityWaitMs ?? args.waitMs, DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS);
const dateImportActivityPreLaunchWaitMs = (args = {}) => normalizePositiveTimeoutMs(args.activityPreLaunchWaitMs ?? args.myActivityPreLaunchWaitMs ?? args.preLaunchWaitMs, DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS);
const operationCancelledError = (signal) => {
    const reason = signal.reason;
    const message = typeof reason === 'string'
        ? reason
        : typeof reason?.message === 'string'
            ? reason.message
            : 'operation_cancelled';
    const error = new Error(message);
    error.code = 'operation_cancelled';
    return error;
};
const throwIfAborted = (signal) => {
    if (signal?.aborted)
        throw operationCancelledError(signal);
};
const abortable = async (promise, signal) => {
    throwIfAborted(signal);
    if (!signal)
        return promise;
    let onAbort = null;
    const abortPromise = new Promise((_, reject) => {
        onAbort = () => reject(operationCancelledError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    promise.catch(() => { });
    try {
        return await Promise.race([promise, abortPromise]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener('abort', onAbort);
    }
};
export const dateImportToolProperties = () => ({
    takeout: {
        type: 'string',
        description: 'Arquivo Google Takeout/My Activity (.zip, .html ou .json) usado como fonte offline; My Activity continua como fallback.',
    },
    useMyActivity: {
        type: 'boolean',
        description: 'Usa My Activity pela extensão para preencher datas. Default: true.',
    },
    noMyActivity: {
        type: 'boolean',
        description: 'Diagnóstico avançado: desliga o fallback My Activity.',
    },
});
const dateImportSourcePath = (args = {}) => args.takeout || args.takeoutPath || args.metadataTakeout || null;
const booleanFlag = (value) => {
    if (typeof value === 'boolean')
        return value;
    if (value === null || value === undefined || value === '')
        return null;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized))
        return false;
    return null;
};
export const dateImportArgsFromSearchParams = (searchParams, body = {}) => ({
    takeout: body.takeout || searchParams.get('takeout') || undefined,
    useMyActivity: booleanFlag(body.useMyActivity ?? searchParams.get('useMyActivity')),
    noMyActivity: booleanFlag(body.noMyActivity ?? searchParams.get('noMyActivity')),
});
export const shouldUseMyActivityForDateImport = (args = {}) => {
    if (booleanFlag(args.noMyActivity) === true)
        return false;
    if (booleanFlag(args.useMyActivity) === false)
        return false;
    return true;
};
export const hasDateImportSource = (args = {}) => Boolean(dateImportSourcePath(args)) || shouldUseMyActivityForDateImport(args);
export const defaultDateImportSummary = (args = {}) => {
    const sourceFile = dateImportSourcePath(args);
    const useMyActivity = shouldUseMyActivityForDateImport(args);
    return {
        enabled: Boolean(sourceFile) || useMyActivity,
        source: sourceFile
            ? useMyActivity
                ? 'takeout+my-activity'
                : 'takeout'
            : useMyActivity
                ? 'my-activity'
                : 'none',
        sourceFile: sourceFile ? basename(String(sourceFile)) : null,
        fallback: useMyActivity ? 'my-activity' : null,
        pending: Boolean(sourceFile) || useMyActivity,
    };
};
export const createExportDateImportContextForArgs = async (args = {}) => {
    if (args._exportDateImportContext)
        return args._exportDateImportContext;
    const context = createExportDateImportContext({
        takeoutPath: dateImportSourcePath(args),
        useMyActivity: shouldUseMyActivityForDateImport(args),
    });
    args._exportDateImportContext = context;
    return context;
};
export const summarizeExportDateImportContextForJob = async (context) => summarizeExportDateImportContext(context);
export const enrichExportPayloadWithDates = async ({ payload, integrity, args, }) => {
    const context = await createExportDateImportContextForArgs(args);
    const groupedEvidence = args._exportDateImportGroupedEvidence?.get(String(integrity.snapshot?.chatId || '').toLowerCase());
    return enrichExportPayloadWithMetadataDates({ payload, integrity, context, groupedEvidence });
};
export const saveCollectedConversationPayloadRuntime = async (collected, args = {}, deps) => {
    let { integrity } = collected;
    const dateImport = await enrichExportPayloadWithDates({
        payload: collected.result.payload,
        integrity,
        args,
    });
    if (!dateImport.ok) {
        const error = new Error(dateImport.message);
        error.code = dateImport.code;
        error.data = {
            code: dateImport.code,
            dateImport: dateImport.receipt,
            evidence: dateImport.evidence,
        };
        throw error;
    }
    integrity = await deps.validateMcpExportPayload(dateImport.payload, {
        expectedChatId: collected.expectedChatId,
        requestedChatId: collected.requestedChatId,
    });
    if (!integrity.ok) {
        const error = new Error(integrity.message);
        error.code = integrity.code;
        error.data = integrity;
        throw error;
    }
    const saveStartedAt = Date.now();
    const saved = deps.writeExportPayloadBundle(dateImport.payload, {
        outputDir: outputDirForDirectReexportItem(collected.conversation, args.outputDir),
    });
    const saveFilesMs = Date.now() - saveStartedAt;
    const savedMediaBytes = Array.isArray(saved.mediaFiles)
        ? saved.mediaFiles.reduce((sum, file) => sum + Number(file.bytes || 0), 0)
        : 0;
    const payloadMetrics = collected.result.payload?.metrics || {};
    const metrics = {
        version: 1,
        timings: {
            browserCommandMs: collected.browserCommandMs,
            saveFilesMs,
            ...(payloadMetrics.timings || {}),
        },
        counters: {
            ...(payloadMetrics.counters || {}),
            mediaFileCount: saved.mediaFileCount || 0,
            mediaFailureCount: saved.mediaFailureCount || 0,
            savedBytes: saved.bytes || 0,
            savedMediaBytes,
        },
        hydration: collected.result.payload?.hydration || null,
        navigation: collected.result.payload?.hydration?.navigation || null,
        media: payloadMetrics.media || null,
        privateRead: payloadMetrics.privateRead || null,
        assets: payloadMetrics.assets || null,
    };
    return {
        client: deps.summarizeClient(collected.activeClient),
        conversation: collected.result.conversation || collected.conversation,
        chatId: integrity.snapshot.chatId ||
            collected.result.payload?.chatId ||
            collected.conversation.chatId ||
            null,
        title: integrity.snapshot.title ||
            collected.result.payload?.title ||
            collected.conversation.title ||
            null,
        turns: integrity.assistantTurnCount,
        hydration: collected.result.payload?.hydration || null,
        returnedToOriginal: collected.result.returnedToOriginal ?? null,
        returnError: collected.result.returnError || null,
        integrity: {
            markdownHash: integrity.markdownHash,
            assistantTurnCount: integrity.assistantTurnCount,
            evidence: integrity.evidence,
            warnings: integrity.warnings,
        },
        dateImport: dateImport.receipt,
        metrics,
        ...saved,
    };
};
export const buildExportDateImportBatchEvidenceForPayloads = async (entries, args = {}) => {
    const context = await createExportDateImportContextForArgs(args);
    return buildExportDateImportBatchEvidence({ entries, context });
};
export const buildExportDateImportActivityCandidatesForPayloads = ({ entries, groupedByKey, }) => buildExportDateImportActivityScanCandidates({ entries, groupedByKey });
export const mergeExportDateImportBatchEvidenceWithActivityMatches = async ({ entries, args = {}, previous, matches, }) => {
    const context = await createExportDateImportContextForArgs(args);
    return mergeExportDateImportBatchEvidenceWithMatches({ entries, context, previous, matches });
};
export const buildExportDateImportBatchEvidenceWithActivityFallback = async (entries, args = {}, options = {}) => {
    const batch = await buildExportDateImportBatchEvidenceForPayloads(entries, args);
    if (!shouldUseMyActivityForDateImport(args) || typeof options.scanActivity !== 'function') {
        return batch;
    }
    const candidates = buildExportDateImportActivityCandidatesForPayloads({
        entries,
        groupedByKey: batch.groupedByKey,
    });
    if (candidates.length === 0)
        return batch;
    throwIfAborted(args.abortSignal);
    const activityWaitMs = dateImportActivityWaitMs(args);
    let activity;
    const explicitActivityTabId = args.activityTabId !== undefined && args.activityTabId !== null && args.activityTabId !== '';
    const companionActivityTabId = args.activityCompanion?.tabId;
    const pinnedByCompanion = !explicitActivityTabId &&
        companionActivityTabId !== undefined &&
        companionActivityTabId !== null;
    let activityScanRetryCount = 0;
    const buildActivityScanArgs = (decision = null) => {
        const clearCompanionAffinity = decision?.effects.clearCompanionAffinity === true;
        const activityTabId = decision?.effects.clearActivityTabId
            ? undefined
            : (args.activityTabId ?? companionActivityTabId);
        const claimVisual = args.claimVisual ?? (activityTabId && !clearCompanionAffinity ? false : undefined);
        return {
            ...args,
            candidates,
            resume: args._exportDateImportActivityCheckpoint || null,
            openIfMissing: args.openMyActivityIfMissing !== false && args.openIfMissing !== false,
            openDetails: true,
            claimLabel: args.claimLabel || options.claimLabel,
            activityTabId,
            claimVisual,
            visualGroupTabId: args.visualGroupTabId ?? args.groupWithTabId ?? args._exportDateImportVisualGroupTabId,
            waitMs: activityWaitMs,
            activityCommandTimeoutMs: args.activityCommandTimeoutMs ?? activityWaitMs + 15_000,
            preLaunchWaitMs: dateImportActivityPreLaunchWaitMs(args),
        };
    };
    let activityScanDecision = null;
    let activityScanDecisionState = null;
    try {
        while (true) {
            try {
                activity = await abortable(options.scanActivity(buildActivityScanArgs(activityScanDecision)), args.abortSignal);
                break;
            }
            catch (err) {
                if (!isRecoverableActivityDateImportError(err))
                    throw err;
                const decision = transitionActivityScanFallbackFsm('initial_scan_failed', {
                    errorCode: err?.code || err?.name,
                    retryCount: activityScanRetryCount,
                    pinnedByCompanion,
                    explicitActivityTabId,
                });
                if (!decision.effects.retry)
                    throw err;
                activityScanDecision = decision;
                activityScanDecisionState = decision.state;
                activityScanRetryCount += 1;
            }
        }
    }
    catch (err) {
        if (!isRecoverableActivityDateImportError(err))
            throw err;
        args._exportDateImportActivitySummary = {
            attempted: true,
            candidates: candidates.length,
            matched: 0,
            loadedCardCount: null,
            checkpoint: args._exportDateImportActivityCheckpoint || null,
            browserWake: null,
            tabClaimWarning: null,
            fallback: activityScanRetryCount > 0
                ? {
                    attempted: true,
                    retries: activityScanRetryCount,
                    reason: activityScanDecisionState || 'activity_scan_retry_failed',
                }
                : null,
            error: {
                code: err?.code || 'activity_date_import_failed',
                message: err?.message || String(err),
            },
        };
        return batch;
    }
    throwIfAborted(args.abortSignal);
    const matches = Array.isArray(activity.matches) ? activity.matches : [];
    args._exportDateImportActivityCheckpoint =
        activity.checkpoint || args._exportDateImportActivityCheckpoint || null;
    args._exportDateImportActivitySummary = {
        attempted: true,
        candidates: candidates.length,
        matched: new Set(matches.map((match) => String(match.chatId || '').toLowerCase()).filter(Boolean)).size,
        loadedCardCount: activity.checkpoint?.loadedCardCount ?? null,
        checkpoint: activity.checkpoint || null,
        browserWake: activity.browserWake || null,
        tabClaimWarning: activity.tabClaimWarning || null,
        fallback: activityScanRetryCount > 0
            ? {
                attempted: true,
                retries: activityScanRetryCount,
                reason: activityScanDecisionState || 'activity_scan_retry_succeeded',
            }
            : null,
    };
    return mergeExportDateImportBatchEvidenceWithActivityMatches({
        entries,
        args,
        previous: batch,
        matches,
    });
};
export const saveCollectedConversationPayloadViaDateImportBatch = async (collected, args = {}, deps) => {
    if (!hasDateImportSource(args)) {
        return deps.saveCollectedConversationPayload(collected, args);
    }
    const chatId = String(collected.integrity?.snapshot?.chatId ||
        collected.result?.payload?.chatId ||
        collected.conversation?.chatId ||
        '').toLowerCase();
    const batch = await deps.buildBatchEvidence([
        {
            key: chatId,
            payload: collected.result.payload,
            integrity: collected.integrity,
        },
    ], args);
    args._exportDateImportGroupedEvidence = batch.groupedByKey;
    try {
        return await deps.saveCollectedConversationPayload(collected, args);
    }
    finally {
        delete args._exportDateImportGroupedEvidence;
        delete args._exportDateImportActivitySummary;
    }
};
