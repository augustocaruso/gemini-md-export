import {
  type AssetFetchPlan,
  type AssetReceipt,
  assetRefsFromChatSnapshot,
  buildAssetFetchPlan,
  receiptsForAssetFetchPlan,
} from '../core/assets.js';
import { parseChatId } from '../core/chat-id.js';
import type { ChatReadAdapterKind } from '../core/chat-read-adapter.js';
import { renderChatSnapshotMarkdown } from '../core/chat-snapshot-markdown.js';
import type { ChatSnapshot } from '../core/types.js';
import type { BrowserExportPayload, McpExportValidation } from './export-workflows.js';

type UnknownRecord = Record<string, unknown>;

export type PrivateReadExportArgs = Readonly<{
  action: 'private_read';
  chatId: string;
  url?: string;
  title?: string;
  clientId?: string;
  tabId?: number | string;
  claimId?: string;
  sessionId?: string;
  waitMs?: number;
  privateApiTransport?: unknown;
  cookiesJson?: unknown;
  python?: unknown;
  downloadAssets?: boolean;
  assetsDir?: string;
  assetsRelDir?: string;
  allowDomFallback: false;
}>;

export type PrivateReadExportPayloadMetrics = Readonly<{
  version: 1;
  timings: Readonly<{
    privateReadMs: number;
  }>;
  counters: Readonly<{
    turnCount: number;
    totalTurnCount: number;
    assetRefCount: number;
    assetRequestCount: number;
    assetReceiptCount: number;
    mediaFileCount: number;
    mediaFailureCount: number;
    privateReadFallbackWarningCount: number;
  }>;
  privateRead: Readonly<{
    adapter: string | null;
    fallbackWarnings: readonly unknown[];
    adapterAttempts: readonly unknown[];
  }>;
  assets: Readonly<{
    warnings: readonly string[];
    dedupedRefCount: number;
  }>;
}>;

export type PrivateReadExportCollectedPayload = Readonly<{
  activeClient: unknown;
  result: Readonly<{
    ok: true;
    conversation: unknown;
    payload: BrowserExportPayload & Readonly<{ metrics: PrivateReadExportPayloadMetrics }>;
    privateRead: Readonly<{
      adapter: string | null;
      fallbackWarnings: readonly unknown[];
      adapterAttempts: readonly unknown[];
      assetPlan: AssetFetchPlan;
      assetReceipts: readonly AssetReceipt[];
      transport: unknown;
    }>;
    returnedToOriginal: null;
  }>;
  conversation: unknown;
  integrity?: Extract<McpExportValidation, { ok: true }>;
  browserCommandMs: number;
  privateReadMs: number;
  expectedChatId: string;
  requestedChatId: unknown;
}>;

export type PrivateReadExportCollectorDeps = Readonly<{
  runPrivateReadAction(args: PrivateReadExportArgs): Promise<unknown>;
  validateMcpExportPayload(
    payload: BrowserExportPayload,
    input: Readonly<{ expectedChatId: unknown; requestedChatId: unknown }>,
  ): Promise<McpExportValidation>;
  assertNotAborted(args: unknown): void;
  env?: Readonly<Record<string, unknown>>;
  now?: () => number;
}>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object';

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const nonNegativeElapsed = (startedAt: number, finishedAt: number): number =>
  Math.max(0, Math.round(finishedAt - startedAt));

const envDisablesPrivateReadExport = (env: Readonly<Record<string, unknown>> = {}): boolean => {
  const value = String(env.GEMINI_MCP_PRIVATE_READ_EXPORT ?? '')
    .trim()
    .toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(value);
};

export const chatIdFromExportConversation = (conversation: unknown): string | null => {
  if (!isRecord(conversation)) return null;
  return (
    parseChatId(conversation.chatId) ||
    parseChatId(conversation.url) ||
    parseChatId(conversation.id)
  );
};

export const shouldAttemptPrivateReadExport = (
  conversation: unknown,
  args: Readonly<UnknownRecord> = {},
  env: Readonly<Record<string, unknown>> = {},
): boolean => {
  if (args.privateReadExport === false) return false;
  if (envDisablesPrivateReadExport(env)) return false;
  return !!chatIdFromExportConversation(conversation);
};

export const buildPrivateReadExportArgs = (
  conversation: unknown,
  args: Readonly<UnknownRecord> = {},
): PrivateReadExportArgs => {
  const chatId = chatIdFromExportConversation(conversation);
  if (!chatId) {
    throw Object.assign(new Error('Conversa sem chatId comprovado para private_read.'), {
      code: 'private_read_export_chat_id_missing',
    });
  }

  const item = isRecord(conversation) ? conversation : {};
  const waitMs = numberOrNull(args.privateReadWaitMs) || numberOrNull(args.waitMs);
  const tabId = numberOrNull(args.tabId);
  return {
    action: 'private_read',
    chatId,
    url: stringOrNull(item.url) || `https://gemini.google.com/app/${chatId}`,
    title: stringOrNull(item.title) || chatId,
    ...(stringOrNull(args.clientId) ? { clientId: stringOrNull(args.clientId) as string } : {}),
    ...(tabId !== null ? { tabId } : {}),
    ...(stringOrNull(args.claimId) ? { claimId: stringOrNull(args.claimId) as string } : {}),
    ...(stringOrNull(args.sessionId) ? { sessionId: stringOrNull(args.sessionId) as string } : {}),
    ...(waitMs !== null ? { waitMs } : {}),
    ...(args.privateApiTransport ? { privateApiTransport: args.privateApiTransport } : {}),
    ...(args.cookiesJson ? { cookiesJson: args.cookiesJson } : {}),
    ...(args.python ? { python: args.python } : {}),
    downloadAssets: true,
    assetsRelDir: `assets/${chatId}`,
    allowDomFallback: false,
  };
};

const snapshotFromPrivateReadResult = (result: unknown): ChatSnapshot => {
  const record = isRecord(result) ? result : {};
  const snapshot = isRecord(record.snapshot) ? record.snapshot : null;
  if (!snapshot || !parseChatId(snapshot.chatId) || !Array.isArray(snapshot.turns)) {
    throw Object.assign(new Error('private_read nao retornou snapshot exportavel.'), {
      code: 'private_read_export_snapshot_missing',
      data: result,
    });
  }
  return snapshot as ChatSnapshot;
};

const adapterOf = (result: unknown): ChatReadAdapterKind | string | null => {
  const adapter = isRecord(result) ? stringOrNull(result.adapter) : null;
  return adapter || null;
};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const assetPlanFromResult = (result: unknown, snapshot: ChatSnapshot): AssetFetchPlan => {
  const plan = isRecord(result) && isRecord(result.assetPlan) ? result.assetPlan : null;
  if (plan && Array.isArray(plan.refs) && Array.isArray(plan.requests)) {
    return plan as unknown as AssetFetchPlan;
  }
  return buildAssetFetchPlan(assetRefsFromChatSnapshot(snapshot));
};

const assetReceiptsFromResult = (
  result: unknown,
  assetPlan: AssetFetchPlan,
): readonly AssetReceipt[] => {
  const receipts = isRecord(result) ? result.assetReceipts : null;
  return Array.isArray(receipts)
    ? (receipts as AssetReceipt[])
    : receiptsForAssetFetchPlan(assetPlan);
};

const assistantTurnCountForSnapshot = (snapshot: ChatSnapshot): number => {
  const metadataCount = Number(snapshot.metadata?.assistantTurnCount);
  if (Number.isFinite(metadataCount) && metadataCount >= 0) return metadataCount;
  return snapshot.turns.filter((turn) => turn.role === 'assistant').length;
};

export const privateReadExportResultToCollectedPayload = ({
  activeClient,
  conversation,
  result,
  privateReadStartedAt,
  privateReadFinishedAt = Date.now(),
}: Readonly<{
  activeClient: unknown;
  conversation: unknown;
  result: unknown;
  privateReadStartedAt: number;
  privateReadFinishedAt?: number;
}>): PrivateReadExportCollectedPayload => {
  const snapshot = snapshotFromPrivateReadResult(result);
  const chatId = parseChatId(snapshot.chatId);
  if (!chatId) {
    throw Object.assign(new Error('private_read retornou chatId invalido.'), {
      code: 'private_read_export_chat_id_invalid',
    });
  }
  const record = isRecord(result) ? result : {};
  const markdown = stringOrNull(record.markdown) || renderChatSnapshotMarkdown({ snapshot });
  const assetPlan = assetPlanFromResult(result, snapshot);
  const assetReceipts = assetReceiptsFromResult(result, assetPlan);
  const mediaFiles = arrayOf(record.mediaFiles);
  const mediaFailures = arrayOf(record.mediaFailures);
  const fallbackWarnings = arrayOf(record.fallbackWarnings);
  const adapterAttempts = arrayOf(record.adapterAttempts);
  const conversationRecord = isRecord(conversation) ? conversation : {};
  const filename = stringOrNull(conversationRecord.filename) || `${chatId}.md`;
  const privateReadMs = nonNegativeElapsed(privateReadStartedAt, privateReadFinishedAt);
  const assistantTurnCount = assistantTurnCountForSnapshot(snapshot);
  const metrics: PrivateReadExportPayloadMetrics = {
    version: 1,
    timings: {
      privateReadMs,
    },
    counters: {
      turnCount: assistantTurnCount,
      totalTurnCount: snapshot.turns.length,
      assetRefCount: assetPlan.refs.length,
      assetRequestCount: assetPlan.requests.length,
      assetReceiptCount: assetReceipts.length,
      mediaFileCount: mediaFiles.length,
      mediaFailureCount: mediaFailures.length,
      privateReadFallbackWarningCount: fallbackWarnings.length,
    },
    privateRead: {
      adapter: adapterOf(result),
      fallbackWarnings,
      adapterAttempts,
    },
    assets: {
      warnings: assetPlan.warnings,
      dedupedRefCount: assetPlan.dedupedRefs.length,
    },
  };
  const payload: BrowserExportPayload & Readonly<{ metrics: PrivateReadExportPayloadMetrics }> = {
    chatId,
    title: snapshot.title,
    url: snapshot.url || `https://gemini.google.com/app/${chatId}`,
    filename,
    content: markdown,
    turns: snapshot.turns,
    ...(mediaFiles.length ? { mediaFiles } : {}),
    ...(mediaFailures.length ? { mediaFailures } : {}),
    metrics,
  };

  return {
    activeClient,
    result: {
      ok: true,
      conversation,
      payload,
      privateRead: {
        adapter: adapterOf(result),
        fallbackWarnings,
        adapterAttempts,
        assetPlan,
        assetReceipts,
        transport: record.transport || null,
      },
      returnedToOriginal: null,
    },
    conversation,
    browserCommandMs: privateReadMs,
    privateReadMs,
    expectedChatId: chatId,
    requestedChatId: isRecord(conversation)
      ? conversation.chatId || conversation.id || conversation.url || null
      : null,
  };
};

const progress = (args: unknown, event: UnknownRecord): void => {
  if (!isRecord(args) || typeof args.onOperationProgress !== 'function') return;
  args.onOperationProgress(event);
};

const allowDomFallback = (args: Readonly<UnknownRecord>): boolean => args.allowDomFallback === true;

const privateReadUnavailableError = (
  code: string,
  message: string,
  data: UnknownRecord = {},
): Error & { code?: string; data?: UnknownRecord } => {
  const err = new Error(message) as Error & { code?: string; data?: UnknownRecord };
  err.code = code;
  err.data = data;
  return err;
};

const errorWasAbort = (err: unknown): boolean =>
  isRecord(err) && (err.commandAborted === true || err.code === 'operation_cancelled');

const clientSelectorForPrivateRead = (
  client: unknown,
  args: Readonly<UnknownRecord>,
): UnknownRecord => {
  const record = isRecord(client) ? client : {};
  return {
    clientId: record.clientId || args.clientId || null,
    tabId: record.tabId ?? args.tabId ?? null,
    waitMs: args.privateReadWaitMs || 25000,
  };
};

export const createPrivateReadExportCollector =
  (deps: PrivateReadExportCollectorDeps) =>
  async (
    client: unknown,
    conversation: unknown,
    args: Readonly<UnknownRecord> = {},
  ): Promise<PrivateReadExportCollectedPayload | null> => {
    if (!shouldAttemptPrivateReadExport(conversation, args, deps.env || {})) return null;
    deps.assertNotAborted(args);

    const now = deps.now || Date.now;
    const privateReadStartedAt = now();
    const privateReadArgs = buildPrivateReadExportArgs(conversation, {
      ...args,
      ...clientSelectorForPrivateRead(client, args),
      allowDomFallback: false,
    });

    try {
      progress(args, {
        phase: 'private-read-started',
        message: 'Lendo conversa pela API privada',
        targetChatId: privateReadArgs.chatId,
      });
      const result = await deps.runPrivateReadAction(privateReadArgs);
      deps.assertNotAborted(args);
      progress(args, {
        phase: isRecord(result) && result.ok ? 'private-read-finished' : 'private-read-fallback',
        message:
          isRecord(result) && result.ok
            ? 'Conversa lida pela API privada'
            : allowDomFallback(args)
              ? 'API privada indisponivel; preparando fallback'
              : 'API privada indisponivel',
        targetChatId: privateReadArgs.chatId,
        adapter: isRecord(result) ? result.adapter || null : null,
        code: isRecord(result) ? result.code || null : null,
      });

      if (!isRecord(result) || result.ok !== true) {
        const failure = isRecord(result) ? result : {};
        if (allowDomFallback(args)) return null;
        throw privateReadUnavailableError(
          String(failure.code || 'private_read_export_unavailable'),
          String(
            failure.message ||
              'A rota privada nao conseguiu ler esta conversa. Fallback DOM exige confirmacao explicita.',
          ),
          { privateRead: failure },
        );
      }

      const collected = privateReadExportResultToCollectedPayload({
        activeClient: client,
        conversation,
        result,
        privateReadStartedAt,
        privateReadFinishedAt: now(),
      });
      const integrity = await deps.validateMcpExportPayload(collected.result.payload, {
        expectedChatId: collected.expectedChatId,
        requestedChatId: collected.requestedChatId,
      });
      if (!integrity.ok) {
        progress(args, {
          phase: 'private-read-fallback',
          message: allowDomFallback(args)
            ? 'API privada retornou payload invalido; preparando fallback'
            : 'API privada retornou payload invalido',
          targetChatId: privateReadArgs.chatId,
          code: integrity.code || 'private_read_payload_invalid',
        });
        if (allowDomFallback(args)) return null;
        throw privateReadUnavailableError(
          integrity.code || 'private_read_payload_invalid',
          integrity.message || 'A rota privada retornou dados invalidos.',
          { integrity },
        );
      }

      return {
        ...collected,
        integrity,
      };
    } catch (err) {
      if (errorWasAbort(err)) throw err;
      progress(args, {
        phase: 'private-read-fallback',
        message: allowDomFallback(args)
          ? 'API privada falhou; preparando fallback'
          : 'API privada falhou',
        targetChatId: privateReadArgs.chatId,
        code: isRecord(err)
          ? err.code || 'private_read_export_failed'
          : 'private_read_export_failed',
      });
      if (allowDomFallback(args)) return null;
      throw err;
    }
  };
