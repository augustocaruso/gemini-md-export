import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildAuthHelp,
  buildAuthStatusToolCall,
  extractAuthStatusResult,
  formatAuthStatusLabel,
  runAuthStatusCommand,
} from '../build/ts/cli/auth-status-command.js';

test('auth status command builds the unified session_status bridge request', () => {
  assert.deepEqual(
    buildAuthStatusToolCall({
      waitMs: 1234,
      cookiesJson: '/tmp/storage_state.json',
      python: '/opt/python',
      clientId: 'client-1',
      tabId: 42,
      claimId: 'claim-1',
      sessionId: 'session-1',
    }),
    {
      name: 'gemini_support',
        arguments: {
          action: 'session_status',
          waitMs: 1234,
          cookiesJson: '/tmp/storage_state.json',
          python: '/opt/python',
          pythonFallback: true,
          clientId: 'client-1',
        tabId: 42,
        claimId: 'claim-1',
        sessionId: 'session-1',
      },
    },
  );
});

test('auth status command extracts MCP structured content and formats the public label', () => {
  const result = extractAuthStatusResult({
    ok: true,
    result: {
      structuredContent: {
        ok: false,
        selectedAdapter: 'geminiWebapiPython',
        nextAction: { message: 'Cookies expiraram.' },
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    selectedAdapter: 'geminiWebapiPython',
    nextAction: { message: 'Cookies expiraram.' },
  });
  assert.equal(
    formatAuthStatusLabel(result),
    'Auth: requer acao - Cookies expiraram.',
  );
});

test('auth status command parses text fallback without leaking implementation shape', () => {
  const result = extractAuthStatusResult({
    result: {
      content: [{ type: 'text', text: '{"ok":true,"selectedAdapter":"browserBackground"}' }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(formatAuthStatusLabel(result), 'Auth: ok via browserBackground');
});

test('auth status command runner keeps bridge IO in injected shell dependencies', async () => {
  const calls = [];
  const labels = [];
  const run = await runAuthStatusCommand({
    subcommand: 'status',
    flags: {
      bridgeUrl: 'http://127.0.0.1:47283',
      waitMs: 1200,
      wakeBrowser: true,
      cookiesJson: '/tmp/storage_state.json',
    },
    ui: {},
    exitCodes: { ok: 0, manualAction: 4 },
    dependencies: {
      ensureBridgeAvailable: async (flags) => calls.push(['ensure', flags.bridgeUrl]),
      readyWithCliWake: async (bridgeUrl) => calls.push(['wake', bridgeUrl]),
      requestJson: async (bridgeUrl, pathname, options) => {
        calls.push(['request', bridgeUrl, pathname, options.body, options.timeoutMs]);
        return {
          result: {
            structuredContent: { ok: true, selectedAdapter: 'browserBackground' },
          },
        };
      },
      writeStructuredResult: (_ui, result, options) => labels.push([result.ok, options.label]),
    },
  });

  assert.equal(run.exitCode, 0);
  assert.deepEqual(calls, [
    ['ensure', 'http://127.0.0.1:47283'],
    ['wake', 'http://127.0.0.1:47283'],
    [
      'request',
      'http://127.0.0.1:47283',
      '/agent/mcp-tool-call',
      {
        name: 'gemini_support',
        arguments: {
          action: 'session_status',
          waitMs: 1200,
          cookiesJson: '/tmp/storage_state.json',
          pythonFallback: true,
          python: undefined,
          clientId: undefined,
          tabId: undefined,
          claimId: undefined,
          sessionId: undefined,
        },
      },
      20000,
    ],
  ]);
  assert.deepEqual(labels, [[true, 'Auth: ok via browserBackground']]);
});

test('auth status command waits for browser extension readiness before checking session by default', async () => {
  const calls = [];

  await runAuthStatusCommand({
    subcommand: 'status',
    flags: {
      bridgeUrl: 'http://127.0.0.1:47283',
      waitMs: 1200,
    },
    ui: {},
    dependencies: {
      ensureBridgeAvailable: async (flags) => calls.push(['ensure', flags.bridgeUrl]),
      readyWithCliWake: async (bridgeUrl, flags) =>
        calls.push(['ready', bridgeUrl, flags.wakeBrowser]),
      requestJson: async (bridgeUrl, pathname) => {
        calls.push(['request', bridgeUrl, pathname]);
        return {
          result: {
            structuredContent: { ok: false, nextAction: { message: 'Cookies expiraram.' } },
          },
        };
      },
      writeStructuredResult: () => {},
    },
  });

  assert.deepEqual(calls, [
    ['ensure', 'http://127.0.0.1:47283'],
    ['ready', 'http://127.0.0.1:47283', true],
    ['request', 'http://127.0.0.1:47283', '/agent/mcp-tool-call'],
  ]);
});

test('auth status command disables Python fallback unless cookies or python are explicit', () => {
  assert.deepEqual(buildAuthStatusToolCall({}).arguments.pythonFallback, false);
  assert.deepEqual(
    buildAuthStatusToolCall({ cookiesJson: '/tmp/storage_state.json' }).arguments.pythonFallback,
    true,
  );
  assert.deepEqual(buildAuthStatusToolCall({ python: '/opt/python' }).arguments.pythonFallback, true);
});

test('auth status command respects explicit no-wake opt-out', async () => {
  let readinessWakeBrowser = null;

  await runAuthStatusCommand({
    subcommand: 'status',
    flags: {
      bridgeUrl: 'http://127.0.0.1:47283',
      wakeBrowser: false,
      wakeBrowserExplicit: true,
    },
    ui: {},
    dependencies: {
      ensureBridgeAvailable: async () => {},
      readyWithCliWake: async (_bridgeUrl, flags) => {
        readinessWakeBrowser = flags.wakeBrowser;
      },
      requestJson: async () => ({
        result: {
          structuredContent: { ok: false, nextAction: { message: 'Cookies expiraram.' } },
        },
      }),
      writeStructuredResult: () => {},
    },
  });

  assert.equal(readinessWakeBrowser, false);
});

test('auth status command uses persisted storage_state when explicit cookies are absent', async () => {
  const root = resolve(tmpdir(), `gme-auth-storage-${process.pid}-${Date.now()}`);
  const storageState = join(root, 'storage_state.json');
  const previousEnv = process.env.GME_GEMINI_WEBAPI_STORAGE_STATE;
  mkdirSync(root, { recursive: true });
  writeFileSync(storageState, '{"cookies":[]}');
  process.env.GME_GEMINI_WEBAPI_STORAGE_STATE = storageState;
  let body = null;

  try {
    await runAuthStatusCommand({
      subcommand: 'status',
      flags: {
        bridgeUrl: 'http://127.0.0.1:47283',
      },
      ui: {},
      dependencies: {
        ensureBridgeAvailable: async () => {},
        readyWithCliWake: async () => {},
        requestJson: async (_bridgeUrl, _pathname, options) => {
          body = options.body;
          return {
            result: {
              structuredContent: { ok: true, selectedAdapter: 'privateApiGeminiWebapi' },
            },
          };
        },
        writeStructuredResult: () => {},
      },
    });

    assert.equal(body.arguments.cookiesJson, storageState);
    assert.equal(body.arguments.pythonFallback, true);
  } finally {
    if (previousEnv === undefined) delete process.env.GME_GEMINI_WEBAPI_STORAGE_STATE;
    else process.env.GME_GEMINI_WEBAPI_STORAGE_STATE = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status command gives the bridge POST more time than adapter waitMs', async () => {
  let requestTimeoutMs = 0;

  await runAuthStatusCommand({
    subcommand: 'status',
    flags: {
      bridgeUrl: 'http://127.0.0.1:47283',
      waitMs: 30_000,
    },
    ui: {},
    dependencies: {
      ensureBridgeAvailable: async () => {},
      readyWithCliWake: async () => {},
      requestJson: async (_bridgeUrl, _pathname, options) => {
        requestTimeoutMs = options.timeoutMs;
        return {
          result: {
            structuredContent: { ok: false, nextAction: { message: 'Cookies expiraram.' } },
          },
        };
      },
      writeStructuredResult: () => {},
    },
  });

  assert.equal(requestTimeoutMs, 45_000);
});

test('auth status help is assembled outside the CLI JavaScript entrypoint', () => {
  const help = buildAuthHelp({
    commonOptions: ['  --bridge-url <url>'],
    outputModes: ['  --json'],
  });

  assert.match(help, /gemini-md-export auth status/);
  assert.match(help, /--cookies-json <path>/);
  assert.match(help, /--bridge-url <url>/);
  assert.match(help, /--json/);
});
