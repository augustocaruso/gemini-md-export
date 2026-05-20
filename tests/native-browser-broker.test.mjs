import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNativeBrowserBrokerClient,
  shouldUseNativeBrowserBroker,
} from '../build/ts/mcp/native-browser-broker.js';

test('native broker is preferred unless explicitly disabled', () => {
  assert.equal(shouldUseNativeBrowserBroker({ disabled: false }), true);
  assert.equal(shouldUseNativeBrowserBroker({ disabled: true }), false);
});

test('native broker client maps failed ipc to fallback-ready error', async () => {
  const client = createNativeBrowserBrokerClient({
    request: async () => {
      throw new Error('socket missing');
    },
  });

  const response = await client.listTabs({ allowFallback: true });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'native_broker_unavailable');
  assert.equal(response.allowFallback, true);
});
