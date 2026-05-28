import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeRequestBlocksIdle,
  transitionBridgeIdleLifecycle,
} from '../build/ts/mcp/bridge-idle-lifecycle.js';

test('bridge idle lifecycle treats diagnostics and stale event streams as non-blocking', () => {
  assert.equal(
    bridgeRequestBlocksIdle(
      { method: 'GET', pathname: '/healthz', clientId: null },
      false,
    ),
    false,
  );
  assert.equal(
    bridgeRequestBlocksIdle(
      { method: 'GET', pathname: '/bridge/events', clientId: 'stale-client' },
      false,
    ),
    false,
  );
  assert.equal(
    bridgeRequestBlocksIdle(
      { method: 'GET', pathname: '/bridge/events', clientId: 'live-client' },
      true,
    ),
    true,
  );
});

test('bridge idle lifecycle emits shutdown only after keepalive without blockers', () => {
  const decision = transitionBridgeIdleLifecycle({
    exitWhenIdle: true,
    keepAliveMs: 1000,
    now: 2500,
    lastActivityAt: 1000,
    lastChromeHeartbeatAt: null,
    activeRequestCount: 7,
    activeRequestBlockerCount: 0,
    activeJobCount: 0,
    liveClientCount: 0,
  });

  assert.equal(decision.state, 'ready_to_shutdown');
  assert.deepEqual(decision.effects, ['shutdown']);
  assert.equal(decision.snapshot.activeRequestCount, 7);
  assert.equal(decision.snapshot.activeRequestBlockerCount, 0);
  assert.deepEqual(decision.snapshot.blockedBy, []);
});

test('bridge idle lifecycle blocks on real work and schedules another check', () => {
  const decision = transitionBridgeIdleLifecycle({
    exitWhenIdle: true,
    keepAliveMs: 1000,
    now: 2500,
    lastActivityAt: 1000,
    lastChromeHeartbeatAt: 1800,
    activeRequestCount: 2,
    activeRequestBlockerCount: 1,
    activeJobCount: 0,
    liveClientCount: 1,
  });

  assert.equal(decision.state, 'blocked');
  assert.deepEqual(decision.effects, ['schedule_check']);
  assert.deepEqual(decision.snapshot.blockedBy, [
    'active_request',
    'recent_extension_heartbeat',
  ]);
  assert.equal(decision.snapshot.heartbeatAgeMs, 700);
});
