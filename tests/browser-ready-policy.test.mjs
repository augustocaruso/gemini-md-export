import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldWaitForExistingTabsForReady,
  shouldWakeBrowserForReady,
  shouldReloadExistingTabsForReady,
} from '../build/ts/cli/browser-ready-policy.js';

test('browser ready policy reloads existing tab after command channel stays unready', () => {
  assert.equal(
    shouldReloadExistingTabsForReady(
      {
        ready: false,
        blockingIssue: 'command_channel_not_ready',
        connectedClientCount: 1,
        nativeBroker: {
          available: true,
          response: {
            result: {
              tabs: [
                {
                  state: 'debuggable',
                  tab: { id: 101, active: true },
                },
              ],
            },
          },
        },
      },
      { allowReload: true },
    ),
    true,
  );
});

test('browser ready policy reloads existing tab when tab orchestrator reports stale runtime epoch', () => {
  const ready = {
    ready: false,
    blockingIssue: {
      code: 'runtime_epoch_not_ready',
      source: 'tab-orchestrator',
    },
    connectedClientCount: 1,
    nativeBroker: {
      available: true,
      response: {
        result: {
          tabs: [
            {
              state: 'debuggable',
              tab: { id: 101, active: true },
            },
          ],
        },
      },
    },
  };

  assert.equal(
    shouldReloadExistingTabsForReady(ready, { allowReload: true }),
    true,
  );
  assert.equal(shouldWaitForExistingTabsForReady(ready), true);
});

test('browser ready policy waits for connected clients after recent command timeout', () => {
  assert.equal(
    shouldWaitForExistingTabsForReady({
      ready: false,
      blockingIssue: { code: 'command_timeout_recent' },
      connectedClientCount: 2,
    }),
    true,
  );
});

test('browser ready policy wakes Gemini when only My Activity clients are connected', () => {
  const ready = {
    ready: false,
    blockingIssue: 'no_selectable_gemini_tab',
    connectedClientCount: 3,
    selectableTabCount: 0,
    commandReadyClientCount: 3,
    diagnosticClients: [
      { clientId: 'activity-1', page: { kind: 'activity', url: 'https://myactivity.google.com/product/gemini' } },
      { clientId: 'activity-2', page: { kind: 'activity', url: 'https://myactivity.google.com/product/gemini' } },
      { clientId: 'activity-3', page: { kind: 'activity', url: 'https://myactivity.google.com/product/gemini' } },
    ],
  };

  assert.equal(shouldWakeBrowserForReady(ready), true);
  assert.equal(shouldWaitForExistingTabsForReady(ready), false);
});

test('browser ready policy waits when connected clients may still be Gemini tabs', () => {
  const ready = {
    ready: false,
    blockingIssue: 'no_selectable_gemini_tab',
    connectedClientCount: 1,
    selectableTabCount: 0,
    commandReadyClientCount: 1,
  };

  assert.equal(shouldWakeBrowserForReady(ready), false);
  assert.equal(shouldWaitForExistingTabsForReady(ready), true);
});
