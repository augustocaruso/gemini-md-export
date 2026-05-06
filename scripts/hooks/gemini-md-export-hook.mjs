#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const mode = process.argv[2] || 'noop';

const DEFAULT_BRIDGE_TIMEOUT_MS = 300;
const BROWSER_LAUNCH_STATE_FILENAME = 'browser-launch.json';
const LEGACY_BROWSER_LAUNCH_STATE_FILENAME = 'hook-browser-launch.json';
const LEGACY_HOOK_LAST_RUN_FILENAME = 'hook-last-run.json';

const parseNonNegativeInt = (value, fallback, max = 60_000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
};

const stateDir = () =>
  process.env.GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR ||
  process.env.GEMINI_MCP_HOOK_STATE_DIR ||
  resolve(process.env.TEMP || process.env.TMP || tmpdir(), 'gemini-md-export');

const statePath = (filename) => resolve(stateDir(), filename);

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
};

const bridgePort = () => parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283, 65_535);

const bridgeTimeoutMs = () =>
  parseNonNegativeInt(
    process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS ||
      process.env.GEMINI_MCP_BRIDGE_TIMEOUT_MS,
    DEFAULT_BRIDGE_TIMEOUT_MS,
    10_000,
  );

const requestBridgeJson = (path) =>
  new Promise((resolveResult) => {
    const timeoutMs = bridgeTimeoutMs();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveResult({ checked: true, ...result });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port: bridgePort(),
        path,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 262144) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch (err) {
            finish({
              ok: false,
              reachable: false,
              statusCode: res.statusCode,
              error: `invalid-json: ${err.message}`,
            });
            return;
          }
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            reachable: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: parsed,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reachable: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ ok: false, reachable: false, error: err.message });
    });
    req.end();
  });

const noOp = () => ({
  suppressOutput: true,
});

const compactReady = (result) => {
  const body = result?.body || {};
  return {
    ...result,
    body: body
      ? {
          ready: body.ready === true,
          blockingIssue: body.blockingIssue || null,
          connectedClientCount: body.connectedClientCount ?? body.connectedClients?.length ?? null,
          selectableTabCount: body.selectableTabCount ?? null,
          matchingClientCount: body.matchingClientCount ?? null,
          commandReadyClientCount: body.commandReadyClientCount ?? null,
          mode: body.mode || null,
        }
      : body,
  };
};

const compactDiagnostics = (result) => {
  const body = result?.body || {};
  return {
    ...result,
    body: body
      ? {
          status: body.status || null,
          nextAction: body.nextAction || null,
          connectedClientCount: body.extension?.connectedClientCount ?? null,
          matchingClientCount: body.extension?.matchingClientCount ?? null,
          outputDir: body.export?.outputDir || null,
        }
      : body,
  };
};

const diagnose = async () => {
  const [health, ready, diagnostics] = await Promise.all([
    requestBridgeJson('/healthz'),
    requestBridgeJson('/agent/ready?wakeBrowser=false&selfHeal=false&waitMs=0'),
    requestBridgeJson('/agent/diagnostics'),
  ]);
  const launchPath = statePath(BROWSER_LAUNCH_STATE_FILENAME);
  const legacyLaunchPath = statePath(LEGACY_BROWSER_LAUNCH_STATE_FILENAME);
  const legacyLastRunPath = statePath(LEGACY_HOOK_LAST_RUN_FILENAME);

  return {
    ok: true,
    mode: 'diagnose',
    hooksRegisteredByDefault: false,
    note:
      'Runtime hooks are intentionally disabled. CLI and MCP own bridge/browser wake; this script is only a manual diagnostic/no-op compatibility entrypoint.',
    pid: process.pid,
    platform: process.platform,
    stateDir: stateDir(),
    files: {
      browserLaunch: launchPath,
      legacyBrowserLaunch: existsSync(legacyLaunchPath) ? legacyLaunchPath : null,
      legacyHookLastRun: existsSync(legacyLastRunPath) ? legacyLastRunPath : null,
    },
    timeouts: {
      bridgeMs: bridgeTimeoutMs(),
    },
    bridge: {
      health,
      ready: compactReady(ready),
      diagnostics: compactDiagnostics(diagnostics),
    },
    lastBrowserLaunch: readJsonFile(launchPath) || readJsonFile(legacyLaunchPath),
    legacyHookLastRun: readJsonFile(legacyLastRunPath),
  };
};

const run = async () => {
  if (mode === 'diagnose') return diagnose();
  return noOp();
};

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
  process.exit(0);
} catch (err) {
  console.error(`[gemini-md-export-hook] ${err?.message || String(err)}`);
  process.stdout.write(`${JSON.stringify(noOp())}\n`);
  process.exit(0);
}
