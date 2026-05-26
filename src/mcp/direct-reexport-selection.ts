import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';

type AnyRecord = Record<string, any>;

type DirectReexportSelectionOptions = {
  maxItems: number;
};

const collectRawDirectReexportItems = (args: AnyRecord = {}) => {
  const rawItems: any[] = [];
  if (Array.isArray(args.chatIds)) {
    for (const chatId of args.chatIds) rawItems.push({ chatId });
  }
  if (Array.isArray(args.items)) {
    for (const item of args.items) rawItems.push(item);
  }
  if (args.chatId) rawItems.push({ chatId: args.chatId, title: args.title });
  return rawItems;
};

const normalizeExpectedCount = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
};

export const normalizeDirectReexportSelection = (
  args: AnyRecord = {},
  options: DirectReexportSelectionOptions,
) => {
  const rawItems = collectRawDirectReexportItems(args);
  if (rawItems.length === 0) {
    throw new Error('Informe chatIds ou items para reexportar.');
  }
  if (rawItems.length > options.maxItems) {
    throw new Error(`Muitos chats em um job; limite atual: ${options.maxItems}.`);
  }

  const seen = new Set<string>();
  const normalized: AnyRecord[] = [];
  const duplicates: string[] = [];
  for (const raw of rawItems) {
    const item = typeof raw === 'string' ? { chatId: raw } : raw || {};
    const idLike = item.chatId || item.id || '';
    const chatId = parseChatId(item.url) || parseChatId(idLike);
    if (!chatId) {
      throw new Error(`chatId inválido para reexportação: ${String(item.chatId || item.url || item.id || raw)}`);
    }

    const key = chatId;
    if (seen.has(key)) {
      duplicates.push(key);
      continue;
    }
    seen.add(key);

    const title = String(item.title || item.label || chatId).slice(0, 240);
    normalized.push({
      id: key,
      chatId: key,
      title,
      url: canonicalGeminiChatUrl(chatId),
      current: false,
      source: item.source || 'direct-url',
      request: {
        title,
        sourcePath: item.sourcePath || item.path || null,
        originalIndex: item.listedIndex || item.index || normalized.length + 1,
      },
    });
  }

  if (normalized.length === 0) {
    throw new Error('Nenhum chatId único válido para reexportar.');
  }

  const expectedCount = normalizeExpectedCount(args.expectedCount);
  if (expectedCount !== null) {
    if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
      const err = new Error('expectedCount precisa ser um inteiro positivo.') as Error & {
        code?: string;
      };
      err.code = 'reexport_invalid_expected_count';
      throw err;
    }
    if (normalized.length !== expectedCount) {
      const err = new Error(
        `A seleção recebida tem ${normalized.length} chatId(s) único(s), mas expectedCount=${expectedCount}.`,
      ) as Error & { code?: string; data?: AnyRecord };
      err.code = 'reexport_selection_mismatch';
      err.data = {
        expectedCount,
        inputCount: rawItems.length,
        uniqueCount: normalized.length,
        duplicateCount: duplicates.length,
        duplicateChatIds: duplicates.slice(0, 20),
      };
      throw err;
    }
  }

  return {
    items: normalized,
    inputCount: rawItems.length,
    uniqueCount: normalized.length,
    duplicateCount: duplicates.length,
    duplicateChatIds: duplicates,
    expectedCount,
    selectionFile: args.selectionFile || null,
  };
};
