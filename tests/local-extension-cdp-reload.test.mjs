import test from 'node:test';
import assert from 'node:assert/strict';

import {
  browserUserDataDirForLocalCdp,
  runLocalExtensionCdpReload,
} from '../build/ts/cli/local-extension-cdp-reload.js';

test('resolve user data dir do Dia para DevToolsActivePort', () => {
  assert.equal(
    browserUserDataDirForLocalCdp({
      browser: 'dia',
      platform: 'darwin',
      homeDir: '/Users/augusto',
    }),
    '/Users/augusto/Library/Application Support/Dia/User Data',
  );
});

test('reload local usa WebSocket quando DevToolsActivePort existe e reload foi autorizado', async () => {
  const calls = [];
  const result = await runLocalExtensionCdpReload(
    {
      allowReload: true,
      browser: 'dia',
      extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
      platform: 'darwin',
      homeDir: '/Users/augusto',
    },
    {
      existsSync: (path) => path.endsWith('DevToolsActivePort'),
      reloadExtensionFromDevToolsActivePort: async (args) => {
        calls.push(args);
        return {
          ok: true,
          mode: 'cdp-browser-websocket',
          extensionId: args.extensionId,
          targetId: 'extensions',
          targetUrl: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.attempted, true);
  assert.equal(result.mode, 'cdp-browser-websocket');
  assert.equal(calls[0].extensionId, 'ikjanjokpogoakdlikhcgfgcjbgoogkc');
  assert.match(calls[0].devToolsActivePortFile, /Dia\/User Data\/DevToolsActivePort$/);
});
