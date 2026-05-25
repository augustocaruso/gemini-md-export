import { runConversationOperation } from './conversation-operation-runner.js';
import type {
  ConversationOperationTerminalResult,
  ExportBatchTarget,
} from './export-operation-contracts.js';
import { evaluateConversationOperationWatchdog } from './export-operation-watchdog.js';

type AnyRecord = Record<string, any>;

export type RecentExportOperationDeps = {
  appendExportJobTrace(job: AnyRecord, event: string, payload?: AnyRecord): void;
  broadcastRecentChatsJobProgress(
    job: AnyRecord,
    client: AnyRecord,
    progress?: AnyRecord,
  ): void;
  buildConversationExportFailure(input: AnyRecord): AnyRecord;
  buildConversationExportSuccess(input: AnyRecord): AnyRecord;
  buildExportDateImportBatchEvidenceForPayloads(
    entries: AnyRecord[],
    args?: AnyRecord,
  ): Promise<AnyRecord>;
  downloadConversationItemWithRetry(
    job: AnyRecord,
    client: AnyRecord,
    conversation: AnyRecord,
    args?: AnyRecord,
  ): Promise<AnyRecord>;
  drainTimeoutMs: number;
  enrichExportPayloadWithDates(input: AnyRecord): Promise<AnyRecord>;
  exportJobRecordingDeps: AnyRecord;
  getClientById(clientId: string): AnyRecord | null;
  hasDateImportSource(args?: AnyRecord): boolean;
  rebindExportJobToClient(job: AnyRecord, client: AnyRecord, reason?: string): AnyRecord | null;
  recordConversationExportFailure(input: AnyRecord, deps: AnyRecord): void;
  recordConversationExportSuccess(input: AnyRecord, deps: AnyRecord): void;
  requestActiveBrowserOperationCancelForJob(
    job: AnyRecord,
    reason?: string,
  ): Promise<AnyRecord | null> | AnyRecord | null;
  summarizeClient(client: AnyRecord): AnyRecord;
  touchExportJob(job: AnyRecord): void;
  validateMcpExportPayload(payload: AnyRecord, input?: AnyRecord): Promise<AnyRecord>;
  writeExportPayloadBundle(payload: AnyRecord, options: AnyRecord): AnyRecord;
};

const operationSettlement = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );

type OperationSettlement =
  | { status: 'fulfilled'; value: ConversationOperationTerminalResult }
  | { status: 'rejected'; reason: any };

type WatchdogSettlement = { status: 'watchdog'; decision: AnyRecord };

const drainTimedOutConversationOperation = async (
  settlementPromise: Promise<AnyRecord>,
  timeoutMs: number,
): Promise<AnyRecord> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      settlementPromise,
      new Promise<AnyRecord>((resolveDrain) => {
        timer = setTimeout(() => resolveDrain({ status: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const errorFromIntegrity = (integrity: AnyRecord): Error => {
  const error = new Error(integrity.message || 'Export inválido.');
  (error as AnyRecord).code = integrity.code || 'export_integrity_failed';
  (error as AnyRecord).data = integrity;
  return error;
};

const savedMediaBytes = (saved: AnyRecord): number =>
  Array.isArray(saved.mediaFiles)
    ? saved.mediaFiles.reduce((sum: number, file: AnyRecord) => sum + Number(file.bytes || 0), 0)
    : 0;

export const runRecentExportConversationOperation = async (
  input: {
    args: AnyRecord;
    client: AnyRecord;
    conversation: AnyRecord;
    failures: AnyRecord[];
    index: number;
    itemMetric: AnyRecord;
    job: AnyRecord;
    noProgressMs: number;
    operationId: string;
    successes: AnyRecord[];
    target: ExportBatchTarget;
  },
  deps: RecentExportOperationDeps,
): Promise<{ client: AnyRecord }> => {
  let { client } = input;
  const {
    args,
    conversation,
    failures,
    index,
    itemMetric,
    job,
    noProgressMs,
    operationId,
    successes,
    target,
  } = input;
  let operationLastProgressAt = Date.now();
  const operationAbortController = new AbortController();
  let operationCollected: AnyRecord | null = null;
  let operationDateImportReceipt: AnyRecord | null = null;
  let operationSavedResult: AnyRecord | null = null;

  const markOperationProgress = (snapshot: AnyRecord = {}) => {
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

  try {
    const operationPromise = runConversationOperation({
      jobId: job.jobId,
      operationId,
      target,
      abortSignal: operationAbortController.signal,
      progressSink: markOperationProgress,
      deps: {
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
        resolveDates: async ({ payload }: AnyRecord) => {
          const integrity = await deps.validateMcpExportPayload(payload, {
            expectedChatId: target.targetChatId,
            requestedChatId: conversation.chatId || conversation.id || conversation.url || null,
          });
          if (!integrity.ok) throw errorFromIntegrity(integrity);

          let batchEvidence: AnyRecord | null = null;
          let dateImport: AnyRecord | null = null;
          try {
            if (deps.hasDateImportSource(args)) {
              batchEvidence = await deps.buildExportDateImportBatchEvidenceForPayloads(
                [
                  {
                    key: String(integrity.snapshot?.chatId || target.targetChatId).toLowerCase(),
                    payload,
                    integrity,
                  },
                ],
                args,
              );
              job.dateImport = {
                ...(job.dateImport || {}),
                batchCandidates: batchEvidence.candidates,
                ...(args._exportDateImportActivitySummary
                  ? { myActivity: args._exportDateImportActivitySummary }
                  : {}),
              };
            }
            dateImport = await deps.enrichExportPayloadWithDates({
              payload,
              integrity,
              args: {
                ...args,
                _exportDateImportGroupedEvidence: batchEvidence?.groupedByKey,
              },
            });
          } finally {
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
              payload,
              receipt: dateImport.receipt || { enabled: false, status: 'unresolved' },
            };
          }
          return {
            payload: dateImport.payload,
            receipt: dateImport.receipt,
          };
        },
        save: async ({ payload }: AnyRecord) => {
          const integrity = await deps.validateMcpExportPayload(payload, {
            expectedChatId: target.targetChatId,
            requestedChatId: conversation.chatId || conversation.id || conversation.url || null,
          });
          if (!integrity.ok) throw errorFromIntegrity(integrity);

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
    const operationSettlementPromise = operationSettlement(
      operationPromise,
    ) as Promise<OperationSettlement>;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let watchdogTriggered = false;
    const watchdogSignalPromise = new Promise<WatchdogSettlement>((resolveWatchdog) => {
      const watchdogIntervalMs = Math.max(500, Math.min(2000, Math.floor(noProgressMs / 4)));
      watchdogTimer = setInterval(() => {
        if (watchdogTriggered) return;
        const decision = evaluateConversationOperationWatchdog({
          operationId,
          now: Date.now(),
          lastProgressAt: operationLastProgressAt,
          noProgressMs,
          cancelRequested: job.cancelRequested === true,
        });
        if (decision.action === 'continue') return;
        watchdogTriggered = true;
        if (watchdogTimer) clearInterval(watchdogTimer);
        resolveWatchdog({ status: 'watchdog', decision });
      }, watchdogIntervalMs);
    });
    const downloadSettlement = (await Promise.race([
      operationSettlementPromise,
      watchdogSignalPromise,
    ]).finally(() => {
      if (watchdogTimer) clearInterval(watchdogTimer);
    })) as OperationSettlement | WatchdogSettlement;

    if (downloadSettlement.status === 'watchdog') {
      const { decision } = downloadSettlement;
      const watchdogError = new Error(decision.message);
      (watchdogError as AnyRecord).code = decision.code;
      (watchdogError as AnyRecord).operationId = operationId;
      (watchdogError as AnyRecord).targetChatId = target.targetChatId;
      operationAbortController.abort(watchdogError);
      deps.appendExportJobTrace(job, 'conversation_no_progress_watchdog', {
        code: decision.code,
        timeoutCode: 'conversation_no_progress_timeout',
        operationId,
        targetChatId: target.targetChatId,
        elapsedMs: decision.elapsedMs,
        noProgressMs,
      });
      const cancelResult = await deps.requestActiveBrowserOperationCancelForJob(job, decision.code);
      const drainResult = await drainTimedOutConversationOperation(
        operationSettlementPromise,
        deps.drainTimeoutMs,
      );
      if (drainResult.status === 'timeout') {
        const error = new Error(
          'Operação do navegador ainda ativa depois do watchdog; interrompi o lote para evitar conflito entre conversas.',
        );
        (error as AnyRecord).code =
          cancelResult?.ok === true || cancelResult?.cancelled === true
            ? 'operation_still_active_after_watchdog'
            : 'operation_cancel_failed_after_watchdog';
        (error as AnyRecord).operationId = operationId;
        (error as AnyRecord).targetChatId = target.targetChatId;
        throw error;
      }
      throw watchdogError;
    }
    if (downloadSettlement.status === 'rejected') throw downloadSettlement.reason;

    const operationResult = downloadSettlement.value;
    if (operationResult.status === 'failed') {
      const error = new Error(operationResult.error || 'Falha ao exportar conversa.');
      (error as AnyRecord).code = operationResult.code || 'conversation_operation_failed';
      (error as AnyRecord).data = { receipts: operationResult.receipts || null };
      throw error;
    }
    if (operationResult.status === 'cancelled') {
      const error = new Error(operationResult.reason || 'Operação cancelada.');
      (error as AnyRecord).code = 'operation_cancelled';
      (error as AnyRecord).data = { receipts: operationResult.receipts || null };
      throw error;
    }
    const savedResult = operationSavedResult as AnyRecord | null;
    if (operationResult.status !== 'saved' || !savedResult) {
      const error = new Error('Operação de exportação terminou sem arquivo salvo.');
      (error as AnyRecord).code = 'conversation_operation_not_saved';
      (error as AnyRecord).data = { receipts: operationResult.receipts || null };
      throw error;
    }

    const result: AnyRecord = {
      ...savedResult,
      operationId,
      batchPosition: target.batchPosition,
      historyIndex: target.historyIndex,
      receipts: operationResult.receipts || savedResult.receipts || null,
    };
    const resultClient = result.client?.clientId ? deps.getClientById(result.client.clientId) : null;
    if (resultClient) client = deps.rebindExportJobToClient(job, resultClient, 'conversation-download') || client;
    const success = {
      ...deps.buildConversationExportSuccess({ index, conversation, result }),
      operationId,
      batchPosition: target.batchPosition,
      historyIndex: target.historyIndex,
      receipts: result.receipts || null,
    };
    deps.recordConversationExportSuccess(
      { job, successes, itemMetric, success, result },
      deps.exportJobRecordingDeps,
    );
  } catch (err: any) {
    const failure = {
      ...deps.buildConversationExportFailure({ index, conversation, err }),
      operationId,
      batchPosition: target.batchPosition,
      historyIndex: target.historyIndex,
      receipts: err?.data?.receipts || err?.receipts || null,
    };
    deps.recordConversationExportFailure(
      { job, failures, itemMetric, failure, err },
      deps.exportJobRecordingDeps,
    );
    if (
      err?.code === 'operation_still_active_after_watchdog' ||
      err?.code === 'operation_cancel_failed_after_watchdog'
    ) {
      throw err;
    }
  }

  return { client };
};
