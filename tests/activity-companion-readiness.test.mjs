import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activityCompanionTabIdsForNativeLease,
  activityCompanionTabIdsForNativeTabs,
  createActivityCompanionPreparer,
  shouldPrepareActivityCompanionForDateImport,
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

test('activity companion preparer can attach and wake a companion found by native list', async () => {
  const calls = [];
  let waitCount = 0;
  const readyActivityClient = { clientId: 'activity-1', tabId: 99, ready: true };
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
