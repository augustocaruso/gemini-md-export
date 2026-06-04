import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserTabLifecycleStateFromLaunchState,
  evaluateBrowserLaunchGate,
  observeBrowserLaunchResult,
  transitionBrowserTabLifecycle,
} from '../build/ts/mcp/blocker-aware-tab-lifecycle.js';

test('blocker-aware tab lifecycle suppresses launch on Google verification', () => {
  const gate = evaluateBrowserLaunchGate({
    launchState: null,
    diagnosis: {
      kind: 'google_sorry',
      terminal: true,
      url: 'https://www.google.com/sorry/index?continue=https%3A%2F%2Fgemini.google.com%2Fapp&token=secret',
    },
    nowMs: 1000,
    launchId: 'launch-1',
    source: 'cli',
    targetUrl: 'https://gemini.google.com/app',
  });

  assert.equal(gate.canLaunch, false);
  assert.equal(gate.state.status, 'blocked');
  assert.equal(gate.blocker?.code, 'google_verification_required');
  assert.equal(gate.blocker?.scope, 'profile');
  assert.equal(gate.blocker?.url, 'https://www.google.com/sorry/index');
  assert.equal(
    gate.effects.some((effect) => effect.type === 'browser.launch.suppress'),
    true,
  );
});

test('blocker-aware tab lifecycle keeps profile blocker even if another Gemini tab is observed', () => {
  const blocked = browserTabLifecycleStateFromLaunchState(
    {
      tabLifecycle: {
        status: 'blocked',
        blocker: {
          code: 'google_verification_required',
          kind: 'google_sorry',
          scope: 'profile',
          terminal: true,
          observedAtMs: 1000,
        },
      },
    },
    2000,
  );

  const gate = evaluateBrowserLaunchGate({
    launchState: { tabLifecycle: blocked },
    diagnosis: {
      kind: 'gemini',
      terminal: false,
      url: 'https://gemini.google.com/app/abcdef1234567890',
    },
    nowMs: 3000,
    launchId: 'launch-2',
    source: 'mcp',
    targetUrl: 'https://gemini.google.com/app',
  });

  assert.equal(gate.canLaunch, false);
  assert.equal(gate.state.status, 'blocked');
  assert.equal(gate.state.blocker?.code, 'google_verification_required');
});

test('blocker-aware tab lifecycle clears tab-scoped blockers after Gemini is observed', () => {
  const blocked = browserTabLifecycleStateFromLaunchState(
    {
      tabLifecycle: {
        status: 'blocked',
        blocker: {
          code: 'browser_not_on_gemini',
          kind: 'other',
          scope: 'tab',
          terminal: true,
          observedAtMs: 1000,
        },
      },
    },
    2000,
  );

  const gate = evaluateBrowserLaunchGate({
    launchState: { tabLifecycle: blocked },
    diagnosis: {
      kind: 'gemini',
      terminal: false,
      url: 'https://gemini.google.com/app/abcdef1234567890',
    },
    nowMs: 3000,
    launchId: 'launch-2b',
    source: 'mcp',
    targetUrl: 'https://gemini.google.com/app',
  });

  assert.equal(gate.canLaunch, true);
  assert.equal(gate.state.status, 'launching');
  assert.equal(gate.state.blocker, null);
});

test('blocker-aware tab lifecycle tracks tabs opened by the launcher', () => {
  const gate = evaluateBrowserLaunchGate({
    launchState: null,
    diagnosis: { kind: 'unknown', terminal: false, url: null },
    nowMs: 1000,
    launchId: 'launch-3',
    source: 'cli',
    targetUrl: 'https://gemini.google.com/app',
  });

  const observed = observeBrowserLaunchResult({
    state: gate.state,
    nowMs: 1100,
    launchId: 'launch-3',
    source: 'cli',
    targetUrl: 'https://gemini.google.com/app',
    result: {
      openedNewTab: true,
      reusedExistingTab: false,
      targetUrl: 'https://gemini.google.com/app',
    },
  });

  assert.equal(observed.state.managedTabs.length, 1);
  assert.equal(observed.state.managedTabs[0].launchId, 'launch-3');
  assert.equal(observed.state.managedTabs[0].targetUrl, 'https://gemini.google.com/app');
});

test('blocker-aware tab lifecycle prunes stale tab-id-less managed launch records', () => {
  const state = browserTabLifecycleStateFromLaunchState(
    {
      tabLifecycle: {
        status: 'idle',
        managedTabs: [
          {
            managed: true,
            launchId: 'old-1',
            source: 'cli',
            targetUrl: 'https://gemini.google.com/app',
            createdAtMs: 1000,
            updatedAtMs: 1000,
          },
          {
            managed: true,
            launchId: 'fresh-1',
            source: 'cli',
            targetUrl: 'https://gemini.google.com/app',
            createdAtMs: 59_000,
            updatedAtMs: 59_000,
          },
          {
            managed: true,
            tabId: 42,
            launchId: 'old-with-tab',
            source: 'cli',
            targetUrl: 'https://gemini.google.com/app',
            createdAtMs: 1000,
            updatedAtMs: 1000,
          },
        ],
      },
    },
    121_000,
  );

  assert.deepEqual(
    state.managedTabs.map((tab) => tab.launchId),
    ['fresh-1', 'old-with-tab'],
  );
});

test('blocker-aware tab lifecycle marks managed launch as blocked when sorry appears after launch', () => {
  const start = transitionBrowserTabLifecycle(
    browserTabLifecycleStateFromLaunchState(null, 1000),
    {
      type: 'launchRequested',
      nowMs: 1000,
      launchId: 'launch-4',
      source: 'mcp',
      targetUrl: 'https://gemini.google.com/app',
    },
  );
  const blocked = transitionBrowserTabLifecycle(start.state, {
    type: 'browserInventoryObserved',
    nowMs: 1200,
    source: 'mcp',
    launchId: 'launch-4',
    diagnosis: {
      kind: 'google_sorry',
      terminal: true,
      url: 'https://www.google.com/sorry/index?continue=https%3A%2F%2Fgemini.google.com%2Fapp',
    },
  });

  assert.equal(blocked.state.status, 'blocked');
  assert.equal(blocked.state.managedTabs.length, 1);
  assert.equal(blocked.state.managedTabs[0].blockerCode, 'google_verification_required');
});
