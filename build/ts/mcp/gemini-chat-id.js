const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const APP_ROUTE_RE = /\/app\/([a-f0-9]{12,})/i;
export const stripGeminiPrefix = (value) => String(value || '').replace(/^c_/, '');
export const extractChatIdFromUrl = (value) => {
    if (!value || typeof value !== 'string')
        return null;
    try {
        const parsed = new URL(value);
        return parsed.pathname.match(APP_ROUTE_RE)?.[1] || null;
    }
    catch {
        return value.match(APP_ROUTE_RE)?.[1] || null;
    }
};
export const normalizeConversationChatId = (conversation = {}) => {
    const candidates = [
        stripGeminiPrefix(conversation.chatId),
        extractChatIdFromUrl(conversation.url),
        stripGeminiPrefix(conversation.id),
    ];
    return candidates.find((candidate) => CHAT_ID_RE.test(candidate || '')) || '';
};
