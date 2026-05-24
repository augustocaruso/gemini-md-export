import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeModalVirtualScrollRange,
  computeModalWheelScroll,
} from '../build/ts/browser/shared/modal-virtual-list.js';

test('computeModalVirtualScrollRange usa altura virtual quando scrollHeight esta subestimado', () => {
  assert.equal(
    computeModalVirtualScrollRange({
      scrollTop: 0,
      clientHeight: 390,
      scrollHeight: 390,
      itemHeight: 78,
      virtualItemCount: 292,
    }),
    22386,
  );
});

test('computeModalWheelScroll move dentro do range virtual e respeita zoom gesture', () => {
  assert.deepEqual(
    computeModalWheelScroll({
      scrollTop: 0,
      clientHeight: 390,
      scrollHeight: 390,
      itemHeight: 78,
      virtualItemCount: 292,
      deltaY: 7020,
    }),
    {
      shouldScroll: true,
      nextScrollTop: 7020,
      maxScrollTop: 22386,
    },
  );

  assert.deepEqual(
    computeModalWheelScroll({
      scrollTop: 0,
      clientHeight: 390,
      scrollHeight: 390,
      itemHeight: 78,
      virtualItemCount: 292,
      deltaY: 7020,
      ctrlKey: true,
    }),
    {
      shouldScroll: false,
      nextScrollTop: 0,
      maxScrollTop: 0,
    },
  );
});
