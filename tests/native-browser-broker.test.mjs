import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canFallbackFromNativeBrowserBrokerFailure,
  createNativeBrowserBrokerClient,
  nativeBrowserBrokerFailureCode,
  shouldUseNativeBrowserBroker,
} from '../build/ts/mcp/native-browser-broker.js';
import {
  NATIVE_BROKER_WAKE_CAPABILITY,
  clientSupportsNativeBrokerWakeCommand,
  createNativeBrokerTabsActionRunner,
  selectNativeBrokerWakeClient,
  shouldAttemptNativeBrokerWake,
} from '../build/ts/mcp/native-release-gate.js';

test('native broker is preferred unless explicitly disabled', () => {
  assert.equal(shouldUseNativeBrowserBroker({ disabled: false }), true);
  assert.equal(shouldUseNativeBrowserBroker({ disabled: true }), false);
});

test('native broker client maps failed ipc to fallback-ready error', async () => {
  const client = createNativeBrowserBrokerClient({
    request: async () => {
      throw new Error('socket missing');
    },
  });

  const response = await client.listTabs({ allowFallback: true });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'native_broker_unavailable');
  assert.equal(response.allowFallback, true);
});

test('native broker failure policy allows fallback only for transport/runtime failures', async () => {
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      code: 'native_broker_unavailable',
      error: 'connect ECONNREFUSED /tmp/broker.sock',
    }),
    true,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      error: {
        code: 'extension_unavailable',
        message: 'A extensao ainda nao abriu a porta nativa do broker.',
      },
    }),
    true,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure(
      {
        ok: false,
        code: 'native_broker_unavailable',
      },
      { strict: true },
    ),
    false,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      code: 'claimed_debuggable_tab_required',
    }),
    false,
  );
});

test('native broker failure code prefers nested native-host error code', () => {
  assert.equal(
    nativeBrowserBrokerFailureCode({
      ok: false,
      code: 'outer',
      error: { code: 'extension_request_timeout' },
    }),
    'extension_request_timeout',
  );
});

test('native broker client sends tabs.reload with target payload', async () => {
  const calls = [];
  const client = createNativeBrowserBrokerClient({
    request: async (request) => {
      calls.push(request);
      return { id: request.id, ok: true, result: { ok: true, reloaded: 1 } };
    },
  });

  const response = await client.reload(
    { tabId: 42, claimId: 'claim-42' },
    { allowFallback: false },
  );

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'tabs.reload');
  assert.deepEqual(calls[0].payload, { tabId: 42, claimId: 'claim-42' });
});

test('native broker client sends extension self-heal command', async () => {
  const calls = [];
  const client = createNativeBrowserBrokerClient({
    request: async (request) => {
      calls.push(request);
      return { id: request.id, ok: true, result: { ok: true, injected: 1 } };
    },
  });

  const response = await client.selfHealContentScripts({ reason: 'release-gate', force: true });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'extension.selfHealContentScripts');
  assert.deepEqual(calls[0].payload, {
    reason: 'release-gate',
    force: true,
    timeoutMs: 30_000,
  });
});

test('native broker self-heal runner forwards targeted tab ids', async () => {
  const calls = [];
  const runner = createNativeBrokerTabsActionRunner({
    shouldUseNativeBrowserBroker: () => true,
    nativeBrowserBroker: {
      selfHealContentScripts: async (payload, options) => {
        calls.push({ payload, options });
        return { id: 'heal-1', ok: true, result: { ok: true, current: 1 } };
      },
    },
    nativeBrowserBrokerToolResult: (response, action) => ({
      action,
      ...(response.result || {}),
    }),
  });

  const response = await runner('selfHealContentScripts', {
    reason: 'post-reload',
    force: true,
    tabIds: [42],
    allowHttpBrowserFallback: true,
  });

  assert.equal(response.action, 'selfHealContentScripts');
  assert.deepEqual(calls, [
    {
      payload: {
        reason: 'post-reload',
        force: true,
        tabIds: [42],
      },
      options: { allowFallback: true },
    },
  ]);
});

test('native broker wake is attempted only for recoverable unavailable states with a live client', () => {
  assert.equal(
    shouldAttemptNativeBrokerWake({
      nativeBrokerStatus: {
        configured: true,
        available: false,
        code: 'native_broker_unavailable',
        message: 'connect ECONNREFUSED /tmp/gemini-md-export-native-broker.sock',
      },
      liveClientCount: 1,
    }),
    true,
  );
  assert.equal(
    shouldAttemptNativeBrokerWake({
      nativeBrokerStatus: {
        configured: true,
        available: false,
        code: 'native_broker_disconnected',
        message: 'Native host has exited.',
      },
      liveClientCount: 1,
    }),
    true,
  );
  assert.equal(
    shouldAttemptNativeBrokerWake({
      nativeBrokerStatus: {
        configured: true,
        available: true,
        code: null,
        message: 'Native broker conectado.',
      },
      liveClientCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldAttemptNativeBrokerWake({
      nativeBrokerStatus: {
        configured: true,
        available: false,
        code: 'native_broker_unavailable',
        message: 'connect ECONNREFUSED /tmp/gemini-md-export-native-broker.sock',
      },
      liveClientCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldAttemptNativeBrokerWake({
      nativeBrokerStatus: {
        configured: false,
        available: false,
        code: 'native_broker_disabled',
        message: 'Native broker desativado por configuracao.',
      },
      liveClientCount: 1,
    }),
    false,
  );
});

test('native broker wake targets only clients that announce the wake capability', () => {
  const clients = [
    { clientId: 'smoke', capabilities: ['snapshot', 'events'] },
    { clientId: 'real', capabilities: ['snapshot', NATIVE_BROKER_WAKE_CAPABILITY] },
  ];

  assert.equal(clientSupportsNativeBrokerWakeCommand(clients[0]), false);
  assert.equal(clientSupportsNativeBrokerWakeCommand(clients[1]), true);
  assert.equal(
    selectNativeBrokerWakeClient({
      clients,
      clientMatchesExpectedBrowserExtension: (client) => client.clientId === 'real',
      commandChannelReadyForClient: () => true,
    })?.clientId,
    'real',
  );
  assert.equal(
    selectNativeBrokerWakeClient({
      clients: [clients[0]],
      clientMatchesExpectedBrowserExtension: () => true,
      commandChannelReadyForClient: () => true,
    }),
    null,
  );
});
