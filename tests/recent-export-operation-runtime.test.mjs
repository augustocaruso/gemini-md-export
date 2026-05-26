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

test('recent export watchdog does not fail a conversation while local date import is making progress', async () => {
  const deps = createDeps({
    localPhaseProgressIntervalMs: 5,
    hasDateImportSource: () => true,
    buildExportDateImportBatchEvidenceForPayloads: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { candidates: 1, groupedByKey: new Map() };
    },
    downloadConversationItemWithRetry: async (_job, client, conversation) => ({
      activeClient: client,
      browserCommandMs: 4,
      result: {
        payload: {
          chatId: conversation.chatId,
          title: conversation.title,
          content: '# ok',
          metrics: { timings: {}, counters: {} },
        },
        conversation,
      },
    }),
  });
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
      noProgressMs: 20,
      operationId: 'job-1:022:f05318e93e234d75',
      successes,
      target,
    },
    deps,
  );

  assert.equal(result.client, client);
  assert.equal(failures.length, 0);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].chatId, target.targetChatId);
  assert.equal(
    deps.traces.some((trace) => trace.event === 'conversation_no_progress_watchdog'),
    false,
  );
});

test('recent export saves conversation with partial date receipt instead of failing metadata-unresolved', async () => {
  let saveCalled = false;
  const deps = createDeps({
    hasDateImportSource: () => true,
    buildExportDateImportBatchEvidenceForPayloads: async () => ({
      candidates: 1,
      groupedByKey: new Map(),
    }),
    downloadConversationItemWithRetry: async (_job, client, conversation) => ({
      activeClient: client,
      browserCommandMs: 4,
      result: {
        payload: {
          chatId: conversation.chatId,
          title: conversation.title,
          content: '# ok',
          metrics: { timings: {}, counters: {} },
        },
        conversation,
      },
    }),
    enrichExportPayloadWithDates: async ({ payload }) => ({
      ok: true,
      payload,
      receipt: {
        enabled: true,
        status: 'partial',
        source: 'takeout',
        dateCreated: '2026-01-01T00:00:00.000Z',
        dateLastMessage: null,
      },
      evidence: [],
    }),
    writeExportPayloadBundle: () => {
      saveCalled = true;
      return {
        filePath: `/tmp/${target.targetChatId}.md`,
        filename: `${target.targetChatId}.md`,
        bytes: 123,
        mediaFiles: [],
      };
    },
  });
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
      noProgressMs: 200,
      operationId: 'job-1:022:f05318e93e234d75',
      successes,
      target,
    },
    deps,
  );

  assert.equal(result.client, client);
  assert.equal(saveCalled, true);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(successes[0].chatId, target.targetChatId);
  assert.equal(
    deps.traces.some((trace) => trace.event === 'date_import_unresolved_saved_without_abort'),
    false,
  );
});

test('recent export watchdog follows active browser operation progress while download is still running', async () => {
  const operationId = 'job-1:022:f05318e93e234d75';
  const startedAt = Date.now();
  let browserProgressAt = startedAt;
  const heartbeatTimer = setInterval(() => {
    browserProgressAt = Date.now();
  }, 80);
  const client = { clientId: 'client-1' };
  const deps = createDeps({
    getClientById: (clientId) =>
      clientId === client.clientId
        ? {
            clientId,
            metrics: {
              tabOperation: {
                active: {
                  operationId,
                  phase: 'hydrating',
                  lastProgressAt: new Date(browserProgressAt).toISOString(),
                },
              },
            },
          }
        : null,
    downloadConversationItemWithRetry: async (_job, activeClient, conversation) => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return {
        activeClient,
        browserCommandMs: 650,
        result: {
          payload: {
            chatId: conversation.chatId,
            title: conversation.title,
            content: '# ok',
            metrics: { timings: {}, counters: {} },
          },
          conversation,
        },
      };
    },
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 21,
  };
  const failures = [];
  const successes = [];

  try {
    const result = await runRecentExportConversationOperation(
      {
        args: {},
        client,
        conversation: { chatId: target.targetChatId, title: target.title },
        failures,
        index: 22,
        itemMetric: {},
        job,
        noProgressMs: 150,
        operationId,
        successes,
        target,
      },
      deps,
    );

    assert.equal(result.client.clientId, client.clientId);
    assert.equal(failures.length, 0);
    assert.equal(successes.length, 1);
    assert.equal(
      deps.traces.some((trace) => trace.event === 'conversation_no_progress_watchdog'),
      false,
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
});

test('recent export operation aborts local date resolution after job cancel request', async () => {
  const deps = createDeps({
    localPhaseProgressIntervalMs: 5,
    hasDateImportSource: () => true,
    buildExportDateImportBatchEvidenceForPayloads: async () => {
      await new Promise(() => {});
    },
    downloadConversationItemWithRetry: async (_job, client, conversation) => ({
      activeClient: client,
      browserCommandMs: 4,
      result: {
        payload: {
          chatId: conversation.chatId,
          title: conversation.title,
          content: '# ok',
          metrics: { timings: {}, counters: {} },
        },
        conversation,
      },
    }),
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 21,
  };
  setTimeout(() => {
    job.cancelRequested = true;
  }, 30);
  const failures = [];
  const successes = [];

  const result = await Promise.race([
    runRecentExportConversationOperation(
      {
        args: { _exportDateImportActivitySummary: { attempted: true } },
        client: { clientId: 'client-1' },
        conversation: { chatId: target.targetChatId, title: target.title },
        failures,
        index: 22,
        itemMetric: {},
        job,
        noProgressMs: 150,
        operationId: 'job-1:022:f05318e93e234d75',
        successes,
        target,
      },
      deps,
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'test-timeout' }), 1000)),
  ]);

  assert.notEqual(result.status, 'test-timeout');
  assert.equal(successes.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'conversation_cancel_requested');
});

test('recent export watchdog reloads the tab and continues when cancel command times out', async () => {
  const recoveries = [];
  const deps = createDeps({
    requestActiveBrowserOperationCancelForJob: async () => null,
    recoverBrowserTabAfterWatchdog: async (_job, reason, context) => {
      recoveries.push({ reason, context });
      return { ok: true, reloaded: 1 };
    },
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 7,
  };
  const client = { clientId: 'client-1', tabId: 42 };
  const failures = [];
  const successes = [];

  const result = await runRecentExportConversationOperation(
    {
      args: {},
      client,
      conversation: { chatId: target.targetChatId, title: target.title },
      failures,
      index: 8,
      itemMetric: {},
      job,
      noProgressMs: 1,
      operationId: 'job-1:008:f05318e93e234d75',
      successes,
      target,
    },
    deps,
  );

  assert.equal(result.client, client);
  assert.equal(successes.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'conversation_no_progress_timeout');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, 'conversation_no_progress_timeout');
  assert.equal(recoveries[0].context.operationId, 'job-1:008:f05318e93e234d75');
});

test('recent export watchdog stops the batch when cancel and recovery both fail', async () => {
  const deps = createDeps({
    requestActiveBrowserOperationCancelForJob: async () => null,
    recoverBrowserTabAfterWatchdog: async () => ({ ok: false, code: 'reload_failed' }),
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 7,
  };

  await assert.rejects(
    () =>
      runRecentExportConversationOperation(
        {
          args: {},
          client: { clientId: 'client-1', tabId: 42 },
          conversation: { chatId: target.targetChatId, title: target.title },
          failures: [],
          index: 8,
          itemMetric: {},
          job,
          noProgressMs: 1,
          operationId: 'job-1:008:f05318e93e234d75',
          successes: [],
          target,
        },
        deps,
      ),
    { code: 'operation_cancel_failed_after_watchdog' },
  );
});
