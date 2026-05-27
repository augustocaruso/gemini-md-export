import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runBrowserCommandWithClientRecovery,
  selectCommandClientLease,
  selectRecoveryCommandClientLease,
} from '../build/ts/mcp/command-lease.js';

test('command lease selection prefers replacement client after reconnect', () => {
  const oldClient = {
    clientId: 'old',
    tabId: 42,
    live: true,
    commandReady: false,
    recentCommandFailure: true,
    lastSeenAt: 100,
  };
  const nextClient = {
    clientId: 'next',
    tabId: 42,
    live: true,
    commandReady: true,
    recentCommandFailure: false,
    lastSeenAt: 200,
  };

  const lease = selectRecoveryCommandClientLease({
    selector: { tabId: 42 },
    error: { code: 'client_reconnected_during_command', replacementClientId: 'next' },
    pool: {
      current: oldClient,
      replacement: nextClient,
      sameTab: [oldClient, nextClient],
    },
  });

  assert.equal(lease.clientId, 'next');
  assert.equal(lease.reason, 'replacement');
});

test('command lease selection does not reuse a failing current client when same tab is connected', () => {
  const lease = selectCommandClientLease({
    selector: { tabId: 7 },
    pool: {
      current: {
        clientId: 'old',
        tabId: 7,
        live: true,
        commandReady: false,
        recentCommandFailure: true,
        lastSeenAt: 100,
      },
      sameTab: [
        {
          clientId: 'old',
          tabId: 7,
          live: true,
          commandReady: false,
          recentCommandFailure: true,
          lastSeenAt: 100,
        },
        {
          clientId: 'next',
          tabId: 7,
          live: true,
          commandReady: true,
          recentCommandFailure: false,
          lastSeenAt: 200,
        },
      ],
    },
  });

  assert.equal(lease.clientId, 'next');
  assert.equal(lease.reason, 'same-tab');
});

test('command runner dispatches only with a lease and retries on replacement lease', async () => {
  const oldClient = {
    clientId: 'old',
    tabId: 9,
    live: true,
    commandReady: true,
    recentCommandFailure: false,
    lastSeenAt: 100,
  };
  const nextClient = {
    clientId: 'next',
    tabId: 9,
    live: true,
    commandReady: true,
    recentCommandFailure: false,
    lastSeenAt: 200,
  };
  const dispatchedClientIds = [];

  const result = await runBrowserCommandWithClientRecovery({
    initialClient: oldClient,
    selector: { tabId: 9 },
    request: { type: 'get-chat-by-id', args: {} },
    getPool: ({ error }) => ({
      current: oldClient,
      replacement:
        error?.replacementClientId === 'next'
          ? nextClient
          : null,
      sameTab:
        error?.replacementClientId === 'next'
          ? [oldClient, nextClient]
          : [oldClient],
    }),
    dispatch: async (lease) => {
      dispatchedClientIds.push(lease.clientId);
      if (lease.clientId === 'old') {
        const error = new Error('reconnected');
        error.code = 'client_reconnected_during_command';
        error.replacementClientId = 'next';
        throw error;
      }
      return { ok: true };
    },
    isRecoverableError: (error) => error?.code === 'client_reconnected_during_command',
    describeError: (error) => ({
      code: error?.code,
      message: error?.message,
      replacementClientId: error?.replacementClientId,
    }),
    waitMs: 10,
    pollMs: 1,
  });

  assert.deepEqual(dispatchedClientIds, ['old', 'next']);
  assert.equal(result.lease.clientId, 'next');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.result, { ok: true });
});

test('command runner reports missing command client with a typed recovery code', async () => {
  await assert.rejects(
    () =>
      runBrowserCommandWithClientRecovery({
        initialClient: {
          clientId: 'old',
          tabId: 42,
          live: false,
          commandReady: false,
          recentCommandFailure: true,
          lastSeenAt: 100,
        },
        selector: { tabId: 42 },
        request: { type: 'get-chat-by-id', args: {} },
        getPool: () => ({
          current: null,
          sameTab: [],
          fallback: null,
        }),
        dispatch: async () => ({ ok: true }),
        isRecoverableError: () => false,
        describeError: () => ({}),
        waitMs: 10,
        pollMs: 1,
      }),
    (error) => {
      assert.equal(error.code, 'no_command_client_available');
      assert.match(error.message, /Nenhum cliente de comando do Gemini/);
      return true;
    },
  );
});
