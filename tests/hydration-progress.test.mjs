import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hydrationConfirmationWaitMs,
  hydrationSnapshotLooksLarge,
} from '../build/ts/browser/navigation/hydration-progress.js';

test('small hydrated conversations use a short top confirmation window', () => {
  const smallState = {
    containerCount: 2,
    turnDomCount: 4,
    scrollHeight: 1800,
  };

  assert.equal(hydrationSnapshotLooksLarge(smallState), false);
  assert.equal(
    hydrationConfirmationWaitMs(smallState, {
      loadWaitMs: 900,
      topSettleMs: 8000,
      smallSettleMs: 900,
    }),
    900,
  );
});

test('large conversations keep the conservative top settle budget', () => {
  const largeState = {
    containerCount: 90,
    turnDomCount: 180,
    scrollHeight: 60000,
  };

  assert.equal(hydrationSnapshotLooksLarge(largeState), true);
  assert.equal(
    hydrationConfirmationWaitMs(largeState, {
      loadWaitMs: 900,
      topSettleMs: 8000,
      smallSettleMs: 900,
    }),
    8000,
  );
});
