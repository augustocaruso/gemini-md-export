import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sharedComputeProgressMilestone,
  sharedNormalizeProgressDisplayPercent,
  sharedShouldRunProgressCreep,
} from '../build/ts/browser/shared/progress-state.js';

test('progress state reseta creep quando total placeholder vira total real', () => {
  assert.equal(
    sharedNormalizeProgressDisplayPercent({
      previousProgress: { total: 1, current: 0, status: 'running' },
      nextProgress: { total: 50, current: 0, status: 'running' },
      previousDisplayPercent: 82,
    }),
    0,
  );
});

test('progress state preserva avanço visual dentro do mesmo milestone', () => {
  const display = sharedNormalizeProgressDisplayPercent({
    previousProgress: { total: 50, current: 22, status: 'running' },
    nextProgress: { total: 50, current: 22, status: 'running' },
    previousDisplayPercent: 44.8,
  });

  assert.equal(display, 44.8);
  assert.deepEqual(sharedComputeProgressMilestone({ total: 50, current: 22 }), {
    base: 44,
    next: 46,
  });
});

test('progress state não deixa placeholder de carregamento virar barra avançada', () => {
  assert.equal(
    sharedShouldRunProgressCreep({
      total: 1,
      current: 0,
      completed: 0,
      phase: 'loading-history',
      status: 'running',
    }),
    false,
  );
  assert.equal(
    sharedNormalizeProgressDisplayPercent({
      previousProgress: {
        total: 1,
        current: 0,
        completed: 0,
        phase: 'loading-history',
        status: 'running',
      },
      nextProgress: {
        total: 1,
        current: 0,
        completed: 0,
        phase: 'loading-history',
        status: 'running',
      },
      previousDisplayPercent: 82,
    }),
    0,
  );
});

test('progress state permite creep em export real de conversa unica', () => {
  assert.equal(
    sharedShouldRunProgressCreep({
      total: 1,
      current: 0,
      completed: 0,
      position: 1,
      phase: 'exporting',
      status: 'running',
    }),
    true,
  );
  assert.equal(
    sharedNormalizeProgressDisplayPercent({
      previousProgress: {
        total: 1,
        current: 0,
        completed: 0,
        position: 1,
        phase: 'exporting',
        status: 'running',
      },
      nextProgress: {
        total: 1,
        current: 0,
        completed: 0,
        position: 1,
        phase: 'exporting',
        status: 'running',
      },
      previousDisplayPercent: 40,
    }),
    40,
  );
});
