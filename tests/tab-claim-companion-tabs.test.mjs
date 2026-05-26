import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  selectClaimVisualCompanionTabIds,
} from '../build/ts/browser/background/tab-claim-companion-tabs.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('claim companion helper picks the nearest My Activity tab in the same window', () => {
  const claimed = {
    id: 42,
    windowId: 7,
    index: 10,
    url: 'https://gemini.google.com/app/abc123456789',
  };
  const farActivity = {
    id: 98,
    windowId: 7,
    index: 2,
    url: 'https://myactivity.google.com/product/gemini',
  };
  const nearActivity = {
    id: 99,
    windowId: 7,
    index: 11,
    url: 'https://myactivity.google.com/product/gemini',
  };
  const otherWindowActivity = {
    id: 100,
    windowId: 8,
    index: 9,
    url: 'https://myactivity.google.com/product/gemini',
  };

  assert.deepEqual(
    selectClaimVisualCompanionTabIds(claimed, [
      otherWindowActivity,
      farActivity,
      claimed,
      nearActivity,
    ]),
    [99],
  );
});

test('claim companion helper does not duplicate explicit related tab ids', () => {
  const claimed = { id: 42, windowId: 7, index: 10 };
  const activity = {
    id: 99,
    windowId: 7,
    index: 11,
    url: 'https://myactivity.google.com/product/gemini',
  };

  assert.deepEqual(selectClaimVisualCompanionTabIds(claimed, [activity], [99]), [99]);
});

test('extension background auto-discovers a My Activity companion for claim visuals', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf8');

  assert.match(source, /queryActivityCompanionTabsForClaim/);
  assert.match(source, /selectClaimVisualCompanionTabIds/);
  assert.match(source, /requestedRelatedTabIds/);
});
