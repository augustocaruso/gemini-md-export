import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canFallbackFromNativeBrowserBrokerFailure,
  createNativeBrowserBrokerClient,
  nativeBrowserBrokerIpcTimeoutMs,
  nativeBrowserBrokerFailureCode,
  shouldUseNativeBrowserBroker,
} from '../build/ts/mcp/native-browser-broker.js';
import {
  NATIVE_BROKER_WAKE_CAPABILITY,
  clientSupportsNativeBrokerWakeCommand,
  createNativeBrokerTabsActionRunner,
  createTabClaimRelease,
  selectNativeBrokerWakeClient,
  shouldAttemptNativeBrokerWake,
} from '../build/ts/mcp/native-release-gate.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

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

test('native broker ipc timeout leaves room for structured extension timeout response', () => {
  assert.equal(
    nativeBrowserBrokerIpcTimeoutMs({
      id: 'native-1',
      protocolVersion: 1,
      command: 'tabs.reload',
      payload: { timeoutMs: 5000 },
    }),
    6500,
  );
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

test('tab claim release cleans a missing server claim through the live tab before native fallback', async () => {
  const calls = [];
  const releaseTabClaim = createTabClaimRelease({
    cleanupExpiredTabClaims: () => {},
    normalizeSessionId: (sessionId) => String(sessionId || 'default-session'),
    sessionClaims: { get: () => undefined, delete: () => calls.push(['session-delete']) },
    tabClaims: { get: () => undefined },
    clients: { get: () => undefined },
    tryNativeBrowserBrokerTabsAction: async (action, args) => {
      calls.push(['native', action, args.reason]);
      return { ok: true, action, released: args.tabIds || [args.tabId] };
    },
    releaseTabClaimVisualByTabId: async (args) => {
      calls.push(['extension-tab', args.tabId, args.claimId, args.reason]);
      return { ok: true, releasedByTab: args.tabId };
    },
    summarizeTabClaims: () => [],
    liveClientForClaim: () => null,
    waitForContinuationClient: async () => null,
    isLiveClient: () => false,
    enqueueCommand: async () => null,
    removeTabClaim: () => null,
    summarizeTabClaim: () => null,
    summarizeClient: () => null,
  });

  const result = await releaseTabClaim({
    claimId: 'claim-orphan',
    tabId: 42,
    tabIds: [42, 99],
    reason: 'job-complete',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['session-delete'],
    ['extension-tab', 42, 'claim-orphan', 'job-complete'],
    ['native', 'release', 'job-complete-native-visual'],
  ]);
  assert.equal(result.visual.releasedByTab, 42);
  assert.equal(result.nativeVisual.ok, true);
});

test('agent tab claim prefers native broker visual before content command', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeHelperSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'mcp-server-runtime-helpers.ts'),
    'utf-8',
  );
  const claimBlock = source.match(
    /const claimTabForClient = async[\s\S]*?\nconst claimGeminiTabForClient/,
  )?.[0];

  assert.ok(claimBlock, 'claimTabForClient deve existir');
  assert.match(claimBlock, /tryNativeTabClaimVisual/);
  assert.match(runtimeHelperSource, /tryNativeBrowserBrokerTabsAction\('claim'/);
  assert.ok(
    claimBlock.indexOf('tryNativeTabClaimVisual') <
      claimBlock.indexOf("'claim-tab'"),
    'claim visual deve preferir native broker antes do content script',
  );
});

test('tab claim release derives tab id from a live client carrying an orphan claim', async () => {
  const calls = [];
  const releaseTabClaim = createTabClaimRelease({
    cleanupExpiredTabClaims: () => {},
    normalizeSessionId: (sessionId) => String(sessionId || 'default-session'),
    sessionClaims: { get: () => undefined, delete: () => calls.push(['session-delete']) },
    tabClaims: { get: () => undefined },
    clients: { get: () => undefined },
    liveClientCarryingClaimId: (claimId) =>
      claimId === 'claim-orphan'
        ? {
            clientId: 'client-42',
            tabId: 42,
            tabClaim: {
              claimId,
              visual: { tabIds: [42, 99] },
            },
          }
        : null,
    tryNativeBrowserBrokerTabsAction: async (action, args) => {
      calls.push(['native', action, args.tabId, args.tabIds, args.reason]);
      return { ok: true, action, released: args.tabIds || [args.tabId] };
    },
    releaseTabClaimVisualByTabId: async (args) => {
      calls.push(['extension-tab', args.tabId, args.claimId, args.reason]);
      return { ok: true, releasedByTab: args.tabId };
    },
    summarizeTabClaims: () => [],
    liveClientForClaim: () => null,
    waitForContinuationClient: async () => null,
    isLiveClient: () => false,
    enqueueCommand: async () => null,
    removeTabClaim: () => null,
    summarizeTabClaim: () => null,
    summarizeClient: () => null,
  });

  const result = await releaseTabClaim({
    claimId: 'claim-orphan',
    reason: 'manual-cleanup',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['session-delete'],
    ['extension-tab', 42, 'claim-orphan', 'manual-cleanup'],
    ['native', 'release', 42, [42, 99], 'manual-cleanup-native-visual'],
  ]);
});

test('tab claim release reloads managed tabs after native fallback clears a stale visual', async () => {
  const calls = [];
  const releaseTabClaim = createTabClaimRelease({
    cleanupExpiredTabClaims: () => {},
    normalizeSessionId: (sessionId) => String(sessionId || 'default-session'),
    sessionClaims: { get: () => 'claim-1', delete: () => calls.push(['session-delete']) },
    tabClaims: {
      get: () => ({
        claimId: 'claim-1',
        sessionId: 'default-session',
        clientId: 'client-42',
        tabId: 42,
        visual: { tabIds: [42, 99] },
      }),
    },
    clients: { get: () => undefined },
    tryNativeBrowserBrokerTabsAction: async (action, args) => {
      calls.push(['native', action, args.tabId, args.tabIds, args.reason]);
      if (action === 'release') return { ok: true, action, ungroupedTabIds: args.tabIds };
      if (action === 'reload') return { ok: true, action, reloadedTabIds: args.tabIds };
      return { ok: true, action };
    },
    releaseTabClaimVisualByTabId: async (args) => {
      calls.push(['extension-tab', args.tabId, args.claimId, args.reason]);
      return { ok: false, code: 'command_timeout' };
    },
    summarizeTabClaims: () => [],
    liveClientForClaim: () => null,
    liveClientCarryingClaimId: () => null,
    waitForContinuationClient: async () => null,
    isLiveClient: () => false,
    enqueueCommand: async () => null,
    removeTabClaim: () => ({ claimId: 'claim-1' }),
    summarizeTabClaim: (claim) => claim,
    summarizeClient: () => null,
  });

  const result = await releaseTabClaim({ reason: 'job-complete' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.staleContentReload.reloadedTabIds, [42, 99]);
  assert.deepEqual(calls, [
    ['extension-tab', 42, 'claim-1', 'job-complete'],
    ['native', 'release', 42, [42, 99], 'job-complete'],
    ['native', 'reload', 42, [42, 99], 'job-complete-stale-content-reload'],
  ]);
});

test('tab claim release always releases native companion tabs for a server-side native visual', async () => {
  const calls = [];
  const releaseTabClaim = createTabClaimRelease({
    cleanupExpiredTabClaims: () => {},
    normalizeSessionId: (sessionId) => String(sessionId || 'default-session'),
    sessionClaims: { get: () => 'claim-native', delete: () => calls.push(['session-delete']) },
    tabClaims: {
      get: () => ({
        claimId: 'claim-native',
        sessionId: 'default-session',
        clientId: 'client-42',
        tabId: 42,
        visual: {
          mode: 'tab-group',
          tabId: 42,
          tabIds: [42, 99],
          groupId: 777,
        },
      }),
    },
    clients: { get: () => ({ clientId: 'client-42', tabId: 42 }) },
    tryNativeBrowserBrokerTabsAction: async (action, args) => {
      calls.push(['native', action, args.tabId, args.tabIds, args.reason]);
      return { ok: true, action, ungroupedTabIds: args.tabIds || [args.tabId] };
    },
    releaseTabClaimVisualByTabId: async () => null,
    summarizeTabClaims: () => [],
    liveClientForClaim: () => ({ clientId: 'client-42', tabId: 42 }),
    liveClientCarryingClaimId: () => null,
    waitForContinuationClient: async () => null,
    isLiveClient: () => true,
    enqueueCommand: async (clientId, type, args) => {
      calls.push(['content', clientId, type, args.claimId, args.reason]);
      return { ok: true, released: true };
    },
    removeTabClaim: () => ({ claimId: 'claim-native' }),
    summarizeTabClaim: (claim) => claim,
    summarizeClient: (client) => client,
  });

  const result = await releaseTabClaim({ claimId: 'claim-native', reason: 'job-complete' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.nativeVisual.ungroupedTabIds, [42, 99]);
  assert.deepEqual(calls, [
    ['content', 'client-42', 'release-tab-claim', 'claim-native', 'job-complete'],
    ['native', 'release', 42, [42, 99], 'job-complete-native-visual'],
  ]);
});
