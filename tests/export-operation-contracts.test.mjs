import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExportBatchTargets,
  buildOperationId,
  isTerminalOperationStatus,
  makeOperationProgressSnapshot,
  operationResultFromError,
} from '../build/ts/mcp/export-operation-contracts.js';

test('buildExportBatchTargets separates batch position from history index', () => {
  const targets = buildExportBatchTargets(
    [
      { conversation: { chatId: 'aaa111aaa111', title: 'Primeira' }, index: 6 },
      { conversation: { id: 'bbb222bbb222', title: 'Segunda' }, index: 7 },
    ],
    { batchTotal: 2, source: 'sidebar' },
  );

  assert.deepEqual(targets, [
    {
      batchPosition: 1,
      batchTotal: 2,
      historyIndex: 6,
      targetChatId: 'aaa111aaa111',
      title: 'Primeira',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/aaa111aaa111',
    },
    {
      batchPosition: 2,
      batchTotal: 2,
      historyIndex: 7,
      targetChatId: 'bbb222bbb222',
      title: 'Segunda',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/bbb222bbb222',
    },
  ]);
});

test('buildExportBatchTargets canonicalizes raw or prefixed URL values', () => {
  const targets = buildExportBatchTargets([
    {
      conversation: {
        chatId: 'b8e7c075effe9457',
        title: 'Prefixado',
        url: 'c_B8E7C075EFFE9457',
      },
      index: 1,
    },
    {
      conversation: {
        chatId: 'abcdef0123456789',
        title: 'Cru',
        url: 'ABCDEF0123456789',
      },
      index: 2,
    },
  ]);

  assert.equal(targets[0].url, 'https://gemini.google.com/app/b8e7c075effe9457');
  assert.equal(targets[1].url, 'https://gemini.google.com/app/abcdef0123456789');
});

test('buildExportBatchTargets compacts positions and totals after filtering invalid conversations', () => {
  const targets = buildExportBatchTargets([
    { conversation: { title: 'Sem ID' }, index: 1 },
    { conversation: { chatId: 'aaa111aaa111', title: 'Valida' }, index: 2 },
  ]);

  assert.deepEqual(targets, [
    {
      batchPosition: 1,
      batchTotal: 1,
      historyIndex: 2,
      targetChatId: 'aaa111aaa111',
      title: 'Valida',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/aaa111aaa111',
    },
  ]);

  const explicitTotalTargets = buildExportBatchTargets(
    [
      { conversation: { title: 'Sem ID' }, index: 1 },
      { conversation: { chatId: 'bbb222bbb222', title: 'Valida' }, index: 2 },
    ],
    { batchTotal: 10 },
  );

  assert.equal(explicitTotalTargets[0].batchPosition, 1);
  assert.equal(explicitTotalTargets[0].batchTotal, 10);
});

test('buildExportBatchTargets falls back for invalid or non-positive explicit batch totals', () => {
  for (const batchTotal of ['x', Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const targets = buildExportBatchTargets(
      [
        { conversation: { title: 'Sem ID' }, index: 1 },
        { conversation: { chatId: 'aaa111aaa111', title: 'Primeira' }, index: 2 },
        { conversation: { chatId: 'bbb222bbb222', title: 'Segunda' }, index: 3 },
      ],
      { batchTotal },
    );

    assert.equal(targets[0].batchTotal, 2);
    assert.equal(targets[1].batchTotal, 2);
  }
});

test('buildExportBatchTargets treats whitespace-only history indexes as missing', () => {
  const targets = buildExportBatchTargets([
    { conversation: { chatId: 'aaa111aaa111', title: 'Sem indice' }, index: '   ' },
  ]);

  assert.equal(targets[0].historyIndex, null);
});

test('operation ids are deterministic and safe for traces', () => {
  assert.equal(
    buildOperationId({
      jobId: 'job-12345678',
      batchPosition: 25,
      targetChatId: 'abcdef0123456789',
    }),
    'job-12345678:025:abcdef0123456789',
  );
});

test('makeOperationProgressSnapshot emits canonical count fields only', () => {
  const snapshot = makeOperationProgressSnapshot({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    phase: 'hydrating',
    status: 'running',
    target: {
      batchPosition: 1,
      batchTotal: 30,
      historyIndex: 6,
      targetChatId: 'aaa111aaa111',
      title: 'Caso CPRE',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/aaa111aaa111',
    },
    message: 'Carregando início da conversa',
    now: 1000,
  });

  assert.equal(snapshot.batchPosition, 1);
  assert.equal(snapshot.batchTotal, 30);
  assert.equal(snapshot.historyIndex, 6);
  assert.equal(snapshot.message, 'Carregando início da conversa');
  assert.equal(snapshot.targetChatId, 'aaa111aaa111');
  assert.equal(snapshot.lastProgressAt, 1000);
});

test('terminal status and error result helpers are stable', () => {
  assert.equal(isTerminalOperationStatus('saved'), true);
  assert.equal(isTerminalOperationStatus('failed'), true);
  assert.equal(isTerminalOperationStatus('running'), false);

  const err = Object.assign(new Error('travou'), { code: 'conversation_no_progress_timeout' });
  assert.deepEqual(
    operationResultFromError({
      operationId: 'op-1',
      targetChatId: 'aaa111aaa111',
      error: err,
      receipts: { navigation: { ok: false } },
    }),
    {
      status: 'failed',
      operationId: 'op-1',
      chatId: 'aaa111aaa111',
      code: 'conversation_no_progress_timeout',
      error: 'travou',
      receipts: { navigation: { ok: false } },
    },
  );
});

test('operationResultFromError guards non-string code and message values', () => {
  const result = operationResultFromError({
    operationId: 'op-2',
    targetChatId: 'bbb222bbb222',
    error: { code: 123, message: { nested: true } },
  });

  assert.deepEqual(result, {
    status: 'failed',
    operationId: 'op-2',
    chatId: 'bbb222bbb222',
    code: 'conversation_operation_failed',
    error: '[object Object]',
    receipts: {},
  });
});
