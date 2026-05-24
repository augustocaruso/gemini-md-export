import type { ChatId } from './types.js';

const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const APP_ROUTE_RE = /\/app\/([a-f0-9]{12,})(?:[/?#]|$)/i;
const PREFIXED_CHAT_ID_RE = /^c_([a-f0-9]{12,})$/i;

export class ChatIdentityError extends Error {
  readonly code = 'identity_unproven';

  constructor(value: unknown) {
    super(`Identidade de chat nao comprovada: ${String(value || '')}`);
    this.name = 'ChatIdentityError';
  }
}

export const parseChatId = (value: unknown): ChatId | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const fromRoute = text.match(APP_ROUTE_RE)?.[1];
  if (fromRoute) return fromRoute.toLowerCase() as ChatId;

  const fromPrefixed = text.match(PREFIXED_CHAT_ID_RE)?.[1];
  if (fromPrefixed) return fromPrefixed.toLowerCase() as ChatId;

  if (CHAT_ID_RE.test(text)) return text.toLowerCase() as ChatId;
  return null;
};

export const assertChatId = (value: unknown): ChatId => {
  const chatId = parseChatId(value);
  if (!chatId) throw new ChatIdentityError(value);
  return chatId;
};

export const canonicalGeminiChatUrl = (chatId: ChatId): string =>
  `https://gemini.google.com/app/${chatId}`;
