import test from 'node:test';
import assert from 'node:assert/strict';

import { runConversationOperation } from '../build/ts/mcp/conversation-operation-runner.js';

const target = {
  batchPosition: 1,
  batchTotal: 2,
  historyIndex: 6,
  targetChatId: 'aaa111aaa111',
  title: 'Caso CPRE',
  source: 'sidebar',
  url: 'https://gemini.google.com/app/aaa111aaa111',
};

const createDeps = (overrides = {}) => ({
  download: async () => ({
    payload: { chatId: target.targetChatId, content: '# ok' },
    receipts: { navigation: { ok: true } },
  }),
  resolveDates: async ({ payload }) => ({
    payload: { ...payload, dateCreated: '2026-05-01T00:00:00Z' },
    receipt: { status: 'matched', source: 'takeout' },
  }),
  save: async ({ payload }) => ({
    filePath: `/tmp/${payload.chatId}.md`,
    bytes: 12,
    receipt: { status: 'saved' },
  }),
  ...overrides,
});

const runOperation = (overrides = {}) =>
  runConversationOperation({
    jobId: 'job-1',
    operationId: 'op-1',
    target,
    progressSink: () => {},
    abortSignal: new AbortController().signal,
    deps: createDeps(),
    ...overrides,
  });

test('conversation operation saves after download, date resolution and writer', async () => {
  const progress = [];
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    target,
    progressSink: (snapshot) => progress.push(snapshot),
    abortSignal: new AbortController().signal,
    deps: {
      now: () => 1000 + progress.length,
      download: async () => ({
        payload: { chatId: 'aaa111aaa111', content: '# ok' },
        client: { clientId: 'client-1' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => ({
        payload: { ...payload, dateCreated: '2026-05-01T00:00:00Z' },
        receipt: { status: 'matched', source: 'takeout' },
      }),
      save: async ({ payload }) => ({
        filePath: `/tmp/${payload.chatId}.md`,
        bytes: 12,
        receipt: { status: 'saved' },
      }),
    },
  });

  assert.equal(result.status, 'saved');
  assert.equal(result.chatId, 'aaa111aaa111');
  assert.equal(result.filePath, '/tmp/aaa111aaa111.md');
  assert.deepEqual(progress, [
    {
      jobId: 'job-1',
      operationId: 'job-1:001:aaa111aaa111',
      status: 'running',
      phase: 'opening',
      batchPosition: 1,
      batchTotal: 2,
      historyIndex: 6,
      title: 'Caso CPRE',
      targetChatId: 'aaa111aaa111',
      currentChatId: null,
      message: 'Abrindo conversa',
      lastProgressAt: 1000,
      errorCount: null,
    },
    {
      jobId: 'job-1',
      operationId: 'job-1:001:aaa111aaa111',
      status: 'running',
      phase: 'resolving_dates',
      batchPosition: 1,
      batchTotal: 2,
      historyIndex: 6,
      title: 'Caso CPRE',
      targetChatId: 'aaa111aaa111',
      currentChatId: null,
      message: 'Conferindo datas da conversa',
      lastProgressAt: 1001,
      errorCount: null,
    },
    {
      jobId: 'job-1',
      operationId: 'job-1:001:aaa111aaa111',
      status: 'running',
      phase: 'saving',
      batchPosition: 1,
      batchTotal: 2,
      historyIndex: 6,
      title: 'Caso CPRE',
      targetChatId: 'aaa111aaa111',
      currentChatId: null,
      message: 'Salvando Markdown',
      lastProgressAt: 1002,
      errorCount: null,
    },
  ]);
});

test('conversation operation reports progress while local date resolution is still running', async () => {
  const progress = [];
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    target,
    progressSink: (snapshot) => progress.push(snapshot),
    abortSignal: new AbortController().signal,
    deps: {
      localPhaseProgressIntervalMs: 5,
      download: async () => ({
        payload: { chatId: 'aaa111aaa111', content: '# ok' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          payload: { ...payload, dateCreated: '2026-05-01T00:00:00Z' },
          receipt: { status: 'matched', source: 'takeout' },
        };
      },
      save: async ({ payload }) => ({
        filePath: `/tmp/${payload.chatId}.md`,
        bytes: 12,
        receipt: { status: 'saved' },
      }),
    },
  });

  assert.equal(result.status, 'saved');
  assert.ok(
    progress.filter((snapshot) => snapshot.phase === 'resolving_dates').length >= 2,
    'date resolution should keep the operation watchdog informed',
  );
});

test('conversation operation reports progress while local save is still running', async () => {
  const progress = [];
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    target,
    progressSink: (snapshot) => progress.push(snapshot),
    abortSignal: new AbortController().signal,
    deps: {
      localPhaseProgressIntervalMs: 5,
      download: async () => ({
        payload: { chatId: 'aaa111aaa111', content: '# ok' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => ({
        payload: { ...payload, dateCreated: '2026-05-01T00:00:00Z' },
        receipt: { status: 'matched', source: 'takeout' },
      }),
      save: async ({ payload }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          filePath: `/tmp/${payload.chatId}.md`,
          bytes: 12,
          receipt: { status: 'saved' },
        };
      },
    },
  });

  assert.equal(result.status, 'saved');
  assert.ok(
    progress.filter((snapshot) => snapshot.phase === 'saving').length >= 2,
    'save should keep the operation watchdog informed',
  );
});

test('conversation operation fails before save when payload chat id does not match target', async () => {
  const calls = [];
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'op-1',
    target,
    progressSink: () => {},
    abortSignal: new AbortController().signal,
    deps: {
      download: async () => ({
        payload: { chatId: 'bbb222bbb222', content: '# wrong' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => {
        calls.push('resolveDates');
        return { payload, receipt: { status: 'unmatched' } };
      },
      save: async () => {
        calls.push('save');
        throw new Error('save should not run');
      },
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'payload_chat_id_mismatch');
  assert.deepEqual(calls, []);
});

test('conversation operation returns cancelled when abort signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort('test-cancel');
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'op-1',
    target,
    progressSink: () => {},
    abortSignal: controller.signal,
    deps: {
      download: async () => {
        throw new Error('download should not run');
      },
      resolveDates: async ({ payload }) => ({ payload, receipt: { status: 'unmatched' } }),
      save: async () => ({ filePath: '/tmp/nope.md', receipt: {} }),
    },
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'test-cancel');
});

test('conversation operation returns string fallback for non-string abort reason', async () => {
  const controller = new AbortController();
  controller.abort({ message: { nested: true } });
  const progress = [];
  const result = await runOperation({
    progressSink: (snapshot) => progress.push(snapshot),
    abortSignal: controller.signal,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'operation_cancelled');
  assert.deepEqual(progress, []);
});

test('conversation operation cancels after download and skips date resolution and save', async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await runOperation({
    abortSignal: controller.signal,
    deps: createDeps({
      download: async () => {
        calls.push('download');
        controller.abort('after-download');
        return {
          payload: { chatId: target.targetChatId, content: '# ok' },
          receipts: { navigation: { ok: true } },
        };
      },
      resolveDates: async ({ payload }) => {
        calls.push('resolveDates');
        return { payload, receipt: { status: 'matched' } };
      },
      save: async () => {
        calls.push('save');
        return { filePath: '/tmp/nope.md', receipt: {} };
      },
    }),
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'after-download');
  assert.deepEqual(result.receipts, { download: { navigation: { ok: true } } });
  assert.deepEqual(calls, ['download']);
});

test('conversation operation cancels while local date resolution is still pending', async () => {
  const controller = new AbortController();
  const calls = [];
  const resultPromise = runOperation({
    abortSignal: controller.signal,
    deps: createDeps({
      download: async () => {
        calls.push('download');
        return {
          payload: { chatId: target.targetChatId, content: '# ok' },
          receipts: { navigation: { ok: true } },
        };
      },
      resolveDates: async () => {
        calls.push('resolveDates');
        await new Promise(() => {});
      },
      save: async () => {
        calls.push('save');
        return { filePath: '/tmp/nope.md', receipt: {} };
      },
    }),
  });
  setTimeout(() => controller.abort('during-dates'), 20);

  const result = await Promise.race([
    resultPromise,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'test-timeout' }), 200)),
  ]);

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'during-dates');
  assert.deepEqual(calls, ['download', 'resolveDates']);
});

test('conversation operation cancels after date resolution and skips save', async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await runOperation({
    abortSignal: controller.signal,
    deps: createDeps({
      download: async () => {
        calls.push('download');
        return {
          payload: { chatId: target.targetChatId, content: '# ok' },
          receipts: { navigation: { ok: true } },
        };
      },
      resolveDates: async ({ payload }) => {
        calls.push('resolveDates');
        controller.abort('after-dates');
        return { payload, receipt: { status: 'matched', source: 'takeout' } };
      },
      save: async () => {
        calls.push('save');
        return { filePath: '/tmp/nope.md', receipt: {} };
      },
    }),
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'after-dates');
  assert.deepEqual(result.receipts, {
    download: { navigation: { ok: true } },
    dateImport: { status: 'matched', source: 'takeout' },
  });
  assert.deepEqual(calls, ['download', 'resolveDates']);
});

test('conversation operation cancels after save and preserves save receipt', async () => {
  const controller = new AbortController();
  const result = await runOperation({
    abortSignal: controller.signal,
    deps: createDeps({
      save: async ({ payload }) => {
        controller.abort('after-save');
        return {
          filePath: `/tmp/${payload.chatId}.md`,
          receipt: { status: 'saved', mode: 'bridge' },
        };
      },
    }),
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'after-save');
  assert.deepEqual(result.receipts.save, { status: 'saved', mode: 'bridge' });
});

test('conversation operation maps non-string dependency error fields to string failure', async () => {
  const result = await runOperation({
    deps: createDeps({
      download: async () => {
        throw { code: 42, message: { nested: true } };
      },
    }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'conversation_operation_failed');
  assert.equal(typeof result.error, 'string');
});
