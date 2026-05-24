import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  browserTransportMode,
  formatBrowserTransportMode,
} from '../build/ts/mcp/browser-transport-mode.js';

test('native proxy over HTTP is reported as hybrid, not native-first', () => {
  const status = browserTransportMode({
    bridgeHttpEnabled: true,
    nativeMessagingConfigured: true,
    nativeBrokerAvailable: false,
    contentScriptTransport: 'native-proxy-http',
  });

  assert.equal(status.mode, 'hybrid_native_proxy_http');
  assert.equal(status.nativeFirst, false);
  assert.equal(status.httpDependency, true);
  assert.equal(status.controlPlane, 'http');
  assert.match(formatBrowserTransportMode(status), /Native Messaging proxy/);
  assert.match(formatBrowserTransportMode(status), /HTTP bridge/);
});

test('native broker without HTTP bridge is the only native-first mode', () => {
  const status = browserTransportMode({
    bridgeHttpEnabled: false,
    nativeMessagingConfigured: true,
    nativeBrokerAvailable: true,
    contentScriptTransport: 'native-broker',
  });

  assert.equal(status.mode, 'native_broker');
  assert.equal(status.nativeFirst, true);
  assert.equal(status.httpDependency, false);
  assert.equal(status.controlPlane, 'native-broker');
});

test('MCP health exposes the typed browser transport status', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /browserTransportMode/);
  assert.match(source, /browserTransportStatus\(\)/);
  assert.match(source, /browserTransport:\s*await browserTransportStatus\(\)/);
});
