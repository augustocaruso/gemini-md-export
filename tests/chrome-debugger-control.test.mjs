import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateTabWithDebugger,
  shouldUseDebuggerForTabControl,
} from '../build/ts/browser/shared/chrome-debugger.js';

const makeChrome = ({ failAttach = false, failCommand = false } = {}) => {
  const calls = [];
  const chrome = {
    runtime: { lastError: null },
    debugger: {
      attach(target, protocolVersion, callback) {
        calls.push(['attach', target.tabId, protocolVersion]);
        chrome.runtime.lastError = failAttach ? { message: 'attach failed' } : null;
        callback();
        chrome.runtime.lastError = null;
      },
      sendCommand(target, method, params, callback) {
        calls.push(['sendCommand', target.tabId, method, params]);
        chrome.runtime.lastError = failCommand ? { message: 'command failed' } : null;
        callback({ ok: true });
        chrome.runtime.lastError = null;
      },
      detach(target, callback) {
        calls.push(['detach', target.tabId]);
        chrome.runtime.lastError = null;
        callback();
      },
    },
  };
  return { chrome, calls };
};

test('usa debugger para controle de aba quando API existe e nao foi desabilitada', () => {
  const { chrome } = makeChrome();
  assert.equal(shouldUseDebuggerForTabControl(chrome, {}), true);
  assert.equal(
    shouldUseDebuggerForTabControl(chrome, { disableDebugger: true }),
    false,
  );
  assert.equal(shouldUseDebuggerForTabControl({}, {}), false);
});

test('ativa aba via CDP Page.bringToFront e faz detach previsivel', async () => {
  const { chrome, calls } = makeChrome();
  const result = await activateTabWithDebugger(123, {
    chromeApi: chrome,
    reason: 'export',
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'chrome-debugger-cdp');
  assert.equal(result.tabId, 123);
  assert.deepEqual(calls, [
    ['attach', 123, '1.3'],
    ['sendCommand', 123, 'Page.bringToFront', {}],
    ['detach', 123],
  ]);
});

test('falha de attach retorna erro estruturado para fallback de tabs.update', async () => {
  const { chrome, calls } = makeChrome({ failAttach: true });
  const result = await activateTabWithDebugger(123, { chromeApi: chrome });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'debugger-attach-failed');
  assert.equal(result.error, 'attach failed');
  assert.deepEqual(calls, [['attach', 123, '1.3']]);
});
