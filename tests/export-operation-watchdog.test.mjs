import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateConversationOperationWatchdog } from '../build/ts/mcp/export-operation-watchdog.js';

const assertSafeContinue = (decision) => {
  assert.equal(decision.action, 'continue');
  assert.equal(Number.isFinite(decision.elapsedMs), true);
  assert.equal(decision.elapsedMs >= 0, true);
};

test('watchdog allows fresh progress', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 10_000,
      lastProgressAt: 8_000,
      noProgressMs: 5_000,
      cancelRequested: false,
    }),
    { action: 'continue', elapsedMs: 2000 },
  );
});

test('watchdog treats invalid timestamps as safe non-terminal progress', () => {
  assertSafeContinue(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: Number.NaN,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: true,
    }),
  );

  assertSafeContinue(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 20_000,
      lastProgressAt: Number.POSITIVE_INFINITY,
      noProgressMs: 5_000,
      cancelRequested: true,
    }),
  );
});

test('watchdog treats invalid or non-positive timeout thresholds as safe non-terminal progress', () => {
  for (const noProgressMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assertSafeContinue(
      evaluateConversationOperationWatchdog({
        operationId: 'op-1',
        now: 20_000,
        lastProgressAt: 10_000,
        noProgressMs,
        cancelRequested: true,
      }),
    );
  }
});

test('watchdog clamps clock skew to finite non-terminal elapsed time', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 8_000,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: true,
    }),
    { action: 'continue', elapsedMs: 0 },
  );
});

test('watchdog fails a silent operation and preserves code', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 20_000,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: false,
    }),
    {
      action: 'fail',
      elapsedMs: 10000,
      code: 'conversation_no_progress_timeout',
      message: 'Conversa sem progresso por 10s.',
    },
  );
});

test('watchdog reports positive subsecond terminal elapsed time in milliseconds', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 1002,
      lastProgressAt: 1000,
      noProgressMs: 1,
      cancelRequested: false,
    }),
    {
      action: 'fail',
      elapsedMs: 2,
      code: 'conversation_no_progress_timeout',
      message: 'Conversa sem progresso por 2ms.',
    },
  );
});

test('watchdog cancels silently stuck operation after job cancel', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 20_000,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: true,
    }),
    {
      action: 'cancel',
      elapsedMs: 10000,
      code: 'conversation_cancelled_after_no_progress',
      message: 'Cancelamento solicitado; operação sem progresso por 10s.',
    },
  );
});
