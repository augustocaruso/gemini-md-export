const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const APP_ROUTE_RE = /\/app\/([a-f0-9]{12,})/i;

type ConversationLike = Readonly<{
  chatId?: unknown;
  url?: unknown;
  id?: unknown;
}>;

export const stripGeminiPrefix = (value: unknown): string => String(value || '').replace(/^c_/, '');

export const extractChatIdFromUrl = (value: unknown): string | null => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.pathname.match(APP_ROUTE_RE)?.[1] || null;
  } catch {
    return value.match(APP_ROUTE_RE)?.[1] || null;
  }
};

export const normalizeConversationChatId = (conversation: ConversationLike = {}): string => {
  const candidates = [
    stripGeminiPrefix(conversation.chatId),
    extractChatIdFromUrl(conversation.url),
    stripGeminiPrefix(conversation.id),
  ];
  return candidates.find((candidate) => CHAT_ID_RE.test(candidate || '')) || '';
};
