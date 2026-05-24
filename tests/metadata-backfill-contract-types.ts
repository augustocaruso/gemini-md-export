import type {
  BlockedMetadataBackfillReport,
  CompleteMetadataBackfillReport,
  MetadataBackfillReport,
} from '../src/core/metadata-backfill-contract.js';

const completeReport = {
  ok: true,
  contract: {
    ok: true,
    status: 'complete',
    code: null,
    message: 'Todos os chats têm datas completas.',
    unresolvedChatIds: [],
  },
  summary: {
    totalChats: 1,
    filesRewritten: 1,
    datesMatched: 1,
    matched: 1,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 0,
    sourceMismatches: 0,
    sourceGaps: 0,
    updated: 1,
    complete: true,
    contractStatus: 'complete',
  },
} satisfies CompleteMetadataBackfillReport;

const blockedReport = {
  ok: false,
  contract: {
    ok: false,
    status: 'blocked',
    code: 'metadata_unresolved',
    message: '1 chat sem datas completas.',
    unresolvedChatIds: ['bbbbbbbbbbbb'],
  },
  summary: {
    totalChats: 2,
    filesRewritten: 2,
    datesMatched: 1,
    matched: 1,
    partial: 0,
    unresolved: 1,
    ambiguous: 0,
    exportErrors: 0,
    sourceMismatches: 0,
    sourceGaps: 0,
    updated: 2,
    complete: false,
    contractStatus: 'blocked',
  },
} satisfies BlockedMetadataBackfillReport;

const rawExportBlockedReport = {
  ok: false,
  contract: {
    ok: false,
    status: 'blocked',
    code: 'raw_export_suspected',
    message: '1 chat parece ter export raw inconsistente.',
    unresolvedChatIds: ['cccccccccccc'],
  },
  summary: {
    totalChats: 1,
    filesRewritten: 1,
    datesMatched: 0,
    matched: 0,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 1,
    sourceMismatches: 0,
    sourceGaps: 0,
    updated: 1,
    complete: false,
    contractStatus: 'blocked',
  },
} satisfies BlockedMetadataBackfillReport;

const sourceGapBlockedReport = {
  ok: false,
  contract: {
    ok: false,
    status: 'blocked',
    code: 'takeout_source_gap',
    message: '1 chat nao aparece no Takeout por falta de atividade do usuario.',
    unresolvedChatIds: ['dddddddddddd'],
  },
  summary: {
    totalChats: 1,
    filesRewritten: 1,
    datesMatched: 0,
    matched: 0,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 0,
    sourceMismatches: 0,
    sourceGaps: 1,
    updated: 1,
    complete: false,
    contractStatus: 'blocked',
  },
} satisfies BlockedMetadataBackfillReport;

const sourceMismatchBlockedReport = {
  ok: false,
  contract: {
    ok: false,
    status: 'blocked',
    code: 'takeout_source_mismatch',
    message:
      '10 chats parecem nao pertencer ao Takeout informado; use a mesma conta/perfil para Takeout e export web.',
    unresolvedChatIds: ['eeeeeeeeeeee'],
  },
  summary: {
    totalChats: 10,
    filesRewritten: 0,
    datesMatched: 0,
    matched: 0,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 0,
    sourceMismatches: 10,
    sourceGaps: 0,
    updated: 0,
    complete: false,
    contractStatus: 'blocked',
  },
} satisfies BlockedMetadataBackfillReport;

const anyReport: MetadataBackfillReport =
  Math.random() > 0.66
    ? completeReport
    : Math.random() > 0.66
      ? blockedReport
      : Math.random() > 0.5
        ? rawExportBlockedReport
        : Math.random() > 0.5
          ? sourceGapBlockedReport
          : sourceMismatchBlockedReport;

if (anyReport.ok) {
  const unresolvedMustBeZero: 0 = anyReport.summary.unresolved;
  unresolvedMustBeZero;
}

const invalidComplete = {
  ok: true,
  contract: {
    ok: true,
    status: 'complete',
    code: null,
    message: 'Todos os chats têm datas completas.',
    unresolvedChatIds: [],
  },
  summary: {
    totalChats: 2,
    filesRewritten: 2,
    datesMatched: 1,
    matched: 1,
    partial: 0,
    // @ts-expect-error complete reports cannot carry unresolved chats.
    unresolved: 1,
    ambiguous: 0,
    exportErrors: 0,
    sourceMismatches: 0,
    sourceGaps: 0,
    updated: 2,
    complete: true,
    contractStatus: 'complete',
  },
} satisfies CompleteMetadataBackfillReport;

invalidComplete;
