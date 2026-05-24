import { portableIsoSeconds } from './date.js';
import {
  buildMetadataBackfillContract,
  metadataBackfillStatusForDates,
  summarizeMetadataBackfillItems,
  type MetadataBackfillDatePair,
  type MetadataBackfillItemStatus,
} from './metadata-backfill-contract.js';
import {
  resolveMetadataDatesForCandidate,
  type MetadataDateResolution,
} from './metadata-date-resolution.js';
import { hashText } from './text-hash.js';
import {
  diagnoseRawExportAgainstTakeout,
  type RawExportDiagnostic,
} from '../takeout/takeout-diagnostics.js';

type EvidenceItemLike = {
  kind?: string | null;
  dateKind?: string | null;
  date?: string | null;
  score?: number | null;
  source?: string | null;
  textHash?: string | null;
  sampleHash?: string | null;
  sampleLength?: number | null;
};

type GroupedMatchLike = MetadataBackfillDatePair & {
  evidence?: EvidenceItemLike[];
};

export type MetadataBackfillCandidateForReport = MetadataBackfillDatePair & {
  chatId: string;
  relativePath: string;
  dateExported?: string | null;
  turnCount?: number | null;
  attachmentCount?: number | null;
  scoring: {
    title?: string;
    firstPrompt?: string;
    lastPrompt?: string;
    firstAssistant?: string;
    lastAssistant?: string;
    assistantSamples?: string[];
  };
};

export type MetadataBackfillReportItem = {
  chatId: string;
  file: string;
  status: MetadataBackfillItemStatus;
  dateCreated: string | null;
  dateLastMessage: string | null;
  dateExported: string | null;
  turnCount: number | null | undefined;
  attachmentCount: number;
  candidateHash: string;
  dateResolution: {
    chatShape: MetadataDateResolution['chatShape'];
    turnCount: number | null;
    hasCreatedEdge: boolean;
    hasLastMessageEdge: boolean;
    hasUnknownEvidence: boolean;
    unknownEvidencePolicy: MetadataDateResolution['unknownEvidencePolicy'];
    warnings: string[];
  };
  evidence: Array<{
    kind: string;
    dateKind: string;
    date: string | null;
    score: number | null;
    source: string | null;
    textHash: string | null;
    sampleHash: string | null;
    sampleLength: number | null;
  }>;
  diagnostic?: RawExportDiagnostic;
};

const buildReportItem = (
  candidate: MetadataBackfillCandidateForReport,
  status: MetadataBackfillItemStatus,
  dates: Required<Pick<MetadataBackfillReportItem, 'dateCreated' | 'dateLastMessage'>>,
  dateResolution: MetadataDateResolution,
  evidence: EvidenceItemLike[] = [],
  diagnostic: RawExportDiagnostic | null = null,
): MetadataBackfillReportItem => ({
  chatId: candidate.chatId,
  file: candidate.relativePath,
  status,
  dateCreated: dates.dateCreated,
  dateLastMessage: dates.dateLastMessage,
  dateExported: portableIsoSeconds(candidate.dateExported) || null,
  turnCount: candidate.turnCount,
  attachmentCount: candidate.attachmentCount || 0,
  candidateHash: hashText(
    [
      candidate.scoring.firstPrompt,
      candidate.scoring.lastPrompt,
      candidate.scoring.firstAssistant,
      candidate.scoring.lastAssistant,
      ...(candidate.scoring.assistantSamples || []),
    ].join('\n'),
  ),
  dateResolution: {
    chatShape: dateResolution.chatShape,
    turnCount: dateResolution.turnCount,
    hasCreatedEdge: dateResolution.hasCreatedEdge,
    hasLastMessageEdge: dateResolution.hasLastMessageEdge,
    hasUnknownEvidence: dateResolution.hasUnknownEvidence,
    unknownEvidencePolicy: dateResolution.unknownEvidencePolicy,
    warnings: dateResolution.warnings,
  },
  evidence: evidence.map((item) => ({
    kind: item.kind || 'unknown',
    dateKind: item.dateKind || item.kind || 'unknown',
    date: item.date || null,
    score: item.score ?? null,
    source: item.source || null,
    textHash: item.textHash || null,
    sampleHash: item.sampleHash || null,
    sampleLength: item.sampleLength || null,
  })),
  ...(diagnostic ? { diagnostic } : {}),
});

const diagnosticSummary = (diagnostics: Map<string, RawExportDiagnostic>) => ({
  enabled: true as const,
  diagnosed: diagnostics.size,
  byCode: Array.from(diagnostics.values()).reduce<Record<string, number>>((acc, diagnostic) => {
    acc[diagnostic.code] = (acc[diagnostic.code] || 0) + 1;
    return acc;
  }, {}),
});

export const buildMetadataBackfillReportState = ({
  candidates,
  groupedMatches,
  filesRewritten,
  takeoutPath = '',
  activityError = null,
}: {
  candidates: MetadataBackfillCandidateForReport[];
  groupedMatches: Map<string, GroupedMatchLike>;
  filesRewritten: number;
  takeoutPath?: string;
  activityError?: { code?: string | null; message?: string | null } | null;
}) => {
  let rawExportDiagnostics = new Map<string, RawExportDiagnostic>();
  if (takeoutPath) {
    const pendingForDiagnostics = candidates.filter((candidate) => {
      const match = groupedMatches.get(candidate.chatId);
      return (
        resolveMetadataDatesForCandidate({
          candidate,
          evidence: match?.evidence || [],
          existingDates: {
            dateCreated: candidate.dateCreated || null,
            dateLastMessage: candidate.dateLastMessage || null,
          },
        }).status !== 'matched'
      );
    });
    if (pendingForDiagnostics.length) {
      rawExportDiagnostics = diagnoseRawExportAgainstTakeout({
        takeoutPath,
        pendingCandidates: pendingForDiagnostics,
        allCandidates: candidates,
      });
    }
  }

  const items = candidates.map((candidate) => {
    const match = groupedMatches.get(candidate.chatId);
    const dateResolution = resolveMetadataDatesForCandidate({
      candidate,
      evidence: match?.evidence || [],
      existingDates: {
        dateCreated: candidate.dateCreated || null,
        dateLastMessage: candidate.dateLastMessage || null,
      },
    });
    const dates = {
      dateCreated: portableIsoSeconds(dateResolution.dateCreated) || null,
      dateLastMessage: portableIsoSeconds(dateResolution.dateLastMessage) || null,
    };
    const baseStatus = metadataBackfillStatusForDates(dates);
    const diagnostic =
      baseStatus !== 'matched' ? rawExportDiagnostics.get(candidate.chatId) || null : null;
    const status = diagnostic
      ? diagnostic.status === 'takeout_source_gap'
        ? 'source_gap'
        : diagnostic.status === 'takeout_source_mismatch'
          ? 'source_mismatch'
          : 'export_error'
      : baseStatus;
    return buildReportItem(
      candidate,
      status,
      dates,
      dateResolution,
      match?.evidence || [],
      diagnostic,
    );
  });
  const summary = summarizeMetadataBackfillItems({
    totalChats: candidates.length,
    filesRewritten,
    items,
  });
  const contract = buildMetadataBackfillContract({ summary, items, activityError });
  return {
    items,
    summary,
    contract,
    rawExportDiagnostics: takeoutPath
      ? diagnosticSummary(rawExportDiagnostics)
      : { enabled: false as const },
  };
};
