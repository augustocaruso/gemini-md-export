import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportTabReadinessPolicyForArgs,
  transitionExportTabReadinessFsm,
} from '../build/ts/mcp/export-tab-readiness.js';

test('export tab readiness FSM is background-first by default', () => {
  const decision = transitionExportTabReadinessFsm('checking', {
    type: 'client_seen',
    explicitActivation: false,
  });

  assert.equal(decision.state, 'background_allowed');
  assert.equal(decision.effects.activateTab, false);
  assert.equal(decision.effects.requireActiveTab, false);
  assert.equal(decision.effects.allowInactiveTab, true);
});

test('export tab readiness FSM activates only when requested explicitly', () => {
  const decision = exportTabReadinessPolicyForArgs({ activateTab: true });

  assert.equal(decision.state, 'foreground_required');
  assert.equal(decision.effects.activateTab, true);
  assert.equal(decision.effects.requireActiveTab, true);
  assert.equal(decision.effects.allowInactiveTab, false);
});

