import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dateImportIssueCountsForJob,
  evaluateDateCompletenessGateFsm,
  evaluateDateImportMessageFsm,
  metadataDateWarningsForJob,
  terminalExportStatusForDateCompleteness,
} from '../build/ts/mcp/export-job-date-summary.js';

test('dateImportIssueCountsForJob counts metadata date statuses from job counters', () => {
  const job = {
    dateImport: { enabled: true },
    metrics: {
      counters: {
        dateImportMatched: 28,
        dateImportPartial: 1,
        dateImportUnresolved: 2,
      },
    },
  };

  assert.deepEqual(dateImportIssueCountsForJob(job), {
    matched: 28,
    partial: 1,
    unresolved: 2,
    pending: 3,
  });
  assert.deepEqual(metadataDateWarningsForJob(job), [
    '2 conversas ficaram sem datas no Takeout/My Activity.',
    '1 conversa ficou com datas incompletas no Takeout/My Activity.',
  ]);
});

test('date import status messages follow the actual source', () => {
  assert.deepEqual(
    evaluateDateImportMessageFsm({
      dateImport: { enabled: true, source: 'my-activity', sourceFile: null },
    }),
    {
      state: 'my_activity_only',
      sourceLabel: 'My Activity',
      loadingMessage: 'Preparando My Activity para preencher datas antes de salvar...',
    },
  );

  assert.deepEqual(
    evaluateDateImportMessageFsm({
      dateImport: {
        enabled: true,
        source: 'takeout+my-activity',
        sourceFile: 'Minhaatividade.html',
        fallback: 'my-activity',
      },
    }),
    {
      state: 'takeout_with_activity_fallback',
      sourceLabel: 'Takeout/My Activity',
      loadingMessage: 'Indexando Takeout; My Activity cobre datas restantes antes de salvar...',
    },
  );
});

test('date completeness gate requires fix-vault when complete dates are required but missing', () => {
  const decision = evaluateDateCompletenessGateFsm({
    outputDir: '/tmp/gemini-exports',
    reportFile: '/tmp/gemini-exports/report.json',
    dateImport: {
      enabled: true,
      source: 'my-activity',
      requireCompleteDates: true,
    },
    metrics: {
      counters: {
        dateImportMatched: 23,
        dateImportPartial: 6,
        dateImportUnresolved: 1,
      },
    },
  });

  assert.equal(decision.state, 'date_errors');
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 'completed_with_errors');
  assert.equal(decision.pending, 7);
  assert.match(decision.nextAction.message, /não consegui preencher todas as datas/i);
  assert.match(decision.nextAction.command.text, /gemini-md-export fix-vault/);
  assert.match(decision.nextAction.command.text, /--report/);
});

test('date completeness gate allows completed export when all required dates are matched', () => {
  const decision = evaluateDateCompletenessGateFsm({
    dateImport: {
      enabled: true,
      source: 'my-activity',
      requireCompleteDates: true,
    },
    metrics: {
      counters: {
        dateImportMatched: 30,
      },
    },
  });

  assert.equal(decision.state, 'complete');
  assert.equal(decision.ok, true);
  assert.equal(decision.status, 'completed');
  assert.equal(decision.nextAction, null);
});

test('terminal export status treats required pending dates as completed_with_errors', () => {
  assert.equal(
    terminalExportStatusForDateCompleteness({
      dateImport: { enabled: true, requireCompleteDates: true },
      metrics: { counters: { dateImportUnresolved: 1 } },
    }),
    'completed_with_errors',
  );
  assert.equal(
    terminalExportStatusForDateCompleteness({
      dateImport: { enabled: true, requireCompleteDates: true },
      metrics: { counters: { dateImportMatched: 1 } },
    }),
    'completed',
  );
});

test('metadata warnings name My Activity without Takeout in My Activity-only jobs', () => {
  const job = {
    dateImport: { enabled: true, source: 'my-activity', sourceFile: null },
    metrics: {
      counters: {
        dateImportPartial: 1,
        dateImportUnresolved: 2,
      },
    },
  };

  assert.deepEqual(metadataDateWarningsForJob(job), [
    '2 conversas ficaram sem datas no My Activity.',
    '1 conversa ficou com datas incompletas no My Activity.',
  ]);
});

test('dateImportIssueCountsForJob falls back to conversation receipts for old jobs', () => {
  const job = {
    dateImport: { enabled: true },
    metrics: {
      counters: {
        dateImportMatched: 28,
      },
      conversations: [
        { dateImport: { status: 'matched' } },
        { dateImport: { status: 'partial' } },
        { dateImport: { status: 'unresolved' } },
      ],
    },
  };

  assert.deepEqual(dateImportIssueCountsForJob(job), {
    matched: 28,
    partial: 1,
    unresolved: 1,
    pending: 2,
  });
});

test('dateImportIssueCountsForJob uses consolidated successes after resume', () => {
  const successes = [
    ...Array.from({ length: 28 }, () => ({ dateImport: { status: 'matched' } })),
    { dateImport: { status: 'unresolved' } },
    { dateImport: { status: 'unresolved' } },
  ];
  const job = {
    dateImport: { enabled: true },
    successes,
    metrics: {
      counters: {
        dateImportMatched: 1,
      },
      conversations: [{ dateImport: { status: 'matched' } }],
    },
  };

  assert.deepEqual(dateImportIssueCountsForJob(job), {
    matched: 28,
    partial: 0,
    unresolved: 2,
    pending: 2,
  });
  assert.deepEqual(metadataDateWarningsForJob(job), [
    '2 conversas ficaram sem datas no Takeout/My Activity.',
  ]);
});
