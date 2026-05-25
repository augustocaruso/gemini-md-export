import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('native broker reloads existing Gemini tabs without content-script clients', async () => {
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
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 1);
  assert.deepEqual(result.reloadedTabIds, [42]);
  assert.deepEqual(reloaded, [42]);
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
