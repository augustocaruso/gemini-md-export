import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNativeBrokerPort,
  handleNativeBrowserBrokerCommand,
} from '../build/ts/browser/background/native-broker-client.js';

const chromeApiForTabs = ({ tabs, hrefByTabId, reloadError = null }) => {
  const reloaded = [];
  const api = {
    runtime: { lastError: null },
    tabs: {
      query(_queryInfo, callback) {
        callback(tabs);
      },
      reload(tabId, _reloadProperties, callback) {
        reloaded.push(tabId);
        api.runtime.lastError = reloadError ? { message: reloadError } : null;
        callback?.();
        api.runtime.lastError = null;
      },
    },
    debugger: {
      attach(_target, _version, callback) {
        callback();
      },
      sendCommand(target, _method, _params, callback) {
        callback({
          result: {
            value: {
              href: hrefByTabId[target.tabId] || 'https://example.com/',
              readyState: 'complete',
            },
          },
        });
      },
      detach(_target, callback) {
        callback?.();
      },
    },
  };
  return { api, reloaded };
};

test('native broker reloads the active Gemini tab without content-script clients', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app' },
      { id: 43, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app',
      43: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 1);
  assert.deepEqual(result.reloadedTabIds, [43]);
  assert.deepEqual(reloaded, [43]);
});

test('native broker reports no_existing_gemini_tabs without opening a tab', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [{ id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' }],
    hrefByTabId: { 99: 'https://myactivity.google.com/product/gemini' },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_existing_gemini_tabs');
  assert.equal(result.reloaded, 0);
  assert.deepEqual(reloaded, []);
});

test('native broker refuses broad reload when no Gemini tab is active', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app' },
      { id: 43, windowId: 7, active: false, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app',
      43: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_active_gemini_tab');
  assert.equal(result.reloaded, 0);
  assert.deepEqual(reloaded, []);
});

test('native broker reloads an explicit tab target even when it is inactive', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app' },
      { id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: { tabId: 42 } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 1);
  assert.deepEqual(result.reloadedTabIds, [42]);
  assert.deepEqual(reloaded, [42]);
});

test('native broker reloads managed tabs through runtime action without tab inspection', async () => {
  const chromeApi = {
    tabs: {
      query() {
        throw new Error('tabs.query should not run for extension.reloadManagedTabs');
      },
    },
    debugger: {
      attach() {
        throw new Error('debugger should not run for extension.reloadManagedTabs');
      },
    },
  };
  const calls = [];

  const result = await handleNativeBrowserBrokerCommand(
    {
      command: 'extension.reloadManagedTabs',
      payload: { reason: 'runtime-refresh', force: true, explicit: true },
    },
    chromeApi,
    {
      reloadManagedTabs: async (payload) => {
        calls.push(payload);
        return { ok: true, reloaded: 3, reason: payload.reason };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 3);
  assert.deepEqual(calls, [{ reason: 'runtime-refresh', force: true, explicit: true }]);
});

test('native broker reloads explicit Gemini and My Activity tab ids together', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: false, url: 'https://myactivity.google.com/product/gemini' },
      { id: 100, windowId: 7, active: true, url: 'https://gemini.google.com/app/def123456789' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
      100: 'https://gemini.google.com/app/def123456789',
    },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: { tabIds: [42, 99] } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.requested, 2);
  assert.equal(result.reloaded, 2);
  assert.deepEqual(result.reloadedTabIds, [42, 99]);
  assert.deepEqual(reloaded, [42, 99]);
});

test('native broker activates an existing Gemini tab without opening another tab', async () => {
  const updated = [];
  const focused = [];
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.update = (tabId, updateProperties, callback) => {
    updated.push({ tabId, updateProperties });
    callback?.({ id: tabId, windowId: 7, active: updateProperties.active });
  };
  api.windows = {
    update(windowId, updateProperties, callback) {
      focused.push({ windowId, updateProperties });
      callback?.({ id: windowId, focused: updateProperties.focused });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.activate', payload: { tabId: 42, focusWindow: true } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.activated, true);
  assert.equal(result.tabId, 42);
  assert.equal(result.isActiveTab, true);
  assert.deepEqual(updated, [{ tabId: 42, updateProperties: { active: true } }]);
  assert.deepEqual(focused, [{ windowId: 7, updateProperties: { focused: true } }]);
});

test('native broker port routes tabs.activate instead of rejecting it as unsupported', async () => {
  const posted = [];
  let onMessage = null;
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app/abc123456789' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
    },
  });
  api.tabs.update = (tabId, updateProperties, callback) => {
    callback?.({ id: tabId, windowId: 7, active: updateProperties.active });
  };
  api.runtime.connectNative = () => ({
    onMessage: {
      addListener(listener) {
        onMessage = listener;
      },
    },
    onDisconnect: {
      addListener() {},
    },
    postMessage(message) {
      posted.push(message);
    },
    disconnect() {},
  });

  const port = createNativeBrokerPort({ chromeApi: api, hostName: 'gemini-md-export-native' });
  port.ensureConnected();
  onMessage({
    id: 'activate-42',
    protocolVersion: 1,
    command: 'tabs.activate',
    payload: { tabId: 42, focusWindow: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = posted.find((message) => message.id === 'activate-42');
  assert.equal(response.ok, true);
  assert.equal(response.result.activated, true);
  assert.equal(response.result.tabId, 42);
});

test('native broker exposes extension status through runtime actions', async () => {
  const result = await handleNativeBrowserBrokerCommand(
    { command: 'extension.status', payload: {} },
    { runtime: { lastError: null } },
    {
      extensionStatus: () => ({
        ok: true,
        runtime: {
          extensionVersion: '0.8.54',
          buildStamp: '20260526-0330',
        },
        contentSelfHeal: {
          status: 'ok',
        },
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.runtime.buildStamp, '20260526-0330');
  assert.equal(result.contentSelfHeal.status, 'ok');
});

test('native broker can ask the service worker to keep native/offscreen context alive', async () => {
  const calls = [];
  const result = await handleNativeBrowserBrokerCommand(
    {
      command: 'extension.keepAlive',
      payload: { reason: 'fix-vault-private-repair', idleCloseMs: 900000 },
    },
    { runtime: { lastError: null }, tabs: { query: (_query, callback) => callback([]) } },
    {
      keepAlive: async (payload) => {
        calls.push(payload);
        return {
          ok: true,
          status: 'ready',
          idleCloseAt: '2026-06-03T03:30:00.000Z',
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, [
    {
      reason: 'fix-vault-private-repair',
      idleCloseMs: 900000,
    },
  ]);
});

test('native broker can ask the service worker to self-heal managed content scripts', async () => {
  const calls = [];
  const result = await handleNativeBrowserBrokerCommand(
    {
      command: 'extension.selfHealContentScripts',
      payload: { reason: 'release-gate', force: true },
    },
    { runtime: { lastError: null } },
    {
      selfHealContentScripts: async (payload) => {
        calls.push(payload);
        return {
          ok: true,
          status: 'ok',
          current: 1,
          injected: 1,
          failed: 0,
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.injected, 1);
  assert.deepEqual(calls, [{ reason: 'release-gate', force: true }]);
});

test('native broker claim groups Gemini and My Activity in the same visual rectangle', async () => {
  const grouped = [];
  const updatedGroups = [];
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: false, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.group = (createProperties, callback) => {
    grouped.push(createProperties.tabIds);
    callback(777);
  };
  api.tabGroups = {
    update(groupId, updateProperties, callback) {
      updatedGroups.push({ groupId, updateProperties });
      callback({ id: groupId, ...updateProperties });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.claim', payload: { claimId: 'claim-42', label: 'Gemini Export' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.tab.tabId, 42);
  assert.equal(result.visual.mode, 'tab-group');
  assert.deepEqual(result.visual.tabIds, [42, 99]);
  assert.deepEqual(grouped, [[42, 99]]);
  assert.equal(updatedGroups[0].groupId, 777);
});

test('native broker claim reuses an existing managed claim group instead of recreating it', async () => {
  const grouped = [];
  const updatedGroups = [];
  const { api } = chromeApiForTabs({
    tabs: [
      {
        id: 42,
        windowId: 7,
        active: true,
        groupId: 777,
        url: 'https://gemini.google.com/app/abc123456789',
      },
      {
        id: 99,
        windowId: 7,
        active: false,
        groupId: 777,
        url: 'https://myactivity.google.com/product/gemini',
      },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.group = (createProperties, callback) => {
    grouped.push(createProperties.tabIds);
    callback(778);
  };
  api.tabGroups = {
    get(groupId, callback) {
      callback({ id: groupId, title: 'Gemini Export' });
    },
    update(groupId, updateProperties, callback) {
      updatedGroups.push({ groupId, updateProperties });
      callback({ id: groupId, ...updateProperties });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    {
      command: 'tabs.claim',
      payload: {
        tabId: 42,
        claimId: 'claim-42',
        tabIds: [42, 99],
        relatedTabIds: [99],
        label: 'Gemini Export',
      },
    },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.visual.mode, 'tab-group');
  assert.equal(result.visual.reason, 'reused-existing-managed-claim-group');
  assert.equal(result.visual.groupId, 777);
  assert.deepEqual(result.visual.tabIds, [42, 99]);
  assert.deepEqual(grouped, []);
  assert.deepEqual(updatedGroups, [
    { groupId: 777, updateProperties: { title: 'Gemini Export', color: 'blue' } },
  ]);
});

test('native broker claim reports tab group create lastError while falling back to badge', async () => {
  const { api } = chromeApiForTabs({
    tabs: [{ id: 42, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' }],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
    },
  });
  api.tabs.group = (_createProperties, callback) => {
    api.runtime.lastError = { message: 'Tabs cannot be grouped in this browser window' };
    callback(null);
    api.runtime.lastError = null;
  };
  api.tabGroups = {
    update() {
      throw new Error('tabGroups.update should not run after group failure');
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.claim', payload: { claimId: 'claim-42', label: 'Gemini Export' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.visual.mode, 'action-badge');
  assert.equal(result.visual.reason, 'tab-group-create-failed');
  assert.equal(result.visual.detail, 'Tabs cannot be grouped in this browser window');
});

test('native broker claim reports tab group update lastError while falling back to badge', async () => {
  const { api } = chromeApiForTabs({
    tabs: [{ id: 42, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' }],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
    },
  });
  api.tabs.group = (_createProperties, callback) => callback(777);
  api.tabGroups = {
    update(_groupId, _updateProperties, callback) {
      api.runtime.lastError = { message: 'Tab group cannot be edited right now' };
      callback(null);
      api.runtime.lastError = null;
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.claim', payload: { claimId: 'claim-42', label: 'Gemini Export' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.visual.mode, 'action-badge');
  assert.equal(result.visual.groupId, 777);
  assert.equal(result.visual.reason, 'tab-group-update-failed');
  assert.equal(result.visual.detail, 'Tab group cannot be edited right now');
});

test('native broker claim does not add a second My Activity tab when one is explicit', async () => {
  const grouped = [];
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, index: 10, active: true, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 98, windowId: 7, index: 13, active: false, url: 'https://myactivity.google.com/product/gemini' },
      { id: 99, windowId: 7, index: 11, active: false, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      98: 'https://myactivity.google.com/product/gemini',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.group = (createProperties, callback) => {
    grouped.push(createProperties.tabIds);
    callback(777);
  };
  api.tabGroups = {
    update(groupId, updateProperties, callback) {
      callback({ id: groupId, ...updateProperties });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    {
      command: 'tabs.claim',
      payload: {
        tabId: 42,
        claimId: 'claim-42',
        tabIds: [42, 98],
        relatedTabIds: [98],
      },
    },
    api,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.visual.tabIds, [42, 98]);
  assert.deepEqual(grouped, [[42, 98]]);
});

test('native broker claim accepts string tabId from HTTP query params', async () => {
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: false, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.group = (_createProperties, callback) => callback(777);
  api.tabGroups = {
    update(groupId, updateProperties, callback) {
      callback({ id: groupId, ...updateProperties });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.claim', payload: { tabId: '42', claimId: 'claim-42' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.tab.tabId, 42);
  assert.equal(result.tab.claimId, 'claim-42');
});

test('native broker release ungroups Gemini and My Activity from managed claim group', async () => {
  const ungrouped = [];
  const { api } = chromeApiForTabs({
    tabs: [
      {
        id: 42,
        windowId: 7,
        active: true,
        groupId: 777,
        url: 'https://gemini.google.com/app/abc123456789',
      },
      {
        id: 99,
        windowId: 7,
        active: false,
        groupId: 777,
        url: 'https://myactivity.google.com/product/gemini',
      },
      {
        id: 100,
        windowId: 7,
        active: false,
        groupId: -1,
        url: 'https://myactivity.google.com/product/gemini',
      },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
      100: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.ungroup = (tabIds, callback) => {
    ungrouped.push(tabIds);
    callback?.();
  };
  api.tabGroups = {
    get(groupId, callback) {
      callback({ id: groupId, title: 'Export 30' });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.release', payload: { tabId: 42, claimId: 'claim-42' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.ungrouped, 2);
  assert.deepEqual(result.ungroupedTabIds, [42, 99]);
  assert.deepEqual(ungrouped, [[42, 99]]);
});

test('native broker release without tab id cleans orphan managed claim groups', async () => {
  const ungrouped = [];
  const { api } = chromeApiForTabs({
    tabs: [
      {
        id: 42,
        windowId: 7,
        active: true,
        groupId: 777,
        url: 'https://gemini.google.com/app/abc123456789',
      },
      {
        id: 99,
        windowId: 7,
        active: false,
        groupId: 777,
        url: 'https://myactivity.google.com/product/gemini',
      },
      {
        id: 100,
        windowId: 7,
        active: false,
        groupId: 778,
        url: 'https://myactivity.google.com/product/gemini',
      },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
      100: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.ungroup = (tabIds, callback) => {
    ungrouped.push(tabIds);
    callback?.();
  };
  api.tabGroups = {
    get(groupId, callback) {
      callback({
        id: groupId,
        title: groupId === 777 ? 'Gemini Export' : 'Pesquisa pessoal',
      });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.release', payload: { reason: 'bridge-startup-orphan-claim-cleanup' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.ungrouped, 2);
  assert.deepEqual(result.ungroupedTabIds, [42, 99]);
  assert.deepEqual(result.groupIds, [777]);
  assert.deepEqual(ungrouped, [[42, 99]]);
});

test('native broker release can target companion tab ids without a primary tab id', async () => {
  const ungrouped = [];
  const { api } = chromeApiForTabs({
    tabs: [
      {
        id: 42,
        windowId: 7,
        active: true,
        groupId: -1,
        url: 'https://gemini.google.com/app/abc123456789',
      },
      {
        id: 99,
        windowId: 7,
        active: false,
        groupId: 777,
        url: 'https://myactivity.google.com/product/gemini',
      },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.ungroup = (tabIds, callback) => {
    ungrouped.push(tabIds);
    callback?.();
  };
  api.tabGroups = {
    get(groupId, callback) {
      callback({ id: groupId, title: 'Export 30' });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.release', payload: { claimId: 'claim-42', tabIds: [42, 99] } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.ungrouped, 1);
  assert.deepEqual(result.ungroupedTabIds, [99]);
  assert.deepEqual(ungrouped, [[99]]);
});

test('native broker release leaves user tab groups alone', async () => {
  const ungrouped = [];
  const { api } = chromeApiForTabs({
    tabs: [
      {
        id: 42,
        windowId: 7,
        active: true,
        groupId: 777,
        url: 'https://gemini.google.com/app/abc123456789',
      },
      {
        id: 99,
        windowId: 7,
        active: false,
        groupId: 777,
        url: 'https://myactivity.google.com/product/gemini',
      },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.ungroup = (tabIds, callback) => {
    ungrouped.push(tabIds);
    callback?.();
  };
  api.tabGroups = {
    get(groupId, callback) {
      callback({ id: groupId, title: 'Pesquisa pessoal' });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.release', payload: { tabId: 42, claimId: 'claim-42' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.ungrouped, 0);
  assert.deepEqual(result.ungroupedTabIds, []);
  assert.deepEqual(ungrouped, []);
});
