import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertClaimableGeminiTab,
  classifyGeminiClientLifecycle,
  getClaimableGeminiTabs,
  getGeminiClientLifecycle,
  toClaimableGeminiTab,
  toClaimedReadyGeminiTab,
} from '../build/ts/mcp/client-lifecycle.js';

const baseClient = {
  clientId: 'chat-active',
  kind: 'chat',
  tabId: 123,
  isActiveTab: true,
  lastHeartbeatAt: 1_000,
  lastSeenAt: 1_100,
  extensionVersion: '0.8.53',
  protocolVersion: 2,
  buildStamp: '20260520-0238',
  commandReady: true,
  recentCommandFailure: false,
  page: {
    url: 'https://gemini.google.com/app/88a98a108cdcfb61',
    pathname: '/app/88a98a108cdcfb61',
    chatId: '88a98a108cdcfb61',
    buildStamp: '20260520-0238',
  },
};

const options = {
  now: 1_500,
  staleAfterMs: 45_000,
  hydrationGraceMs: 4_000,
  expectedExtensionVersion: '0.8.53',
  expectedProtocolVersion: 2,
  expectedBuildStamp: '20260520-0238',
  requireCommandReady: true,
  sessionId: 'session-a',
  claims: [],
};

test('classifies an active ready Gemini tab as claimable', () => {
  const state = getGeminiClientLifecycle(baseClient, options);

  assert.equal(state.state, 'claimable');
  assert.equal(state.ok, true);
  assert.equal(state.client.clientId, 'chat-active');
});

test('splits missing page from dead clients', () => {
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: null,
        lastHeartbeatAt: -10_000,
        lastSeenAt: -10_000,
      },
      options,
    ).state,
    'transport_connected',
  );
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        lastHeartbeatAt: 1_000,
      },
      {
        ...options,
        now: 60_000,
      },
    ).state,
    'dead',
  );
});

test('classifies fresh missing page as warming up when connected recently', () => {
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: null,
        lastSeenAt: 1_300,
      },
      options,
    ).state,
    'warming_up',
  );
});

test('rejects version, protocol and build mismatches with specific codes', () => {
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, extensionVersion: '0.0.1' }, options).code,
    'extension_version_mismatch',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, protocolVersion: 1 }, options).code,
    'extension_protocol_mismatch',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, buildStamp: 'old' }, options).code,
    'extension_build_mismatch',
  );
});

test('rejects inactive, non-Gemini, unhydrated, command-unready and busy clients', () => {
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, isActiveTab: false }, options).code,
    'inactive_tab',
  );
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: { url: 'https://example.com/' },
      },
      options,
    ).code,
    'page_not_gemini',
  );
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: { url: 'https://gemini.google.com/app', pathname: '/app' },
      },
      options,
    ).code,
    'page_not_hydrated',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, commandReady: false }, options).code,
    'command_channel_unready',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, tabOperationInProgress: true }, options).code,
    'tab_operation_in_progress',
  );
});

test('creates branded claimable and claimed-ready capabilities only after validation', () => {
  const claimable = toClaimableGeminiTab(baseClient, options);
  assert.equal(claimable.clientId, 'chat-active');

  const claimed = toClaimedReadyGeminiTab(baseClient, {
    ...options,
    claims: [
      {
        claimId: 'claim-a',
        clientId: 'chat-active',
        sessionId: 'session-a',
        tabId: 123,
        expiresAtMs: 10_000,
      },
    ],
  });
  assert.equal(claimed.claim.claimId, 'claim-a');
});

test('claimed-ready rejects missing and conflicting claims', () => {
  assert.equal(
    getGeminiClientLifecycle(baseClient, {
      ...options,
      requireClaimed: true,
      claims: [],
    }).code,
    'claim_missing',
  );
  assert.equal(
    getGeminiClientLifecycle(baseClient, {
      ...options,
      requireClaimed: true,
      claims: [
        {
          claimId: 'claim-b',
          clientId: 'chat-active',
          sessionId: 'other-session',
          tabId: 123,
          expiresAtMs: 10_000,
        },
      ],
    }).code,
    'claim_conflict',
  );
});

test('list helper returns only claimable Gemini tabs', () => {
  const result = getClaimableGeminiTabs(
    [
      baseClient,
      { ...baseClient, clientId: 'inactive', isActiveTab: false },
      {
        ...baseClient,
        clientId: 'activity',
        kind: 'activity',
        page: { url: 'https://myactivity.google.com/product/gemini' },
      },
    ],
    options,
  );

  assert.deepEqual(
    result.map((client) => client.clientId),
    ['chat-active'],
  );
});

test('assert helper throws structured lifecycle data', () => {
  assert.throws(
    () => assertClaimableGeminiTab({ ...baseClient, isActiveTab: false }, options),
    (error) => error.code === 'inactive_tab' && error.data?.lifecycle?.state === 'page_unready',
  );
});

test('classify helper exposes compact diagnostics for raw clients', () => {
  const classified = classifyGeminiClientLifecycle(
    [
      baseClient,
      { ...baseClient, clientId: 'old-build', buildStamp: 'old' },
    ],
    options,
  );

  assert.deepEqual(
    classified.map((item) => [item.client.clientId, item.lifecycle.state, item.lifecycle.code]),
    [
      ['chat-active', 'claimable', null],
      ['old-build', 'extension_mismatch', 'extension_build_mismatch'],
    ],
  );
});
