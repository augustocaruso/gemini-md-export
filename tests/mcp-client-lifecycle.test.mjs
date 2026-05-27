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
    getGeminiClientLifecycle(
      { ...baseClient, buildStamp: 'old', page: { ...baseClient.page, buildStamp: 'old' } },
      options,
    ).code,
    'extension_build_mismatch',
  );
});

test('prefers page build stamp when service worker stamp is stale', () => {
  const state = getGeminiClientLifecycle(
    {
      ...baseClient,
      buildStamp: 'old-service-worker',
      page: {
        ...baseClient.page,
        buildStamp: options.expectedBuildStamp,
      },
    },
    options,
  );

  assert.equal(state.state, 'claimable');
  assert.equal(state.code, null);
});

test('prioritizes terminal Google blockers over extension mismatch diagnostics', () => {
  const state = getGeminiClientLifecycle(
    {
      ...baseClient,
      extensionVersion: '0.0.1',
      protocolVersion: 1,
      buildStamp: 'old',
      page: {
        url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app',
        pathname: '/sorry/index',
        blocker: {
          code: 'google_verification_required',
          kind: 'google_sorry',
          terminal: true,
        },
      },
    },
    options,
  );

  assert.equal(state.state, 'blocked');
  assert.equal(state.code, 'google_verification_required');
});

test('rejects inactive, non-Gemini, missing current chat, command-unready and busy clients', () => {
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
      {
        ...options,
        capability: 'current-chat',
      },
    ).code,
    'current_chat_required',
  );
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: {
          url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app',
          pathname: '/sorry/index',
          blocker: {
            code: 'google_verification_required',
            kind: 'google_sorry',
            terminal: true,
          },
        },
      },
      options,
    ).code,
    'google_verification_required',
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

test('allows inactive Gemini tab for explicit background export readiness', () => {
  const lifecycle = getGeminiClientLifecycle(
    { ...baseClient, isActiveTab: false },
    {
      ...options,
      allowInactiveTab: true,
      capability: 'recent-export',
    },
  );

  assert.equal(lifecycle.state, 'claimable');
  assert.equal(lifecycle.code, null);

  const claimed = getGeminiClientLifecycle(
    { ...baseClient, isActiveTab: false },
    {
      ...options,
      allowInactiveTab: true,
      capability: 'recent-export',
      requireClaimed: true,
      claims: [
        {
          claimId: 'claim-a',
          clientId: baseClient.clientId,
          sessionId: 'session-a',
          tabId: baseClient.tabId,
          expiresAtMs: 60_000,
        },
      ],
    },
  );

  assert.equal(claimed.state, 'claimed_ready');
  assert.equal(claimed.code, null);
});

test('accepts page-level active tab evidence when top-level tab state lags', () => {
  const lifecycle = getGeminiClientLifecycle(
    {
      ...baseClient,
      isActiveTab: false,
      page: {
        ...baseClient.page,
        isActiveTab: true,
      },
    },
    options,
  );

  assert.equal(lifecycle.state, 'claimable');
  assert.equal(lifecycle.code, null);
});

test('/app home is claimable for recent export but not current chat', () => {
  const homeClient = {
    ...baseClient,
    page: {
      url: 'https://gemini.google.com/app',
      pathname: '/app',
      chatId: null,
      listedConversationCount: 12,
      sidebarConversationCount: 12,
      buildStamp: '20260520-0238',
    },
  };

  assert.equal(
    getGeminiClientLifecycle(homeClient, {
      ...options,
      capability: 'current-chat',
    }).code,
    'current_chat_required',
  );

  const recent = getGeminiClientLifecycle(homeClient, {
    ...options,
    capability: 'recent-export',
  });
  assert.equal(recent.state, 'claimable');
  assert.equal(recent.code, null);
});

test('/app home with sidebar evidence keeps legacy default claimability', () => {
  const homeClient = {
    ...baseClient,
    page: {
      url: 'https://gemini.google.com/app',
      pathname: '/app',
      chatId: null,
      listedConversationCount: 12,
      sidebarConversationCount: 12,
      buildStamp: '20260520-0238',
    },
  };

  const lifecycle = getGeminiClientLifecycle(homeClient, options);

  assert.equal(lifecycle.state, 'claimable');
  assert.equal(lifecycle.code, null);
});

test('/app home without sidebar evidence can warm for recent export when command is ready', () => {
  const homeClient = {
    ...baseClient,
    page: {
      url: 'https://gemini.google.com/app',
      pathname: '/app',
      chatId: null,
      buildStamp: '20260520-0238',
    },
  };

  const recent = getGeminiClientLifecycle(homeClient, {
    ...options,
    capability: 'recent-export',
  });
  assert.equal(recent.state, 'claimable');
});

test('recent export only accepts exact Gemini app routes', () => {
  for (const pathname of ['/application', '/appfoo']) {
    const lifecycle = getGeminiClientLifecycle(
      {
        ...baseClient,
        page: {
          url: `https://gemini.google.com${pathname}`,
          pathname,
          chatId: null,
          listedConversationCount: 12,
          sidebarConversationCount: 12,
          buildStamp: '20260520-0238',
        },
      },
      {
        ...options,
        capability: 'recent-export',
      },
    );

    assert.equal(lifecycle.state, 'page_unready');
    assert.equal(lifecycle.code, 'page_not_hydrated');
  }
});

test('explicit current-chat app home rejection is not retryable', () => {
  const lifecycle = getGeminiClientLifecycle(
    {
      ...baseClient,
      page: {
        url: 'https://gemini.google.com/app',
        pathname: '/app',
        chatId: null,
        listedConversationCount: 12,
        sidebarConversationCount: 12,
        buildStamp: '20260520-0238',
      },
    },
    {
      ...options,
      capability: 'current-chat',
    },
  );

  assert.equal(lifecycle.state, 'page_unready');
  assert.equal(lifecycle.code, 'current_chat_required');
  assert.equal(lifecycle.retryable, false);
});

test('creates branded claimable and claimed-ready capabilities only after validation', () => {
  const claimable = toClaimableGeminiTab(baseClient, options);
  assert.equal(claimable.clientId, 'chat-active');
  assert.equal(claimable.lastRuntimeSignalAt, 1_100);
  assert.equal(Object.hasOwn(claimable, 'lastHeartbeatAt'), true);

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
  assert.equal(claimed.commandReady, true);
  assert.equal(claimed.lastRuntimeSignalAt, 1_100);
});

test('claimed-ready can be proven by runtime signal without requiring heartbeat', () => {
  const state = toClaimedReadyGeminiTab(
    {
      ...baseClient,
      lastHeartbeatAt: null,
      lastSeenAt: 1_400,
      commandReady: true,
    },
    {
      ...options,
      claims: [
        {
          claimId: 'claim-runtime',
          clientId: 'chat-active',
          sessionId: 'session-a',
          tabId: 123,
          expiresAtMs: 10_000,
        },
      ],
    },
  );

  assert.equal(state.clientId, 'chat-active');
  assert.equal(state.lastRuntimeSignalAt, 1_400);
  assert.equal(state.commandReady, true);
});

test('claimable tab can be proven by fresh snapshot without heartbeat', () => {
  const state = toClaimableGeminiTab(
    {
      ...baseClient,
      lastHeartbeatAt: null,
      lastSeenAt: null,
      lastSnapshotAt: 1_400,
    },
    options,
  );

  assert.equal(state.clientId, 'chat-active');
  assert.equal(state.lastRuntimeSignalAt, 1_400);
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
      {
        ...baseClient,
        clientId: 'old-build',
        buildStamp: 'old',
        page: { ...baseClient.page, buildStamp: 'old' },
      },
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
