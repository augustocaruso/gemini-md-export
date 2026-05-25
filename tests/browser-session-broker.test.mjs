import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimDebuggableGeminiTab,
  classifyBrowserTabs,
  getDebuggableGeminiTabs,
} from '../build/ts/browser/background/browser-session-broker.js';

const tab = {
  id: 42,
  windowId: 7,
  active: true,
  url: 'https://gemini.google.com/app/abc123456789',
  title: 'Gemini',
};

test('lists one debuggable Gemini tab from fresh debugger inspection', async () => {
  const result = await getDebuggableGeminiTabs([tab], {
    inspectTab: async () => ({
      ok: true,
      tabId: 42,
      url: tab.url,
      pageKind: 'gemini',
      blockerCode: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].tabId, 42);
});

test('ambiguous tabs block export until explicit claim', async () => {
  const result = await claimDebuggableGeminiTab([tab, { ...tab, id: 43 }], {
    inspectTab: async (tabId) => ({
      ok: true,
      tabId,
      url: `https://gemini.google.com/app/${tabId}abc123456789`,
      pageKind: 'gemini',
      blockerCode: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ambiguous_gemini_tabs');
});

test('google blocker returns typed blocker code', async () => {
  const classified = await classifyBrowserTabs([{ ...tab, url: 'https://www.google.com/sorry/index' }], {
    inspectTab: async () => ({
      ok: true,
      tabId: 42,
      url: 'https://www.google.com/sorry/index',
      pageKind: 'google_sorry',
      blockerCode: 'google_verification_required',
    }),
  });

  assert.equal(classified[0].state, 'blocked');
  assert.equal(classified[0].code, 'google_verification_required');
});

test('My Activity entra no alvo visual da claim sem virar aba exportavel', async () => {
  const activityTab = {
    id: 99,
    windowId: 7,
    active: false,
    url: 'https://myactivity.google.com/product/gemini',
    title: 'My Activity',
  };
  const inspectTab = async (tabId) =>
    tabId === 42
      ? {
          ok: true,
          tabId,
          url: tab.url,
          pageKind: 'gemini',
          blockerCode: null,
        }
      : {
          ok: true,
          tabId,
          url: activityTab.url,
          pageKind: 'my_activity',
          blockerCode: null,
        };
  const result = await claimDebuggableGeminiTab([tab, activityTab], { inspectTab });
  const listed = await getDebuggableGeminiTabs([tab, activityTab], { inspectTab });

  assert.equal(result.ok, true);
  assert.equal(result.tab.tabId, 42);
  assert.deepEqual(result.visualCompanionTabIds, [99]);
  assert.deepEqual(listed.tabs.map((item) => item.tabId), [42]);
});
