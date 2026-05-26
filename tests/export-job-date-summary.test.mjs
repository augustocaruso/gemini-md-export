import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dateImportIssueCountsForJob,
  metadataDateWarningsForJob,
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
