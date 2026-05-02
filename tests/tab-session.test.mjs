import test from 'node:test';
import assert from 'node:assert/strict';

import { createTabSessionManager, summarizeTabSession } from '../src/tab-session.mjs';

test('tab session invalida epoca antiga quando nova sessao assume a mesma aba', () => {
  let ids = 0;
  const manager = createTabSessionManager({
    idFactory: () => `id-${++ids}`,
    clock: () => '2026-05-02T00:00:00.000Z',
  });
  const client = { clientId: 'client-a', tabId: 123, windowId: 9 };

  const first = manager.createSession({ client, claim: { claimId: 'claim-1' }, purpose: 'count' });
  const second = manager.createSession({ client, claim: { claimId: 'claim-2' }, purpose: 'export' });

  assert.equal(first.state, 'superseded');
  assert.equal(first.supersededBy, second.sessionId);
  assert.equal(manager.assertCurrent(first, client).code, 'tab_session_superseded');
  assert.equal(manager.assertCurrent(second, client).ok, true);
});

test('tab session registra cleanup verificavel antes de finalizar', () => {
  const manager = createTabSessionManager({
    idFactory: () => 'stable',
    clock: () => '2026-05-02T00:00:00.000Z',
  });
  const session = manager.createSession({
    client: { clientId: 'client-a', tabId: 456 },
    claim: { claimId: 'claim-a' },
    purpose: 'sync',
    jobId: 'job-a',
  });

  manager.startOperation(session, 'load-more-conversations');
  manager.finishOperation(session, { ok: true });
  manager.recordCleanup(session, 'tab-claim-release', { ok: true, reason: 'job-completed' });
  manager.finishSession(session, { reason: 'job-completed' });

  const summary = summarizeTabSession(session);
  assert.equal(summary.state, 'released');
  assert.equal(summary.cleanup.length, 2);
  assert.equal(summary.cleanup[1].step, 'tab-claim-release');
});

