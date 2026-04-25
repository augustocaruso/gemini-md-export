const CONVERSATION_ITEM_KEYS = [
  'id',
  'chatId',
  'title',
  'subtitle',
  'timestamp',
  'url',
  'notebookUrl',
  'source',
  'notebookId',
  'rowIndex',
  'cacheKey',
  'current',
  'exportable',
];

export function serializeConversationItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  for (const key of CONVERSATION_ITEM_KEYS) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return out;
}

export function createBatchExportSession({
  items,
  originalItem = null,
  originalWasNotebook = false,
  originalNotebookReturnItem = null,
} = {}) {
  const serializedItems = Array.isArray(items)
    ? items.map(serializeConversationItem).filter(Boolean)
    : [];

  return {
    kind: 'batch-export',
    version: 1,
    createdAt: new Date().toISOString(),
    nextIndex: 0,
    failureIds: [],
    originalWasNotebook: Boolean(originalWasNotebook),
    originalItem: serializeConversationItem(originalItem),
    originalNotebookReturnItem: serializeConversationItem(originalNotebookReturnItem),
    items: serializedItems,
  };
}

export function normalizeBatchExportSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind !== 'batch-export') return null;
  const items = Array.isArray(value.items)
    ? value.items.map(serializeConversationItem).filter(Boolean)
    : [];
  if (items.length === 0) return null;

  const nextIndex = Math.max(0, Math.min(items.length, Number(value.nextIndex) || 0));
  const failureIds = Array.isArray(value.failureIds)
    ? value.failureIds.map((entry) => String(entry))
    : [];

  return {
    kind: 'batch-export',
    version: 1,
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date().toISOString(),
    nextIndex,
    failureIds,
    originalWasNotebook: Boolean(value.originalWasNotebook),
    originalItem: serializeConversationItem(value.originalItem),
    originalNotebookReturnItem: serializeConversationItem(value.originalNotebookReturnItem),
    items,
  };
}
