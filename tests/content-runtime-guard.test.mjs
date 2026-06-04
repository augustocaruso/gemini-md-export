import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  transitionContentRuntimeGuard,
} from '../build/ts/browser/shared/content-runtime-guard.js';

const transition = (event) =>
  transitionContentRuntimeGuard(
    { tag: 'checking' },
    {
      type: 'evaluate-runtime',
      nowMs: 10_000,
      bootGraceMs: 1_000,
      staleHeartbeatMs: 2_000,
      ...event,
    },
  );

test('content runtime guard inicia bootstrap quando nao ha runtime existente', () => {
  assert.deepEqual(
    transition({ hasRuntime: false, sameBuild: false, sameProtocol: false }).effects,
    ['continue-bootstrap'],
  );
});

test('content runtime guard reaproveita runtime do mesmo build quando heartbeat esta vivo', () => {
  const result = transition({
    hasRuntime: true,
    sameBuild: true,
    sameProtocol: true,
    installedAt: 1_000,
    status: {
      bridge: {
        started: true,
        heartbeatTimerActive: true,
        lastHeartbeatAt: 9_500,
      },
    },
  });

  assert.equal(result.state.tag, 'same-signature-healthy');
  assert.deepEqual(result.effects, ['return-existing']);
});

test('content runtime guard tolera runtime recem instalada durante boot', () => {
  const result = transition({
    hasRuntime: true,
    sameBuild: true,
    sameProtocol: true,
    installedAt: 9_500,
    status: null,
  });

  assert.equal(result.state.tag, 'same-signature-booting');
  assert.deepEqual(result.effects, ['return-existing']);
});

test('content runtime guard substitui runtime do mesmo build quando heartbeat morreu', () => {
  const result = transition({
    hasRuntime: true,
    sameBuild: true,
    sameProtocol: true,
    installedAt: 1_000,
    status: {
      bridge: {
        started: true,
        heartbeatTimerActive: false,
        lastHeartbeatAt: 9_500,
      },
    },
  });

  assert.equal(result.state.tag, 'same-signature-stale');
  assert.deepEqual(result.effects, ['quiesce-existing', 'continue-bootstrap']);
});

test('content runtime guard substitui runtime do mesmo build quando heartbeat esta stale', () => {
  const result = transition({
    hasRuntime: true,
    sameBuild: true,
    sameProtocol: true,
    installedAt: 1_000,
    status: {
      bridge: {
        started: true,
        heartbeatTimerActive: true,
        lastHeartbeatAt: 6_000,
      },
    },
  });

  assert.equal(result.state.tag, 'same-signature-stale');
  assert.deepEqual(result.effects, ['quiesce-existing', 'continue-bootstrap']);
});
