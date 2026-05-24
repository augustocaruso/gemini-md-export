import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { buildMarkdownChatNote } from '../core/markdown-note.js';
import {
  groupMetadataEvidence,
  type GroupedMetadataEvidence,
} from '../core/metadata-evidence.js';
import {
  metadataCandidateHasCompleteResolvedDates,
  resolveMetadataDatesForCandidate,
} from '../core/metadata-date-resolution.js';
import type { IsoDateTime, MetadataEvidence } from '../core/types.js';
import { buildCanonicalFrontmatter } from '../core/yaml.js';
import {
  loadTakeoutSource,
  matchTakeoutSource,
  type LoadedTakeoutSource,
  type TakeoutCandidate,
} from '../takeout/takeout-adapter.js';
import type { BrowserExportPayload, McpExportValidation } from './export-workflows.js';

export type ExportDateImportDisabledContext = {
  enabled: false;
  source: 'none';
  requireCompleteDates: false;
};

export type ExportDateImportTakeoutContext = {
  enabled: true;
  source: 'takeout';
  fallback: 'my-activity' | null;
  requireCompleteDates: true;
  takeoutPath: string;
  takeout: LoadedTakeoutSource;
};

export type ExportDateImportActivityContext = {
  enabled: true;
  source: 'my-activity';
  requireCompleteDates: true;
};

export type ExportDateImportContext =
  | ExportDateImportDisabledContext
  | ExportDateImportTakeoutContext
  | ExportDateImportActivityContext;

export type ExportDateImportDisabledReceipt = {
  enabled: false;
  status: 'disabled';
  source: 'none';
  sourceFile: null;
  dateCreated: null;
  dateLastMessage: null;
  evidenceCount: 0;
  warnings: [];
};

export type ExportDateImportMatchedReceipt = {
  enabled: true;
  status: 'matched';
  source: 'takeout' | 'my-activity' | 'frontmatter';
  sourceFile: string | null;
  dateCreated: IsoDateTime;
  dateLastMessage: IsoDateTime;
  evidenceCount: number;
  warnings: string[];
  dateResolution: {
    chatShape: string;
    turnCount: number | null;
    hasCreatedEdge: boolean;
    hasLastMessageEdge: boolean;
    hasUnknownEvidence: boolean;
    unknownEvidencePolicy: string;
    warnings: string[];
  };
};

export type ExportDateImportUnresolvedReceipt = {
  enabled: true;
  status: 'partial' | 'unresolved';
  source: 'takeout' | 'my-activity';
  sourceFile: string | null;
  dateCreated: IsoDateTime | null;
  dateLastMessage: IsoDateTime | null;
  evidenceCount: number;
  warnings: string[];
  dateResolution: ExportDateImportMatchedReceipt['dateResolution'];
};

export type ExportDateImportReceipt =
  | ExportDateImportDisabledReceipt
  | ExportDateImportMatchedReceipt
  | ExportDateImportUnresolvedReceipt;

export type ExportDateImportEnrichment =
  | {
      ok: true;
      payload: BrowserExportPayload;
      receipt: ExportDateImportReceipt;
    }
  | {
      ok: false;
      code: 'metadata_unresolved';
      message: string;
      receipt: ExportDateImportUnresolvedReceipt;
      evidence: MetadataEvidence[];
    };

export type ExportDateImportBatchEntry = {
  key: string;
  payload: BrowserExportPayload;
  integrity: Extract<McpExportValidation, { ok: true }>;
};

export type ExportDateImportBatchEvidence = {
  enabled: boolean;
  candidates: number;
  source?: 'takeout' | 'my-activity';
  groupedByKey: Map<string, GroupedMetadataEvidence>;
};

const disabledReceipt: ExportDateImportDisabledReceipt = {
  enabled: false,
  status: 'disabled',
  source: 'none',
  sourceFile: null,
  dateCreated: null,
  dateLastMessage: null,
  evidenceCount: 0,
  warnings: [],
};

const markdownContentOf = (payload: BrowserExportPayload = {}): string => {
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.contentBase64 === 'string') {
    return Buffer.from(payload.contentBase64, 'base64').toString('utf-8');
  }
  return '';
};

const replaceMarkdownContent = (
  payload: BrowserExportPayload,
  content: string,
): BrowserExportPayload => {
  const next: BrowserExportPayload = { ...payload, content };
  delete next.contentBase64;
  return next;
};

const sourcePath = (value: string): string => resolve(String(value).replace(/^~(?=\/|$)/, homedir()));

export const createExportDateImportContext = ({
  takeoutPath = '',
  useMyActivity = false,
}: {
  takeoutPath?: string | null;
  useMyActivity?: boolean;
} = {}): ExportDateImportContext => {
  if (!takeoutPath) {
    if (useMyActivity) {
      return {
        enabled: true,
        source: 'my-activity',
        requireCompleteDates: true,
      };
    }
    return {
      enabled: false,
      source: 'none',
      requireCompleteDates: false,
    };
  }
  const resolved = sourcePath(takeoutPath);
  const takeout = loadTakeoutSource(resolved);
  if (takeout.itemsIndexed <= 0) {
    throw new Error(`Takeout nao contem eventos Gemini Apps indexaveis: ${takeout.sourceFile}.`);
  }
  return {
    enabled: true,
    source: 'takeout',
    fallback: useMyActivity ? 'my-activity' : null,
    requireCompleteDates: true,
    takeoutPath: resolved,
    takeout,
  };
};

export const summarizeExportDateImportContext = (
  context: ExportDateImportContext,
) => {
  if (!context.enabled) {
    return {
      enabled: false,
      source: 'none',
    };
  }
  return {
    enabled: true,
    source:
      context.source === 'takeout' && context.fallback === 'my-activity'
        ? 'takeout+my-activity'
        : context.source,
    primarySource: context.source,
    fallback:
      context.source === 'takeout'
        ? context.fallback
        : context.source === 'my-activity'
          ? 'my-activity'
          : null,
    requireCompleteDates: context.requireCompleteDates,
    sourceFile: context.source === 'takeout' ? context.takeout.sourceFile : null,
    sourceKind: context.source === 'takeout' ? context.takeout.sourceKind : 'browser-bridge',
    sourceEntries: context.source === 'takeout' ? context.takeout.sourceEntries : 0,
    itemsIndexed: context.source === 'takeout' ? context.takeout.itemsIndexed : 0,
  };
};

const evidenceForCandidate = (
  context: ExportDateImportContext,
  candidate: TakeoutCandidate,
): GroupedMetadataEvidence | undefined => {
  if (!context.enabled || context.source !== 'takeout') return undefined;
  const grouped = groupMetadataEvidence(matchTakeoutSource(context.takeout, [candidate]));
  return grouped.get(candidate.chatId.toLowerCase());
};

const noteAndCandidateForPayload = ({
  payload,
  integrity,
}: {
  payload: BrowserExportPayload;
  integrity: Extract<McpExportValidation, { ok: true }>;
}) => {
  const markdown = markdownContentOf(payload);
  const chatId = integrity.snapshot.chatId;
  const filename = String(payload.filename || `${chatId}.md`);
  const note = buildMarkdownChatNote({
    filePath: filename,
    relativePath: basename(filename),
    raw: markdown,
    fallbackChatId: chatId,
  });
  if (!note) return null;
  return {
    note,
    candidate: {
      chatId: String(note.chatId).toLowerCase(),
      turnCount: note.metadata.assistantTurnCount,
      scoring: note.scoring,
    } satisfies TakeoutCandidate,
  };
};

export const buildExportDateImportBatchCandidates = (
  entries: ExportDateImportBatchEntry[],
): Map<string, TakeoutCandidate> => {
  const candidatesByKey = new Map<string, TakeoutCandidate>();
  for (const entry of entries) {
    const parsed = noteAndCandidateForPayload(entry);
    if (parsed) candidatesByKey.set(entry.key, parsed.candidate);
  }
  return candidatesByKey;
};

export const buildExportDateImportActivityScanCandidates = ({
  entries,
  groupedByKey,
}: {
  entries: ExportDateImportBatchEntry[];
  groupedByKey?: Map<string, GroupedMetadataEvidence>;
}): TakeoutCandidate[] => {
  const candidates: TakeoutCandidate[] = [];
  for (const entry of entries) {
    const parsed = noteAndCandidateForPayload(entry);
    if (!parsed) continue;
    const { note, candidate } = parsed;
    const matched = groupedByKey?.get(entry.key) || groupedByKey?.get(candidate.chatId.toLowerCase());
    const complete = metadataCandidateHasCompleteResolvedDates(
      {
        chatId: candidate.chatId,
        turnCount: candidate.turnCount,
        dateCreated: note.metadata.dateCreated || null,
        dateLastMessage: note.metadata.dateLastMessage || null,
      },
      matched,
    );
    if (!complete) candidates.push(candidate);
  }
  return candidates;
};

export const buildExportDateImportBatchEvidenceFromMatches = ({
  entries,
  context,
  matches,
}: {
  entries: ExportDateImportBatchEntry[];
  context: ExportDateImportContext;
  matches: MetadataEvidence[];
}): ExportDateImportBatchEvidence => {
  const candidatesByKey = new Map<string, TakeoutCandidate>();
  for (const [key, candidate] of buildExportDateImportBatchCandidates(entries)) {
    candidatesByKey.set(key, candidate);
  }
  const grouped = groupMetadataEvidence(matches);
  const groupedByKey = new Map<string, GroupedMetadataEvidence>();
  for (const [key, candidate] of candidatesByKey.entries()) {
    const evidence = grouped.get(candidate.chatId.toLowerCase());
    if (evidence) groupedByKey.set(key, evidence);
  }
  return {
    enabled: true,
    candidates: candidatesByKey.size,
    source: context.enabled ? context.source : undefined,
    groupedByKey,
  };
};

export const buildExportDateImportBatchEvidence = ({
  entries,
  context,
}: {
  entries: ExportDateImportBatchEntry[];
  context: ExportDateImportContext;
}): ExportDateImportBatchEvidence => {
  if (!context.enabled) {
    return {
      enabled: false,
      candidates: 0,
      groupedByKey: new Map(),
    };
  }
  if (context.source === 'my-activity') {
    return buildExportDateImportBatchEvidenceFromMatches({
      entries,
      context,
      matches: [],
    });
  }
  const candidates = [...buildExportDateImportBatchCandidates(entries).values()];
  return buildExportDateImportBatchEvidenceFromMatches({
    entries,
    context,
    matches: matchTakeoutSource(context.takeout, candidates),
  });
};

export const mergeExportDateImportBatchEvidenceWithMatches = ({
  entries,
  context,
  previous,
  matches,
}: {
  entries: ExportDateImportBatchEntry[];
  context: ExportDateImportContext;
  previous: ExportDateImportBatchEvidence;
  matches: MetadataEvidence[];
}): ExportDateImportBatchEvidence => {
  const previousEvidence = Array.from(previous.groupedByKey.values()).flatMap(
    (grouped) => grouped.evidence,
  );
  return buildExportDateImportBatchEvidenceFromMatches({
    entries,
    context,
    matches: [...previousEvidence, ...matches],
  });
};

const receiptSourceFromEvidence = (
  context: ExportDateImportContext,
  evidence: MetadataEvidence[],
): ExportDateImportMatchedReceipt['source'] => {
  if (evidence.some((item) => item.source === 'my-activity-web')) return 'my-activity';
  if (evidence.length && context.enabled && context.source === 'takeout') return 'takeout';
  if (evidence.length && context.enabled && context.source === 'my-activity') return 'my-activity';
  return 'frontmatter';
};

const dateResolutionSummary = (
  resolution: ReturnType<typeof resolveMetadataDatesForCandidate>,
): ExportDateImportMatchedReceipt['dateResolution'] => ({
  chatShape: resolution.chatShape,
  turnCount: resolution.turnCount,
  hasCreatedEdge: resolution.hasCreatedEdge,
  hasLastMessageEdge: resolution.hasLastMessageEdge,
  hasUnknownEvidence: resolution.hasUnknownEvidence,
  unknownEvidencePolicy: resolution.unknownEvidencePolicy,
  warnings: resolution.warnings,
});

const buildMatchedReceipt = ({
  sourceFile,
  source,
  dateCreated,
  dateLastMessage,
  evidenceCount,
  warnings,
  dateResolution,
}: {
  sourceFile: string | null;
  source: ExportDateImportMatchedReceipt['source'];
  dateCreated: IsoDateTime;
  dateLastMessage: IsoDateTime;
  evidenceCount: number;
  warnings: string[];
  dateResolution: ExportDateImportMatchedReceipt['dateResolution'];
}): ExportDateImportMatchedReceipt => ({
  enabled: true,
  status: 'matched',
  source,
  sourceFile,
  dateCreated,
  dateLastMessage,
  evidenceCount,
  warnings,
  dateResolution,
});

const buildUnresolvedReceipt = ({
  sourceFile,
  source,
  status,
  dateCreated,
  dateLastMessage,
  evidenceCount,
  warnings,
  dateResolution,
}: {
  sourceFile: string | null;
  source: ExportDateImportUnresolvedReceipt['source'];
  status: ExportDateImportUnresolvedReceipt['status'];
  dateCreated: IsoDateTime | null;
  dateLastMessage: IsoDateTime | null;
  evidenceCount: number;
  warnings: string[];
  dateResolution: ExportDateImportUnresolvedReceipt['dateResolution'];
}): ExportDateImportUnresolvedReceipt => ({
  enabled: true,
  status,
  source,
  sourceFile,
  dateCreated,
  dateLastMessage,
  evidenceCount,
  warnings,
  dateResolution,
});

export const enrichExportPayloadWithMetadataDates = ({
  payload,
  context,
  integrity,
  groupedEvidence,
}: {
  payload: BrowserExportPayload;
  context: ExportDateImportContext;
  integrity: Extract<McpExportValidation, { ok: true }>;
  groupedEvidence?: GroupedMetadataEvidence;
}): ExportDateImportEnrichment => {
  if (!context.enabled) {
    return { ok: true, payload, receipt: disabledReceipt };
  }

  const chatId = integrity.snapshot.chatId;
  const parsed = noteAndCandidateForPayload({ payload, integrity });
  if (!parsed) {
    const dateResolution = {
      chatShape: 'unknown_turn_count',
      turnCount: null,
      hasCreatedEdge: false,
      hasLastMessageEdge: false,
      hasUnknownEvidence: false,
      unknownEvidencePolicy: 'not_used',
      warnings: ['metadata_candidate_unreadable'],
    };
    const receipt = buildUnresolvedReceipt({
      sourceFile: context.source === 'takeout' ? context.takeout.sourceFile : null,
      source: context.source,
      status: 'unresolved',
      dateCreated: null,
      dateLastMessage: null,
      evidenceCount: 0,
      warnings: ['metadata_candidate_unreadable'],
      dateResolution,
    });
    return {
      ok: false,
      code: 'metadata_unresolved',
      message: `Exportacao abortada: nao consegui montar candidato de datas para ${String(chatId)}. Nenhum arquivo foi salvo.`,
      receipt,
      evidence: [],
    };
  }
  const { note, candidate } = parsed;

  const grouped = groupedEvidence || evidenceForCandidate(context, candidate);
  const evidence = grouped?.evidence || [];
  const resolution = resolveMetadataDatesForCandidate({
    candidate,
    evidence,
    existingDates: {
      dateCreated: note.metadata.dateCreated || null,
      dateLastMessage: note.metadata.dateLastMessage || null,
    },
  });
  const resolutionSummary = dateResolutionSummary(resolution);
  if (resolution.status !== 'matched' || !resolution.dateCreated || !resolution.dateLastMessage) {
    const unresolvedStatus = resolution.status === 'partial' ? 'partial' : 'unresolved';
    const receipt = buildUnresolvedReceipt({
      sourceFile: context.source === 'takeout' ? context.takeout.sourceFile : null,
      source: context.source,
      status: unresolvedStatus,
      dateCreated: resolution.dateCreated,
      dateLastMessage: resolution.dateLastMessage,
      evidenceCount: evidence.length,
      warnings: resolution.warnings,
      dateResolution: resolutionSummary,
    });
    return {
      ok: false,
      code: 'metadata_unresolved',
      message:
        `Exportacao abortada: nao consegui resolver date_created/date_last_message para ${String(note.chatId)} ` +
        `usando ${context.source === 'takeout' ? context.takeout.sourceFile : 'My Activity'}. Nenhum arquivo foi salvo.`,
      receipt,
      evidence,
    };
  }

  const updatedFrontmatter = buildCanonicalFrontmatter(note, {
    dateCreated: resolution.dateCreated,
    dateLastMessage: resolution.dateLastMessage,
  });
  const updatedMarkdown = updatedFrontmatter + note.body.replace(/^\n+/, '');
  return {
    ok: true,
    payload: replaceMarkdownContent(payload, updatedMarkdown),
    receipt: buildMatchedReceipt({
      sourceFile: context.source === 'takeout' ? context.takeout.sourceFile : null,
      source: receiptSourceFromEvidence(context, evidence),
      dateCreated: resolution.dateCreated,
      dateLastMessage: resolution.dateLastMessage,
      evidenceCount: evidence.length,
      warnings: resolution.warnings,
      dateResolution: resolutionSummary,
    }),
  };
};
