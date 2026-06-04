const chatIdFromText = (value) => {
    const text = String(value || '');
    const prefixed = text.match(/\bc_([a-f0-9]{12,})\b/i);
    if (prefixed)
        return prefixed[1].toLowerCase();
    const app = text.match(/\/app\/([a-f0-9]{12,})/i);
    if (app)
        return app[1].toLowerCase();
    const bare = text.match(/\b([a-f0-9]{12,})\b/i);
    return bare?.[1]?.toLowerCase() || '';
};
const stripGeminiPrefix = (value) => {
    const text = String(value || '').trim();
    const match = text.match(/^c_([a-f0-9]{12,})$/i);
    return match?.[1] || text;
};
const normalizeConversationChatId = (conversation = {}) => {
    const candidates = [
        stripGeminiPrefix(conversation.chatId || ''),
        chatIdFromText(conversation.url),
        stripGeminiPrefix(conversation.id || ''),
    ];
    return candidates.find((candidate) => /^[a-f0-9]{12,}$/i.test(candidate || '')) || '';
};
export const normalizeReportItemChatId = (item = {}) => normalizeConversationChatId(item) ||
    chatIdFromText(item.chatId) ||
    chatIdFromText(item.url) ||
    chatIdFromText(item.filename) ||
    chatIdFromText(item.filePath) ||
    '';
const compactDateImport = (value) => value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
export const compactReportItems = (items, kind) => (Array.isArray(items) ? items : [])
    .map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const chatId = normalizeReportItemChatId(source);
    if (!chatId)
        return null;
    return {
        kind,
        index: source.index ?? null,
        chatId: chatId.toLowerCase(),
        title: source.title || null,
        filename: source.filename || null,
        filePath: source.filePath || null,
        relativePath: source.relativePath || null,
        bytes: source.bytes ?? null,
        reason: source.reason || kind,
        mediaFileCount: source.mediaFileCount ?? null,
        mediaFailureCount: source.mediaFailureCount ?? null,
        turns: source.turns ?? null,
        overwritten: source.overwritten ?? null,
        error: source.error || null,
        dateImport: compactDateImport(source.dateImport),
    };
})
    .filter(Boolean);
