import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertActiveClaimableGeminiClient,
  getActiveClaimableGeminiClients,
  toRecentExportClaimableGeminiClient,
  toActiveClaimableGeminiClient,
} from '../build/ts/mcp/tab-selection.js';
import { getGeminiClientLifecycle } from '../build/ts/mcp/client-lifecycle.js';

const baseClient = {
  clientId: 'chat-active',
  tabId: 123,
  isActiveTab: true,
  lastHeartbeatAt: 1_000,
  extensionVersion: '0.8.53',
  protocolVersion: 2,
  buildStamp: '20260520-0238',
  commandReady: true,
  page: {
    url: 'https://gemini.google.com/app/88a98a108cdcfb61',
    chatId: '88a98a108cdcfb61',
  },
};

const options = {
  now: 1_500,
  staleAfterMs: 45_000,
  expectedExtensionVersion: '0.8.53',
  expectedProtocolVersion: 2,
  expectedBuildStamp: '20260520-0238',
};

test('active Gemini tab snapshot becomes a claimable client only after validation', () => {
  const claimable = toActiveClaimableGeminiClient(baseClient, options);

  assert.ok(claimable);
  assert.equal(claimable.clientId, 'chat-active');
  assert.equal(claimable.tabId, 123);
  assert.equal(claimable.isActiveTab, true);
});

test('recent export claimable helper accepts Gemini app home', () => {
  const claimable = toRecentExportClaimableGeminiClient(
    {
      ...baseClient,
      page: {
        url: 'https://gemini.google.com/app',
        pathname: '/app',
        chatId: null,
      },
    },
    options,
  );

  assert.ok(claimable);
  assert.equal(claimable.page.url, 'https://gemini.google.com/app');
});

test('inactive Gemini tab snapshot is rejected before claim/export', () => {
  const claimable = toActiveClaimableGeminiClient(
    {
      ...baseClient,
      clientId: 'chat-inactive',
      isActiveTab: false,
    },
    options,
  );

  assert.equal(claimable, null);
});

test('stale heartbeat snapshot is rejected before claim/export', () => {
  const claimable = toActiveClaimableGeminiClient(
    {
      ...baseClient,
      clientId: 'chat-stale',
      lastHeartbeatAt: 1_000,
    },
    {
      ...options,
      now: 50_500,
    },
  );

  assert.equal(claimable, null);
});

test('activity clients are rejected even when they have an active tab id', () => {
  const claimable = toActiveClaimableGeminiClient(
    {
      ...baseClient,
      clientId: 'activity-active',
      kind: 'activity',
      page: {
        url: 'https://myactivity.google.com/product/gemini',
      },
    },
    options,
  );

  assert.equal(claimable, null);
});

test('active Gemini tab is rejected when command channel is not ready', () => {
  const claimable = toActiveClaimableGeminiClient(
    {
      ...baseClient,
      clientId: 'chat-command-stuck',
      commandReady: false,
    },
    {
      ...options,
      requireCommandReady: true,
    },
  );

  assert.equal(claimable, null);
});

test('list helper returns only active claimable Gemini clients', () => {
  const claimable = getActiveClaimableGeminiClients(
    [
      baseClient,
      { ...baseClient, clientId: 'inactive', isActiveTab: false },
      { ...baseClient, clientId: 'stale', lastHeartbeatAt: 0 },
    ],
    options,
  );

  assert.deepEqual(
    claimable.map((client) => client.clientId),
    ['chat-active'],
  );
});

test('assert helper throws an actionable code for inactive tabs', () => {
  assert.throws(
    () =>
      assertActiveClaimableGeminiClient(
        {
          ...baseClient,
          isActiveTab: false,
        },
        options,
      ),
    /inactive_tab/,
  );
});

test('compat active-claimable guard uses lifecycle diagnostics', () => {
  const lifecycle = getGeminiClientLifecycle(
    {
      ...baseClient,
      isActiveTab: false,
    },
    options,
  );

  assert.equal(lifecycle.state, 'page_unready');
  assert.equal(lifecycle.code, 'inactive_tab');
});
