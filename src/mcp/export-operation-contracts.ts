import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import type { ChatId } from '../core/types.js';

export type ExportBatchTargetSource = 'sidebar' | 'notebook' | 'direct';

export type ExportBatchTarget = {
  batchPosition: number;
  batchTotal: number;
  historyIndex?: number | null;
  targetChatId: string;
  title?: string | null;
  source: ExportBatchTargetSource;
  url?: string | null;
};

export type OperationProgressStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ConversationOperationStatus = 'saved' | 'failed' | 'skipped' | 'cancelled';

export type ExportProgressSnapshot = {
  jobId: string;
  operationId?: string | null;
  status: OperationProgressStatus;
  phase: string;
  batchPosition?: number | null;
  batchTotal?: number | null;
  historyIndex?: number | null;
  title?: string | null;
  targetChatId?: string | null;
  currentChatId?: string | null;
  message?: string | null;
  lastProgressAt?: number | null;
  errorCount?: number | null;
};

export type ConversationOperationTerminalResult =
  | {
      status: 'saved';
      operationId: string;
      chatId: string;
      filePath: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'failed';
      operationId: string;
      chatId?: string | null;
      code: string;
      error: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'skipped';
      operationId: string;
      chatId: string;
      reason: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'cancelled';
      operationId: string;
      chatId?: string | null;
      reason: string;
      receipts: Record<string, unknown>;
    };

type RawConversationItem = {
  conversation?: Record<string, unknown>;
  index?: number | string | null;
};

type BuildTargetsOptions = {
  batchTotal?: number | null;
  source?: ExportBatchTargetSource;
};

type ResolvedConversationItem = {
  historyIndex: number | null;
  targetChatId: ChatId;
  title: string | null;
};

const normalizeChatId = (value: unknown): ChatId | null => parseChatId(String(value || ''));

const chatIdForConversation = (conversation: Record<string, unknown>): ChatId | null =>
  normalizeChatId(conversation.chatId) ||
  normalizeChatId(conversation.id) ||
  normalizeChatId(conversation.url);

const titleForConversation = (conversation: Record<string, unknown>): string | null => {
  const title = String(conversation.title || conversation.label || '').trim();
  return title || null;
};

const historyIndexForItem = (index: RawConversationItem['index']): number | null => {
  if (typeof index === 'number') return Number.isFinite(index) ? index : null;
  if (typeof index !== 'string') return null;

  const trimmed = index.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

export const buildExportBatchTargets = (
  items: RawConversationItem[] = [],
  { batchTotal = null, source = 'sidebar' }: BuildTargetsOptions = {},
): ExportBatchTarget[] => {
  const resolvedItems = items
    .map<ResolvedConversationItem | null>((item) => {
      const conversation = item.conversation || {};
      const targetChatId = chatIdForConversation(conversation);
      if (!targetChatId) return null;
      return {
        targetChatId,
        historyIndex: historyIndexForItem(item.index),
        title: titleForConversation(conversation),
      };
    })
    .filter((item): item is ResolvedConversationItem => Boolean(item));
  const explicitBatchTotal = batchTotal !== null && batchTotal !== undefined;
  const parsedBatchTotal = explicitBatchTotal ? Number(batchTotal) : null;
  const resolvedTotal =
    parsedBatchTotal !== null && Number.isFinite(parsedBatchTotal) && parsedBatchTotal > 0
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

export const buildOperationId = ({
  jobId,
  batchPosition,
  targetChatId,
}: {
  jobId: string;
  batchPosition: number;
  targetChatId: string;
}): string =>
  `${String(jobId || 'job').slice(0, 12)}:${String(Math.max(0, batchPosition)).padStart(3, '0')}:${targetChatId}`;

export const makeOperationProgressSnapshot = ({
  jobId,
  operationId = null,
  status = 'running',
  phase,
  target,
  message = null,
  currentChatId = null,
  errorCount = null,
  now = Date.now(),
}: {
  jobId: string;
  operationId?: string | null;
  status?: OperationProgressStatus;
  phase: string;
  target: ExportBatchTarget;
  message?: string | null;
  currentChatId?: string | null;
  errorCount?: number | null;
  now?: number;
}): ExportProgressSnapshot => ({
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

export const isTerminalOperationStatus = (status: unknown): status is ConversationOperationStatus =>
  status === 'saved' || status === 'failed' || status === 'skipped' || status === 'cancelled';

export const operationResultFromError = ({
  operationId,
  targetChatId,
  error,
  receipts = {},
}: {
  operationId: string;
  targetChatId?: string | null;
  error: unknown;
  receipts?: Record<string, unknown>;
}): ConversationOperationTerminalResult => {
  const err = error as { message?: unknown; code?: unknown };
  const code =
    typeof err?.code === 'string' ? err.code : 'conversation_operation_failed';
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
