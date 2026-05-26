import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activityCompanionTabIdsForNativeLease,
  shouldPrepareActivityCompanionForDateImport,
} from '../build/ts/mcp/activity-companion-readiness.js';

test('activity companion helper extracts the non-Gemini visual tab from a native lease', () => {
  const lease = {
    tabId: 42,
    visual: {
      mode: 'tab-group',
      tabIds: [42, 99, 99],
    },
  };

  assert.deepEqual(activityCompanionTabIdsForNativeLease(lease, 42), [99]);
});

test('activity companion helper falls back to lease tab id and ignores invalid ids', () => {
  const lease = {
    tabId: '42',
    visual: {
      tabIds: ['42', '99', 'not-a-tab', 0, -1],
    },
  };

  assert.deepEqual(activityCompanionTabIdsForNativeLease(lease), [99]);
});

test('activity companion helper follows My Activity date-import opt-out flags', () => {
  assert.equal(shouldPrepareActivityCompanionForDateImport({}), true);
  assert.equal(shouldPrepareActivityCompanionForDateImport({ noMyActivity: true }), false);
  assert.equal(shouldPrepareActivityCompanionForDateImport({ useMyActivity: false }), false);
});
