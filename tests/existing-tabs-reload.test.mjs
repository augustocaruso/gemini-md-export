import test from 'node:test';
import assert from 'node:assert/strict';

import * as existingTabsReload from '../build/ts/mcp/existing-tabs-reload.js';

const {
  evaluateExistingTabsRuntimeRefreshFsm,
  evaluateExistingTabsPostReloadRecoveryFsm,
} = existingTabsReload;

test('runtime refresh FSM reloads extension when service worker build is stale', () => {
  const decision = evaluateExistingTabsRuntimeRefreshFsm({
    allowReload: true,
    expected: {
      extensionVersion: '0.8.54',
      protocolVersion: 2,
      buildStamp: '20260526-2108',
    },
    extensionStatus: {
      ok: true,
      extensionVersion: '0.8.54',
      protocolVersion: 2,
      buildStamp: '20260526-2106',
    },
  });

  assert.equal(decision.state, 'reload_extension_self');
  assert.equal(decision.reason, 'extension_build_mismatch');
  assert.equal(decision.force, true);
});

test('runtime refresh FSM is ready when service worker matches expected runtime', () => {
  const decision = evaluateExistingTabsRuntimeRefreshFsm({
    allowReload: true,
    expected: {
      extensionVersion: '0.8.54',
      protocolVersion: 2,
      buildStamp: '20260526-2108',
    },
    extensionStatus: {
      ok: true,
      extensionVersion: '0.8.54',
      protocolVersion: 2,
      buildStamp: '20260526-2108',
    },
  });

  assert.equal(decision.state, 'ready');
  assert.equal(decision.reason, 'extension_runtime_current');
});

test('post-reload FSM self-heals content scripts after native extension timeout with no clients', () => {
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: true,
    connectedClientCount: 0,
    nativeReload: {
      ok: false,
      code: 'extension_request_timeout',
      reloadedTabIds: [101, 102],
    },
  });

  assert.equal(decision.state, 'self_heal_content_scripts');
  assert.equal(decision.reason, 'native_reload_extension_request_timeout');
  assert.deepEqual(decision.tabIds, [101, 102]);
  assert.equal(decision.force, true);
  assert.equal(decision.waitForClients, true);
});

test('post-reload FSM does not self-heal when a content client is already connected', () => {
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: true,
    connectedClientCount: 1,
    nativeReload: {
      ok: false,
      code: 'extension_request_timeout',
    },
  });

  assert.equal(decision.state, 'ready');
  assert.equal(decision.reason, 'content_client_connected');
});

test('post-reload FSM broadens self-heal when targeted post-reload injection fails', () => {
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: true,
    connectedClientCount: 0,
    nativeReload: {
      ok: true,
      reloadedTabIds: [101],
      contentScriptSelfHeal: {
        ok: false,
        status: 'partial',
        results: [{ tabId: 101, status: 'injected-unconfirmed' }],
      },
    },
  });

  assert.equal(decision.state, 'self_heal_content_scripts');
  assert.equal(decision.reason, 'native_reload_post_self_heal_failed');
  assert.equal(decision.tabIds, undefined);
  assert.equal(decision.force, true);
});

test('post-reload FSM does not trust transient clients after targeted self-heal fails', () => {
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: true,
    connectedClientCount: 1,
    nativeReload: {
      ok: true,
      reloadedTabIds: [101],
      contentScriptSelfHeal: {
        ok: false,
        status: 'partial',
      },
    },
  });

  assert.equal(decision.state, 'self_heal_content_scripts');
  assert.equal(decision.reason, 'native_reload_post_self_heal_failed');
});

test('post-reload FSM blocks side effects when reload was not explicitly allowed', () => {
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: false,
    connectedClientCount: 0,
    nativeReload: {
      ok: false,
      code: 'extension_request_timeout',
    },
  });

  assert.equal(decision.state, 'blocked');
  assert.equal(decision.reason, 'reload_not_allowed');
});

test('ready activation FSM activates an existing healthy inactive Gemini tab when side effects are allowed', () => {
  const evaluate = existingTabsReload.evaluateBrowserReadyInactiveTabActivationFsm;
  assert.equal(typeof evaluate, 'function');

  const decision = evaluate({
    allowActivation: true,
    ready: false,
    claimableClientCount: 0,
    selectableClients: [
      {
        clientId: 'chat-background',
        tabId: 101,
        isActiveTab: false,
        commandReady: true,
        lastSeenAt: 1000,
        page: {
          url: 'https://gemini.google.com/app',
          kind: 'chat',
          listedConversationCount: 20,
        },
      },
    ],
  });

  assert.equal(decision.state, 'activate_existing_tab');
  assert.equal(decision.reason, 'inactive_ready_gemini_tab');
  assert.equal(decision.tabId, 101);
  assert.equal(decision.clientId, 'chat-background');
});
