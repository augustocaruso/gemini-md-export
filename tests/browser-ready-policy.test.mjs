import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
  assert.equal(
    shouldReloadExistingTabsForReady(
      {
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
      },
      { allowReload: true },
    ),
    true,
  );
});
