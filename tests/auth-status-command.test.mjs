import assert from 'node:assert/strict';
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
        calls.push(['request', bridgeUrl, pathname, options.body]);
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
          python: undefined,
          clientId: undefined,
          tabId: undefined,
          claimId: undefined,
          sessionId: undefined,
        },
      },
    ],
  ]);
  assert.deepEqual(labels, [[true, 'Auth: ok via browserBackground']]);
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
