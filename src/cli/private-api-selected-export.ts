import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { planExportAdapters } from '../core/export-adapter-policy.js';
import { normalizeDirectReexportSelection } from '../mcp/direct-reexport-selection.js';
import { validateMcpExportPayloadBeforeWrite } from '../mcp/export-workflows.js';
import {
  runGeminiWebapiPythonListChats,
  type GeminiWebapiPythonReadChatInput,
  type GeminiWebapiPythonReadChatResult,
  runGeminiWebapiPythonReadChat,
} from '../mcp/gemini-webapi-python-adapter.js';
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
  python?: unknown;
  cookiesJson?: unknown;
  delayMs?: unknown;
  maxItems?: unknown;
  recent?: unknown;
  startIndex?: unknown;
  onProgress?: (job: PrivateApiSelectedExportJob) => void;
}>;

type PrivateApiSelectedExportDeps = Readonly<{
  runReadChat(input: GeminiWebapiPythonReadChatInput): Promise<GeminiWebapiPythonReadChatResult>;
  runListChats(input: {
    limit?: unknown;
    timeoutMs?: unknown;
    python?: unknown;
    cookiesJson?: unknown;
  }): Promise<AnyRecord>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}>;

const defaultDeps: PrivateApiSelectedExportDeps = {
  runReadChat: runGeminiWebapiPythonReadChat,
  runListChats: runGeminiWebapiPythonListChats,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
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

const writePayloadBundle = (payload: AnyRecord, outputDir: string) => {
  const markdown = writeMarkdownPayload(payload, outputDir);
  const mediaFiles = mediaFilesOf(payload).map((file) =>
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
    error: err instanceof Error ? err.message : String(record.message || err || 'erro sem detalhe'),
    code: stringOrNull(record.code) || null,
  };
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
  deps: PrivateApiSelectedExportDeps = defaultDeps,
): Promise<PrivateApiSelectedExportJob> => {
  let items = args.recent === true ? [] : normalizeItems(args);
  if (items.length === 0 && args.recent === true) {
    items = await listRecentItems(args, deps);
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
  const outputDir = resolveOutputDir(args.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const requested = items.length;
  const savedFiles: PrivateApiSelectedExportSavedFile[] = [];
  const failures: PrivateApiSelectedExportFailure[] = [];
  const startedAt = deps.now().toISOString();
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
      updatedAt: deps.now().toISOString(),
      finishedAt,
    });
    args.onProgress?.(job);
    return job;
  };

  let latestJob = emit('running', null, 'Preparando export privado');
  const readTimeoutMs = numberInRange(
    args.privateReadWaitMs ?? args.waitMs ?? args.timeoutMs,
    45_000,
    5_000,
    120_000,
  );
  const limit = numberInRange(args.limit, 200, 1, 2000);
  const delayMs = numberInRange(args.delayMs, 0, 0, 60_000);

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
      const readResult = await deps.runReadChat({
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
      if (!readResult.ok) {
        throw Object.assign(new Error(readResult.message), {
          code: readResult.code,
        });
      }

      latestJob = emit('running', current, 'Validando Markdown e datas');
      const collected = privateReadExportResultToCollectedPayload({
        activeClient: null,
        conversation: item,
        result: { ...readResult, adapter: 'privateApiGeminiWebapi' },
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

    if (delayMs > 0 && index < items.length - 1) await deps.sleep(delayMs);
  }

  const finishedAt = deps.now().toISOString();
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
