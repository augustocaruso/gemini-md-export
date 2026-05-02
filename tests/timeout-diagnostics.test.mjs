import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLayeredTimeoutError,
  decorateErrorWithTimeoutContext,
  formatTimeoutContext,
} from '../src/timeout-diagnostics.mjs';

test('timeout diagnostics carrega camada, operacao e trace no erro', () => {
  const err = createLayeredTimeoutError({
    code: 'job_timeout',
    layer: 'job',
    operation: 'follow-job',
    timeoutMs: 1000,
    elapsedMs: 1200,
    jobId: 'job-a',
    traceFile: '/tmp/job-a.trace.jsonl',
  });

  assert.equal(err.code, 'job_timeout');
  assert.equal(err.layer, 'job');
  assert.equal(err.data.timeout.jobId, 'job-a');
  assert.match(err.message, /camada: job/);
  assert.match(formatTimeoutContext(err.data.timeout), /trace:/);
});

test('timeout diagnostics decora erro existente sem apagar data anterior', () => {
  const err = new Error('bridge caiu');
  err.data = { cause: 'ECONNRESET' };
  decorateErrorWithTimeoutContext(err, {
    layer: 'bridge',
    operation: 'GET /healthz',
    timeoutMs: 1000,
  });

  assert.equal(err.data.cause, 'ECONNRESET');
  assert.equal(err.data.timeout.layer, 'bridge');
});

