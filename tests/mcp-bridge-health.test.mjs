import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBridgeHealth,
} from '../build/ts/mcp/bridge-health.js';
import {
  evaluateBrowserReadiness,
} from '../build/ts/mcp/browser-readiness.js';

const baseClient = {
  clientId: 'chat-active',
  kind: 'chat',
  tabId: 123,
  isActiveTab: true,
  lastHeartbeatAt: 1_000,
  lastSeenAt: 1_000,
  extensionVersion: '0.8.53',
  protocolVersion: 2,
  buildStamp: '20260520-0453',
  commandReady: true,
  page: {
    url: 'https://gemini.google.com/app/88a98a108cdcfb61',
    pathname: '/app/88a98a108cdcfb61',
    chatId: '88a98a108cdcfb61',
  },
};

test('bridge health reports terminal Google blocker before extension mismatch', () => {
  const health = evaluateBridgeHealth(
    {
      ...baseClient,
      kind: 'blocker',
      extensionVersion: 'old',
      protocolVersion: 1,
      buildStamp: 'old',
      page: {
        url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app',
        pathname: '/sorry/index',
        kind: 'blocker',
        blocker: {
          code: 'google_verification_required',
          terminal: true,
          nextAction: 'Resolva a verificacao no navegador e tente novamente.',
        },
      },
    },
    {
      now: 1_500,
      staleAfterMs: 45_000,
      degradedHeartbeatMs: 10_000,
      versionMatches: false,
      eventStreamConnected: false,
      longPollConnected: false,
      pagePolling: null,
      queuedCommands: 0,
      recentCommandFailure: false,
    },
  );

  assert.equal(health.status, 'blocked');
  assert.equal(health.blockingIssue, 'google_verification_required');
  assert.equal(health.clientKind, 'blocker');
});

test('bridge health reports command channel stuck after blocker and version checks pass', () => {
  const health = evaluateBridgeHealth(baseClient, {
    now: 1_500,
    staleAfterMs: 45_000,
    degradedHeartbeatMs: 10_000,
    versionMatches: true,
    eventStreamConnected: false,
    longPollConnected: false,
    pagePolling: false,
    queuedCommands: 0,
    recentCommandFailure: false,
  });

  assert.equal(health.status, 'command_channel_stuck');
  assert.equal(health.blockingIssue, 'command_channel_stuck');
});

test('bridge health treats a fresh snapshot as a runtime signal without requiring heartbeat', () => {
  const health = evaluateBridgeHealth(
    {
      ...baseClient,
      lastHeartbeatAt: null,
      lastSnapshotAt: 1_400,
    },
    {
      now: 1_500,
      staleAfterMs: 45_000,
      degradedHeartbeatMs: 10_000,
      versionMatches: true,
      eventStreamConnected: true,
      longPollConnected: false,
      pagePolling: false,
      queuedCommands: 0,
      recentCommandFailure: false,
    },
  );

  assert.equal(health.status, 'healthy');
  assert.equal(health.blockingIssue, null);
  assert.equal(health.heartbeatAgeMs, null);
  assert.equal(health.runtimeSignalAgeMs, 100);
});

test('browser readiness requires at least one claimable Gemini tab', () => {
  const readiness = evaluateBrowserReadiness({
    allLiveClients: [baseClient],
    selectableClients: [baseClient],
    matchingClients: [baseClient],
    commandReadyClients: [baseClient],
    claimableClients: [],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockingIssue, 'no_active_claimable_gemini_tab');
  assert.equal(readiness.claimableTabCount, 0);
});

test('browser readiness reports Google blocker before generic command readiness', () => {
  const blockerClient = {
    ...baseClient,
    clientId: 'blocked',
    kind: 'blocker',
    commandReady: false,
    page: {
      url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app',
      blocker: {
        code: 'google_verification_required',
        terminal: true,
      },
    },
  };
  const readiness = evaluateBrowserReadiness({
    allLiveClients: [blockerClient],
    selectableClients: [],
    matchingClients: [blockerClient],
    commandReadyClients: [],
    claimableClients: [],
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockingIssue, 'google_verification_required');
});
