import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideManagedTabsReload,
  managedTabsReloadRuntimeKey,
} from '../build/ts/browser/background/managed-tabs-reload-policy.js';

test('managed tab reload is allowed once per runtime build', () => {
  const runtimeKey = managedTabsReloadRuntimeKey({
    extensionVersion: '1.2.3',
    protocolVersion: 7,
    buildStamp: '20260520-1200',
  });
  const first = decideManagedTabsReload({
    previous: null,
    runtimeKey,
    reason: 'extension-runtime-changed',
    nowMs: 100_000,
    cooldownMs: 30_000,
  });

  assert.equal(first.ok, true);
  assert.equal(first.current.runtimeKey, runtimeKey);

  const second = decideManagedTabsReload({
    previous: first.current,
    runtimeKey,
    reason: 'extension-self-reload',
    nowMs: 200_000,
    cooldownMs: 30_000,
  });

  assert.equal(second.ok, false);
  assert.equal(second.status, 'already-reloaded-current-runtime');
});

test('managed tab reload cooldown blocks immediate repeated reloads', () => {
  const runtimeKey = managedTabsReloadRuntimeKey({
    extensionVersion: '1.2.3',
    protocolVersion: 7,
    buildStamp: '20260520-1200',
  });
  const first = decideManagedTabsReload({
    previous: null,
    runtimeKey,
    reason: 'mcp-command',
    nowMs: 100_000,
    cooldownMs: 30_000,
  });
  const second = decideManagedTabsReload({
    previous: first.current,
    runtimeKey: `${runtimeKey}:next`,
    reason: 'mcp-command',
    nowMs: 105_000,
    cooldownMs: 30_000,
  });

  assert.equal(second.ok, false);
  assert.equal(second.status, 'cooldown');
  assert.equal(second.cooldownMs, 25_000);
});

test('managed tab reload force bypasses runtime build guard', () => {
  const runtimeKey = managedTabsReloadRuntimeKey({
    extensionVersion: '1.2.3',
    protocolVersion: 7,
    buildStamp: '20260520-1200',
  });
  const previous = decideManagedTabsReload({
    previous: null,
    runtimeKey,
    reason: 'extension-runtime-changed',
    nowMs: 100_000,
    cooldownMs: 30_000,
  }).current;

  const forced = decideManagedTabsReload({
    previous,
    runtimeKey,
    reason: 'manual',
    nowMs: 101_000,
    cooldownMs: 30_000,
    force: true,
  });

  assert.equal(forced.ok, true);
  assert.equal(forced.current.forced, true);
});
