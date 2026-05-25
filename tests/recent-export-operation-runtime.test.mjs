import test from 'node:test';
import assert from 'node:assert/strict';

import { runRecentExportConversationOperation } from '../build/ts/mcp/recent-export-operation-runtime.js';

const target = {
  batchPosition: 22,
  batchTotal: 30,
  historyIndex: 22,
  targetChatId: 'f05318e93e234d75',
  title: 'Mac App UI/UX Design Trends',
  source: 'sidebar',
  url: 'https://gemini.google.com/app/f05318e93e234d75',
};

const createDeps = (overrides = {}) => {
  const traces = [];
  const failures = [];
  const successes = [];
  const deps = {
    traces,
    failures,
    successes,
    appendExportJobTrace: (_job, event, payload = {}) => traces.push({ event, payload }),
    broadcastRecentChatsJobProgress: () => {},
    buildConversationExportFailure: ({ index, conversation, err }) => ({
      index,
      chatId: conversation.chatId,
      title: conversation.title,
      error: err.message,
      code: err.code,
    }),
    buildConversationExportSuccess: ({ index, conversation, result }) => ({
      index,
      chatId: result.chatId || conversation.chatId,
      title: result.title || conversation.title,
    }),
    buildExportDateImportBatchEvidenceForPayloads: async () => ({
      candidates: 0,
      groupedByKey: {},
    }),
    downloadConversationItemWithRetry: async () => new Promise(() => {}),
    drainTimeoutMs: 10,
    enrichExportPayloadWithDates: async ({ payload }) => ({
      ok: true,
      payload,
      receipt: { status: 'matched' },
    }),
    exportJobRecordingDeps: {},
    getClientById: () => null,
    hasDateImportSource: () => false,
    rebindExportJobToClient: (_job, client) => client,
    recordConversationExportFailure: ({ failures: targetFailures, failure }) =>
      targetFailures.push(failure),
    recordConversationExportSuccess: ({ successes: targetSuccesses, success }) =>
      targetSuccesses.push(success),
    requestActiveBrowserOperationCancelForJob: async () => ({
      ok: true,
      cancelled: false,
      reason: 'no-active-operation',
    }),
    summarizeClient: (client) => client,
    touchExportJob: () => {},
    validateMcpExportPayload: async () => ({
      ok: true,
      snapshot: { chatId: target.targetChatId, title: target.title },
      assistantTurnCount: 1,
      markdownHash: 'fnv1a32:abc',
      evidence: [],
      warnings: [],
    }),
    writeExportPayloadBundle: () => ({
      filePath: `/tmp/${target.targetChatId}.md`,
      filename: `${target.targetChatId}.md`,
      bytes: 123,
      mediaFiles: [],
    }),
    ...overrides,
  };
  return deps;
};

test('recent export watchdog records one conversation failure when cancel is acknowledged but operation drain times out', async () => {
  const deps = createDeps();
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 21,
  };
  const client = { clientId: 'client-1' };
  const failures = [];
  const successes = [];

  const result = await runRecentExportConversationOperation(
    {
      args: {},
      client,
      conversation: { chatId: target.targetChatId, title: target.title },
      failures,
      index: 22,
      itemMetric: {},
      job,
      noProgressMs: 1,
      operationId: 'job-1:022:f05318e93e234d75',
      successes,
      target,
    },
    deps,
  );

  assert.equal(result.client, client);
  assert.equal(successes.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'conversation_no_progress_timeout');
  assert.equal(failures[0].chatId, target.targetChatId);
  assert.equal(
    deps.traces.some((trace) => trace.event === 'conversation_watchdog_drain_timeout'),
    true,
  );
});
