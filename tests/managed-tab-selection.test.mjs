import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManagedChatClientSelection } from '../build/ts/mcp/managed-tab-selection.js';

const expected = {
  extensionVersion: '0.8.56',
  buildStamp: '20260528-lease',
  protocolVersion: 2,
};

const clientDeps = {
  normalizeTabId: (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  },
  clientBuildStamp: (client) => client.buildStamp,
  clientCommandEventStreamUsable: (client) => client.eventStreamConnected === true,
  commandChannelReadyForClient: (client) => client.commandReady === true,
};

const chatClient = (overrides = {}) => ({
  clientId: 'chat-client',
  tabId: 41,
  page: { kind: 'chat', url: 'https://gemini.google.com/app/abc123abc123' },
  extensionVersion: expected.extensionVersion,
  buildStamp: expected.buildStamp,
  protocolVersion: expected.protocolVersion,
  lastSeenAt: 1000,
  eventStreamConnected: true,
  commandReady: true,
  ...overrides,
});

const selection = (overrides = {}) =>
  buildManagedChatClientSelection({
    selector: {},
    purpose: 'export-recent',
    processSessionId: 'session-1',
    expected,
    clients: [chatClient()],
    clientDeps,
    nowMs: 1100,
    ...overrides,
  });

test('managed tab selection reuses a client leased to the same claim', () => {
  const client = chatClient({ tabClaim: { claimId: 'claim-1' } });
  const result = selection({
    selector: { claimId: 'claim-1' },
    clients: [client],
    explicitClaim: { claimId: 'claim-1', clientId: client.clientId, tabId: client.tabId },
    explicitClaimClient: client,
  });

  assert.equal(result.ok, true);
  assert.equal(result.client.clientId, 'chat-client');
  assert.equal(result.claimId, 'claim-1');
});

test('managed tab selection blocks a tab leased to another claim', () => {
  const result = selection({
    clients: [chatClient({ tabClaim: { claimId: 'other-claim' } })],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_ready_tab_for_purpose');
  assert.equal(result.tabOrchestrator.ready, false);
});

test('managed tab selection rejects activity clients for chat commands', () => {
  const result = selection({
    clients: [
      chatClient({
        clientId: 'activity-client',
        tabId: 42,
        page: { kind: 'activity', url: 'https://myactivity.google.com/product/gemini' },
      }),
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_ready_tab_for_purpose');
});

test('managed recent chat selection prefers the only tab with loaded recent inventory', () => {
  const useful = chatClient({
    clientId: 'useful-recent-tab',
    tabId: 51,
    page: { kind: 'chat', url: 'https://gemini.google.com/app' },
    recentCount: 293,
  });
  const empty = chatClient({
    clientId: 'empty-tab',
    tabId: 52,
    page: { kind: 'chat', url: 'https://gemini.google.com/app' },
    recentCount: 0,
  });

  const result = selection({
    candidateMode: 'recent-chats',
    clients: [empty, useful],
    recentConversationCountForClient: (client) => client.recentCount || 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.client.clientId, 'useful-recent-tab');
});

test('managed recent chat selection stays ambiguous when multiple tabs have useful inventory', () => {
  const result = selection({
    candidateMode: 'recent-chats',
    clients: [
      chatClient({ clientId: 'recent-a', tabId: 61, recentCount: 12 }),
      chatClient({ clientId: 'recent-b', tabId: 62, recentCount: 15 }),
    ],
    recentConversationCountForClient: (client) => client.recentCount || 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ambiguous_tabs');
});
