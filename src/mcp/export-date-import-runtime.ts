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
