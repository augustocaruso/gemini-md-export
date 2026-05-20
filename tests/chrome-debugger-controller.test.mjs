import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserUrl,
  inspectTabWithDebugger,
} from '../build/ts/browser/background/chrome-debugger-controller.js';

test('classifies Gemini, Google login and Google verification URLs', () => {
  assert.equal(classifyBrowserUrl('https://gemini.google.com/app/abc123456789'), 'gemini');
  assert.equal(classifyBrowserUrl('https://accounts.google.com/v3/signin'), 'google_login');
  assert.equal(classifyBrowserUrl('https://www.google.com/sorry/index'), 'google_sorry');
  assert.equal(classifyBrowserUrl('https://example.com/'), 'other');
});

test('inspectTabWithDebugger attaches, reads runtime location and detaches', async () => {
  const calls = [];
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(target, version, cb) {
        calls.push(['attach', target.tabId, version]);
        cb();
      },
      sendCommand(target, method, params, cb) {
        calls.push(['sendCommand', target.tabId, method, params.expression]);
        cb({
          result: {
            value: {
              href: 'https://gemini.google.com/app/abc123456789',
              readyState: 'complete',
            },
          },
        });
      },
      detach(target, cb) {
        calls.push(['detach', target.tabId]);
        cb();
      },
    },
  };

  const result = await inspectTabWithDebugger(42, { chromeApi });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 42);
  assert.equal(result.pageKind, 'gemini');
  assert.equal(result.url, 'https://gemini.google.com/app/abc123456789');
  assert.deepEqual(calls.map((call) => call[0]), ['attach', 'sendCommand', 'detach']);
});
