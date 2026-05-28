import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExistingTabsReloadRequestParams } from '../build/ts/cli/existing-tabs-reload-request.js';

test('existing tabs reload request carries explicit HTTP fallback only when requested', () => {
  assert.deepEqual(
    buildExistingTabsReloadRequestParams(
      { allowHttpBrowserFallback: true, delayMs: 250 },
      { blockingIssue: 'extension_build_mismatch' },
    ),
    {
      action: 'reload',
      openIfMissing: false,
      allowReload: true,
      reloadAll: false,
      delayMs: 250,
      allowHttpBrowserFallback: true,
    },
  );

  assert.equal(
    Object.hasOwn(
      buildExistingTabsReloadRequestParams(
        { allowHttpBrowserFallback: false },
        { blockingIssue: 'extension_build_mismatch' },
      ),
      'allowHttpBrowserFallback',
    ),
    false,
  );
});
