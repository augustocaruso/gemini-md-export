import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  BROWSER_SIDE_EFFECTS_STATE_FILENAME,
  browserCommandSideEffectKind,
  browserControlRuntimeState,
  browserSideEffectsStatePath,
  decideBrowserSideEffectAllowed,
  markBrowserSideEffectCommandArgs,
  readBrowserSideEffectsState,
  setBrowserSideEffectsDisabled,
  shouldStartBrowserBridgeHttp,
} from '../build/ts/mcp/browser-side-effects.js';
import {
  buildBridgeOnlyChildEnv,
  FORBIDDEN_BRIDGE_ONLY_BROWSER_ENV_KEYS,
} from '../build/ts/mcp/browser-runtime-env.js';

test('browser side effects are allowed only with explicit intent outside proxy mode', () => {
  assert.deepEqual(
    decideBrowserSideEffectAllowed({
      kind: 'browser-launch',
      explicit: true,
      bridgeRole: 'primary',
      state: { disabled: false },
    }),
    { ok: true, kind: 'browser-launch' },
  );

  assert.equal(
    decideBrowserSideEffectAllowed({
      kind: 'browser-launch',
      explicit: false,
      bridgeRole: 'primary',
      state: { disabled: false },
    }).code,
    'browser_side_effect_requires_explicit_intent',
  );
});

test('browser side effects default to explicit-command control instead of runtime quarantine', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'gme-side-effects-default-'));
  try {
    const runtime = browserControlRuntimeState({});
    assert.equal(runtime.authorized, true);
    assert.equal(runtime.source, 'runtime-default');

    const state = readBrowserSideEffectsState({ diagnosticDir: tmp, env: {} });
    assert.equal(state.disabled, false);

    const implicit = decideBrowserSideEffectAllowed({
      kind: 'tab-reload',
      explicit: false,
      bridgeRole: 'primary',
      state,
    });
    assert.equal(implicit.ok, false);
    assert.equal(implicit.code, 'browser_side_effect_requires_explicit_intent');

    assert.deepEqual(
      decideBrowserSideEffectAllowed({
        kind: 'tab-reload',
        explicit: true,
        bridgeRole: 'primary',
        state,
      }),
      { ok: true, kind: 'tab-reload' },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('browser side effects are blocked in proxy mode even when explicit', () => {
  const decision = decideBrowserSideEffectAllowed({
    kind: 'tab-reload',
    explicit: true,
    bridgeRole: 'proxy',
    state: { disabled: false },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'browser_side_effect_proxy_blocked');
});

test('browser side effects are blocked by local quarantine file', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'gme-side-effects-'));
  try {
    const written = setBrowserSideEffectsDisabled({
      diagnosticDir: tmp,
      disabled: true,
      reason: 'stale-session-loop',
      source: 'test',
      nowMs: 1_000,
    });

    assert.equal(written.path, resolve(tmp, BROWSER_SIDE_EFFECTS_STATE_FILENAME));
    assert.equal(JSON.parse(readFileSync(written.path, 'utf-8')).disabled, true);

    const state = readBrowserSideEffectsState({
      diagnosticDir: tmp,
      nowMs: 1_500,
      env: { GEMINI_MCP_BROWSER_CONTROL: 'cli' },
    });
    assert.equal(state.disabled, true);
    assert.equal(state.reason, 'stale-session-loop');

    const decision = decideBrowserSideEffectAllowed({
      kind: 'extension-reload',
      explicit: true,
      bridgeRole: 'primary',
      state,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'browser_side_effects_disabled');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('env kill switch disables browser side effects without writing state', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'gme-side-effects-env-'));
  try {
    const state = readBrowserSideEffectsState({
      diagnosticDir: tmp,
      env: { GEMINI_MCP_BROWSER_SIDE_EFFECTS: 'off' },
    });

    assert.equal(state.disabled, true);
    assert.equal(state.source, 'env');
    assert.equal(browserSideEffectsStatePath(tmp), resolve(tmp, BROWSER_SIDE_EFFECTS_STATE_FILENAME));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bridge HTTP starts by default while browser side effects stay gated', () => {
  assert.equal(shouldStartBrowserBridgeHttp({ env: {} }), true);
  assert.equal(shouldStartBrowserBridgeHttp({ env: { GEMINI_MCP_BRIDGE_HTTP: 'off' } }), false);

  const decision = decideBrowserSideEffectAllowed({
    kind: 'browser-launch',
    explicit: false,
    bridgeRole: 'primary',
    state: { disabled: false },
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'browser_side_effect_requires_explicit_intent');
});

test('bridge HTTP does not own the shared port when browser control is disabled by env', () => {
  assert.equal(
    shouldStartBrowserBridgeHttp({
      env: { GEMINI_MCP_BROWSER_SIDE_EFFECTS: 'off' },
    }),
    false,
  );

  assert.equal(
    shouldStartBrowserBridgeHttp({
      env: {
        GEMINI_MCP_BROWSER_SIDE_EFFECTS: 'off',
        GEMINI_MCP_BRIDGE_HTTP: 'on',
      },
    }),
    true,
  );
});

test('CLI bridge-only child env cannot force browser side effects on', () => {
  const env = buildBridgeOnlyChildEnv({
    GEMINI_MCP_BROWSER_CONTROL: 'cli',
    GEMINI_MD_EXPORT_BROWSER_CONTROL: 'cli',
    GME_BROWSER_CONTROL: 'cli',
    GEMINI_MCP_BROWSER_SIDE_EFFECTS: 'on',
    GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS: 'on',
    GEMINI_MCP_BROWSER_SIDE_EFFECTS_DISABLED: 'true',
    GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'true',
  });

  for (const key of FORBIDDEN_BRIDGE_ONLY_BROWSER_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must not be forwarded to bridge-only child`);
  }
  assert.equal(env.GEMINI_MCP_BROWSER_SIDE_EFFECTS_DISABLED, 'true');
  assert.equal(env.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED, 'false');
});

test('CLI bridge-only bootstrap uses the typed env builder instead of inline browser overrides', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const block =
    source.match(/const startBridgeOnlyProcess = \(flags\) => \{[\s\S]*?\n\};\n\nconst BRIDGE_PROCESS_RE/)?.[0] ||
    '';

  assert.match(block, /buildBridgeOnlyChildEnv\(process\.env\)/);
  assert.doesNotMatch(block, /GEMINI_MCP_BROWSER_CONTROL/);
  assert.doesNotMatch(block, /GEMINI_MD_EXPORT_BROWSER_CONTROL/);
  assert.doesNotMatch(block, /GEMINI_MCP_BROWSER_SIDE_EFFECTS/);
  assert.doesNotMatch(block, /GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS/);
});

test('browser command side effect classification covers navigation, reload and activation commands', () => {
  assert.equal(browserCommandSideEffectKind('open-chat'), 'tab-navigation');
  assert.equal(browserCommandSideEffectKind('get-chat-by-id'), 'tab-navigation');
  assert.equal(browserCommandSideEffectKind('reload-page'), 'tab-reload');
  assert.equal(browserCommandSideEffectKind('reload-gemini-tabs'), 'tab-reload');
  assert.equal(browserCommandSideEffectKind('activate-browser-tab'), 'tab-activation');
  assert.equal(browserCommandSideEffectKind('reload-extension-self'), 'extension-reload');
  assert.equal(browserCommandSideEffectKind('get-extension-info'), null);
});

test('browser side effect command args carry explicit runtime intent for content scripts', () => {
  assert.deepEqual(markBrowserSideEffectCommandArgs('reload-page', { delayMs: 250 }, true), {
    delayMs: 250,
    explicit: true,
    explicitBrowserSideEffect: true,
  });
  assert.deepEqual(markBrowserSideEffectCommandArgs('get-extension-info', {}, true), {});
  assert.deepEqual(markBrowserSideEffectCommandArgs('reload-page', { delayMs: 250 }, false), {
    delayMs: 250,
  });
});

test('MCP gates browser launch, reload and extension reload through side effect policy', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /readBrowserSideEffectsState/);
  assert.match(source, /assertBrowserSideEffectAllowed/);
  assert.match(source, /browserCommandSideEffectKind/);
  assert.match(source, /assertBrowserSideEffect\('browser-launch'/);
  assert.match(source, /assertBrowserSideEffect\('extension-reload'/);
  assert.match(source, /assertBrowserSideEffect\('tab-reload'/);
  assert.match(source, /bridgeRole,|bridgeRole:\s*bridgeRole/);
  assert.match(source, /launchIfClosed:\s*process\.env\.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED === 'true'/);
  assert.doesNotMatch(source, /launchIfClosed:\s*process\.env\.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED !== 'false'/);
});

test('content script does not forward tab reload command without explicit intent', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'userscript-shell.ts'), 'utf-8');
  const block =
    source.match(/if \(command\.type === 'reload-gemini-tabs'\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.match(source, /const browserSideEffectCommands = new Set\(\[[\s\S]*'get-chat-by-id'[\s\S]*'reload-page'/);
  assert.match(source, /explicitBrowserCommandIntentRequired/);
  assert.match(block, /command\.args\?\.explicit !== true && command\.args\?\.force !== true/);
  assert.match(block, /status: 'explicit-reload-required'/);
  assert.match(block, /skipped: true/);
  assert.match(block, /explicit: command\.args\?\.explicit === true/);
  assert.match(block, /force: command\.args\?\.force === true/);
});

test('MCP marks explicit browser side effect command args before dispatch', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /markBrowserSideEffectCommandArgs/);
  assert.match(source, /const browserSideEffectExplicit =/);
  assert.match(source, /args: commandArgs/);
});
