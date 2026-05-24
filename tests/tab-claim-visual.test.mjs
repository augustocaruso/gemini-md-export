import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTabClaimReceipt,
  tabGroupClaimFailureReason,
} from '../build/ts/mcp/tab-claim-visual.js';

test('tab claim receipt accepts tab-group and action-badge visuals', () => {
  assert.equal(
    isTabClaimReceipt({
      ok: true,
      visual: {
        mode: 'tab-group',
        tabId: 42,
        groupId: 99,
        label: 'Exportando',
        color: 'green',
      },
    }),
    true,
  );

  assert.equal(isTabClaimReceipt({ ok: true, visual: { mode: 'action-badge', tabId: 42 } }), true);
  assert.equal(isTabClaimReceipt({ ok: true }), false);
  assert.equal(isTabClaimReceipt({ ok: false, visual: { mode: 'tab-group', tabId: 42, groupId: 99 } }), false);
});

test('tab claim failure reason names missing visual evidence', () => {
  assert.equal(
    tabGroupClaimFailureReason({
      ok: true,
      visual: { mode: 'action-badge', reason: 'tab-already-in-user-group' },
    }),
    'tab-already-in-user-group',
  );
  assert.equal(tabGroupClaimFailureReason({ ok: true }), 'missing-tab-claim-visual');
});
