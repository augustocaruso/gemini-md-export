import test from 'node:test';
import assert from 'node:assert/strict';

import {
  finishActiveTabOperation,
  reapStaleActiveTabOperation,
  requestActiveTabOperationCancel,
  startActiveTabOperation,
  updateActiveTabOperationProgress,
} from '../build/ts/mcp/export-operation-lock.js';

const assertFiniteNonNegative = (value) => {
  assert.equal(Number.isFinite(value), true);
  assert.equal(value >= 0, true);
};

test('active tab operation is tied to operationId and progresses deterministically', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'opening',
    now: 1000,
  });

  assert.equal(active.operationId, 'op-1');
  assert.equal(active.phase, 'opening');
  assert.equal(active.lastProgressAt, 1000);

  const next = updateActiveTabOperationProgress(active, { phase: 'hydrating', now: 1500 });
  assert.equal(next.phase, 'hydrating');
  assert.equal(next.lastProgressAt, 1500);
});

test('cancel only affects matching operation when operationId is supplied', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'hydrating',
    now: 1000,
  });

  assert.deepEqual(requestActiveTabOperationCancel(active, { operationId: 'other', now: 1200 }), {
    active,
    cancelled: false,
    reason: 'operation-id-mismatch',
  });

  const result = requestActiveTabOperationCancel(active, {
    operationId: 'op-1',
    reason: 'tool-cancel',
    now: 1300,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.active.cancelRequestedAt, 1300);
  assert.equal(result.active.abortReason, 'tool-cancel');
});

test('cancel treats empty operationId as a supplied mismatching filter', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'hydrating',
    now: 1000,
  });

  assert.deepEqual(requestActiveTabOperationCancel(active, { operationId: '', now: 1200 }), {
    active,
    cancelled: false,
    reason: 'operation-id-mismatch',
  });
});

test('terminal operation clears lock and stale operation is reaped with receipt', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'hydrating',
    now: 1000,
  });

  assert.equal(finishActiveTabOperation(active, { operationId: 'op-1' }), null);
  assert.equal(finishActiveTabOperation(active, { operationId: 'other' }), active);

  const reaped = reapStaleActiveTabOperation(active, {
    now: 10_500,
    staleAfterMs: 9000,
  });
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.active, null);
  assert.equal(reaped.receipt.code, 'operation_lock_reaped');
});

test('finish treats empty operationId as a supplied mismatching filter', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'hydrating',
    now: 1000,
  });

  assert.equal(finishActiveTabOperation(active, { operationId: '' }), active);
});

test('active tab operation stores only finite non-negative timestamps', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'opening',
    now: Number.NaN,
  });
  assertFiniteNonNegative(active.startedAt);
  assertFiniteNonNegative(active.lastProgressAt);

  const updated = updateActiveTabOperationProgress(active, {
    phase: 'hydrating',
    now: Number.POSITIVE_INFINITY,
  });
  assertFiniteNonNegative(updated.lastProgressAt);

  const result = requestActiveTabOperationCancel(updated, {
    operationId: 'op-1',
    reason: 'tool-cancel',
    now: Number.NEGATIVE_INFINITY,
  });
  assert.equal(result.cancelled, true);
  assertFiniteNonNegative(result.active.cancelRequestedAt);
});

test('stale reaping ignores invalid or non-positive ttl values', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'hydrating',
    now: 1000,
  });

  for (const staleAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const result = reapStaleActiveTabOperation(active, {
      now: 100_000,
      staleAfterMs,
    });
    assert.equal(result.reaped, false);
    assert.equal(result.active.operationId, 'op-1');
    assert.equal(result.receipt, null);
  }
});

test('stale reaping sanitizes elapsed values and receipt ttl', () => {
  const active = {
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'hydrating',
    startedAt: Number.NaN,
    lastProgressAt: Number.NEGATIVE_INFINITY,
  };

  const reaped = reapStaleActiveTabOperation(active, {
    now: 10_500,
    staleAfterMs: 9000,
  });
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.active, null);
  assert.equal(reaped.receipt.code, 'operation_lock_reaped');
  assertFiniteNonNegative(reaped.receipt.elapsedMs);
  assertFiniteNonNegative(reaped.receipt.staleAfterMs);
});

test('stale reaping treats clock skew as non-negative elapsed time', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'hydrating',
    now: 1000,
  });

  const result = reapStaleActiveTabOperation(active, {
    now: 500,
    staleAfterMs: 1,
  });
  assert.equal(result.reaped, false);
  assert.equal(result.active.operationId, 'op-1');
  assert.equal(result.receipt, null);
});

test('progress timestamps are monotonic across clock skew', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'opening',
    now: 1000,
  });
  const progressed = updateActiveTabOperationProgress(active, {
    phase: 'hydrating',
    now: 10_000,
  });
  const skewed = updateActiveTabOperationProgress(progressed, {
    phase: 'extracting',
    now: 5000,
  });

  assert.equal(skewed.lastProgressAt, 10_000);

  const result = reapStaleActiveTabOperation(skewed, {
    now: 14_001,
    staleAfterMs: 8000,
  });
  assert.equal(result.reaped, false);
  assert.equal(result.active.operationId, 'op-1');
  assert.equal(result.receipt, null);
});
