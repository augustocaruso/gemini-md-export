import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRecoveredBrowserClientLifecycle } from '../build/ts/mcp/mcp-server-runtime-helpers.js';

test('recovered browser client validation allows inactive export tabs', () => {
  let observedOptions = null;
  const result = validateRecoveredBrowserClientLifecycle(
    {
      clientId: 'chat-1',
      kind: 'chat',
      isActiveTab: false,
      page: { url: 'https://gemini.google.com/app/dad25bd803741664', kind: 'chat' },
    },
    {
      hydrateClientLifecycleFields: (client) => client,
      activeClaimableGeminiClientOptions: () => ({
        requireCommandReady: true,
        expectedExtensionVersion: '0.8.54',
      }),
      getGeminiClientLifecycle: (_client, options) => {
        observedOptions = options;
        return options.allowInactiveTab === true
          ? {
              ok: true,
              state: 'claimable',
              code: null,
              message: 'ok',
              nextAction: 'ok',
              retryable: false,
              manualReloadRecommended: false,
            }
          : {
              ok: false,
              state: 'page_unready',
              code: 'inactive_tab',
              message: 'inactive',
              nextAction: 'activate',
              retryable: false,
              manualReloadRecommended: false,
            };
      },
    },
  );

  assert.equal(observedOptions.allowInactiveTab, true);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'claimable');
});
