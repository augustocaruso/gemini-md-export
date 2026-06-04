import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkPrivateSessionStatus,
  listPrivateChatsForClient,
} from '../build/ts/mcp/private-inventory-runtime.js';

const commandReadyClient = {
  clientId: 'chat-connected-without-tab-id',
  kind: 'chat',
  tabId: null,
  page: {
    url: 'https://gemini.google.com/app',
    pathname: '/app',
  },
};

const depsForCommandReadyClient = (events = []) => ({
  enqueueCommand: async (clientId, type, args, options) => {
    events.push({ clientId, type, args, options });
    return {
      ok: true,
      authenticated: true,
      transport: { source: 'browser-background' },
    };
  },
  commandChannelReadyForClient: (client) => client?.clientId === commandReadyClient.clientId,
  normalizeConversationChatId: () => null,
  summarizeClient: (client) => (client ? { clientId: client.clientId, tabId: client.tabId } : null),
  getSelectableGeminiClients: () => [],
  getCommandReadyGeminiClients: () => [commandReadyClient],
  normalizeClientSelector: (args = {}) => ({
    clientId: args.clientId || null,
    tabId: args.tabId ?? null,
    claimId: args.claimId || null,
    sessionId: args.sessionId || null,
  }),
  requireClient: () => {
    const err = new Error('Nenhuma aba do Gemini conectada à extensão.');
    err.code = 'browser_client_unavailable';
    throw err;
  },
  claimForSession: () => null,
});

const depsWithoutBrowserClient = () => ({
  enqueueCommand: async () => {
    throw new Error('should not enqueue');
  },
  commandChannelReadyForClient: () => false,
  normalizeConversationChatId: () => null,
  summarizeClient: (client) => (client ? { clientId: client.clientId, tabId: client.tabId } : null),
  getSelectableGeminiClients: () => [],
  getCommandReadyGeminiClients: () => [],
  normalizeClientSelector: (args = {}) => ({
    clientId: args.clientId || null,
    tabId: args.tabId ?? null,
    claimId: args.claimId || null,
    sessionId: args.sessionId || null,
  }),
  requireClient: () => {
    const err = new Error('Nenhuma aba do Gemini conectada à extensão.');
    err.code = 'browser_client_unavailable';
    throw err;
  },
  claimForSession: () => null,
});

test('session status can use native broker background when no content client is connected', async () => {
  const calls = [];
  const result = await checkPrivateSessionStatus(
    { waitMs: 5000, pythonFallback: false },
    {
      ...depsWithoutBrowserClient(),
      normalizeConversationChatId: (value) => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') return value.chatId || null;
        return null;
      },
      nativeBrowserBroker: {
        privateApiSessionStatus: async (payload, options) => {
          calls.push({ payload, options });
          return {
            ok: true,
            result: {
              ok: true,
              authenticated: true,
              transport: { source: 'browser-background-native-broker' },
            },
          };
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedAdapter, 'browserBackground');
  assert.equal(result.client, null);
  assert.deepEqual(calls, [
    {
      payload: { timeoutMs: 5000 },
      options: { allowFallback: true },
    },
  ]);
});

test('private inventory can list chats through native broker without a content client', async () => {
  const calls = [];
  const result = await listPrivateChatsForClient(
    null,
    { limit: 2, privateInventory: true, python: '__python_should_not_be_used__' },
    {
      ...depsWithoutBrowserClient(),
      normalizeConversationChatId: (value) => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') return value.chatId || null;
        return null;
      },
      nativeBrowserBroker: {
        privateApiListChats: async (payload, options) => {
          calls.push({ payload, options });
          return {
            ok: true,
            result: {
              ok: true,
              chats: [
                {
                  chatId: 'dbe5dd4b50b09c74',
                  title: 'Native broker chat',
                },
              ],
              transport: { source: 'browser-background-native-broker' },
            },
          };
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, 'browser-background');
  assert.equal(result.count, 1);
  assert.equal(result.conversations[0].chatId, 'dbe5dd4b50b09c74');
  assert.deepEqual(calls, [
    {
      payload: { limit: 2, timeoutMs: 30000 },
      options: { allowFallback: true },
    },
  ]);
});

test('session status can use a command-ready Gemini client even when native tabId is missing', async () => {
  const events = [];
  const result = await checkPrivateSessionStatus(
    { waitMs: 5000, python: '__python_should_not_be_used__' },
    depsForCommandReadyClient(events),
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedAdapter, 'browserBackground');
  assert.equal(result.client.clientId, commandReadyClient.clientId);
  assert.deepEqual(events.map((event) => event.type), ['private-api-session-status']);
});

test('session status honors an explicit clientId for a command-ready client without tabId', async () => {
  const events = [];
  const result = await checkPrivateSessionStatus(
    {
      clientId: commandReadyClient.clientId,
      waitMs: 5000,
      python: '__python_should_not_be_used__',
    },
    depsForCommandReadyClient(events),
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedAdapter, 'browserBackground');
  assert.equal(events[0].clientId, commandReadyClient.clientId);
});

test('session status can skip Python fallback when auth check is browser-first', async () => {
  const result = await checkPrivateSessionStatus(
    { waitMs: 5000, pythonFallback: false },
    depsWithoutBrowserClient(),
  );

  assert.equal(result.ok, false);
  assert.equal(result.selectedAdapter, null);
  assert.equal(result.client, null);
  assert.equal(
    result.attempts.some((attempt) => attempt.adapter === 'privateApiGeminiWebapi'),
    false,
  );
  assert.equal(result.nextAction.code, 'browser_session_not_connected');
});

test('session status reports stale extension runtime when native broker and content client are absent', async () => {
  const result = await checkPrivateSessionStatus(
    { waitMs: 5000, pythonFallback: false },
    {
      ...depsWithoutBrowserClient(),
      nativeBrowserBroker: {
        privateApiSessionStatus: async () => ({
          ok: false,
          code: 'native_broker_unavailable',
          message: 'connect ENOENT \\\\.\\pipe\\gemini-md-export-native-broker',
        }),
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.selectedAdapter, null);
  assert.equal(result.client, null);
  assert.equal(result.nextAction.code, 'extension_runtime_not_connected');
  assert.match(result.nextAction.message, /Recarregue a extensao/);
});
