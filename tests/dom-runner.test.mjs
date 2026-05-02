import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionabilityTimeoutMessage,
  buildAutoWaitSnapshot,
  describeDomActionability,
  summarizeStrictLocator,
} from '../src/dom-runner.mjs';

test('dom runner aplica strict locator antes de actionability', () => {
  const strict = summarizeStrictLocator({ name: 'botao', count: 2 });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, 'locator_not_strict');

  const actionability = describeDomActionability({
    name: 'botao',
    count: 2,
    attached: true,
    visible: true,
  });
  assert.equal(actionability.ok, false);
  assert.equal(actionability.code, 'locator_not_strict');
});

test('dom runner descreve falha retryable de visibilidade e mensagem humana', () => {
  const actionability = describeDomActionability({
    name: 'sidebar scroller',
    count: 1,
    attached: true,
    visible: false,
  });
  const snapshot = buildAutoWaitSnapshot({
    name: 'rolar histórico',
    attempts: 3,
    elapsedMs: 1200,
    timeoutMs: 5000,
    lastActionability: actionability,
  });

  assert.equal(actionability.retryable, true);
  assert.equal(snapshot.lastCode, 'actionability_visible');
  assert.match(actionabilityTimeoutMessage(snapshot), /rolar histórico/);
  assert.match(actionabilityTimeoutMessage(snapshot), /visível/);
});

