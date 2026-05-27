import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBrowserTabWatchdogRecovery,
  evaluateRecoveredBrowserTargetFsm,
  evaluateWatchdogRecoveryRetryFsm,
  runRecentExportConversationOperation,
} from '../build/ts/mcp/recent-export-operation-runtime.js';

const target = {
  batchPosition: 22,
  batchTotal: 30,
  historyIndex: 22,
  targetChatId: 'f05318e93e234d75',
  title: 'Mac App UI/UX Design Trends',
  source: 'sidebar',
  url: 'https://gemini.google.com/app/f05318e93e234d75',
};

test('watchdog recovery retry FSM retries the same conversation after successful tab recovery', () => {
  const decision = evaluateWatchdogRecoveryRetryFsm({
    watchdogCode: 'conversation_no_progress_timeout',
    recoveryOk: true,
    retryAttempt: 0,
    retryLimit: 1,
  });

  assert.equal(decision.state, 'retry_same_conversation');
  assert.equal(decision.reason, 'recovered_tab_ready');
});

test('watchdog recovery retry FSM forces direct target reopen when recovery lands on another chat', () => {
  const decision = evaluateWatchdogRecoveryRetryFsm({
    watchdogCode: 'conversation_no_progress_timeout',
    recoveryOk: true,
    recoveredTargetState: 'wrong_target',
    retryAttempt: 0,
    retryLimit: 1,
  });

  assert.equal(decision.state, 'retry_same_conversation');
  assert.equal(decision.reason, 'recovered_tab_wrong_target_reopen_required');
  assert.equal(decision.forceDirectChatUrlNavigation, true);
});

test('watchdog recovery retry FSM records the conversation failure when retry budget is exhausted', () => {
  const decision = evaluateWatchdogRecoveryRetryFsm({
    watchdogCode: 'conversation_no_progress_timeout',
    recoveryOk: true,
    retryAttempt: 1,
    retryLimit: 1,
  });

  assert.equal(decision.state, 'record_failure');
  assert.equal(decision.reason, 'retry_limit_exhausted');
});

test('recovered browser target FSM detects target mismatch from recovered page URL', () => {
  const decision = evaluateRecoveredBrowserTargetFsm({
    targetChatId: '8837c0ae19ce4d2e',
    recoveredClient: {
      page: {
        url: 'https://gemini.google.com/app/538f2f6eec041e0a',
      },
    },
  });

  assert.equal(decision.state, 'wrong_target');
  assert.equal(decision.expectedChatId, '8837c0ae19ce4d2e');
  assert.equal(decision.observedChatId, '538f2f6eec041e0a');
});

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

test('recent export watchdog records one conversation failure when recovered retry budget is exhausted', async () => {
  const deps = createDeps({
    recoverBrowserTabAfterWatchdog: async () => ({ ok: true }),
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
      args: { watchdogRecoveryRetryLimit: 1 },
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

test('recent export saves conversation when My Activity date evidence is unavailable', async () => {
  let saveCalled = false;
  const activityError = new Error('Nenhuma aba do My Activity conectada à extensão.');
  activityError.code = 'activity_client_missing';
  const deps = createDeps({
    hasDateImportSource: () => true,
    buildExportDateImportBatchEvidenceForPayloads: async () => {
      throw activityError;
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
    enrichExportPayloadWithDates: async ({ payload }) => ({
      ok: true,
      payload,
      receipt: {
        enabled: true,
        status: 'unresolved',
        source: 'takeout+my-activity',
        dateCreated: null,
        dateLastMessage: null,
        evidenceCount: 0,
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
    dateImport: { enabled: true, source: 'takeout+my-activity' },
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
  assert.equal(successes[0].receipts.dateImport.status, 'unresolved');
  assert.ok(
    deps.traces.some(
      (trace) =>
        trace.event === 'date_import_batch_evidence_unavailable' &&
        trace.payload.code === 'activity_client_missing',
    ),
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

test('recent export watchdog retries the same conversation after tab recovery when operation drain times out', async () => {
  const recoveries = [];
  const recoveredClient = { clientId: 'client-2', tabId: 42 };
  const reboundReasons = [];
  let downloadAttempts = 0;
  const deps = createDeps({
    downloadConversationItemWithRetry: async (_job, activeClient, activeConversation) => {
      downloadAttempts += 1;
      if (downloadAttempts === 1) {
        await new Promise(() => {});
      }
      return {
        activeClient,
        browserCommandMs: 4,
        result: {
          payload: {
            chatId: activeConversation.chatId,
            title: activeConversation.title,
            content: '# ok',
            metrics: { timings: {}, counters: {} },
          },
          conversation: activeConversation,
        },
      };
    },
    getClientById: (clientId) => (clientId === recoveredClient.clientId ? recoveredClient : null),
    rebindExportJobToClient: (_job, client, reason) => {
      reboundReasons.push(reason);
      return client;
    },
    requestActiveBrowserOperationCancelForJob: async () => null,
    recoverBrowserTabAfterWatchdog: async (_job, reason, context) => {
      recoveries.push({ reason, context });
      return { ok: true, reloaded: 1, recoveredClient };
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

  assert.equal(result.client, recoveredClient);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(downloadAttempts, 2);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, 'conversation_no_progress_timeout');
  assert.equal(recoveries[0].context.operationId, 'job-1:008:f05318e93e234d75');
  assert.equal(reboundReasons.includes('conversation-watchdog-recovery'), true);
  assert.equal(reboundReasons.includes('conversation-download'), true);
  assert.equal(
    deps.traces.some((trace) => trace.event === 'conversation_watchdog_recovered_retry'),
    true,
  );
});

test('recent export watchdog retry uses direct URL navigation when recovery reconnects on another chat', async () => {
  const recoveredClient = {
    clientId: 'client-2',
    tabId: 42,
    page: {
      url: 'https://gemini.google.com/app/538f2f6eec041e0a',
      chatId: '538f2f6eec041e0a',
    },
  };
  const browserArgs = [];
  let downloadAttempts = 0;
  const deps = createDeps({
    downloadConversationItemWithRetry: async (_job, activeClient, activeConversation, args) => {
      downloadAttempts += 1;
      browserArgs.push({ ...args });
      if (downloadAttempts === 1) return new Promise(() => {});
      return {
        activeClient,
        browserCommandMs: 4,
        result: {
          payload: {
            chatId: activeConversation.chatId,
            title: activeConversation.title,
            content: '# ok',
            metrics: { timings: {}, counters: {} },
          },
          conversation: activeConversation,
        },
      };
    },
    getClientById: (clientId) => (clientId === recoveredClient.clientId ? recoveredClient : null),
    rebindExportJobToClient: (_job, client) => client,
    requestActiveBrowserOperationCancelForJob: async () => ({ ok: true, cancelled: true }),
    recoverBrowserTabAfterWatchdog: async () => ({
      ok: true,
      recoveredClient,
      targetReadiness: {
        state: 'wrong_target',
        expectedChatId: target.targetChatId,
        observedChatId: recoveredClient.page.chatId,
      },
    }),
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 7,
  };
  const failures = [];
  const successes = [];

  await runRecentExportConversationOperation(
    {
      args: {},
      client: { clientId: 'client-1', tabId: 42 },
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

  assert.equal(downloadAttempts, 2);
  assert.equal(browserArgs[0].preferDirectChatUrlNavigation, undefined);
  assert.equal(browserArgs[1].preferDirectChatUrlNavigation, true);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
});

test('recent export watchdog retries the same conversation after tab recovery when aborted operation settles quickly', async () => {
  const recoveries = [];
  const recoveredClient = { clientId: 'client-2', tabId: 42 };
  let downloadAttempts = 0;
  const deps = createDeps({
    downloadConversationItemWithRetry: async (_job, activeClient, activeConversation, args) => {
      downloadAttempts += 1;
      if (downloadAttempts === 1) {
        return new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener('abort', () => reject(args.abortSignal.reason), {
            once: true,
          });
        });
      }
      return {
        activeClient,
        browserCommandMs: 4,
        result: {
          payload: {
            chatId: activeConversation.chatId,
            title: activeConversation.title,
            content: '# ok',
            metrics: { timings: {}, counters: {} },
          },
          conversation: activeConversation,
        },
      };
    },
    getClientById: (clientId) => (clientId === recoveredClient.clientId ? recoveredClient : null),
    rebindExportJobToClient: (_job, client) => client,
    requestActiveBrowserOperationCancelForJob: async () => null,
    recoverBrowserTabAfterWatchdog: async (_job, reason, context) => {
      recoveries.push({ reason, context });
      return { ok: true, recoveredClient };
    },
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 7,
  };
  const failures = [];
  const successes = [];

  const result = await runRecentExportConversationOperation(
    {
      args: {},
      client: { clientId: 'client-1', tabId: 42 },
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

  assert.equal(result.client, recoveredClient);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(downloadAttempts, 2);
  assert.equal(recoveries.length, 1);
});

test('recent export watchdog allows two recovered retries by default before recording failure', async () => {
  const recoveries = [];
  let downloadAttempts = 0;
  const recoveredClient = {
    clientId: 'client-2',
    tabId: 42,
    page: {
      chatId: target.targetChatId,
      url: target.url,
    },
  };
  const deps = createDeps({
    downloadConversationItemWithRetry: async (_job, activeClient, activeConversation, args) => {
      downloadAttempts += 1;
      if (downloadAttempts <= 2) {
        return new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener('abort', () => reject(args.abortSignal.reason), {
            once: true,
          });
        });
      }
      return {
        activeClient,
        browserCommandMs: 4,
        result: {
          payload: {
            chatId: activeConversation.chatId,
            title: activeConversation.title,
            content: '# ok',
            metrics: { timings: {}, counters: {} },
          },
          conversation: activeConversation,
        },
      };
    },
    getClientById: (clientId) => (clientId === recoveredClient.clientId ? recoveredClient : null),
    rebindExportJobToClient: (_job, client) => client,
    requestActiveBrowserOperationCancelForJob: async () => ({ ok: true, cancelled: true }),
    recoverBrowserTabAfterWatchdog: async (_job, reason, context) => {
      recoveries.push({ reason, context });
      return {
        ok: true,
        recoveredClient: {
          ...recoveredClient,
          page: {
            ...recoveredClient.page,
            turnCount: recoveries.length === 1 ? 0 : 46,
          },
        },
        targetReadiness: {
          state: 'target_ready',
          ok: true,
          reason: 'recovered_target_matches',
          expectedChatId: target.targetChatId,
          observedChatId: target.targetChatId,
        },
      };
    },
  });
  const job = {
    jobId: 'job-1',
    phase: 'exporting',
    outputDir: '/tmp/export',
    completed: 7,
  };
  const failures = [];
  const successes = [];

  await runRecentExportConversationOperation(
    {
      args: {},
      client: { clientId: 'client-1', tabId: 42 },
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

  assert.equal(downloadAttempts, 3);
  assert.equal(recoveries.length, 2);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 0);
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

test('browser tab recovery rejects a reconnected client that is not usable for the current runtime', async () => {
  const traces = [];
  const recoveredClient = {
    clientId: 'client-old-build',
    tabId: 42,
    lifecycle: {
      ok: false,
      state: 'extension_mismatch',
      code: 'extension_build_mismatch',
      message: 'A extensão conectada não está no build esperado.',
    },
  };
  const recover = createBrowserTabWatchdogRecovery({
    appendExportJobTrace: (_job, event, payload = {}) => traces.push({ event, payload }),
    getClaimById: () => ({ claimId: 'claim-1', tabId: 42, sessionId: 'session-1' }),
    getClientById: () => ({ clientId: 'client-1', tabId: 42 }),
    claimForClient: () => null,
    normalizeTabId: () => 42,
    tryNativeBrowserBrokerTabsAction: async () => ({ ok: true, action: 'reload', reloaded: 1 }),
    waitForContinuationClient: async () => recoveredClient,
    summarizeClient: (client) => ({
      clientId: client.clientId,
      tabId: client.tabId,
      lifecycle: client.lifecycle || null,
    }),
    validateRecoveredClient: (client) => ({
      ok: client.lifecycle?.ok === true,
      code: client.lifecycle?.code || 'recovered_client_not_ready',
      message: client.lifecycle?.message || null,
      state: client.lifecycle?.state || null,
    }),
    touchExportJob: () => {},
    recoveryWaitMs: 1,
  });

  const result = await recover(
    { clientId: 'client-1', tabClaimId: 'claim-1' },
    'stale_conversation_dom',
    { operationId: 'job-1:012:8837c0ae19ce4d2e', targetChatId: '8837c0ae19ce4d2e' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_build_mismatch');
  assert.equal(result.reload.ok, true);
  assert.equal(result.recoveredClient.clientId, 'client-old-build');
  assert.equal(result.recoveredClientReadiness.ok, false);
  assert.equal(
    traces.some((trace) => trace.event === 'browser_operation_recovery_result'),
    true,
  );
});

test('browser tab recovery waits for a post-reload client signal before accepting recovery', async () => {
  let selectorSeen = null;
  const startedBeforeRecovery = Date.now();
  const recover = createBrowserTabWatchdogRecovery({
    appendExportJobTrace: () => {},
    getClaimById: () => ({ claimId: 'claim-1', tabId: 42, sessionId: 'session-1' }),
    getClientById: () => ({ clientId: 'client-1', tabId: 42 }),
    claimForClient: () => null,
    normalizeTabId: () => 42,
    tryNativeBrowserBrokerTabsAction: async () => ({ ok: true, action: 'reload', reloaded: 1 }),
    waitForContinuationClient: async (_client, selector) => {
      selectorSeen = selector;
      return { clientId: 'client-2', tabId: 42, lastSeenAt: Date.now() };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    validateRecoveredClient: () => ({ ok: true }),
    touchExportJob: () => {},
    recoveryWaitMs: 1,
  });

  const result = await recover(
    { clientId: 'client-1', tabClaimId: 'claim-1' },
    'stale_conversation_dom',
    { operationId: 'job-1:012:8837c0ae19ce4d2e', targetChatId: '8837c0ae19ce4d2e' },
  );

  assert.equal(result.ok, true);
  assert.equal(selectorSeen.tabId, 42);
  assert.equal(selectorSeen.claimId, 'claim-1');
  assert.equal(selectorSeen.sessionId, 'session-1');
  assert.equal(selectorSeen.requireExpectedBrowserExtension, true);
  assert.equal(selectorSeen.requireCommandReady, true);
  assert.ok(selectorSeen.minRuntimeSignalAt >= startedBeforeRecovery);
  assert.ok(selectorSeen.minRuntimeSignalAt <= Date.now());
});
