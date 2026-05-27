import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activityCompanionTabIdsForNativeLease,
  activityCompanionTabIdsForNativeTabs,
  createActivityCompanionPreparer,
  shouldPrepareActivityCompanionForDateImport,
  transitionActivityCompanionWakeFsm,
} from '../build/ts/mcp/activity-companion-readiness.js';

test('activity companion helper extracts the non-Gemini visual tab from a native lease', () => {
  const lease = {
    tabId: 42,
    visual: {
      mode: 'tab-group',
      tabIds: [42, 99, 99],
    },
  };

  assert.deepEqual(activityCompanionTabIdsForNativeLease(lease, 42), [99]);
});

test('activity companion helper falls back to lease tab id and ignores invalid ids', () => {
  const lease = {
    tabId: '42',
    visual: {
      tabIds: ['42', '99', 'not-a-tab', 0, -1],
    },
  };

  assert.deepEqual(activityCompanionTabIdsForNativeLease(lease), [99]);
});

test('activity companion helper follows My Activity date-import opt-out flags', () => {
  assert.equal(shouldPrepareActivityCompanionForDateImport({}), true);
  assert.equal(shouldPrepareActivityCompanionForDateImport({ noMyActivity: true }), false);
  assert.equal(shouldPrepareActivityCompanionForDateImport({ useMyActivity: false }), false);
});

test('activity companion wake FSM is background-first unless activation is explicit', () => {
  assert.deepEqual(
    transitionActivityCompanionWakeFsm('checking', {
      type: 'needs_wake',
      explicitActivation: false,
      companionTabIdKnown: true,
      exportTabIdKnown: true,
    }),
    {
      state: 'background_reload',
      effects: {
        activateCompanion: false,
        reloadCompanion: true,
        restoreExportTab: false,
      },
    },
  );
  assert.deepEqual(
    transitionActivityCompanionWakeFsm('checking', {
      type: 'needs_wake',
      explicitActivation: true,
      companionTabIdKnown: true,
      exportTabIdKnown: true,
    }).effects,
    {
      activateCompanion: true,
      reloadCompanion: true,
      restoreExportTab: true,
    },
  );
});

test('activity companion helper selects nearest existing My Activity tab from native list', () => {
  const list = {
    tabs: [
      {
        tab: { id: 42, windowId: 7, index: 17, url: 'https://gemini.google.com/app/abc123abc123' },
        inspection: { pageKind: 'gemini' },
      },
      {
        tab: { id: 77, windowId: 8, index: 18, url: 'https://myactivity.google.com/product/gemini' },
        inspection: { pageKind: 'my_activity' },
      },
      {
        tab: { id: 99, windowId: 7, index: 18, url: 'https://myactivity.google.com/product/gemini' },
        inspection: { pageKind: 'my_activity' },
      },
    ],
  };

  assert.deepEqual(activityCompanionTabIdsForNativeTabs(list, 42), [99]);
});

test('activity companion preparer does not recreate claim visual already containing My Activity', async () => {
  const calls = [];
  const readyActivityClient = { clientId: 'activity-1', tabId: 99, ready: true };
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (_value, fallbackMs) => fallbackMs,
    waitForActivityClient: async (selector) => {
      calls.push({ action: 'wait', selector });
      return readyActivityClient;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, args });
      return { ok: true };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [],
  });

  const result = await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1' },
    {
      tabId: 42,
      tab: { claimId: 'claim-1' },
      visual: {
        mode: 'tab-group',
        groupId: 10,
        tabIds: [42, 99],
      },
    },
  );

  assert.equal(result.reason, 'activity-companion-already-ready');
  assert.equal(result.source, 'claim-visual');
  assert.equal(result.tabId, 99);
  assert.equal(calls.some((call) => call.action === 'claim'), false);
  assert.equal(result.visualRefresh, null);
});

test('activity companion preparer wakes a companion by background reload by default', async () => {
  const calls = [];
  let waitCount = 0;
  const readyActivityClient = { clientId: 'activity-1', tabId: 99, ready: true };
  const rawClient = {
    clientId: 'raw-activity-activation',
    tabId: 99,
    eventStream: { res: {} },
  };
  rawClient.eventStream.res.socket = rawClient;
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (_value, fallbackMs) => fallbackMs,
    waitForActivityClient: async (selector) => {
      calls.push({ action: 'wait', selector });
      waitCount += 1;
      return waitCount >= 2 ? readyActivityClient : null;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, reason: args.activateTabReason });
      return {
        ok: true,
        broker: rawClient,
        client: rawClient,
        result: { ok: true, tabId, native: { socket: rawClient } },
      };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      if (action === 'list') {
        return {
          ok: true,
          tabs: [
            {
              tab: {
                id: 42,
                windowId: 7,
                index: 17,
                url: 'https://gemini.google.com/app/abc123abc123',
              },
              inspection: { pageKind: 'gemini' },
            },
            {
              tab: {
                id: 99,
                windowId: 7,
                index: 18,
                url: 'https://myactivity.google.com/product/gemini',
              },
              inspection: { pageKind: 'my_activity' },
            },
          ],
        };
      }
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [],
  });

  const result = await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1' },
    { tabId: 42, tab: { claimId: 'claim-1' } },
  );

  assert.equal(result.attempted, true);
  assert.equal(result.source, 'native-tabs-list');
  assert.equal(result.tabId, 99);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(result.wakePolicy.state, 'background_reload');
  assert.equal(result.activation, null);
  assert.equal(calls.some((call) => call.action === 'activate'), false);
  assert.deepEqual(
    calls.find((call) => call.action === 'claim')?.args.relatedTabIds,
    [99],
  );
  assert.deepEqual(
    calls.find((call) => call.action === 'claim')?.args.tabIds,
    [42, 99],
  );
  assert.equal(calls.some((call) => call.action === 'reload'), true);
});

test('activity companion preparer still supports explicit foreground activation', async () => {
  const calls = [];
  let waitCount = 0;
  const readyActivityClient = { clientId: 'activity-1', tabId: 99, ready: true };
  const rawClient = {
    clientId: 'raw-activity-activation',
    tabId: 99,
    eventStream: { res: {} },
  };
  rawClient.eventStream.res.socket = rawClient;
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (_value, fallbackMs) => fallbackMs,
    waitForActivityClient: async (selector) => {
      calls.push({ action: 'wait', selector });
      waitCount += 1;
      return waitCount >= 2 ? readyActivityClient : null;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, reason: args.activateTabReason });
      return {
        ok: true,
        broker: rawClient,
        client: rawClient,
        result: { ok: true, tabId, native: { socket: rawClient } },
      };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [],
  });

  const result = await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1', activateActivityTabBeforeExport: true },
    {
      tabId: 42,
      tab: { claimId: 'claim-1' },
      visual: {
        mode: 'tab-group',
        groupId: 10,
        tabIds: [42, 99],
      },
    },
  );

  assert.equal(result.wakePolicy.state, 'activate_then_reload');
  assert.equal(result.activation.client.clientId, 'raw-activity-activation');
  assert.equal(result.activation.client.eventStream, undefined);
  assert.deepEqual(
    calls.filter((call) => call.action === 'activate').map((call) => call.reason),
    ['wake-activity-companion-before-export', 'restore-gemini-after-activity-companion'],
  );
});

test('activity companion preparer waits for a post-reload My Activity client signal', async () => {
  const calls = [];
  const readyActivityClient = { clientId: 'activity-new', tabId: 99, ready: true };
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (_value, fallbackMs) => fallbackMs,
    waitForActivityClient: async (selector) => {
      calls.push({ action: 'wait', selector });
      return selector.minRuntimeSignalAt ? readyActivityClient : null;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, reason: args.activateTabReason });
      return { ok: true, tabId };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [],
  });

  const result = await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1' },
    {
      tabId: 42,
      tab: { claimId: 'claim-1' },
      visual: {
        mode: 'tab-group',
        groupId: 10,
        tabIds: [42, 99],
      },
    },
  );

  const postReloadWait = calls.find(
    (call) => call.action === 'wait' && call.selector.minRuntimeSignalAt,
  );
  assert.equal(result.reason, 'activity-companion-ready-after-wake');
  assert.ok(postReloadWait, 'deve ignorar cliente antigo anterior ao reload');
  assert.equal(postReloadWait.selector.tabId, 99);
  assert.equal(typeof postReloadWait.selector.minRuntimeSignalAt, 'number');
  assert.equal(result.client.clientId, 'activity-new');
});

test('activity companion preparer falls back to another My Activity tab when claim companion stays stale', async () => {
  const calls = [];
  const readyActivityClient = { clientId: 'activity-fallback', tabId: 100, ready: true };
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (_value, fallbackMs) => fallbackMs,
    waitForActivityClient: async (selector) => {
      calls.push({ action: 'wait', selector });
      return selector.tabId === 100 && selector.minRuntimeSignalAt ? readyActivityClient : null;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, reason: args.activateTabReason });
      return { ok: true, tabId };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      if (action === 'list') {
        return {
          ok: true,
          tabs: [
            {
              tab: {
                id: 42,
                windowId: 7,
                index: 20,
                url: 'https://gemini.google.com/app/abc123abc123',
              },
              inspection: { pageKind: 'gemini' },
            },
            {
              tab: {
                id: 100,
                windowId: 7,
                index: 21,
                url: 'https://myactivity.google.com/product/gemini',
              },
              inspection: { pageKind: 'my_activity' },
            },
          ],
        };
      }
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [{ clientId: 'activity-stale', tabId: 99, buildStamp: 'old' }],
  });

  const result = await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1' },
    {
      tabId: 42,
      tab: { claimId: 'claim-1' },
      visual: {
        mode: 'tab-group',
        groupId: 10,
        tabIds: [42, 99],
      },
    },
  );

  assert.equal(result.reason, 'activity-companion-ready-after-fallback');
  assert.equal(result.source, 'native-tabs-list');
  assert.equal(result.tabId, 100);
  assert.deepEqual(
    calls.find((call) => call.action === 'claim')?.args.tabIds,
    [42, 100],
  );
  assert.deepEqual(
    calls.filter((call) => call.action === 'reload').map((call) => call.args.tabIds),
    [[99], [100]],
  );
});

test('activity companion preparer uses export ready wait budget after reload', async () => {
  const calls = [];
  const readyActivityClient = { clientId: 'activity-new', tabId: 99, ready: true };
  const prepare = createActivityCompanionPreparer({
    normalizeTabId: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    normalizeWaitMs: (value, fallbackMs, maxMs) => {
      calls.push({ action: 'normalize-wait', value, fallbackMs, maxMs });
      return Math.min(Number(value || fallbackMs), maxMs);
    },
    waitForActivityClient: async (selector, timeoutMs) => {
      calls.push({ action: 'wait', selector, timeoutMs });
      return selector.minRuntimeSignalAt ? readyActivityClient : null;
    },
    activityClientCommandReady: (client) => client?.ready === true,
    activateBrowserTabById: async (tabId, args) => {
      calls.push({ action: 'activate', tabId, reason: args.activateTabReason });
      return { ok: true, tabId };
    },
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      calls.push({ action, args });
      return { ok: true, action, args };
    },
    summarizeClient: (client) => ({ clientId: client.clientId, tabId: client.tabId }),
    getActivityClients: () => [],
  });

  await prepare(
    { clientId: 'chat-1', tabId: 42 },
    { claimId: 'claim-1', readyWaitMs: 75_000 },
    {
      tabId: 42,
      tab: { claimId: 'claim-1' },
      visual: {
        mode: 'tab-group',
        groupId: 10,
        tabIds: [42, 99],
      },
    },
  );

  const postReloadWait = calls.find(
    (call) => call.action === 'wait' && call.selector.minRuntimeSignalAt,
  );
  assert.equal(postReloadWait.timeoutMs, 75_000);
});

test('MCP waitForActivityClient filters stale clients from before a requested runtime signal', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/mcp-server.js', import.meta.url), 'utf8'),
  );
  const runtimeHelperSource = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/mcp/mcp-server-runtime-helpers.ts', import.meta.url), 'utf8'),
  );
  const waitBlock = source.match(
    /const waitForActivityClient = async[\s\S]*?\n\};\n\nconst activityClientMissingError/,
  )?.[0] || '';

  assert.match(waitBlock, /activityClientMatchesSelector\(client, selector/);
  assert.match(runtimeHelperSource, /minRuntimeSignalAt/);
  assert.match(runtimeHelperSource, /clientRuntimeSignalAt/);
  assert.match(runtimeHelperSource, /clientRuntimeSignalAt\(candidate\) >= min/);
});
