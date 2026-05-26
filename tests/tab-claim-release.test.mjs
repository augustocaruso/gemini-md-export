import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  storedManagedClaimGroupIdForRelease,
  trackedTabIdsForOwnedClaimRelease,
  trackedTabIdsForClaimRelease,
} from '../build/ts/browser/background/tab-claim-release.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('trackedTabIdsForClaimRelease releases every grouped claim tab', () => {
  assert.deepEqual(
    trackedTabIdsForClaimRelease(42, {
      mode: 'tab-group',
      tabIds: [42, 99, 99, 'bad', null],
      groupId: 777,
    }),
    [42, 99],
  );
});

test('trackedTabIdsForClaimRelease falls back to the primary tab id', () => {
  assert.deepEqual(trackedTabIdsForClaimRelease(42, null), [42]);
});

test('trackedTabIdsForClaimRelease can release tracked tabs without primary tab context', () => {
  assert.deepEqual(trackedTabIdsForClaimRelease(0, { tabIds: ['99', 99, null] }), [99]);
});

test('trackedTabIdsForOwnedClaimRelease does not release tabs owned by another active claim', () => {
  assert.deepEqual(
    trackedTabIdsForOwnedClaimRelease(
      42,
      { claimId: 'export-claim', tabIds: [42, 99, 100] },
      {
        42: { claimId: 'export-claim' },
        99: { claimId: 'activity-claim' },
      },
    ),
    [42, 100],
  );
});

test('storedManagedClaimGroupIdForRelease keeps companion cleanup independent from primary tab', () => {
  assert.equal(
    storedManagedClaimGroupIdForRelease({
      mode: 'tab-group',
      originalGroupId: -1,
      groupId: 777,
      tabIds: [42, 99],
    }),
    777,
  );
  assert.equal(
    storedManagedClaimGroupIdForRelease({
      mode: 'tab-group',
      originalGroupId: 12,
      groupId: 777,
      tabIds: [42, 99],
    }),
    null,
  );
});

test('extension background releases claim visuals for all tracked tab ids', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf8');

  assert.match(source, /trackedTabIdsForClaimRelease/);
  assert.match(source, /trackedTabIdsForOwnedClaimRelease/);
  assert.match(source, /protectedTabIds/);
  assert.match(source, /chromeUpdateTabGroup\(groupId/);
  assert.match(source, /storedManagedClaimGroupIdForRelease\(existing\)/);
  assert.match(source, /for \(const releaseTabId of releaseTabIds\)/);
});
