import { basename } from 'node:path';
import {
  buildExportDateImportActivityScanCandidates,
  buildExportDateImportBatchEvidence,
  createExportDateImportContext,
  enrichExportPayloadWithMetadataDates,
  mergeExportDateImportBatchEvidenceWithMatches,
  summarizeExportDateImportContext,
  type ExportDateImportBatchEntry,
  type ExportDateImportBatchEvidence,
  type ExportDateImportContext,
} from './export-metadata.js';
import type { MetadataEvidence } from '../core/types.js';

type RuntimeArgs = Record<string, any>;
type ActivityScanner = (args: RuntimeArgs) => Promise<RuntimeArgs>;
type SaveCollectedConversationPayload = (
  collected: RuntimeArgs,
  args?: RuntimeArgs,
) => Promise<RuntimeArgs>;

export const DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS = 45_000;
export const DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS = 8_000;

const normalizePositiveTimeoutMs = (
  value: unknown,
  fallback: number,
  max = 120_000,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const dateImportActivityWaitMs = (args: RuntimeArgs = {}): number =>
  normalizePositiveTimeoutMs(
    args.activityWaitMs ?? args.myActivityWaitMs ?? args.waitMs,
    DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS,
  );

const dateImportActivityPreLaunchWaitMs = (args: RuntimeArgs = {}): number =>
  normalizePositiveTimeoutMs(
    args.activityPreLaunchWaitMs ?? args.myActivityPreLaunchWaitMs ?? args.preLaunchWaitMs,
    DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS,
  );

export const dateImportToolProperties = () => ({
  takeout: {
    type: 'string',
    description:
      'Arquivo Google Takeout/My Activity (.zip, .html ou .json) usado como fonte offline; My Activity continua como fallback.',
  },
  useMyActivity: {
    type: 'boolean',
    description: 'Usa My Activity pela extensão para preencher datas. Default: true.',
  },
  noMyActivity: {
    type: 'boolean',
    description: 'Diagnóstico avançado: desliga o fallback My Activity.',
  },
});

const dateImportSourcePath = (args: RuntimeArgs = {}): string | null =>
  args.takeout || args.takeoutPath || args.metadataTakeout || null;

const booleanFlag = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  return null;
};

export const dateImportArgsFromSearchParams = (
  searchParams: { get(name: string): string | null },
  body: RuntimeArgs = {},
): RuntimeArgs => ({
  takeout: body.takeout || searchParams.get('takeout') || undefined,
  useMyActivity: booleanFlag(body.useMyActivity ?? searchParams.get('useMyActivity')),
  noMyActivity: booleanFlag(body.noMyActivity ?? searchParams.get('noMyActivity')),
});

export const shouldUseMyActivityForDateImport = (args: RuntimeArgs = {}): boolean => {
  if (booleanFlag(args.noMyActivity) === true) return false;
  if (booleanFlag(args.useMyActivity) === false) return false;
  return true;
};

export const hasDateImportSource = (args: RuntimeArgs = {}): boolean =>
  Boolean(dateImportSourcePath(args)) || shouldUseMyActivityForDateImport(args);

export const defaultDateImportSummary = (args: RuntimeArgs = {}): RuntimeArgs => {
  const sourceFile = dateImportSourcePath(args);
  const useMyActivity = shouldUseMyActivityForDateImport(args);
  return {
    enabled: Boolean(sourceFile) || useMyActivity,
    source: sourceFile
      ? useMyActivity
        ? 'takeout+my-activity'
        : 'takeout'
      : useMyActivity
        ? 'my-activity'
        : 'none',
    sourceFile: sourceFile ? basename(String(sourceFile)) : null,
    fallback: useMyActivity ? 'my-activity' : null,
    pending: Boolean(sourceFile) || useMyActivity,
  };
};

export const createExportDateImportContextForArgs = async (
  args: RuntimeArgs = {},
): Promise<ExportDateImportContext> => {
  if (args._exportDateImportContext) return args._exportDateImportContext;
  const context = createExportDateImportContext({
    takeoutPath: dateImportSourcePath(args),
    useMyActivity: shouldUseMyActivityForDateImport(args),
  });
  args._exportDateImportContext = context;
  return context;
};

export const summarizeExportDateImportContextForJob = async (
  context: ExportDateImportContext,
): Promise<ReturnType<typeof summarizeExportDateImportContext>> =>
  summarizeExportDateImportContext(context);

export const enrichExportPayloadWithDates = async ({
  payload,
  integrity,
  args,
}: RuntimeArgs): Promise<ReturnType<typeof enrichExportPayloadWithMetadataDates>> => {
  const context = await createExportDateImportContextForArgs(args);
  const groupedEvidence = args._exportDateImportGroupedEvidence?.get(
    String(integrity.snapshot?.chatId || '').toLowerCase(),
  );
  return enrichExportPayloadWithMetadataDates({ payload, integrity, context, groupedEvidence });
};

export const saveCollectedConversationPayloadRuntime = async (
  collected: RuntimeArgs,
  args: RuntimeArgs = {},
  deps: {
    summarizeClient(client: RuntimeArgs): RuntimeArgs;
    validateMcpExportPayload(payload: RuntimeArgs, input?: RuntimeArgs): Promise<RuntimeArgs>;
    writeExportPayloadBundle(payload: RuntimeArgs, options: RuntimeArgs): RuntimeArgs;
  },
): Promise<RuntimeArgs> => {
  let { integrity } = collected;
  const dateImport = await enrichExportPayloadWithDates({
    payload: collected.result.payload,
    integrity,
    args,
  });
  if (!dateImport.ok) {
    const error = new Error(dateImport.message);
    (error as RuntimeArgs).code = dateImport.code;
    (error as RuntimeArgs).data = {
      code: dateImport.code,
      dateImport: dateImport.receipt,
      evidence: dateImport.evidence,
    };
    throw error;
  }
  integrity = await deps.validateMcpExportPayload(dateImport.payload, {
    expectedChatId: collected.expectedChatId,
    requestedChatId: collected.requestedChatId,
  });
  if (!integrity.ok) {
    const error = new Error(integrity.message);
    (error as RuntimeArgs).code = integrity.code;
    (error as RuntimeArgs).data = integrity;
    throw error;
  }

  const saveStartedAt = Date.now();
  const saved = deps.writeExportPayloadBundle(dateImport.payload, { outputDir: args.outputDir });
  const saveFilesMs = Date.now() - saveStartedAt;
  const savedMediaBytes = Array.isArray(saved.mediaFiles)
    ? saved.mediaFiles.reduce((sum: number, file: RuntimeArgs) => sum + Number(file.bytes || 0), 0)
    : 0;
  const payloadMetrics = collected.result.payload?.metrics || {};
  const metrics = {
    version: 1,
    timings: {
      browserCommandMs: collected.browserCommandMs,
      saveFilesMs,
      ...(payloadMetrics.timings || {}),
    },
    counters: {
      ...(payloadMetrics.counters || {}),
      mediaFileCount: saved.mediaFileCount || 0,
      mediaFailureCount: saved.mediaFailureCount || 0,
      savedBytes: saved.bytes || 0,
      savedMediaBytes,
    },
    hydration: collected.result.payload?.hydration || null,
    navigation: collected.result.payload?.hydration?.navigation || null,
    media: payloadMetrics.media || null,
  };
  return {
    client: deps.summarizeClient(collected.activeClient),
    conversation: collected.result.conversation || collected.conversation,
    chatId: integrity.snapshot.chatId || collected.result.payload?.chatId || collected.conversation.chatId || null,
    title: integrity.snapshot.title || collected.result.payload?.title || collected.conversation.title || null,
    turns: integrity.assistantTurnCount,
    hydration: collected.result.payload?.hydration || null,
    returnedToOriginal: collected.result.returnedToOriginal ?? null,
    returnError: collected.result.returnError || null,
    integrity: {
      markdownHash: integrity.markdownHash,
      assistantTurnCount: integrity.assistantTurnCount,
      evidence: integrity.evidence,
      warnings: integrity.warnings,
    },
    dateImport: dateImport.receipt,
    metrics,
    ...saved,
  };
};

export const buildExportDateImportBatchEvidenceForPayloads = async (
  entries: ExportDateImportBatchEntry[],
  args: RuntimeArgs = {},
): Promise<ExportDateImportBatchEvidence> => {
  const context = await createExportDateImportContextForArgs(args);
  return buildExportDateImportBatchEvidence({ entries, context });
};

export const buildExportDateImportActivityCandidatesForPayloads = ({
  entries,
  groupedByKey,
}: {
  entries: ExportDateImportBatchEntry[];
  groupedByKey?: Map<string, any>;
}) => buildExportDateImportActivityScanCandidates({ entries, groupedByKey });

export const mergeExportDateImportBatchEvidenceWithActivityMatches = async ({
  entries,
  args = {},
  previous,
  matches,
}: {
  entries: ExportDateImportBatchEntry[];
  args?: RuntimeArgs;
  previous: ExportDateImportBatchEvidence;
  matches: MetadataEvidence[];
}): Promise<ExportDateImportBatchEvidence> => {
  const context = await createExportDateImportContextForArgs(args);
  return mergeExportDateImportBatchEvidenceWithMatches({ entries, context, previous, matches });
};

export const buildExportDateImportBatchEvidenceWithActivityFallback = async (
  entries: ExportDateImportBatchEntry[],
  args: RuntimeArgs = {},
  options: {
    scanActivity?: ActivityScanner;
    claimLabel?: string;
  } = {},
): Promise<ExportDateImportBatchEvidence> => {
  const batch = await buildExportDateImportBatchEvidenceForPayloads(entries, args);
  if (!shouldUseMyActivityForDateImport(args) || typeof options.scanActivity !== 'function') {
    return batch;
  }

  const candidates = buildExportDateImportActivityCandidatesForPayloads({
    entries,
    groupedByKey: batch.groupedByKey,
  });
  if (candidates.length === 0) return batch;

  const activity = await options.scanActivity({
    ...args,
    candidates,
    resume: args._exportDateImportActivityCheckpoint || null,
    openIfMissing: args.openMyActivityIfMissing !== false && args.openIfMissing !== false,
    openDetails: false,
    claimLabel: args.claimLabel || options.claimLabel,
    visualGroupTabId:
      args.visualGroupTabId ?? args.groupWithTabId ?? args._exportDateImportVisualGroupTabId,
    waitMs: dateImportActivityWaitMs(args),
    preLaunchWaitMs: dateImportActivityPreLaunchWaitMs(args),
  });
  const matches = Array.isArray(activity.matches) ? activity.matches : [];
  args._exportDateImportActivityCheckpoint =
    activity.checkpoint || args._exportDateImportActivityCheckpoint || null;
  args._exportDateImportActivitySummary = {
    attempted: true,
    candidates: candidates.length,
    matched: new Set(
      matches.map((match: RuntimeArgs) => String(match.chatId || '').toLowerCase()).filter(Boolean),
    ).size,
    loadedCardCount: activity.checkpoint?.loadedCardCount ?? null,
    checkpoint: activity.checkpoint || null,
    browserWake: activity.browserWake || null,
    tabClaimWarning: activity.tabClaimWarning || null,
  };
  return mergeExportDateImportBatchEvidenceWithActivityMatches({
    entries,
    args,
    previous: batch,
    matches,
  });
};

export const saveCollectedConversationPayloadViaDateImportBatch = async (
  collected: RuntimeArgs,
  args: RuntimeArgs = {},
  deps: {
    buildBatchEvidence: (
      entries: ExportDateImportBatchEntry[],
      args?: RuntimeArgs,
    ) => Promise<ExportDateImportBatchEvidence>;
    saveCollectedConversationPayload: SaveCollectedConversationPayload;
  },
): Promise<RuntimeArgs> => {
  if (!hasDateImportSource(args)) {
    return deps.saveCollectedConversationPayload(collected, args);
  }
  const chatId = String(
    collected.integrity?.snapshot?.chatId ||
      collected.result?.payload?.chatId ||
      collected.conversation?.chatId ||
      '',
  ).toLowerCase();
  const batch = await deps.buildBatchEvidence(
    [
      {
        key: chatId,
        payload: collected.result.payload,
        integrity: collected.integrity,
      },
    ],
    args,
  );
  args._exportDateImportGroupedEvidence = batch.groupedByKey;
  try {
    return await deps.saveCollectedConversationPayload(collected, args);
  } finally {
    delete args._exportDateImportGroupedEvidence;
    delete args._exportDateImportActivitySummary;
  }
};
