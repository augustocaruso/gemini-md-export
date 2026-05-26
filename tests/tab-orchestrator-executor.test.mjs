import assert from 'node:assert/strict';
import test from 'node:test';

import { executeTabOrchestratorEffects } from '../build/ts/mcp/tab-orchestrator/index.js';

const effects = {
  reloadSelf: { type: 'extension.reloadSelf', reason: 'new build', clientId: 'client-1' },
  selfHeal: { type: 'serviceWorker.selfHeal', reason: 'worker stale', target: 'content-script' },
  openBrowser: { type: 'browser.open', reason: 'need tab', url: 'https://gemini.google.com/app', pageKind: 'home' },
  reloadTab: { type: 'tab.reload', reason: 'stale tab', tabId: 7, url: 'https://gemini.google.com/app/abc123abc123' },
  claimTab: { type: 'tab.claim', reason: 'job owns tab', tabId: 7, claimId: 'claim-1' },
  waitForEpoch: { type: 'runtime.waitForEpoch', reason: 'wait for reloaded runtime', epochId: 'epoch-1', timeoutMs: 5000 },
  recordDiagnostic: { type: 'diagnostic.record', reason: 'suppressed', code: 'runtime_recovery_suppressed', severity: 'warning' },
};

const createRecordingAdapter = (overrides = {}) => {
  const calls = [];
  const method = (name) => async (effect) => {
    calls.push({ method: name, effect });
    return { method: name, type: effect.type };
  };
  return {
    calls,
    adapter: {
      reloadExtensionSelf: method('reloadExtensionSelf'),
      serviceWorkerSelfHeal: method('serviceWorkerSelfHeal'),
      openBrowser: method('openBrowser'),
      reloadTab: method('reloadTab'),
      claimTab: method('claimTab'),
      waitForRuntimeEpoch: method('waitForRuntimeEpoch'),
      recordDiagnostic: method('recordDiagnostic'),
      ...overrides,
    },
  };
};

test('effect executor invokes adapter calls in order for selfHeal, waitForEpoch, tab.claim', async () => {
  const { adapter, calls } = createRecordingAdapter();
  const orderedEffects = [effects.selfHeal, effects.waitForEpoch, effects.claimTab];

  const report = await executeTabOrchestratorEffects(orderedEffects, adapter);

  assert.equal(report.status, 'completed');
  assert.deepEqual(calls, [
    { method: 'serviceWorkerSelfHeal', effect: effects.selfHeal },
    { method: 'waitForRuntimeEpoch', effect: effects.waitForEpoch },
    { method: 'claimTab', effect: effects.claimTab },
  ]);
  assert.deepEqual(
    report.executed.map((item) => ({
      effect: item.effect,
      ok: item.ok,
      result: item.result,
    })),
    orderedEffects.map((effect, index) => ({
      effect,
      ok: true,
      result: { method: calls[index].method, type: effect.type },
    })),
  );
});

test('all effect types dispatch to matching adapter method', async () => {
  const { adapter, calls } = createRecordingAdapter();
  const allEffects = [
    effects.reloadSelf,
    effects.selfHeal,
    effects.openBrowser,
    effects.reloadTab,
    effects.claimTab,
    effects.waitForEpoch,
    effects.recordDiagnostic,
  ];

  const report = await executeTabOrchestratorEffects(allEffects, adapter);

  assert.equal(report.status, 'completed');
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'reloadExtensionSelf',
      'serviceWorkerSelfHeal',
      'openBrowser',
      'reloadTab',
      'claimTab',
      'waitForRuntimeEpoch',
      'recordDiagnostic',
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.effect),
    allEffects,
  );
  assert.equal(report.executed.length, allEffects.length);
  assert.equal(report.executed.every((item) => item.ok), true);
});

test('adapter error is captured and subsequent effects still run', async () => {
  const failure = new Error('reload failed');
  failure.code = 'RELOAD_FAILED';
  const { adapter, calls } = createRecordingAdapter({
    reloadTab: async (effect) => {
      calls.push({ method: 'reloadTab', effect });
      throw failure;
    },
  });
  const orderedEffects = [effects.selfHeal, effects.reloadTab, effects.claimTab];

  const report = await executeTabOrchestratorEffects(orderedEffects, adapter);

  assert.equal(report.status, 'completed_with_errors');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['serviceWorkerSelfHeal', 'reloadTab', 'claimTab'],
  );
  assert.deepEqual(report.executed, [
    {
      effect: effects.selfHeal,
      ok: true,
      result: { method: 'serviceWorkerSelfHeal', type: effects.selfHeal.type },
    },
    {
      effect: effects.reloadTab,
      ok: false,
      error: {
        name: 'Error',
        message: 'reload failed',
        code: 'RELOAD_FAILED',
      },
    },
    {
      effect: effects.claimTab,
      ok: true,
      result: { method: 'claimTab', type: effects.claimTab.type },
    },
  ]);
});

test('thrown Error returns serializable error with name and message', async () => {
  const failure = new TypeError('runtime epoch unavailable');
  const { adapter } = createRecordingAdapter({
    waitForRuntimeEpoch: async () => {
      throw failure;
    },
  });

  const report = await executeTabOrchestratorEffects([effects.waitForEpoch], adapter);

  assert.deepEqual(report.executed, [
    {
      effect: effects.waitForEpoch,
      ok: false,
      error: {
        name: 'TypeError',
        message: 'runtime epoch unavailable',
      },
    },
  ]);
  assert.match(JSON.stringify(report), /runtime epoch unavailable/);
});

test('thrown string and object return useful messages and do not break execution', async () => {
  const { adapter, calls } = createRecordingAdapter({
    openBrowser: async (effect) => {
      calls.push({ method: 'openBrowser', effect });
      throw 'browser refused';
    },
    reloadTab: async (effect) => {
      calls.push({ method: 'reloadTab', effect });
      throw { message: 'tab missing', code: 'TAB_MISSING' };
    },
  });
  const orderedEffects = [
    effects.openBrowser,
    effects.reloadTab,
    effects.recordDiagnostic,
  ];

  const report = await executeTabOrchestratorEffects(orderedEffects, adapter);

  assert.equal(report.status, 'completed_with_errors');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['openBrowser', 'reloadTab', 'recordDiagnostic'],
  );
  assert.deepEqual(report.executed, [
    {
      effect: effects.openBrowser,
      ok: false,
      error: { message: 'browser refused' },
    },
    {
      effect: effects.reloadTab,
      ok: false,
      error: {
        message: 'tab missing',
        code: 'TAB_MISSING',
      },
    },
    {
      effect: effects.recordDiagnostic,
      ok: true,
      result: {
        method: 'recordDiagnostic',
        type: effects.recordDiagnostic.type,
      },
    },
  ]);
});

test('empty effects returns completed with empty executed list', async () => {
  const { adapter, calls } = createRecordingAdapter();

  const report = await executeTabOrchestratorEffects([], adapter);

  assert.deepEqual(report, { status: 'completed', executed: [] });
  assert.deepEqual(calls, []);
});
