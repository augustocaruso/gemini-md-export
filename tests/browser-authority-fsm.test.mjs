import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialBrowserAuthorityState,
  transitionBrowserAuthority,
} from '../build/ts/mcp/browser-authority/index.js';

const budget = {
  maxNewTabs: 1,
  maxReloads: 1,
  maxActivations: 1,
  maxNavigations: 1,
  deadlineAtMs: 10_000,
};

test('browser authority grants a lease and emits leased launch effect', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = transitionBrowserAuthority(start, {
    type: 'leaseRequested',
    nowMs: 1_000,
    leaseId: 'lease-1',
    operationId: 'op-1',
    operationKind: 'selected_export',
    owner: 'cli',
    policy: 'private_first',
    budget,
  });

  assert.equal(result.state.leases.length, 1);
  assert.equal(result.state.leases[0].leaseId, 'lease-1');

  const launch = transitionBrowserAuthority(result.state, {
    type: 'effectRequested',
    nowMs: 1_100,
    leaseId: 'lease-1',
    effect: {
      type: 'browser.launch',
      reason: 'no_ready_private_session',
      url: 'https://gemini.google.com/app',
    },
  });

  assert.equal(launch.effects[0].type, 'browser.launch');
  assert.equal(launch.effects[0].leaseId, 'lease-1');
});

test('browser authority blocks effects without a valid lease', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = transitionBrowserAuthority(start, {
    type: 'effectRequested',
    nowMs: 1_000,
    leaseId: 'missing',
    effect: { type: 'tab.reload', reason: 'test', tabId: 1 },
  });

  assert.equal(result.effects.length, 0);
  assert.equal(result.blocker?.code, 'lease_missing');
});

test('browser authority suppresses profile-wide Google verification retries', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const blocked = transitionBrowserAuthority(start, {
    type: 'profileBlockerObserved',
    nowMs: 1_000,
    blocker: {
      code: 'google_verification_required',
      scope: 'profile',
      terminal: true,
      message: 'O Google pediu uma verificacao.',
      nextAction: 'Resolva a verificacao no navegador.',
      observedAtMs: 1_000,
    },
  });

  const lease = transitionBrowserAuthority(blocked.state, {
    type: 'leaseRequested',
    nowMs: 1_100,
    leaseId: 'lease-2',
    operationId: 'op-2',
    operationKind: 'recent_export',
    owner: 'mcp',
    policy: 'job_safe',
    budget,
  });

  assert.equal(lease.state.leases.length, 0);
  assert.equal(lease.blocker?.code, 'google_verification_required');
});

test('browser authority releases a lease and stops future effects', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const leased = transitionBrowserAuthority(start, {
    type: 'leaseRequested',
    nowMs: 1_000,
    leaseId: 'lease-3',
    operationId: 'op-3',
    operationKind: 'fix_vault',
    owner: 'repair',
    policy: 'private_first',
    budget,
  });
  const released = transitionBrowserAuthority(leased.state, {
    type: 'leaseReleased',
    nowMs: 1_500,
    leaseId: 'lease-3',
    reason: 'operation_completed',
  });
  const effect = transitionBrowserAuthority(released.state, {
    type: 'effectRequested',
    nowMs: 1_600,
    leaseId: 'lease-3',
    effect: { type: 'tab.reload', reason: 'after_release', tabId: 5 },
  });

  assert.equal(effect.effects.length, 0);
  assert.equal(effect.blocker?.code, 'lease_expired');
});

test('browser authority blocks browser effects when operation budget is exhausted', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const leased = transitionBrowserAuthority(start, {
    type: 'leaseRequested',
    nowMs: 1_000,
    leaseId: 'lease-4',
    operationId: 'op-4',
    operationKind: 'selected_export',
    owner: 'cli',
    policy: 'private_first',
    budget: { ...budget, maxNewTabs: 0 },
  });

  const effect = transitionBrowserAuthority(leased.state, {
    type: 'effectRequested',
    nowMs: 1_100,
    leaseId: 'lease-4',
    effect: {
      type: 'browser.launch',
      reason: 'no_ready_private_session',
      url: 'https://gemini.google.com/app',
    },
  });

  assert.equal(effect.effects.length, 0);
  assert.equal(effect.blocker?.code, 'operation_budget_exhausted');
});
