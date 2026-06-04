import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
const normalizeChatId = (value) => parseChatId(String(value || ''));
const chatIdForConversation = (conversation) => normalizeChatId(conversation.chatId) ||
    normalizeChatId(conversation.id) ||
    normalizeChatId(conversation.url);
const titleForConversation = (conversation) => {
    const title = String(conversation.title || conversation.label || '').trim();
    return title || null;
};
const historyIndexForItem = (index) => {
    if (typeof index === 'number')
        return Number.isFinite(index) ? index : null;
    if (typeof index !== 'string')
        return null;
    const trimmed = index.trim();
    if (!trimmed)
        return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
};
export const buildExportBatchTargets = (items = [], { batchTotal = null, source = 'sidebar' } = {}) => {
    const resolvedItems = items
        .map((item) => {
        const conversation = item.conversation || {};
        const targetChatId = chatIdForConversation(conversation);
        if (!targetChatId)
            return null;
        return {
            targetChatId,
            historyIndex: historyIndexForItem(item.index),
            title: titleForConversation(conversation),
        };
    })
        .filter((item) => Boolean(item));
    const explicitBatchTotal = batchTotal !== null && batchTotal !== undefined;
    const parsedBatchTotal = explicitBatchTotal ? Number(batchTotal) : null;
    const resolvedTotal = parsedBatchTotal !== null && Number.isFinite(parsedBatchTotal) && parsedBatchTotal > 0
        ? parsedBatchTotal
        : resolvedItems.length;
    return resolvedItems.map((item, offset) => ({
        batchPosition: offset + 1,
        batchTotal: resolvedTotal,
        historyIndex: item.historyIndex,
        targetChatId: item.targetChatId,
        title: item.title,
        source,
        url: canonicalGeminiChatUrl(item.targetChatId),
    }));
};
export const buildOperationId = ({ jobId, batchPosition, targetChatId, }) => `${String(jobId || 'job').slice(0, 12)}:${String(Math.max(0, batchPosition)).padStart(3, '0')}:${targetChatId}`;
export const makeOperationProgressSnapshot = ({ jobId, operationId = null, status = 'running', phase, target, message = null, currentChatId = null, errorCount = null, now = Date.now(), }) => ({
    jobId,
    operationId,
    status,
    phase,
    batchPosition: target.batchPosition,
    batchTotal: target.batchTotal,
    historyIndex: target.historyIndex ?? null,
    title: target.title ?? null,
    targetChatId: target.targetChatId,
    currentChatId,
    message,
    lastProgressAt: now,
    errorCount,
});
export const isTerminalOperationStatus = (status) => status === 'saved' || status === 'failed' || status === 'skipped' || status === 'cancelled';
export const operationResultFromError = ({ operationId, targetChatId, error, receipts = {}, }) => {
    const err = error;
    const code = typeof err?.code === 'string' ? err.code : 'conversation_operation_failed';
    const message = typeof err?.message === 'string' ? err.message : String(error);
    return {
        status: 'failed',
        operationId,
        chatId: targetChatId || null,
        code,
        error: message,
        receipts,
    };
};
