import { portableIsoSeconds } from './date.js';

export type MetadataBackfillItemStatus =
  | 'matched'
  | 'partial'
  | 'unresolved'
  | 'ambiguous'
  | 'export_error'
  | 'source_mismatch'
  | 'source_gap';

export type MetadataBackfillContractCode =
  | 'metadata_unresolved'
  | 'metadata_ambiguous'
  | 'takeout_source_mismatch'
  | 'raw_export_suspected'
  | 'takeout_source_gap'
  | 'activity_scan_failed';

export type MetadataBackfillReportItemLike = {
  chatId: string;
  status: MetadataBackfillItemStatus;
};

export type MetadataBackfillDatePair = {
  dateCreated?: unknown;
  dateLastMessage?: unknown;
};

export type CompleteMetadataBackfillContract = {
  ok: true;
  status: 'complete';
  code: null;
  message: string;
  unresolvedChatIds: [];
};

export type BlockedMetadataBackfillContract = {
  ok: false;
  status: 'blocked';
  code: MetadataBackfillContractCode;
  message: string;
  unresolvedChatIds: string[];
};

export type CompleteMetadataBackfillSummary = {
  totalChats: number;
  filesRewritten: number;
  datesMatched: number;
  matched: number;
  partial: 0;
  unresolved: 0;
  ambiguous: 0;
  exportErrors: 0;
  sourceMismatches: 0;
  sourceGaps: 0;
  updated: number;
  complete: true;
  contractStatus: 'complete';
};

export type BlockedMetadataBackfillSummary = {
  totalChats: number;
  filesRewritten: number;
  datesMatched: number;
  matched: number;
  partial: number;
  unresolved: number;
  ambiguous: number;
  exportErrors: number;
  sourceMismatches: number;
  sourceGaps: number;
  updated: number;
  complete: false;
  contractStatus: 'blocked';
};

export type MetadataBackfillSummary =
  | CompleteMetadataBackfillSummary
  | BlockedMetadataBackfillSummary;

export type CompleteMetadataBackfillReport = {
  ok: true;
  contract: CompleteMetadataBackfillContract;
  summary: CompleteMetadataBackfillSummary;
};

export type BlockedMetadataBackfillReport = {
  ok: false;
  contract: BlockedMetadataBackfillContract;
  summary: BlockedMetadataBackfillSummary;
};

export type MetadataBackfillReport = CompleteMetadataBackfillReport | BlockedMetadataBackfillReport;

const plural = (count: number, singular: string, pluralText: string): string =>
  count === 1 ? singular : pluralText;

export const summarizeMetadataBackfillItems = ({
  totalChats,
  filesRewritten,
  items,
}: {
  totalChats: number;
  filesRewritten: number;
  items: MetadataBackfillReportItemLike[];
}): MetadataBackfillSummary => {
  const matched = items.filter((item) => item.status === 'matched').length;
  const partial = items.filter((item) => item.status === 'partial').length;
  const unresolved = items.filter((item) => item.status === 'unresolved').length;
  const ambiguous = items.filter((item) => item.status === 'ambiguous').length;
  const exportErrors = items.filter((item) => item.status === 'export_error').length;
  const sourceMismatches = items.filter((item) => item.status === 'source_mismatch').length;
  const sourceGaps = items.filter((item) => item.status === 'source_gap').length;
  const pending = partial + unresolved + ambiguous + exportErrors + sourceMismatches + sourceGaps;
  const base = {
    totalChats,
    filesRewritten,
    datesMatched: matched,
    matched,
    partial,
    unresolved,
    ambiguous,
    exportErrors,
    sourceMismatches,
    sourceGaps,
    updated: filesRewritten,
  };
  if (pending === 0) {
    return {
      ...base,
      partial: 0,
      unresolved: 0,
      ambiguous: 0,
      exportErrors: 0,
      sourceMismatches: 0,
      sourceGaps: 0,
      complete: true,
      contractStatus: 'complete',
    };
  }
  return {
    ...base,
    complete: false,
    contractStatus: 'blocked',
  };
};

export const buildMetadataBackfillContract = ({
  summary,
  items,
  activityError = null,
}: {
  summary: MetadataBackfillSummary;
  items: MetadataBackfillReportItemLike[];
  activityError?: { code?: string | null; message?: string | null } | null;
}): CompleteMetadataBackfillContract | BlockedMetadataBackfillContract => {
  if (summary.complete) {
    return {
      ok: true,
      status: 'complete',
      code: null,
      message: 'Todos os chats têm datas completas.',
      unresolvedChatIds: [],
    };
  }

  const pendingItems = items.filter((item) => item.status !== 'matched');
  const pendingCount = pendingItems.length;
  const hasAmbiguous = pendingItems.some((item) => item.status === 'ambiguous');
  const hasUnresolved = pendingItems.some(
    (item) => item.status === 'unresolved' || item.status === 'partial',
  );
  const hasExportError = pendingItems.some((item) => item.status === 'export_error');
  const hasSourceMismatch = pendingItems.some((item) => item.status === 'source_mismatch');
  const hasSourceGap = pendingItems.some((item) => item.status === 'source_gap');
  const code: MetadataBackfillContractCode = activityError
    ? 'activity_scan_failed'
    : hasUnresolved
      ? 'metadata_unresolved'
      : hasAmbiguous
        ? 'metadata_ambiguous'
        : hasSourceMismatch
          ? 'takeout_source_mismatch'
          : hasExportError
            ? 'raw_export_suspected'
            : hasSourceGap
              ? 'takeout_source_gap'
              : 'metadata_unresolved';
  const message = hasSourceMismatch
    ? `${summary.sourceMismatches} ${plural(summary.sourceMismatches, 'chat parece', 'chats parecem')} nao pertencer ao Takeout informado; use a mesma conta/perfil para Takeout e export web.`
    : hasExportError && hasSourceGap
      ? `${summary.exportErrors} ${plural(summary.exportErrors, 'chat parece', 'chats parecem')} ter export raw inconsistente; ${summary.sourceGaps} ${plural(summary.sourceGaps, 'chat nao aparece', 'chats nao aparecem')} no Takeout por falta de atividade do usuario.`
      : code === 'raw_export_suspected'
        ? `${pendingCount} ${plural(pendingCount, 'chat parece', 'chats parecem')} ter export raw inconsistente.`
        : code === 'takeout_source_gap'
          ? `${pendingCount} ${plural(pendingCount, 'chat nao aparece', 'chats nao aparecem')} no Takeout por falta de atividade do usuario.`
          : `${pendingCount} ${plural(pendingCount, 'chat', 'chats')} sem datas completas.`;
  return {
    ok: false,
    status: 'blocked',
    code,
    message,
    unresolvedChatIds: pendingItems.map((item) => item.chatId).sort(),
  };
};

export const metadataBackfillStatusForDates = (
  dates: MetadataBackfillDatePair,
): MetadataBackfillItemStatus => {
  const hasCreated = Boolean(portableIsoSeconds(dates.dateCreated));
  const hasLastMessage = Boolean(portableIsoSeconds(dates.dateLastMessage));
  if (hasCreated && hasLastMessage) return 'matched';
  return hasCreated || hasLastMessage ? 'partial' : 'unresolved';
};

export const metadataCandidateHasCompleteDates = (
  candidate: MetadataBackfillDatePair,
  match: MetadataBackfillDatePair | null | undefined,
): boolean =>
  metadataBackfillStatusForDates({
    dateCreated: match?.dateCreated || candidate.dateCreated,
    dateLastMessage: match?.dateLastMessage || candidate.dateLastMessage,
  }) === 'matched';

export const filterCandidatesMissingMetadataDates = <
  T extends MetadataBackfillDatePair & { chatId: string },
>(
  candidates: T[],
  groupedMatches: Map<string, MetadataBackfillDatePair>,
): T[] =>
  candidates.filter(
    (candidate) =>
      !metadataCandidateHasCompleteDates(candidate, groupedMatches.get(candidate.chatId)),
  );

export const metadataBackfillHumanSummary = (
  summary: MetadataBackfillSummary,
  contract: CompleteMetadataBackfillContract | BlockedMetadataBackfillContract,
): string => {
  if (!summary.complete && summary.sourceMismatches) {
    return `Backfill metadata: ${summary.filesRewritten} arquivo(s) normalizado(s); ${summary.datesMatched}/${summary.totalChats} com datas completas; ${summary.sourceMismatches} fonte incompatível; ${summary.exportErrors} export raw suspeito(s); ${summary.sourceGaps} lacuna(s) de fonte.\n`;
  }
  if (!summary.complete && summary.exportErrors && summary.sourceGaps) {
    return `Backfill metadata: ${summary.filesRewritten} arquivo(s) normalizado(s); ${summary.datesMatched}/${summary.totalChats} com datas completas; ${summary.exportErrors} export raw suspeito(s); ${summary.sourceGaps} lacuna(s) de fonte.\n`;
  }
  const pendingLabel =
    contract.code === 'takeout_source_mismatch'
      ? 'fonte incompatível'
      : contract.code === 'raw_export_suspected'
        ? 'export raw suspeito(s)'
        : contract.code === 'takeout_source_gap'
          ? 'lacuna(s) de fonte'
          : 'pendente(s)';
  return `Backfill metadata: ${summary.filesRewritten} arquivo(s) normalizado(s); ${summary.datesMatched}/${summary.totalChats} com datas completas; ${contract.unresolvedChatIds.length} ${pendingLabel}.\n`;
};

export const metadataBackfillStepStatus = ({
  exitCode,
  contract = null,
}: {
  exitCode: number;
  contract?: { status?: string | null } | null;
}): 'completed' | 'blocked' | 'failed' => {
  if (contract?.status === 'blocked') return 'blocked';
  return exitCode === 0 ? 'completed' : 'failed';
};

export const metadataBackfillWarning = (
  contract: CompleteMetadataBackfillContract | BlockedMetadataBackfillContract | null | undefined,
): {
  code: MetadataBackfillContractCode;
  message: string;
  unresolvedChatIds: string[];
  nextAction: string;
} | null => {
  if (contract?.status !== 'blocked') return null;
  return {
    code: contract.code,
    message: contract.message || 'Alguns chats ficaram sem datas completas.',
    unresolvedChatIds: contract.unresolvedChatIds || [],
    nextAction:
      contract.code === 'raw_export_suspected'
        ? 'Abra o relatório de metadata e reexporte/deduplique os chats marcados como raw_export_suspected.'
        : contract.code === 'takeout_source_mismatch'
          ? 'Use um Takeout gerado pela mesma conta/perfil do navegador que exportou estes chats, ou rode o export web no perfil que corresponde a este Takeout.'
          : contract.code === 'takeout_source_gap'
            ? 'Revise os chats marcados como source_gap: eles nao têm atividade do usuario no Takeout; use uma fonte web alternativa para datas ou exclua do conjunto reconciliavel por Takeout.'
            : 'Revise o relatório de pendências e rode fix-vault de novo com uma fonte de datas que corresponda a esses chats.',
  };
};

export const buildFixVaultMetadataStatus = ({
  exitCode,
  report = null,
}: {
  exitCode: number;
  report?: {
    contract?: CompleteMetadataBackfillContract | BlockedMetadataBackfillContract | null;
    activityError?: { code?: string | null; message?: string | null } | null;
  } | null;
}): {
  stepStatus: 'completed' | 'blocked' | 'failed';
  warnings: Array<{
    code: string;
    message: string;
    nextAction?: string;
    unresolvedChatIds?: string[];
  }>;
  activityWarningText: string;
} => {
  const contract = report?.contract || null;
  const activityError = report?.activityError || null;
  const warnings = [];
  if (activityError) {
    warnings.push({
      code: activityError.code || 'my_activity_unavailable',
      message: activityError.message || 'My Activity nao ficou disponivel.',
      nextAction:
        'Abra https://myactivity.google.com/product/gemini, confirme que a extensao foi recarregada e rode fix-vault de novo para datas remanescentes.',
    });
  }
  const metadataWarning = metadataBackfillWarning(contract);
  if (metadataWarning) warnings.push(metadataWarning);
  return {
    stepStatus: metadataBackfillStepStatus({ exitCode, contract }),
    warnings,
    activityWarningText: activityError
      ? 'Aviso: My Activity nao ficou disponivel. Abra https://myactivity.google.com/product/gemini, recarregue a extensao se necessario e rode fix-vault de novo para datas remanescentes.\n'
      : '',
  };
};
