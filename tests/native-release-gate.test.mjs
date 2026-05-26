import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoTabClaimReleaseForJob } from '../build/ts/mcp/native-release-gate.js';

test('auto job claim release reuses released claim visual tab ids for native cleanup', async () => {
  const nativeCalls = [];
  const releaseTabClaimCalls = [];
  const releaseTabClaimResult = {
    ok: true,
    released: {
      claimId: 'claim-1',
      visual: {
        mode: 'tab-group',
        tabId: 42,
        tabIds: [42, 99],
        groupId: 777,
      },
    },
    nativeVisual: {
      ok: true,
      ungrouped: 0,
      ungroupedTabIds: [],
      groupIds: [],
    },
  };

  const autoRelease = createAutoTabClaimReleaseForJob({
    clients: new Map([['client-1', { clientId: 'client-1', tabId: 42 }]]),
    clientTabClaim: () => null,
    releaseTabClaim: async (args) => {
      releaseTabClaimCalls.push(args);
      return releaseTabClaimResult;
    },
    shouldUseNativeBrowserBroker: () => true,
    tryNativeBrowserBrokerTabsAction: async (action, args = {}) => {
      nativeCalls.push({ action, args });
      return {
        ok: true,
        action,
        ungrouped: Array.isArray(args.tabIds) ? args.tabIds.length : 0,
        ungroupedTabIds: Array.isArray(args.tabIds) ? args.tabIds : [],
        groupIds: Array.isArray(args.tabIds) ? [777] : [],
      };
    },
  });

  const job = {
    autoReleaseTabClaim: true,
    tabClaimId: 'claim-1',
    clientId: 'client-1',
    tabSession: { tabId: 42 },
  };

  await autoRelease(job, 'job-completed');

  assert.deepEqual(releaseTabClaimCalls[0].tabIds, null);
  assert.deepEqual(nativeCalls[0].args.tabIds, [42, 99]);
  assert.deepEqual(job.nativeTabClaimRelease.ungroupedTabIds, [42, 99]);
  assert.deepEqual(job.tabClaimRelease.nativeVisual.ungroupedTabIds, [42, 99]);
});
