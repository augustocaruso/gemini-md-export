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
