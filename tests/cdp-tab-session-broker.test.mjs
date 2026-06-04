import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateExtensionClientWithCdp,
  cdpUrlForRuntimeInput,
} from '../build/ts/cdp/tab-session-broker.js';
import {
  browserControlParamsFromFlags,
  cdpRuntimeInputForArgs,
  defaultCdpUrlFromEnv,
} from '../build/ts/cdp/runtime-options.js';

test('broker CDP fica desligado sem endpoint explícito ou default', () => {
  assert.equal(cdpUrlForRuntimeInput({}), null);
  assert.equal(cdpUrlForRuntimeInput({ defaultCdpUrl: 'http://127.0.0.1:9222' }), 'http://127.0.0.1:9222');
  assert.equal(
    cdpUrlForRuntimeInput({
      controlPlane: 'bridge',
      defaultCdpUrl: 'http://127.0.0.1:9222',
    }),
    null,
  );
});

test('opcoes runtime de CDP ficam em modulo TypeScript compartilhado', () => {
  assert.equal(
    defaultCdpUrlFromEnv({
      GEMINI_MCP_CDP_URL: ' http://127.0.0.1:9222 ',
    }),
    'http://127.0.0.1:9222',
  );
  assert.equal(
    cdpRuntimeInputForArgs(
      {},
      {
        env: {
          GEMINI_MCP_CDP_DEVTOOLS_ACTIVE_PORT_FILE:
            ' C:\\Users\\leo\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort ',
        },
      },
    ).devToolsActivePortFile,
    'C:\\Users\\leo\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort',
  );
  assert.deepEqual(browserControlParamsFromFlags({}), {
    activateTab: false,
    focusWindow: false,
  });
  assert.deepEqual(browserControlParamsFromFlags({ cdpUrl: 'http://127.0.0.1:9222' }), {
    activateTab: false,
    cdpUrl: 'http://127.0.0.1:9222',
    controlPlane: 'cdp',
    focusWindow: false,
  });
  assert.deepEqual(browserControlParamsFromFlags({ activateTab: true, focusWindow: true }), {
    activateTab: true,
    focusWindow: true,
  });
  assert.deepEqual(
    cdpRuntimeInputForArgs(
      { controlPlane: 'bridge', cdpUrl: 'http://127.0.0.1:9222' },
      { defaultCdpUrl: 'http://127.0.0.1:9333' },
    ),
    {
      controlPlane: 'bridge',
      defaultCdpUrl: 'http://127.0.0.1:9333',
      cdpUrl: null,
    },
  );
});

test('broker ativa por CDP usando chatId/url do cliente da extensão sem executar DOM', async () => {
  const calls = [];
  const result = await activateExtensionClientWithCdp(
    {
      tabId: 123,
      windowId: 7,
      page: {
        chatId: '88a98a108cdcfb61',
        url: 'https://gemini.google.com/app/88a98a108cdcfb61',
      },
    },
    { cdpUrl: 'http://127.0.0.1:9222' },
    {
      buildSnapshot: async ({ endpoint }) => {
        calls.push(['snapshot', endpoint]);
        return {
          ok: true,
          controlPlane: 'cdp',
          endpoint,
          targets: [
            {
              id: 'target-1',
              type: 'page',
              url: 'https://gemini.google.com/app/88a98a108cdcfb61',
              chatId: '88a98a108cdcfb61',
              classification: { kind: 'gemini_chat', terminal: false, url: 'https://gemini.google.com/app/88a98a108cdcfb61' },
            },
          ],
          geminiTargets: [],
          blocker: null,
          version: null,
        };
      },
      activateTarget: async (target, { endpoint }) => {
        calls.push(['activate', endpoint, target.id]);
        return { ok: true, targetId: target.id };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cdp');
  assert.equal(result.targetId, 'target-1');
  assert.deepEqual(calls, [
    ['snapshot', 'http://127.0.0.1:9222'],
    ['activate', 'http://127.0.0.1:9222', 'target-1'],
  ]);
});

test('broker CDP retorna skipped quando target correspondente nao existe', async () => {
  const result = await activateExtensionClientWithCdp(
    {
      tabId: 123,
      page: { chatId: '88a98a108cdcfb61', url: 'https://gemini.google.com/app/88a98a108cdcfb61' },
    },
    { cdpUrl: 'http://127.0.0.1:9222' },
    {
      buildSnapshot: async () => ({
        ok: true,
        controlPlane: 'cdp',
        endpoint: 'http://127.0.0.1:9222',
        targets: [],
        geminiTargets: [],
        blocker: null,
        version: null,
      }),
      activateTarget: async () => {
        throw new Error('should not activate');
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'cdp-target-not-found');
});
