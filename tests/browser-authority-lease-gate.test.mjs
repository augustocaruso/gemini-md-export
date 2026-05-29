import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLeasedBrowserEffect,
  browserAuthorityLeaseToken,
} from '../build/ts/mcp/browser-authority/index.js';

const lease = {
  leaseId: 'lease-1',
  operationId: 'op-1',
  operationKind: 'selected_export',
  owner: 'cli',
  policy: 'private_first',
  budget: {
    maxNewTabs: 1,
    maxReloads: 1,
    maxActivations: 1,
    maxNavigations: 1,
    deadlineAtMs: 9_999,
  },
  managedTabIds: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

test('lease gate accepts matching leased browser effect', () => {
  const token = browserAuthorityLeaseToken(lease);
  const effect = assertLeasedBrowserEffect({
    effect: { type: 'tab.reload', reason: 'test', leaseId: 'lease-1', tabId: 10 },
    token,
    nowMs: 2,
  });

  assert.equal(effect.leaseId, 'lease-1');
});

test('lease gate rejects missing token', () => {
  assert.throws(
    () =>
      assertLeasedBrowserEffect({
        effect: { type: 'tab.reload', reason: 'test', leaseId: 'lease-1', tabId: 10 },
        token: null,
        nowMs: 2,
      }),
    /autorizacao de navegador/i,
  );
});

test('lease gate rejects mismatched token', () => {
  const token = {
    leaseId: 'lease-real',
    operationId: 'op-1',
    deadlineAtMs: 9_999,
  };

  assert.throws(
    () =>
      assertLeasedBrowserEffect({
        effect: { type: 'browser.launch', reason: 'test', leaseId: 'lease-other' },
        token,
        nowMs: 2,
      }),
    /nao pertence/i,
  );
});

test('lease gate rejects expired token', () => {
  const token = browserAuthorityLeaseToken(lease);

  assert.throws(
    () =>
      assertLeasedBrowserEffect({
        effect: { type: 'browser.launch', reason: 'test', leaseId: 'lease-1' },
        token,
        nowMs: 10_000,
      }),
    /expirou/i,
  );
});
