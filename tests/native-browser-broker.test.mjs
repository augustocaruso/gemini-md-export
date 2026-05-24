import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canFallbackFromNativeBrowserBrokerFailure,
  createNativeBrowserBrokerClient,
  nativeBrowserBrokerFailureCode,
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

test('native broker failure policy allows fallback only for transport/runtime failures', async () => {
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      code: 'native_broker_unavailable',
      error: 'connect ECONNREFUSED /tmp/broker.sock',
    }),
    true,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      error: {
        code: 'extension_unavailable',
        message: 'A extensao ainda nao abriu a porta nativa do broker.',
      },
    }),
    true,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure(
      {
        ok: false,
        code: 'native_broker_unavailable',
      },
      { strict: true },
    ),
    false,
  );
  assert.equal(
    canFallbackFromNativeBrowserBrokerFailure({
      ok: false,
      code: 'claimed_debuggable_tab_required',
    }),
    false,
  );
});

test('native broker failure code prefers nested native-host error code', () => {
  assert.equal(
    nativeBrowserBrokerFailureCode({
      ok: false,
      code: 'outer',
      error: { code: 'extension_request_timeout' },
    }),
    'extension_request_timeout',
  );
});
