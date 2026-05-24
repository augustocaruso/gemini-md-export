import { portableIsoSeconds } from './date.js';
import type { ChatId, IsoDateTime, MetadataEvidence } from './types.js';

export type CreatedDateEvidence = Omit<MetadataEvidence, 'date' | 'dateKind'> & {
  date: IsoDateTime;
  dateKind: 'created';
};

export type LastMessageDateEvidence = Omit<MetadataEvidence, 'date' | 'dateKind'> & {
  date: IsoDateTime;
  dateKind: 'last_message';
};

export type UnknownDateEvidence = Omit<MetadataEvidence, 'date' | 'dateKind'> & {
  date: IsoDateTime;
  dateKind: 'unknown';
};

export type EdgeDateEvidence = CreatedDateEvidence | LastMessageDateEvidence;
export type ResolvedDateEvidence = EdgeDateEvidence | UnknownDateEvidence;

export type SingleTurnMetadataDateCandidate = {
  chatId: string;
  chatShape: 'single_turn';
  turnCount: 1;
};

export type MultiTurnMetadataDateCandidate = {
  chatId: string;
  chatShape: 'multi_turn';
  turnCount: number;
};

export type UnknownTurnCountMetadataDateCandidate = {
  chatId: string;
  chatShape: 'unknown_turn_count';
  turnCount: null;
};

export type MetadataDateCandidate =
  | SingleTurnMetadataDateCandidate
  | MultiTurnMetadataDateCandidate
  | UnknownTurnCountMetadataDateCandidate;

export type CompleteSingleTurnMetadataDates = {
  dateCreated: IsoDateTime;
  dateLastMessage: IsoDateTime;
  usedEvidence: {
    created: ResolvedDateEvidence;
    lastMessage: ResolvedDateEvidence;
  };
  unknownEvidencePolicy: 'not_used' | 'used_for_single_turn';
};

export type CompleteMultiTurnMetadataDates = {
  dateCreated: IsoDateTime;
  dateLastMessage: IsoDateTime;
  usedEvidence: {
    created: CreatedDateEvidence;
    lastMessage: LastMessageDateEvidence;
  };
  unknownEvidencePolicy: 'not_used';
};

export type MetadataDateResolutionStatus = 'matched' | 'partial' | 'unresolved';

export type MetadataDateResolution = {
  status: MetadataDateResolutionStatus;
  dateCreated: IsoDateTime | null;
  dateLastMessage: IsoDateTime | null;
  chatShape: MetadataDateCandidate['chatShape'];
  turnCount: number | null;
  hasCreatedEdge: boolean;
  hasLastMessageEdge: boolean;
  hasUnknownEvidence: boolean;
  unknownEvidencePolicy:
    | 'not_used'
    | 'used_for_single_turn'
    | 'ignored_for_multi_turn'
    | 'ambiguous_for_single_turn';
  warnings: string[];
  complete: CompleteSingleTurnMetadataDates | CompleteMultiTurnMetadataDates | null;
};

export type MetadataDateCandidateInput = {
  chatId: string;
  turnCount?: number | null;
};

export type ExistingMetadataDateInput = {
  dateCreated?: unknown;
  dateLastMessage?: unknown;
};

export type MetadataDateEvidenceInput =
  | {
      chatId?: ChatId | string;
      source?: MetadataEvidence['source'] | string | null;
      dateKind?: MetadataEvidence['dateKind'] | string | null;
      kind?: string | null;
      date?: unknown;
      confidence?: MetadataEvidence['confidence'] | null;
      score?: number | null;
      textHash?: string | null;
      sampleHash?: string | null;
      sampleLength?: number | null;
      warnings?: string[] | null;
    }
  | null
  | undefined;

const sortDates = <T extends { date: IsoDateTime }>(items: T[]): T[] =>
  [...items].sort((a, b) => String(a.date).localeCompare(String(b.date)));

const evidenceScore = (item: { score?: number | null }): number => {
  const score = Number(item.score);
  return Number.isFinite(score) ? score : 0;
};

const bestUniqueEdgeEvidence = <T extends EdgeDateEvidence>(
  items: T[],
  warningCode: string,
  warnings: string[],
): T | null => {
  if (!items.length) return null;
  const sorted = [...items].sort(
    (a, b) => evidenceScore(b) - evidenceScore(a) || String(a.date).localeCompare(String(b.date)),
  );
  const topScore = evidenceScore(sorted[0]);
  const topItems = sorted.filter((item) => Math.abs(evidenceScore(item) - topScore) < 0.0001);
  const topDates = Array.from(new Set(topItems.map((item) => item.date)));
  if (topDates.length === 1) {
    return sortDates(topItems.filter((item) => item.date === topDates[0]))[0] || null;
  }
  warnings.push(warningCode);
  return null;
};

const statusForDates = (
  dateCreated: IsoDateTime | null,
  dateLastMessage: IsoDateTime | null,
): MetadataDateResolutionStatus => {
  if (dateCreated && dateLastMessage) return 'matched';
  return dateCreated || dateLastMessage ? 'partial' : 'unresolved';
};

export const metadataDateCandidateFor = (
  candidate: MetadataDateCandidateInput,
): MetadataDateCandidate => {
  const turnCount =
    Number.isFinite(candidate.turnCount) && Number(candidate.turnCount) >= 0
      ? Number(candidate.turnCount)
      : null;
  if (turnCount === 1) {
    return {
      chatId: candidate.chatId,
      chatShape: 'single_turn',
      turnCount: 1,
    };
  }
  if (turnCount === null) {
    return {
      chatId: candidate.chatId,
      chatShape: 'unknown_turn_count',
      turnCount: null,
    };
  }
  return {
    chatId: candidate.chatId,
    chatShape: 'multi_turn',
    turnCount,
  };
};

const normalizeEvidenceDateKind = (
  item: MetadataDateEvidenceInput,
): ResolvedDateEvidence['dateKind'] => {
  const kind = String(item?.dateKind || item?.kind || 'unknown');
  return kind === 'created' || kind === 'last_message' ? kind : 'unknown';
};

export const normalizeDateEvidence = (
  item: MetadataDateEvidenceInput,
): ResolvedDateEvidence | null => {
  const date = portableIsoSeconds(item?.date);
  if (!item || !date) return null;
  const dateKind = normalizeEvidenceDateKind(item);
  const evidence = {
    ...item,
    chatId: item.chatId,
    source: (item.source || 'takeout-html') as MetadataEvidence['source'],
    kind: item.kind || dateKind,
    dateKind,
    confidence: item.confidence || 'strong',
    date,
    score: item.score,
    warnings: item.warnings || [],
  };
  return evidence as ResolvedDateEvidence;
};

const isResolvedDateEvidence = (item: ResolvedDateEvidence | null): item is ResolvedDateEvidence =>
  Boolean(item);

const frontmatterEvidence = ({
  chatId,
  date,
  dateKind,
}: {
  chatId: string;
  date: IsoDateTime;
  dateKind: EdgeDateEvidence['dateKind'];
}): EdgeDateEvidence => ({
  chatId: chatId.toLowerCase() as ChatId,
  source: 'frontmatter',
  kind: dateKind,
  dateKind,
  confidence: 'strong',
  date,
  score: 1,
  warnings: [],
});

export const resolveMetadataDatesForCandidate = ({
  candidate,
  evidence = [],
  existingDates = {},
}: {
  candidate: MetadataDateCandidateInput;
  evidence?: MetadataDateEvidenceInput[];
  existingDates?: ExistingMetadataDateInput;
}): MetadataDateResolution => {
  const shapedCandidate = metadataDateCandidateFor(candidate);
  const normalizedEvidence = evidence.map(normalizeDateEvidence).filter(isResolvedDateEvidence);
  const createdEvidence: CreatedDateEvidence[] = [];
  const lastMessageEvidence: LastMessageDateEvidence[] = [];
  const unknownEvidence: UnknownDateEvidence[] = [];

  const existingCreated = portableIsoSeconds(existingDates.dateCreated);
  const existingLastMessage = portableIsoSeconds(existingDates.dateLastMessage);
  if (existingCreated) {
    createdEvidence.push(
      frontmatterEvidence({
        chatId: candidate.chatId,
        date: existingCreated,
        dateKind: 'created',
      }) as CreatedDateEvidence,
    );
  }
  if (existingLastMessage) {
    lastMessageEvidence.push(
      frontmatterEvidence({
        chatId: candidate.chatId,
        date: existingLastMessage,
        dateKind: 'last_message',
      }) as LastMessageDateEvidence,
    );
  }

  for (const item of normalizedEvidence) {
    if (item.dateKind === 'created') createdEvidence.push(item);
    else if (item.dateKind === 'last_message') lastMessageEvidence.push(item);
    else unknownEvidence.push(item);
  }

  const warnings: string[] = [];
  const firstCreated =
    shapedCandidate.chatShape === 'single_turn'
      ? sortDates(createdEvidence)[0] || null
      : bestUniqueEdgeEvidence(
          createdEvidence,
          'created_date_ambiguous_for_non_single_turn',
          warnings,
        );
  const lastMessage =
    shapedCandidate.chatShape === 'single_turn'
      ? sortDates(lastMessageEvidence).at(-1) || null
      : bestUniqueEdgeEvidence(
          lastMessageEvidence,
          'last_message_date_ambiguous_for_non_single_turn',
          warnings,
        );
  let dateCreated = firstCreated?.date || null;
  let dateLastMessage = lastMessage?.date || null;
  let unknownEvidencePolicy: MetadataDateResolution['unknownEvidencePolicy'] = 'not_used';
  let singleTurnSharedEvidence: ResolvedDateEvidence | null = null;

  if (shapedCandidate.chatShape === 'single_turn' && (!dateCreated || !dateLastMessage)) {
    const explicitEdges = sortDates([...createdEvidence, ...lastMessageEvidence]);
    const explicitEdgeDates = Array.from(new Set(explicitEdges.map((item) => item.date)));
    const unknownDates = Array.from(new Set(sortDates(unknownEvidence).map((item) => item.date)));
    if (explicitEdgeDates.length === 1) {
      singleTurnSharedEvidence = explicitEdges.find((item) => item.date === explicitEdgeDates[0]) || null;
      if (!dateCreated) dateCreated = explicitEdgeDates[0];
      if (!dateLastMessage) dateLastMessage = explicitEdgeDates[0];
    } else if (unknownDates.length === 1 && explicitEdgeDates.length === 0) {
      singleTurnSharedEvidence = unknownEvidence.find((item) => item.date === unknownDates[0]) || null;
      if (!dateCreated) dateCreated = unknownDates[0];
      if (!dateLastMessage) dateLastMessage = unknownDates[0];
      unknownEvidencePolicy = 'used_for_single_turn';
    } else if (unknownDates.length > 1 || explicitEdgeDates.length > 1) {
      unknownEvidencePolicy = 'ambiguous_for_single_turn';
      warnings.push('unknown_date_ambiguous_for_single_turn');
    }
  } else if (unknownEvidence.length) {
    unknownEvidencePolicy = 'ignored_for_multi_turn';
    warnings.push('unknown_date_ignored_for_non_single_turn');
  }

  if (dateCreated && dateLastMessage && dateCreated > dateLastMessage) {
    warnings.push('date_created_after_date_last_message');
    dateCreated = null;
    dateLastMessage = null;
  }

  const status = statusForDates(dateCreated, dateLastMessage);
  let complete: MetadataDateResolution['complete'] = null;
  if (dateCreated && dateLastMessage && shapedCandidate.chatShape === 'single_turn') {
    const createdUsed = firstCreated || singleTurnSharedEvidence;
    const lastMessageUsed = lastMessage || singleTurnSharedEvidence;
    if (createdUsed && lastMessageUsed) {
      complete = {
        dateCreated,
        dateLastMessage,
        usedEvidence: {
          created: createdUsed,
          lastMessage: lastMessageUsed,
        },
        unknownEvidencePolicy:
          unknownEvidencePolicy === 'used_for_single_turn' ? 'used_for_single_turn' : 'not_used',
      };
    }
  } else if (dateCreated && dateLastMessage && firstCreated && lastMessage) {
    complete = {
      dateCreated,
      dateLastMessage,
      usedEvidence: {
        created: firstCreated,
        lastMessage,
      },
      unknownEvidencePolicy: 'not_used',
    };
  }

  return {
    status,
    dateCreated,
    dateLastMessage,
    chatShape: shapedCandidate.chatShape,
    turnCount: shapedCandidate.turnCount,
    hasCreatedEdge: createdEvidence.length > 0,
    hasLastMessageEdge: lastMessageEvidence.length > 0,
    hasUnknownEvidence: unknownEvidence.length > 0,
    unknownEvidencePolicy,
    warnings,
    complete,
  };
};

export const metadataCandidateHasCompleteResolvedDates = (
  candidate: MetadataDateCandidateInput & ExistingMetadataDateInput,
  match:
    | (ExistingMetadataDateInput & {
        evidence?: MetadataDateEvidenceInput[];
      })
    | null
    | undefined,
): boolean => {
  const matchHasEvidence = Boolean((match?.evidence || []).length);
  return resolveMetadataDatesForCandidate({
    candidate,
    evidence: match?.evidence || [],
    existingDates: {
      dateCreated: candidate.dateCreated || (!matchHasEvidence ? match?.dateCreated : null),
      dateLastMessage: candidate.dateLastMessage || (!matchHasEvidence ? match?.dateLastMessage : null),
    },
  }).status === 'matched';
};

export const filterCandidatesMissingResolvedMetadataDates = <
  T extends MetadataDateCandidateInput & ExistingMetadataDateInput,
>(
  candidates: T[],
  groupedMatches: Map<
    string,
    ExistingMetadataDateInput & {
      evidence?: MetadataDateEvidenceInput[];
    }
  >,
): T[] =>
  candidates.filter(
    (candidate) =>
      !metadataCandidateHasCompleteResolvedDates(candidate, groupedMatches.get(candidate.chatId)),
  );
