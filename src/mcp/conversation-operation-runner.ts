import {
  type ConversationOperationTerminalResult,
  type ExportBatchTarget,
  makeOperationProgressSnapshot,
  operationResultFromError,
} from './export-operation-contracts.js';

type RuntimePayload = Record<string, any> & { chatId?: string | null };

type DownloadResult = {
  payload: RuntimePayload;
  client?: Record<string, unknown> | null;
  activeClient?: Record<string, unknown> | null;
  receipts?: Record<string, unknown>;
};

type DateResult = {
  payload: RuntimePayload;
  receipt: Record<string, unknown>;
};

type SaveResult = {
  filePath: string;
  bytes?: number | null;
  receipt?: Record<string, unknown>;
};

type OperationDeps = {
  now?: () => number;
  download: (args: {
    target: ExportBatchTarget;
    operationId: string;
    abortSignal: AbortSignal;
  }) => Promise<DownloadResult>;
  resolveDates: (args: {
    target: ExportBatchTarget;
    payload: RuntimePayload;
    operationId: string;
    abortSignal: AbortSignal;
  }) => Promise<DateResult>;
  save: (args: {
    target: ExportBatchTarget;
    payload: RuntimePayload;
    operationId: string;
    abortSignal: AbortSignal;
  }) => Promise<SaveResult>;
};

export type RunConversationOperationArgs = {
  jobId: string;
  operationId: string;
  target: ExportBatchTarget;
  abortSignal: AbortSignal;
  progressSink: (snapshot: ReturnType<typeof makeOperationProgressSnapshot>) => void;
  deps: OperationDeps;
};

const abortReason = (signal: AbortSignal): string => {
  if (typeof signal.reason === 'string') return signal.reason;
  const message = (signal.reason as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : 'operation_cancelled';
};

const cancelled = (
  operationId: string,
  target: ExportBatchTarget,
  signal: AbortSignal,
  receipts: Record<string, unknown> = {},
): ConversationOperationTerminalResult => ({
  status: 'cancelled',
  operationId,
  chatId: target.targetChatId,
  reason: abortReason(signal),
  receipts,
});

const throwIfAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;
  const error = new Error(abortReason(signal));
  (error as Error & { code?: string }).code = 'operation_cancelled';
  throw error;
};

export const runConversationOperation = async ({
  jobId,
  operationId,
  target,
  abortSignal,
  progressSink,
  deps,
}: RunConversationOperationArgs): Promise<ConversationOperationTerminalResult> => {
  const now = deps.now || Date.now;
  const receipts: Record<string, unknown> = {};
  const progress = (phase: string, message: string) =>
    progressSink(
      makeOperationProgressSnapshot({
        jobId,
        operationId,
        phase,
        status: 'running',
        target,
        message,
        now: now(),
      }),
    );

  try {
    if (abortSignal.aborted) return cancelled(operationId, target, abortSignal, receipts);

    progress('opening', 'Abrindo conversa');
    const downloaded = await deps.download({ target, operationId, abortSignal });
    receipts.download = downloaded.receipts || {};
    throwIfAborted(abortSignal);

    const payload = downloaded.payload || {};
    if (String(payload.chatId || '').toLowerCase() !== target.targetChatId.toLowerCase()) {
      const error = new Error(
        `Payload do navegador veio de ${payload.chatId || 'chat desconhecido'}, mas o alvo era ${target.targetChatId}.`,
      );
      (error as Error & { code?: string }).code = 'payload_chat_id_mismatch';
      throw error;
    }

    progress('resolving_dates', 'Conferindo datas da conversa');
    const dated = await deps.resolveDates({ target, payload, operationId, abortSignal });
    receipts.dateImport = dated.receipt;
    throwIfAborted(abortSignal);

    progress('saving', 'Salvando Markdown');
    const saved = await deps.save({ target, payload: dated.payload, operationId, abortSignal });
    receipts.save = saved.receipt || {};
    throwIfAborted(abortSignal);

    return {
      status: 'saved',
      operationId,
      chatId: target.targetChatId,
      filePath: saved.filePath,
      receipts,
    };
  } catch (error) {
    if ((error as { code?: string })?.code === 'operation_cancelled' || abortSignal.aborted) {
      return cancelled(operationId, target, abortSignal, receipts);
    }
    return operationResultFromError({
      operationId,
      targetChatId: target.targetChatId,
      error,
      receipts,
    });
  }
};
