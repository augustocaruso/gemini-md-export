const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const APP_ROUTE_RE = /\/app\/([a-f0-9]{12,})(?:[/?#]|$)/i;
const PREFIXED_CHAT_ID_RE = /^c_([a-f0-9]{12,})$/i;
export class ChatIdentityError extends Error {
    code = 'identity_unproven';
    constructor(value) {
        super(`Identidade de chat nao comprovada: ${String(value || '')}`);
        this.name = 'ChatIdentityError';
    }
}
export const parseChatId = (value) => {
    const text = String(value ?? '').trim();
    if (!text)
        return null;
    const fromRoute = text.match(APP_ROUTE_RE)?.[1];
    if (fromRoute)
        return fromRoute.toLowerCase();
    const fromPrefixed = text.match(PREFIXED_CHAT_ID_RE)?.[1];
    if (fromPrefixed)
        return fromPrefixed.toLowerCase();
    if (CHAT_ID_RE.test(text))
        return text.toLowerCase();
    return null;
};
export const assertChatId = (value) => {
    const chatId = parseChatId(value);
    if (!chatId)
        throw new ChatIdentityError(value);
    return chatId;
};
export const canonicalGeminiChatUrl = (chatId) => `https://gemini.google.com/app/${chatId}`;
