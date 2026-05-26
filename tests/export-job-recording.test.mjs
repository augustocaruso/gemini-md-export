import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordConversationExportSuccess,
} from '../build/ts/mcp/export-job-recording.js';

const createRecordingDeps = () => ({
  assetTimeoutCountFromConversationMetrics: () => 0,
  browserTimeoutCountFromConversationMetrics: () => 0,
  finishConversationMetric: () => {},
  recordJobCounter: (job, name, delta = 1) => {
    job.metrics ||= { counters: {} };
    job.metrics.counters ||= {};
    job.metrics.counters[name] = (job.metrics.counters[name] || 0) + delta;
  },
});

test('recordConversationExportSuccess counts partial and unresolved date imports', () => {
  const job = {
    recentSuccesses: [],
    successCount: 0,
    metrics: { counters: {} },
  };
  const successes = [];
  const deps = createRecordingDeps();

  for (const status of ['partial', 'unresolved']) {
    const result = {
      chatId: `chat-${status}`,
      title: `Chat ${status}`,
      filename: `${status}.md`,
      filePath: `/tmp/${status}.md`,
      bytes: 100,
      mediaFileCount: 0,
      mediaFailureCount: 0,
      turns: 1,
      dateImport: {
        enabled: true,
        status,
        source: 'takeout',
      },
      metrics: { counters: {}, timings: {} },
    };
    const success = {
      index: successes.length + 1,
      chatId: result.chatId,
      title: result.title,
      dateImport: result.dateImport,
    };

    recordConversationExportSuccess(
      {
        job,
        successes,
        itemMetric: {},
        success,
        result,
      },
      deps,
    );
  }

  assert.equal(job.metrics.counters.dateImportPartial, 1);
  assert.equal(job.metrics.counters.dateImportUnresolved, 1);
  assert.equal(job.metrics.counters.dateImportMatched || 0, 0);
});
