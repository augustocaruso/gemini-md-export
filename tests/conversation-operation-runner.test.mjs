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
  assert.deepEqual(
    progress.map((item) => item.phase),
    ['opening', 'resolving_dates', 'saving'],
  );
});

test('conversation operation fails before save when payload chat id does not match target', async () => {
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
      resolveDates: async ({ payload }) => ({ payload, receipt: { status: 'unmatched' } }),
      save: async () => {
        throw new Error('save should not run');
      },
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'payload_chat_id_mismatch');
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
