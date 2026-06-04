import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { planExportAdapters } from '../core/export-adapter-policy.js';
import { normalizeDirectReexportSelection } from '../mcp/direct-reexport-selection.js';
import { validateMcpExportPayloadBeforeWrite } from '../mcp/export-workflows.js';
import {
  ensureGeminiWebapiPythonBootstrap,
  type GeminiWebapiPythonBootstrapInput,
  type GeminiWebapiPythonBootstrapResult,
  type GeminiWebapiPythonReadChatInput,
  type GeminiWebapiPythonReadChatResult,
  runGeminiWebapiPythonListChats,
  runGeminiWebapiPythonReadChat,
  runGeminiWebapiPythonSessionStatus,
} from '../mcp/gemini-webapi-python-adapter.js';
import { createNativeBrowserBrokerClient } from '../mcp/native-browser-broker.js';
import { privateReadExportResultToCollectedPayload } from '../mcp/private-read-export-runtime.js';

type AnyRecord = Record<string, any>;

export type PrivateApiSelectedExportItem = Readonly<{
  chatId: string;
  title?: string | null;
  url?: string | null;
  filename?: string | null;
  outputDir?: string | null;
  sourcePath?: string | null;
}>;

export type PrivateApiSelectedExportSavedFile = Readonly<{
  chatId: string;
  title: string | null;
  filePath: string;
  filename: string;
  bytes: number;
  overwritten: boolean;
  mediaFileCount: number;
  mediaFailureCount: number;
  mediaBytes: number;
  dateCreated: string | null;
  dateLastMessage: string | null;
  adapter: string | null;
}>;

export type PrivateApiSelectedExportFailure = Readonly<{
  index: number;
  chatId: string | null;
  title: string | null;
  error: string;
  code: string | null;
}>;

export type PrivateApiSelectedExportJob = Readonly<{
  jobId: string;
  type: 'private-api-selected-export';
  sourceKind: 'export-job';
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  phase: 'exporting' | 'writing-report';
  requested: number;
  completed: number;
  batchTotal: number;
  successCount: number;
  failureCount: number;
  outputDir: string;
  current: Readonly<{
    index: number;
    batchPosition: number;
    batchTotal: number;
    chatId: string;
    title: string | null;
  }> | null;
  progressMessage: string;
  operationMessage: string;
  decisionSummary: Readonly<{
    headline: string;
    totals: Readonly<{
      downloadedNow: number;
      failed: number;
      skipped: number;
      geminiWebSeen: number;
      missingInVault: number;
    }>;
  }>;
  savedFiles: readonly PrivateApiSelectedExportSavedFile[];
  failures: readonly PrivateApiSelectedExportFailure[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}>;

export type PrivateApiSelectedExportArgs = Readonly<{
  chatIds?: readonly unknown[];
  items?: readonly unknown[];
  expectedCount?: unknown;
  outputDir?: unknown;
  limit?: unknown;
  waitMs?: unknown;
  privateReadWaitMs?: unknown;
  timeoutMs?: unknown;
  bootstrapTimeoutMs?: unknown;
  python?: unknown;
  cookiesJson?: unknown;
  delayMs?: unknown;
  bridgeUrl?: unknown;
  pollMs?: unknown;
  preferBridge?: unknown;
  clientId?: unknown;
  tabId?: unknown;
  claimId?: unknown;
  sessionId?: unknown;
  openIfMissing?: unknown;
  wakeBrowser?: unknown;
  activateTab?: unknown;
  allowReload?: unknown;
  browserKeepAliveMs?: unknown;
  maxItems?: unknown;
  maxReadAttempts?: unknown;
  recent?: unknown;
  startIndex?: unknown;
  onProgress?: (job: PrivateApiSelectedExportJob) => void;
}>;

type PrivateApiSelectedExportDeps = Readonly<{
  bootstrapPythonSidecar(
    input: GeminiWebapiPythonBootstrapInput,
  ): Promise<GeminiWebapiPythonBootstrapResult>;
  runReadChat(input: GeminiWebapiPythonReadChatInput): Promise<GeminiWebapiPythonReadChatResult>;
  runListChats(input: {
    limit?: unknown;
    timeoutMs?: unknown;
    python?: unknown;
    cookiesJson?: unknown;
  }): Promise<AnyRecord>;
  runSessionStatus(input: {
    timeoutMs?: unknown;
    python?: unknown;
    cookiesJson?: unknown;
  }): Promise<AnyRecord>;
  ensureBrowserKeepAlive(input: { reason: string; idleCloseMs: number }): Promise<AnyRecord>;
  recoverBrowserBackgroundSession(input: {
    args: PrivateApiSelectedExportArgs;
    item: PrivateApiSelectedExportItem;
    error: { code: string | null; message: string | null };
    timeoutMs: number;
  }): Promise<AnyRecord>;
  runBrowserBackgroundReadChat(input: {
    args: PrivateApiSelectedExportArgs;
    item: PrivateApiSelectedExportItem;
    timeoutMs: number;
  }): Promise<AnyRecord>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}>;

const defaultDeps: PrivateApiSelectedExportDeps = {
  bootstrapPythonSidecar: ensureGeminiWebapiPythonBootstrap,
  runReadChat: runGeminiWebapiPythonReadChat,
  runListChats: runGeminiWebapiPythonListChats,
  runSessionStatus: runGeminiWebapiPythonSessionStatus,
  ensureBrowserKeepAlive: async (input) =>
    (await createNativeBrowserBrokerClient().keepAlive(input, {
      allowFallback: true,
    })) as AnyRecord,
  recoverBrowserBackgroundSession: async ({ args, timeoutMs }) => {
    const waitMs = Math.max(5000, Math.min(timeoutMs, 30_000));
    await bridgeJsonFetch(
      args.bridgeUrl,
      appendParams('/agent/ready', {
        detail: 'compact',
        wakeBrowser: args.wakeBrowser === true,
        allowReload: args.allowReload === true,
        waitMs,
      }),
      { timeoutMs: waitMs + 5000 },
    );
    const response = await bridgeJsonFetch(args.bridgeUrl, '/agent/mcp-tool-call', {
      method: 'POST',
      timeoutMs: waitMs + 15_000,
      body: {
        name: 'gemini_support',
        arguments: {
          action: 'session_status',
          waitMs,
          pythonFallback: false,
          clientId: args.clientId,
          tabId: args.tabId,
          claimId: args.claimId,
          sessionId: args.sessionId,
        },
      },
    });
    return toolTextPayload(response);
  },
  runBrowserBackgroundReadChat: async ({ args, item, timeoutMs }) => {
    const payload = {
      chatId: item.chatId,
      title: item.title || null,
      timeoutMs,
      downloadAssets: true,
      assetsRelDir: `assets/${item.chatId}`,
    };
    try {
      const nativeResponse = (await createNativeBrowserBrokerClient().privateApiReadChat(payload, {
        allowFallback: true,
      })) as AnyRecord;
      const nativeResult =
        nativeResponse?.ok === true
          ? (nativeResponse.result as AnyRecord)
          : (nativeResponse as AnyRecord);
      if (nativeResult?.ok === true) return nativeResult;
      throw Object.assign(
        new Error(
          readableText(nativeResult?.message) ||
            readableText(nativeResult?.error) ||
            'A leitura privada pelo native broker falhou.',
        ),
        { code: stringOrNull(nativeResult?.code) || 'native_broker_private_read_failed' },
      );
    } catch {
      return readChatViaBridgePrivateRead({ args, item, timeoutMs });
    }
  },
  now: () => new Date(),
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
};

const shouldAttemptBridgePrivateExport = (
  args: PrivateApiSelectedExportArgs,
  items: readonly PrivateApiSelectedExportItem[],
): boolean => {
  if (args.preferBridge === false) return false;
  if (stringOrNull(args.python) || stringOrNull(args.cookiesJson)) return false;
  if (stringOrNull(process.env.GME_GEMINI_WEBAPI_RUNNER)) return false;
  if (args.recent === true) return false;
  if (items.length === 0) return false;
  return !!stringOrNull(args.bridgeUrl);
};

const numberInRange = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
};

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const readableText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return stringOrNull(value);
  if (value instanceof Error) return stringOrNull(value.message);
  if (typeof value !== 'object') return stringOrNull(value);
  const record = value as AnyRecord;
  for (const key of ['message', 'error', 'reason', 'detail', 'statusText']) {
    const nested = readableText(record[key]);
    if (nested) return nested;
  }
  const code = stringOrNull(record.code);
  if (code) return code;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const expandUserPath = (value: string): string => {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
};

const resolveOutputDir = (outputDir: unknown): string => {
  const raw =
    stringOrNull(outputDir) || process.env.GEMINI_MCP_EXPORT_DIR || resolve(homedir(), 'Downloads');
  return resolve(expandUserPath(raw));
};

const normalizeBridgeUrl = (value: unknown): string => {
  const raw = stringOrNull(value);
  if (!raw) {
    throw Object.assign(new Error('Bridge local nao configurada para leitura privada.'), {
      code: 'bridge_private_read_unavailable',
    });
  }
  return raw.replace(/\/+$/, '');
};

const bridgeJsonFetch = async (
  bridgeUrl: unknown,
  path: string,
  {
    method = 'GET',
    body,
    timeoutMs = 15_000,
  }: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<AnyRecord> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  try {
    const response = await fetch(new URL(path, `${normalizeBridgeUrl(bridgeUrl)}/`), {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(bodyText ? { 'content-type': 'application/json' } : {}),
      },
      body: bodyText,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw Object.assign(
        new Error(
          stringOrNull(json.message) ||
            stringOrNull(json.error) ||
            `Bridge retornou HTTP ${response.status}.`,
        ),
        {
          code: stringOrNull(json.code) || 'bridge_private_read_unavailable',
          data: json,
        },
      );
    }
    return json;
  } catch (err) {
    if (err instanceof Error && 'code' in err) throw err;
    throw Object.assign(
      new Error(
        err instanceof Error
          ? `Bridge local indisponivel para leitura privada: ${err.message}`
          : 'Bridge local indisponivel para leitura privada.',
      ),
      { code: 'bridge_private_read_unavailable', cause: err },
    );
  } finally {
    clearTimeout(timeout);
  }
};

const appendParams = (path: string, params: AnyRecord): string => {
  const url = new URL(path, 'http://127.0.0.1');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
};

const bridgePrivateReadClientId = async (
  args: PrivateApiSelectedExportArgs,
  timeoutMs: number,
): Promise<string | null> => {
  const explicit = stringOrNull(args.clientId);
  if (explicit) return explicit;
  const ready = await bridgeJsonFetch(
    args.bridgeUrl,
    appendParams('/agent/ready', {
      wakeBrowser: false,
      waitMs: Math.min(timeoutMs, 30_000),
      allowReload: args.allowReload === true,
    }),
    { timeoutMs: Math.max(5_000, Math.min(timeoutMs + 5_000, 45_000)) },
  );
  const clients = Array.isArray(ready.connectedClients) ? ready.connectedClients : [];
  return stringOrNull(
    clients.find((client: AnyRecord) => stringOrNull(client?.clientId))?.clientId,
  );
};

const toolTextPayload = (toolCallResponse: AnyRecord): AnyRecord => {
  const result =
    toolCallResponse.result && typeof toolCallResponse.result === 'object'
      ? (toolCallResponse.result as AnyRecord)
      : {};
  if (result.isError === true) {
    throw Object.assign(new Error('A tool private_read retornou erro pela bridge.'), {
      code: 'bridge_private_read_tool_error',
      data: result,
    });
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = stringOrNull(content.find((item: AnyRecord) => item?.type === 'text')?.text);
  if (text) {
    try {
      return JSON.parse(text) as AnyRecord;
    } catch (err) {
      throw Object.assign(new Error('A bridge retornou private_read em formato invalido.'), {
        code: 'bridge_private_read_invalid_json',
        cause: err,
      });
    }
  }
  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as AnyRecord)
      : null;
  if (structured) return structured;
  throw Object.assign(new Error('A bridge nao retornou payload de private_read.'), {
    code: 'bridge_private_read_empty',
  });
};

const readChatViaBridgePrivateRead = async ({
  args,
  item,
  timeoutMs,
}: {
  args: PrivateApiSelectedExportArgs;
  item: PrivateApiSelectedExportItem;
  timeoutMs: number;
}): Promise<AnyRecord> => {
  const clientId = await bridgePrivateReadClientId(args, timeoutMs);
  const response = await bridgeJsonFetch(args.bridgeUrl, '/agent/mcp-tool-call', {
    method: 'POST',
    timeoutMs: Math.max(20_000, timeoutMs + 10_000),
    body: {
      name: 'gemini_chats',
      arguments: {
        action: 'private_read',
        intent: 'one_off',
        diagnostic: true,
        detail: 'full',
        chatId: item.chatId,
        url: item.url || undefined,
        title: item.title || undefined,
        privateApiTransport: 'browser-background',
        waitMs: timeoutMs,
        downloadAssets: true,
        assetsRelDir: `assets/${item.chatId}`,
        allowPythonFallback: false,
        allowDomFallback: false,
        clientId: clientId || undefined,
        tabId: args.tabId,
        claimId: args.claimId,
      },
    },
  });
  const payload = toolTextPayload(response);
  if (payload.ok !== true) {
    throw Object.assign(
      new Error(
        readableText(payload.message) ||
          readableText(payload.error) ||
          'A leitura privada pela bridge falhou.',
      ),
      { code: stringOrNull(payload.code) || 'bridge_private_read_failed', data: payload },
    );
  }
  return payload;
};

const safeFilename = (filename: unknown): string => {
  const raw = String(filename || '')
    .trim()
    .replace(/\\/g, '/');
  if (
    !raw ||
    raw.startsWith('/') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.includes('\0') ||
    raw.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw Object.assign(new Error('Nome de arquivo inválido retornado pelo adapter privado.'), {
      code: 'private_api_invalid_filename',
    });
  }
  return raw;
};

const bufferFromPayload = (payload: AnyRecord, emptyMessage: string, emptyCode: string): Buffer => {
  const content =
    typeof payload.contentBase64 === 'string'
      ? Buffer.from(payload.contentBase64, 'base64')
      : Buffer.from(String(payload.content || ''), 'utf-8');
  if (content.length === 0) {
    throw Object.assign(new Error(emptyMessage), { code: emptyCode });
  }
  return content;
};

const writePayloadFile = (
  payload: AnyRecord,
  outputDir: string,
  fallbackFilename: string,
  emptyMessage: string,
  emptyCode: string,
) => {
  const content = bufferFromPayload(payload, emptyMessage, emptyCode);
  const filename = safeFilename(payload.filename || fallbackFilename);
  const filePath = resolve(outputDir, filename);
  const relativePath = relative(outputDir, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || isAbsolute(relativePath)) {
    throw Object.assign(new Error('Caminho de arquivo inválido retornado pelo adapter privado.'), {
      code: 'private_api_invalid_file_path',
    });
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const overwritten = existsSync(filePath);
  writeFileSync(filePath, content);
  return {
    filename,
    filePath,
    bytes: content.length,
    overwritten,
  };
};

const writeMarkdownPayload = (payload: AnyRecord, outputDir: string) =>
  writePayloadFile(
    payload,
    outputDir,
    `${payload.chatId || 'gemini-chat'}.md`,
    'O adapter privado nao retornou Markdown para salvar.',
    'private_api_empty_markdown',
  );

const mediaFilesOf = (payload: AnyRecord): AnyRecord[] =>
  Array.isArray(payload.mediaFiles)
    ? payload.mediaFiles.filter(
        (item): item is AnyRecord => item !== null && typeof item === 'object',
      )
    : [];

const mediaFailuresOf = (payload: AnyRecord): readonly unknown[] =>
  Array.isArray(payload.mediaFailures) ? payload.mediaFailures : [];

const payloadWithLocalMediaLinks = (payload: AnyRecord, mediaFiles: readonly AnyRecord[]) => {
  if (typeof payload.content !== 'string') return payload;
  let content = payload.content;
  for (const file of mediaFiles) {
    const sourceUrl = stringOrNull(file.sourceUrl);
    if (!sourceUrl) continue;
    const filename = safeFilename(file.filename || 'asset.bin').replace(/\\/g, '/');
    content = content.split(sourceUrl).join(filename);
  }
  return content === payload.content ? payload : { ...payload, content };
};

const writePayloadBundle = (payload: AnyRecord, outputDir: string) => {
  const mediaPayloads = mediaFilesOf(payload);
  const markdown = writeMarkdownPayload(
    payloadWithLocalMediaLinks(payload, mediaPayloads),
    outputDir,
  );
  const mediaFiles = mediaPayloads.map((file) =>
    writePayloadFile(
      file,
      outputDir,
      String(file.filename || 'asset.bin'),
      'O adapter privado retornou um asset vazio.',
      'private_api_empty_asset',
    ),
  );
  return {
    ...markdown,
    mediaFiles,
    mediaFileCount: mediaFiles.length,
    mediaFailureCount: mediaFailuresOf(payload).length,
    mediaBytes: mediaFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
};

const payloadWithFilename = (payload: AnyRecord, filename: string | null): AnyRecord =>
  filename ? { ...payload, filename } : payload;

const makeJob = ({
  jobId,
  status,
  outputDir,
  requested,
  completed,
  current,
  savedFiles,
  failures,
  progressMessage,
  startedAt,
  updatedAt,
  finishedAt,
}: {
  jobId: string;
  status: PrivateApiSelectedExportJob['status'];
  outputDir: string;
  requested: number;
  completed: number;
  current: PrivateApiSelectedExportJob['current'];
  savedFiles: readonly PrivateApiSelectedExportSavedFile[];
  failures: readonly PrivateApiSelectedExportFailure[];
  progressMessage: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}): PrivateApiSelectedExportJob => ({
  jobId,
  type: 'private-api-selected-export',
  sourceKind: 'export-job',
  status,
  phase: status === 'running' ? 'exporting' : 'writing-report',
  requested,
  completed,
  batchTotal: requested,
  successCount: savedFiles.length,
  failureCount: failures.length,
  outputDir,
  current,
  progressMessage,
  operationMessage: progressMessage,
  decisionSummary: {
    headline: progressMessage,
    totals: {
      downloadedNow: savedFiles.length,
      failed: failures.length,
      skipped: 0,
      geminiWebSeen: requested,
      missingInVault: requested,
    },
  },
  savedFiles,
  failures,
  startedAt,
  updatedAt,
  ...(finishedAt ? { finishedAt } : {}),
});

const failureFromError = (
  item: PrivateApiSelectedExportItem,
  index: number,
  err: unknown,
): PrivateApiSelectedExportFailure => {
  const record = err && typeof err === 'object' ? (err as AnyRecord) : {};
  return {
    index,
    chatId: item.chatId || null,
    title: item.title || null,
    error:
      readableText(err instanceof Error ? err.message : record.message || err) ||
      'erro sem detalhe',
    code: stringOrNull(record.code) || null,
  };
};

const isTransientPrivateReadError = (err: unknown): boolean => {
  const record = err && typeof err === 'object' ? (err as AnyRecord) : {};
  const code = stringOrNull(record.code) || '';
  const message = readableText(err) || '';
  const signal = `${code} ${message}`.toLowerCase();
  return (
    [
      'browserbackground_failed',
      'bridge_private_read_failed',
      'bridge_private_read_tool_error',
      'bridge_private_read_unavailable',
      'native_broker_unavailable',
      'command_timeout',
      'extension_request_timeout',
    ].includes(code.toLowerCase()) ||
    signal.includes('timeout') ||
    signal.includes('tempor') ||
    signal.includes('unavailable') ||
    signal.includes('background') ||
    signal.includes('broker')
  );
};

const browserKeepAliveMsForBatch = ({
  args,
  requested,
  readTimeoutMs,
}: {
  args: PrivateApiSelectedExportArgs;
  requested: number;
  readTimeoutMs: number;
}): number => {
  const explicit = Number(args.browserKeepAliveMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(60_000, explicit);
  const estimated = Math.max(1, requested) * Math.min(readTimeoutMs + 5000, 120_000);
  return Math.min(30 * 60_000, Math.max(15 * 60_000, estimated));
};

const normalizeItems = (args: PrivateApiSelectedExportArgs): PrivateApiSelectedExportItem[] => {
  const maxItems = numberInRange(args.maxItems, 500, 1, 1000);
  const selection = normalizeDirectReexportSelection(args as AnyRecord, { maxItems });
  return selection.items.map((item: AnyRecord) => ({
    chatId: item.chatId,
    title: stringOrNull(item.title),
    url: stringOrNull(item.url),
    filename: stringOrNull(item.filename),
    outputDir: stringOrNull(item.outputDir),
    sourcePath: stringOrNull(item.sourcePath || item.request?.sourcePath),
  }));
};

const normalizePrivateRecentChatItem = (chat: AnyRecord): PrivateApiSelectedExportItem | null => {
  const chatId = stringOrNull(
    chat.chatId || chat.chat_id || chat.privateChatId || chat.private_chat_id || chat.id,
  )?.replace(/^c_/, '');
  if (!chatId) return null;
  return {
    chatId,
    title: stringOrNull(chat.title),
    url: stringOrNull(chat.url) || `https://gemini.google.com/app/${chatId}`,
  };
};

const listRecentItems = async (
  args: PrivateApiSelectedExportArgs,
  deps: PrivateApiSelectedExportDeps,
): Promise<PrivateApiSelectedExportItem[]> => {
  const limit = numberInRange(args.limit, 10, 1, 2000);
  const startIndex = numberInRange(args.startIndex, 1, 1, 2000);
  const requested = startIndex - 1 + limit;
  const inventoryPlan = planExportAdapters({
    operationKind: 'recent_export',
    privateInventoryAvailable: true,
    browserFallbackAllowed: false,
  });
  if (inventoryPlan.blocker) {
    throw Object.assign(new Error(inventoryPlan.blocker.message), {
      code: inventoryPlan.blocker.code,
    });
  }
  const result = await deps.runListChats({
    limit: requested,
    timeoutMs: args.waitMs ?? args.privateReadWaitMs ?? args.timeoutMs,
    python: args.python,
    cookiesJson: args.cookiesJson,
  });
  if (result?.ok !== true) {
    throw Object.assign(
      new Error(
        stringOrNull(result?.message) ||
          stringOrNull(result?.error) ||
          'Nao consegui listar conversas pela API privada.',
      ),
      { code: stringOrNull(result?.code) || 'private_inventory_unavailable' },
    );
  }
  const chats = Array.isArray(result.chats) ? result.chats : [];
  return chats
    .map((chat) => normalizePrivateRecentChatItem(chat))
    .filter((item): item is PrivateApiSelectedExportItem => item !== null)
    .slice(startIndex - 1, startIndex - 1 + limit);
};

export const runPrivateApiSelectedExport = async (
  args: PrivateApiSelectedExportArgs,
  deps: Partial<PrivateApiSelectedExportDeps> = {},
): Promise<PrivateApiSelectedExportJob> => {
  const runtimeDeps: PrivateApiSelectedExportDeps = { ...defaultDeps, ...deps };
  let items = args.recent === true ? [] : normalizeItems(args);
  if (items.length === 0 && args.recent !== true) {
    throw Object.assign(new Error('Nenhuma conversa selecionada para exportar.'), {
      code: 'private_api_selection_empty',
    });
  }
  const outputDir = resolveOutputDir(args.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const useBridgePrivateRead = shouldAttemptBridgePrivateExport(args, items);

  let requested = Math.max(
    items.length,
    numberInRange(
      args.expectedCount ?? (args.recent === true ? args.limit : 0),
      args.recent === true ? 10 : 0,
      0,
      2000,
    ),
  );
  const savedFiles: PrivateApiSelectedExportSavedFile[] = [];
  const failures: PrivateApiSelectedExportFailure[] = [];
  const startedAt = runtimeDeps.now().toISOString();
  const jobId = `private-api-${Date.now().toString(36)}`;
  const emit = (
    status: PrivateApiSelectedExportJob['status'],
    current: PrivateApiSelectedExportJob['current'],
    progressMessage: string,
    finishedAt?: string,
  ) => {
    const job = makeJob({
      jobId,
      status,
      outputDir,
      requested,
      completed: savedFiles.length + failures.length,
      current,
      savedFiles: [...savedFiles],
      failures: [...failures],
      progressMessage,
      startedAt,
      updatedAt: runtimeDeps.now().toISOString(),
      finishedAt,
    });
    args.onProgress?.(job);
    return job;
  };

  let latestJob = emit('running', null, 'Preparando API privada');
  if (!useBridgePrivateRead) {
    const bootstrapTimeoutMs = numberInRange(
      args.bootstrapTimeoutMs ?? process.env.GME_GEMINI_WEBAPI_BOOTSTRAP_TIMEOUT_MS,
      180_000,
      30_000,
      300_000,
    );
    const bootstrapResult = await runtimeDeps.bootstrapPythonSidecar({
      timeoutMs: bootstrapTimeoutMs,
      python: args.python,
    });
    if (!bootstrapResult.ok) {
      failures.push({
        index: 0,
        chatId: null,
        title: null,
        error: bootstrapResult.message,
        code: bootstrapResult.code,
      });
      return emit(
        'failed',
        null,
        'Preparacao da API privada falhou',
        runtimeDeps.now().toISOString(),
      );
    }

    latestJob = emit('running', null, 'Verificando sessão da API privada');
    const sessionResult = await runtimeDeps.runSessionStatus({
      timeoutMs: args.waitMs ?? args.privateReadWaitMs ?? args.timeoutMs,
      python: args.python,
      cookiesJson: args.cookiesJson,
    });
    if (sessionResult?.ok !== true || sessionResult.authenticated !== true) {
      failures.push({
        index: 0,
        chatId: null,
        title: null,
        error:
          stringOrNull(sessionResult?.message) ||
          stringOrNull(sessionResult?.error) ||
          'Sessao da API privada nao autenticada.',
        code: stringOrNull(sessionResult?.code) || 'private_api_session_unavailable',
      });
      return emit(
        'failed',
        null,
        'Sessão da API privada precisa de login',
        runtimeDeps.now().toISOString(),
      );
    }
  }

  if (items.length === 0 && args.recent === true) {
    latestJob = emit('running', null, 'Listando conversas pela API privada');
    try {
      items = await listRecentItems(args, runtimeDeps);
      requested = items.length;
    } catch (err) {
      const record = err && typeof err === 'object' ? (err as AnyRecord) : {};
      failures.push({
        index: 0,
        chatId: null,
        title: null,
        error:
          err instanceof Error ? err.message : String(record.message || err || 'erro sem detalhe'),
        code: stringOrNull(record.code) || null,
      });
      return emit(
        'failed',
        null,
        'Listagem pela API privada falhou',
        runtimeDeps.now().toISOString(),
      );
    }
  }
  if (items.length === 0) {
    throw Object.assign(new Error('Nenhuma conversa selecionada para exportar.'), {
      code: 'private_api_selection_empty',
    });
  }
  const adapterPlan = planExportAdapters({
    operationKind: args.recent === true ? 'recent_export' : 'selected_export',
    knownChatIds: items.map((item) => item.chatId),
    privateApiAvailable: true,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: true,
    browserFallbackAllowed: false,
  });
  if (adapterPlan.blocker) {
    throw Object.assign(new Error(adapterPlan.blocker.message), {
      code: adapterPlan.blocker.code,
    });
  }

  const readTimeoutMs = numberInRange(
    args.privateReadWaitMs ?? args.waitMs ?? args.timeoutMs,
    45_000,
    5_000,
    120_000,
  );
  const maxReadAttempts = numberInRange(
    args.maxReadAttempts ?? (useBridgePrivateRead ? process.env.GME_PRIVATE_READ_MAX_ATTEMPTS : 1),
    useBridgePrivateRead ? 2 : 1,
    1,
    5,
  );
  const limit = numberInRange(args.limit, 200, 1, 2000);
  const delayMs = numberInRange(args.delayMs, 0, 0, 60_000);
  const browserKeepAliveMs = browserKeepAliveMsForBatch({ args, requested, readTimeoutMs });
  const ensureBrowserBackgroundLease = async () => {
    if (!useBridgePrivateRead) return;
    try {
      await runtimeDeps.ensureBrowserKeepAlive({
        reason: 'private-api-selected-export',
        idleCloseMs: browserKeepAliveMs,
      });
    } catch {
      // A leitura privada abaixo ainda pode funcionar; falha de keepalive vira evidência no próprio read.
    }
  };

  for (const [index, item] of items.entries()) {
    const current = {
      index: index + 1,
      batchPosition: index + 1,
      batchTotal: requested,
      chatId: item.chatId,
      title: item.title || item.chatId,
    };
    try {
      latestJob = emit('running', current, 'Lendo conversa pela API privada');
      const readStartedAt = Date.now();
      let readResult: AnyRecord | GeminiWebapiPythonReadChatResult | null = null;
      for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
        try {
          await ensureBrowserBackgroundLease();
          readResult = useBridgePrivateRead
            ? await runtimeDeps.runBrowserBackgroundReadChat({
                args,
                item,
                timeoutMs: readTimeoutMs,
              })
            : await runtimeDeps.runReadChat({
                chatId: item.chatId,
                url: item.url || undefined,
                title: item.title || undefined,
                timeoutMs: readTimeoutMs,
                limit,
                python: args.python,
                cookiesJson: args.cookiesJson,
                downloadAssets: true,
                assetsRelDir: `assets/${item.chatId}`,
              });
          if (readResult?.ok === false) {
            const failure = readResult as AnyRecord;
            throw Object.assign(
              new Error(
                readableText(failure.message) ||
                  readableText(failure.error) ||
                  'A leitura privada da conversa falhou.',
              ),
              {
                code: stringOrNull(failure.code) || 'private_api_read_failed',
              },
            );
          }
          break;
        } catch (err) {
          const canRetry = attempt < maxReadAttempts && isTransientPrivateReadError(err);
          if (!canRetry) throw err;
          if (useBridgePrivateRead) {
            latestJob = emit('running', current, 'Recuperando sessão do navegador');
            const record = err && typeof err === 'object' ? (err as AnyRecord) : {};
            try {
              await runtimeDeps.recoverBrowserBackgroundSession({
                args,
                item,
                error: {
                  code: stringOrNull(record.code) || null,
                  message: readableText(err),
                },
                timeoutMs: readTimeoutMs,
              });
            } catch {
              // A proxima tentativa ainda renova o lease; se falhar, o erro final fica no item.
            }
          }
          latestJob = emit('running', current, 'Leitura privada falhou; tentando novamente');
          await runtimeDeps.sleep(Math.min(500 * attempt, 2_000));
          latestJob = emit('running', current, 'Lendo conversa pela API privada');
        }
      }
      if (!readResult) {
        throw Object.assign(new Error('A leitura privada nao retornou resultado.'), {
          code: 'private_api_read_empty',
        });
      }
      if (!readResult.ok) {
        const failure = readResult as AnyRecord;
        throw Object.assign(
          new Error(
            readableText(failure.message) ||
              readableText(failure.error) ||
              'A leitura privada da conversa falhou.',
          ),
          {
            code: stringOrNull(failure.code) || 'private_api_read_failed',
          },
        );
      }

      latestJob = emit('running', current, 'Validando Markdown e datas');
      const collected = privateReadExportResultToCollectedPayload({
        activeClient: null,
        conversation: item,
        result: {
          ...readResult,
          adapter:
            stringOrNull((readResult as AnyRecord).adapter) ||
            (useBridgePrivateRead ? 'browserBackground' : 'privateApiGeminiWebapi'),
        },
        privateReadStartedAt: readStartedAt,
        privateReadFinishedAt: Date.now(),
      });
      const integrity = validateMcpExportPayloadBeforeWrite(collected.result.payload, {
        expectedChatId: item.chatId,
        requestedChatId: item.chatId,
      });
      if (!integrity.ok) {
        throw Object.assign(new Error(integrity.message), {
          code: integrity.code,
        });
      }

      latestJob = emit('running', current, 'Salvando Markdown e assets');
      const itemOutputDir = item.outputDir ? resolveOutputDir(item.outputDir) : outputDir;
      mkdirSync(itemOutputDir, { recursive: true });
      const saved = writePayloadBundle(
        payloadWithFilename(collected.result.payload as AnyRecord, item.filename || null),
        itemOutputDir,
      );
      savedFiles.push({
        chatId: integrity.snapshot.chatId,
        title: integrity.snapshot.title || item.title || null,
        filePath: saved.filePath,
        filename: saved.filename,
        bytes: saved.bytes,
        overwritten: saved.overwritten,
        mediaFileCount: saved.mediaFileCount,
        mediaFailureCount: saved.mediaFailureCount,
        mediaBytes: saved.mediaBytes,
        dateCreated: integrity.snapshot.metadata.dateCreated || null,
        dateLastMessage: integrity.snapshot.metadata.dateLastMessage || null,
        adapter: collected.result.privateRead.adapter,
      });
      latestJob = emit('running', current, 'Markdown e assets salvos pela API privada');
    } catch (err) {
      failures.push(failureFromError(item, index + 1, err));
      latestJob = emit('running', current, 'Falha registrada; seguindo para o proximo chat');
    }

    if (delayMs > 0 && index < items.length - 1) await runtimeDeps.sleep(delayMs);
  }

  const finishedAt = runtimeDeps.now().toISOString();
  const status =
    failures.length === 0
      ? 'completed'
      : savedFiles.length > 0
        ? 'completed_with_errors'
        : 'failed';
  latestJob = emit(
    status,
    null,
    status === 'completed'
      ? 'Export privado concluido'
      : status === 'completed_with_errors'
        ? 'Export privado concluido com falhas'
        : 'Export privado falhou',
    finishedAt,
  );
  return latestJob;
};

export const summarizePrivateApiSelectedExportJob = (job: PrivateApiSelectedExportJob) => ({
  ok: job.status === 'completed',
  status: job.status,
  jobId: job.jobId,
  adapter: 'privateApiGeminiWebapi',
  outputDir: job.outputDir,
  requestedCount: job.requested,
  downloadedCount: job.successCount,
  failedCount: job.failureCount,
  files: job.savedFiles.map((file) => ({
    chatId: file.chatId,
    title: file.title,
    filePath: file.filePath,
    bytes: file.bytes,
    overwritten: file.overwritten,
    mediaFileCount: file.mediaFileCount,
    mediaFailureCount: file.mediaFailureCount,
    mediaBytes: file.mediaBytes,
    dateCreated: file.dateCreated,
    dateLastMessage: file.dateLastMessage,
  })),
  failures: job.failures,
});
