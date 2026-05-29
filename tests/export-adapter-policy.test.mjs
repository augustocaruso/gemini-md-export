import assert from 'node:assert/strict';
import test from 'node:test';

import { planExportAdapters } from '../build/ts/core/export-adapter-policy.js';

test('known chat ids prefer private API and avoid browser lease', () => {
  const plan = planExportAdapters({
    operationKind: 'selected_export',
    knownChatIds: ['abc123abc123'],
    privateApiAvailable: true,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: true,
    browserFallbackAllowed: true,
  });

  assert.deepEqual(plan.adapters.map((item) => item.kind), ['private_api']);
  assert.equal(plan.requiresBrowserLease, false);
});

test('private API falls back to extension private API before browser DOM', () => {
  const plan = planExportAdapters({
    operationKind: 'selected_export',
    knownChatIds: ['abc123abc123'],
    privateApiAvailable: false,
    extensionPrivateApiAvailable: true,
    pythonSidecarAvailable: true,
    browserFallbackAllowed: true,
  });

  assert.deepEqual(plan.adapters.map((item) => item.kind), [
    'extension_private_api',
    'python_sidecar',
  ]);
  assert.equal(plan.requiresBrowserLease, false);
});

test('inventory fallback requires a browser lease when private inventory is unavailable', () => {
  const plan = planExportAdapters({
    operationKind: 'recent_export',
    knownChatIds: [],
    privateApiAvailable: false,
    privateInventoryAvailable: false,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: false,
    browserFallbackAllowed: true,
  });

  assert.equal(plan.requiresBrowserLease, true);
  assert.deepEqual(plan.adapters.map((item) => item.kind), ['browser_inventory', 'dom_legacy']);
});

test('browser fallback disabled returns a blocker instead of DOM fallback', () => {
  const plan = planExportAdapters({
    operationKind: 'recent_export',
    knownChatIds: [],
    privateApiAvailable: false,
    privateInventoryAvailable: false,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: false,
    browserFallbackAllowed: false,
  });

  assert.equal(plan.requiresBrowserLease, false);
  assert.equal(plan.blocker?.code, 'private_inventory_unavailable');
});

test('private inventory is preferred for list-based jobs', () => {
  const plan = planExportAdapters({
    operationKind: 'sync_export',
    knownChatIds: [],
    privateInventoryAvailable: true,
    browserFallbackAllowed: true,
  });

  assert.equal(plan.requiresBrowserLease, false);
  assert.deepEqual(plan.adapters.map((item) => item.kind), ['private_inventory']);
});
