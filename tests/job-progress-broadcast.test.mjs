import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJobProgressBroadcast,
  setClientJobProgress,
  TERMINAL_JOB_PROGRESS_TTL_MS,
  TERMINAL_JOB_STATUSES,
} from '../src/job-progress-broadcast.mjs';

test('jobProgress null por default', () => {
  const client = {};
  assert.equal(buildJobProgressBroadcast(client), null);
});

test('setClientJobProgress carimba updatedAt e expõe o snapshot via build', () => {
  const client = {};
  setClientJobProgress(
    client,
    {
      source: 'mcp',
      status: 'running',
      total: 10,
      current: 3,
      label: 'baixando 3/10',
    },
    1000,
  );

  const snapshot = buildJobProgressBroadcast(client, 1500);
  assert.equal(snapshot.source, 'mcp');
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.total, 10);
  assert.equal(snapshot.current, 3);
  assert.equal(snapshot.label, 'baixando 3/10');
  assert.equal(snapshot.updatedAt, 1000);
  assert.ok(!('_terminalAt' in snapshot));
});

test('setClientJobProgress(null) limpa o snapshot', () => {
  const client = {};
  setClientJobProgress(client, { status: 'running', total: 1, current: 0 }, 1000);
  setClientJobProgress(client, null);
  assert.equal(buildJobProgressBroadcast(client, 2000), null);
});

test('status terminal é entregue durante o TTL e limpo depois', () => {
  const client = {};
  setClientJobProgress(
    client,
    {
      source: 'mcp',
      status: 'completed',
      total: 5,
      current: 5,
      label: 'concluído',
    },
    1000,
  );

  const first = buildJobProgressBroadcast(client, 1100);
  assert.ok(first, 'primeiro broadcast deve manter terminal disponível');
  assert.equal(first.status, 'completed');

  const second = buildJobProgressBroadcast(client, 1100 + TERMINAL_JOB_PROGRESS_TTL_MS / 2);
  assert.ok(second, 'durante TTL ainda entrega terminal mesmo em heartbeats subsequentes');
  assert.equal(second.status, 'completed');

  const expired = buildJobProgressBroadcast(client, 1000 + TERMINAL_JOB_PROGRESS_TTL_MS + 1);
  assert.equal(expired, null, 'depois do TTL o snapshot terminal é limpo');
  assert.equal(client.jobProgress, null);
});

test('todos os status terminais cobertos', () => {
  for (const status of ['completed', 'completed_with_errors', 'failed', 'cancelled']) {
    assert.ok(TERMINAL_JOB_STATUSES.has(status), `${status} deveria ser terminal`);
  }
  assert.ok(!TERMINAL_JOB_STATUSES.has('running'));
});
