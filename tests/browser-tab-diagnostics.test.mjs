import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyManagedBrowserUrl,
  diagnoseManagedBrowserTabs,
} from '../build/ts/mcp/browser-tab-diagnostics.js';

test('managed browser diagnostics keep Google blockers terminal even with partial tab evidence', () => {
  assert.deepEqual(classifyManagedBrowserUrl('https://accounts.google.com/signin'), {
    kind: 'google_login',
    terminal: true,
    url: 'https://accounts.google.com/signin',
  });

  const sorry = diagnoseManagedBrowserTabs({
    activeUrl:
      'https://www.google.com/sorry/index?continue=https%3A%2F%2Fgemini.google.com%2Fapp',
    inventoryComplete: false,
  });

  assert.equal(sorry.kind, 'google_sorry');
  assert.equal(sorry.terminal, true);
});

test('managed browser diagnostics do not treat a non-Gemini active tab as terminal with partial evidence', () => {
  const partial = diagnoseManagedBrowserTabs({
    activeUrl: 'https://chatgpt.com/c/6a0e1ccb-1db0-83e9-a023-07c296350e29',
    urls: [],
    inventoryComplete: false,
  });

  assert.equal(partial.kind, 'unknown');
  assert.equal(partial.terminal, false);
  assert.equal(partial.url, 'https://chatgpt.com/c/6a0e1ccb-1db0-83e9-a023-07c296350e29');

  const complete = diagnoseManagedBrowserTabs({
    activeUrl: 'https://chatgpt.com/c/6a0e1ccb-1db0-83e9-a023-07c296350e29',
    urls: [],
    inventoryComplete: true,
  });

  assert.equal(complete.kind, 'other');
  assert.equal(complete.terminal, true);
});

test('managed browser diagnostics prefer Gemini evidence over unrelated active tabs', () => {
  const diagnosis = diagnoseManagedBrowserTabs({
    activeUrl: 'https://chatgpt.com/c/6a0e1ccb-1db0-83e9-a023-07c296350e29',
    urls: ['https://gemini.google.com/app/abcdef1234567890'],
    inventoryComplete: true,
  });

  assert.equal(diagnosis.kind, 'gemini');
  assert.equal(diagnosis.terminal, false);
});
