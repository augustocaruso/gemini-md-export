import test from 'node:test';
import assert from 'node:assert/strict';

import * as tabRuntime from '../build/ts/mcp/tab-runtime.js';

const {
  clientHasLiveRuntimeEvidence,
  selectReconnectSourcesForTab,
  shouldIncludeHeartbeatJobProgress,
} = tabRuntime;

test('tab reconnect aborts every older command client for the durable tab', () => {
  const selected = selectReconnectSourcesForTab({
    nextClient: {
      clientId: 'next',
      tabId: 42,
      conversationCount: 1,
      lastSeenAt: 400,
    },
    candidates: [
      {
        clientId: 'old-original',
        tabId: 42,
        conversationCount: 291,
        hasPendingCommand: false,
        lastSeenAt: 100,
      },
      {
        clientId: 'old-command',
        tabId: 42,
        conversationCount: 1,
        hasPendingCommand: true,
        lastSeenAt: 300,
      },
      {
        clientId: 'other-tab',
        tabId: 99,
        conversationCount: 999,
        hasPendingCommand: true,
        lastSeenAt: 500,
      },
    ],
  });

  assert.deepEqual(selected.abortClientIds.sort(), ['old-command', 'old-original']);
  assert.equal(selected.cacheSourceClientId, 'old-original');
});

test('tab reconnect can match by claim when tabId is not available yet', () => {
  const selected = selectReconnectSourcesForTab({
    nextClient: {
      clientId: 'next',
      tabId: null,
      claimId: 'claim-1',
      sessionId: 'session-1',
      lastSeenAt: 400,
    },
    candidates: [
      {
        clientId: 'old-command',
        tabId: null,
        claimId: 'claim-1',
        sessionId: 'session-1',
        hasPendingCommand: true,
        lastSeenAt: 300,
      },
      {
        clientId: 'wrong-claim',
        tabId: null,
        claimId: 'claim-2',
        sessionId: 'session-1',
        hasPendingCommand: true,
        lastSeenAt: 350,
      },
    ],
  });

  assert.deepEqual(selected.abortClientIds, ['old-command']);
  assert.equal(selected.cacheSourceClientId, 'old-command');
});

test('active job progress is included in heartbeat even when SSE is connected', () => {
  assert.equal(
    shouldIncludeHeartbeatJobProgress({
      hasJobProgress: true,
      status: 'running',
      eventStreamUsable: true,
    }),
    true,
  );
});

test('stale terminal job progress is not included in heartbeat', () => {
  assert.equal(
    shouldIncludeHeartbeatJobProgress({
      hasJobProgress: true,
      status: 'completed',
      eventStreamUsable: true,
      terminalAgeMs: 31_000,
      terminalTtlMs: 30_000,
    }),
    false,
  );
});

test('event stream alone is not enough to make a browser client live', () => {
  assert.equal(
    clientHasLiveRuntimeEvidence(
      {
        clientId: 'old-event-stream-only',
        lastSeenAt: 2_000,
        extensionVersion: '0.8.53',
        protocolVersion: 2,
        buildStamp: 'old-build',
      },
      {
        now: 2_100,
        staleAfterMs: 45_000,
        warmupGraceMs: 4_000,
        eventStreamConnected: true,
        expectedExtensionVersion: '0.8.53',
        expectedProtocolVersion: 2,
        expectedBuildStamp: 'new-build',
      },
    ),
    false,
  );
});

test('fresh event stream can be live only when it carries concrete tab evidence', () => {
  assert.equal(
    clientHasLiveRuntimeEvidence(
      {
        clientId: 'fresh-tab-runtime',
        tabId: 42,
        lastSeenAt: 2_000,
        extensionVersion: '0.8.53',
        protocolVersion: 2,
        buildStamp: 'new-build',
      },
      {
        now: 2_100,
        staleAfterMs: 45_000,
        warmupGraceMs: 4_000,
        eventStreamConnected: true,
        expectedExtensionVersion: '0.8.53',
        expectedProtocolVersion: 2,
        expectedBuildStamp: 'new-build',
      },
    ),
    true,
  );
});

test('tab activation resolves only the requested browser tab target, never the broker', () => {
  assert.equal(typeof tabRuntime.resolveActivatedTargetClient, 'function');

  const broker = { clientId: 'activity-broker', tabId: 7, kind: 'activity' };
  const target = { clientId: 'chat-target', tabId: 42, kind: 'chat' };

  assert.equal(
    tabRuntime.resolveActivatedTargetClient({
      targetTabId: 42,
      activeClient: null,
      liveClient: null,
      preferredClient: target,
      brokerClient: broker,
    }),
    target,
  );
  assert.equal(
    tabRuntime.resolveActivatedTargetClient({
      targetTabId: 42,
      activeClient: null,
      liveClient: null,
      preferredClient: null,
      brokerClient: broker,
    }),
    null,
  );
});
