import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatReadAdapterPlan,
  browserBackgroundChatReadCapability,
  domChatReadCapability,
  privateApiGeminiWebapiChatReadCapability,
  takeoutChatReadCapability,
  transitionChatReadAdapterFallback,
} from '../build/ts/core/chat-read-adapter.js';

test('chat read adapter plan gates experimental private API transports unless explicitly allowed', () => {
  const capabilities = [
    privateApiGeminiWebapiChatReadCapability({ available: true }),
    browserBackgroundChatReadCapability({ available: true }),
    domChatReadCapability({ available: true }),
    takeoutChatReadCapability({ available: true }),
  ];

  const defaultPlan = buildChatReadAdapterPlan({
    capabilities,
    preferredAdapter: 'privateApiGeminiWebapi',
  });
  assert.equal(defaultPlan.selectedAdapter, 'dom');
  assert.deepEqual(defaultPlan.fallbackAdapters, ['takeout']);

  const experimentalPlan = buildChatReadAdapterPlan({
    capabilities,
    preferredAdapter: 'privateApiGeminiWebapi',
    allowExperimental: true,
  });
  assert.equal(experimentalPlan.selectedAdapter, 'privateApiGeminiWebapi');
  assert.deepEqual(experimentalPlan.fallbackAdapters, ['browserBackground', 'dom', 'takeout']);
});

test('chat read adapter plan exposes DOM fallback when private API fails capability check', () => {
  const plan = buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'privateApiGeminiWebapi',
    capabilities: [
      privateApiGeminiWebapiChatReadCapability({
        available: false,
        reason: 'private_api_token_missing',
      }),
      browserBackgroundChatReadCapability({
        available: false,
        reason: 'managed_browser_client_missing',
      }),
      domChatReadCapability({ available: true }),
    ],
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.selectedAdapter, 'dom');
  assert.deepEqual(plan.fallbackAdapters, []);
  assert.equal(plan.capabilities[0].reason, 'private_api_token_missing');
});

test('chat read adapter fallback FSM advances through failed adapters and records structured warnings', () => {
  const plan = buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'privateApiGeminiWebapi',
    capabilities: [
      privateApiGeminiWebapiChatReadCapability({ available: true }),
      browserBackgroundChatReadCapability({ available: true }),
      domChatReadCapability({ available: true }),
    ],
  });

  const started = transitionChatReadAdapterFallback(
    { status: 'idle', plan, warnings: [], attempts: [] },
    { type: 'start' },
  );
  assert.equal(started.state.status, 'attempting');
  assert.deepEqual(started.effects, [
    { type: 'read_adapter', adapter: 'privateApiGeminiWebapi' },
  ]);

  const afterPythonFailure = transitionChatReadAdapterFallback(started.state, {
    type: 'adapter_failed',
    adapter: 'privateApiGeminiWebapi',
    code: 'cookie_import_failed',
    message: 'cookies indisponiveis',
  });

  assert.equal(afterPythonFailure.state.status, 'attempting');
  assert.deepEqual(afterPythonFailure.effects, [
    { type: 'read_adapter', adapter: 'browserBackground' },
  ]);
  assert.deepEqual(afterPythonFailure.state.warnings, [
    {
      adapter: 'privateApiGeminiWebapi',
      code: 'cookie_import_failed',
      message: 'cookies indisponiveis',
    },
  ]);

  const afterBrowserFailure = transitionChatReadAdapterFallback(afterPythonFailure.state, {
    type: 'adapter_failed',
    adapter: 'browserBackground',
    code: 'private_api_wire_format_changed',
    message: 'wire drift',
  });
  assert.deepEqual(afterBrowserFailure.effects, [{ type: 'read_adapter', adapter: 'dom' }]);

  const succeeded = transitionChatReadAdapterFallback(afterBrowserFailure.state, {
    type: 'adapter_succeeded',
    adapter: 'dom',
  });
  assert.equal(succeeded.state.status, 'succeeded');
  assert.deepEqual(succeeded.effects, [{ type: 'finish', ok: true }]);
  assert.deepEqual(
    succeeded.state.attempts.map((attempt) => [attempt.adapter, attempt.status]),
    [
      ['privateApiGeminiWebapi', 'failed'],
      ['browserBackground', 'failed'],
      ['dom', 'succeeded'],
    ],
  );
});
