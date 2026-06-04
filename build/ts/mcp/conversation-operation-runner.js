import { makeOperationProgressSnapshot, operationResultFromError, } from './export-operation-contracts.js';
const abortReason = (signal) => {
    if (typeof signal.reason === 'string')
        return signal.reason;
    const message = signal.reason?.message;
    return typeof message === 'string' ? message : 'operation_cancelled';
};
const cancelled = (operationId, target, signal, receipts = {}) => ({
    status: 'cancelled',
    operationId,
    chatId: target.targetChatId,
    reason: abortReason(signal),
    receipts,
});
const throwIfAborted = (signal) => {
    if (!signal.aborted)
        return;
    const error = new Error(abortReason(signal));
    error.code = 'operation_cancelled';
    throw error;
};
const abortError = (signal) => {
    const error = new Error(abortReason(signal));
    error.code = 'operation_cancelled';
    return error;
};
const normalizeLocalPhaseProgressIntervalMs = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 5000;
    return Math.min(Math.floor(parsed), 15000);
};
export const runConversationOperation = async ({ jobId, operationId, target, abortSignal, progressSink, deps, }) => {
    const now = deps.now || Date.now;
    const receipts = {};
    const progress = (phase, message) => progressSink(makeOperationProgressSnapshot({
        jobId,
        operationId,
        phase,
        status: 'running',
        target,
        message,
        now: now(),
    }));
    const abortableWork = async (work) => {
        throwIfAborted(abortSignal);
        let onAbort = null;
        const abortPromise = new Promise((_resolve, reject) => {
            onAbort = () => reject(abortError(abortSignal));
            abortSignal.addEventListener('abort', onAbort, { once: true });
        });
        const workPromise = work();
        workPromise.catch(() => { });
        try {
            return await Promise.race([workPromise, abortPromise]);
        }
        finally {
            if (onAbort)
                abortSignal.removeEventListener('abort', onAbort);
        }
    };
    const withLocalPhaseProgress = async (phase, message, work) => {
        progress(phase, message);
        const heartbeatMs = normalizeLocalPhaseProgressIntervalMs(deps.localPhaseProgressIntervalMs);
        const timer = setInterval(() => progress(phase, message), heartbeatMs);
        try {
            return await abortableWork(work);
        }
        finally {
            clearInterval(timer);
        }
    };
    try {
        if (abortSignal.aborted)
            return cancelled(operationId, target, abortSignal, receipts);
        progress('opening', 'Abrindo conversa');
        const downloaded = await deps.download({ target, operationId, abortSignal });
        receipts.download = downloaded.receipts || {};
        throwIfAborted(abortSignal);
        const payload = downloaded.payload || {};
        if (String(payload.chatId || '').toLowerCase() !== target.targetChatId.toLowerCase()) {
            const error = new Error(`Payload do navegador veio de ${payload.chatId || 'chat desconhecido'}, mas o alvo era ${target.targetChatId}.`);
            error.code = 'payload_chat_id_mismatch';
            throw error;
        }
        const dated = await withLocalPhaseProgress('resolving_dates', 'Conferindo datas da conversa', () => deps.resolveDates({ target, payload, operationId, abortSignal }));
        receipts.dateImport = dated.receipt;
        throwIfAborted(abortSignal);
        const saved = await withLocalPhaseProgress('saving', 'Salvando Markdown', () => deps.save({ target, payload: dated.payload, operationId, abortSignal }));
        receipts.save = saved.receipt || {};
        throwIfAborted(abortSignal);
        return {
            status: 'saved',
            operationId,
            chatId: target.targetChatId,
            filePath: saved.filePath,
            receipts,
        };
    }
    catch (error) {
        if (error?.code === 'operation_cancelled' || abortSignal.aborted) {
            return cancelled(operationId, target, abortSignal, receipts);
        }
        const errorData = error?.data;
        if (errorData?.dateImport) {
            receipts.dateImport = errorData.dateImport;
        }
        return operationResultFromError({
            operationId,
            targetChatId: target.targetChatId,
            error,
            receipts,
        });
    }
};
