#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SERVER_PATH = resolve(ROOT, 'src', 'mcp-server.js');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ORIGIN = 'https://gemini.google.com';

const parseArgs = (argv) => {
  const out = {
    json: false,
    spawn: false,
    host: DEFAULT_HOST,
    port: null,
    bridgeUrl: null,
    timeoutMs: 8000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--spawn') {
      out.spawn = true;
      continue;
    }
    if (arg === '--bridge-url' && argv[i + 1]) {
      out.bridgeUrl = argv[++i];
      continue;
    }
    if (arg === '--host' && argv[i + 1]) {
      out.host = argv[++i];
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[++i]);
      continue;
    }
    if (arg === '--timeout-ms' && argv[i + 1]) {
      out.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!out.bridgeUrl) out.spawn = true;
  return out;
};

const usage = () =>
  [
    'bridge-smoke.mjs',
    '',
    'Uso:',
    '  node scripts/bridge-smoke.mjs --spawn [--json]',
    '  node scripts/bridge-smoke.mjs --bridge-url http://127.0.0.1:47283 [--json]',
    '',
    'O smoke isolado nao exige login no Gemini: ele cria um cliente sintetico',
    'da extensao e valida healthz, snapshot, SSE events, ready, clients, diagnostics e diagnostico.',
    '',
  ].join('\n');

const getFreePort = async () => {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, DEFAULT_HOST, resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

const normalizeBridgeUrl = (url) => String(url).replace(/\/+$/, '');

const requestJson = async (bridgeUrl, path, { method = 'GET', body, origin, timeoutMs } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, `${bridgeUrl}/`), {
      method,
      headers: {
        ...(origin ? { origin } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(json?.error || `HTTP ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const waitForHealth = async (bridgeUrl, timeoutMs) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(bridgeUrl, '/healthz', { timeoutMs: 1000 });
    } catch (err) {
      lastError = err;
      await sleep(80);
    }
  }
  throw new Error(`Bridge nao ficou saudavel: ${lastError?.message || 'timeout'}`);
};

const spawnBridge = (port) => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_MCP_BRIDGE_PORT: String(port),
      GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
      GEMINI_MCP_DEBUG: 'false',
      GEMINI_MCP_PORT_OWNER_DIAGNOSTIC_TIMEOUT_MS: '1000',
      GEMINI_MCP_PROCESS_DIAGNOSTIC_TIMEOUT_MS: '1000',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });
  return {
    pid: child.pid,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        sleep(1200).then(() => child.kill('SIGKILL')),
      ]);
    },
  };
};

const readSseHello = async (bridgeUrl, clientId, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      new URL(`/bridge/events?clientId=${encodeURIComponent(clientId)}`, `${bridgeUrl}/`),
      {
        headers: { origin: DEFAULT_ORIGIN },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value || []).toString('utf-8');
    controller.abort();
    return chunk;
  } finally {
    clearTimeout(timer);
  }
};

const runCheck = async (checks, name, fn) => {
  const startedAt = Date.now();
  try {
    const value = await fn();
    checks.push({ name, ok: true, elapsedMs: Date.now() - startedAt, value });
    return value;
  } catch (err) {
    checks.push({ name, ok: false, elapsedMs: Date.now() - startedAt, error: err.message });
    return null;
  }
};

const runSmoke = async (options) => {
  const port = options.port || (options.spawn ? await getFreePort() : 47283);
  const bridgeUrl = normalizeBridgeUrl(options.bridgeUrl || `http://${options.host}:${port}`);
  const spawned = options.spawn ? spawnBridge(port) : null;
  const checks = [];
  const clientId = `bridge-smoke-${process.pid}-${Date.now()}`;
  let expectedChromeExtension = {
    extensionVersion: pkg.version,
    protocolVersion: bridgeVersion.protocolVersion,
    buildStamp: null,
  };

  try {
    const health = await runCheck(checks, 'healthz', async () => {
      const value = await waitForHealth(bridgeUrl, options.timeoutMs);
      if (!value.ok) throw new Error('healthz retornou ok=false');
      return {
        name: value.name,
        version: value.version,
        protocolVersion: value.protocolVersion,
        bridgeRole: value.bridgeRole,
        pid: value.pid,
      };
    });

    await runCheck(checks, 'agent_expected_extension', async () => {
      const value = await requestJson(bridgeUrl, '/agent/clients', {
        timeoutMs: options.timeoutMs,
      });
      expectedChromeExtension = value.expectedChromeExtension || expectedChromeExtension;
      return expectedChromeExtension;
    });

    await runCheck(checks, 'bridge_snapshot', async () => {
      const value = await requestJson(bridgeUrl, '/bridge/snapshot', {
        method: 'POST',
        origin: DEFAULT_ORIGIN,
        timeoutMs: options.timeoutMs,
        body: {
          clientId,
          extensionVersion: expectedChromeExtension.extensionVersion,
          protocolVersion: expectedChromeExtension.protocolVersion,
          buildStamp: expectedChromeExtension.buildStamp || 'smoke-test',
          capabilities: ['snapshot', 'events'],
          page: {
            url: 'https://gemini.google.com/app',
            title: 'Smoke test',
            buildStamp: expectedChromeExtension.buildStamp || 'smoke-test',
          },
          conversations: [],
          modalConversations: [],
          snapshotHash: 'smoke-empty',
          observedAt: new Date().toISOString(),
        },
      });
      if (!value.ok) throw new Error('snapshot retornou ok=false');
      return {
        clientId: value.clientId,
        bridgeHealth: value.bridgeHealth,
      };
    });

    await runCheck(checks, 'bridge_events_sse', async () => {
      const chunk = await readSseHello(bridgeUrl, clientId, options.timeoutMs);
      if (!chunk.includes('connected') && !chunk.includes('hello')) {
        throw new Error('SSE nao retornou connected/hello');
      }
      return { firstChunk: chunk.split(/\r?\n/).filter(Boolean).slice(0, 4) };
    });

    await runCheck(checks, 'bridge_heartbeat', async () => {
      const value = await requestJson(bridgeUrl, '/bridge/heartbeat', {
        method: 'POST',
        origin: DEFAULT_ORIGIN,
        timeoutMs: options.timeoutMs,
        body: {
          clientId,
          extensionVersion: expectedChromeExtension.extensionVersion,
          protocolVersion: expectedChromeExtension.protocolVersion,
          buildStamp: expectedChromeExtension.buildStamp || 'smoke-test',
          capabilities: ['snapshot', 'events'],
          snapshotHash: 'smoke-empty',
          commandPoll: { polling: true },
          page: {
            url: 'https://gemini.google.com/app',
            title: 'Smoke test',
            buildStamp: expectedChromeExtension.buildStamp || 'smoke-test',
          },
        },
      });
      if (!value.ok) throw new Error('heartbeat retornou ok=false');
      return {
        clientId: value.clientId,
        transport: value.transport,
        bridgeHealth: value.bridgeHealth,
      };
    });

    await runCheck(checks, 'agent_ready', async () => {
      const value = await requestJson(bridgeUrl, '/agent/ready', {
        timeoutMs: options.timeoutMs,
      });
      if (value.ready !== true) {
        throw new Error(`ready retornou ${value.ready} (${value.blockingIssue || 'sem motivo'})`);
      }
      return {
        ready: value.ready,
        mode: value.mode,
        connectedClientCount: value.connectedClientCount,
        selectableTabCount: value.selectableTabCount,
        matchingClientCount: value.matchingClientCount,
        commandReadyClientCount: value.commandReadyClientCount,
        blockingIssue: value.blockingIssue,
      };
    });

    await runCheck(checks, 'agent_clients', async () => {
      const value = await requestJson(bridgeUrl, '/agent/clients?diagnostics=1', {
        timeoutMs: options.timeoutMs,
      });
      const client = value.connectedClients?.find((item) => item.clientId === clientId);
      if (!client) throw new Error('cliente sintetico nao apareceu em /agent/clients');
      return {
        connectedClients: value.connectedClients.length,
        smokeClient: {
          clientId: client.clientId,
          extensionVersion: client.extensionVersion,
          protocolVersion: client.protocolVersion,
          buildStamp: client.buildStamp,
          bridgeHealth: client.bridgeHealth,
        },
      };
    });

    await runCheck(checks, 'agent_diagnostics', async () => {
      const value = await requestJson(bridgeUrl, '/agent/diagnostics', {
        timeoutMs: options.timeoutMs,
      });
      if (value.status !== 'ready') {
        throw new Error(`diagnostico nao ficou ready: ${value.status}`);
      }
      return {
        status: value.status,
        nextAction: value.nextAction,
        connectedClientCount: value.extension?.connectedClientCount,
        matchingClientCount: value.extension?.matchingClientCount,
        outputDir: value.export?.outputDir,
      };
    });

    await runCheck(checks, 'process_diagnostics', async () => {
      const value = await requestJson(bridgeUrl, '/agent/mcp-tool-call', {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        body: {
          name: 'gemini_support',
          arguments: { action: 'processes', detail: 'full' },
        },
      });
      const structured = value.result?.structuredContent;
      if (!value.ok || !structured) throw new Error(value.error || 'diagnostico sem structuredContent');
      return {
        proxyState: structured.proxyState,
        cleanupEligible: structured.cleanupPlan?.eligible === true,
        primaryVersion: structured.primaryBridge?.version || null,
      };
    });

    return {
      ok: checks.every((item) => item.ok),
      bridgeUrl,
      spawned: spawned ? { pid: spawned.pid } : null,
      expected: {
        version: expectedChromeExtension.extensionVersion,
        protocolVersion: expectedChromeExtension.protocolVersion,
        buildStamp: expectedChromeExtension.buildStamp || null,
      },
      health,
      checks,
    };
  } finally {
    await spawned?.stop();
  }
};

const printPlain = (result) => {
  process.stdout.write(`Bridge smoke: ${result.ok ? 'OK' : 'FALHOU'}\n`);
  process.stdout.write(`Bridge: ${result.bridgeUrl}\n`);
  for (const check of result.checks) {
    process.stdout.write(
      `- ${check.ok ? 'OK' : 'FAIL'} ${check.name} (${check.elapsedMs}ms)${
        check.error ? `: ${check.error}` : ''
      }\n`,
    );
  }
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const result = await runSmoke(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printPlain(result);
  }
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  const errorResult = {
    ok: false,
    error: err.message,
  };
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(errorResult, null, 2)}\n`);
  } else {
    process.stderr.write(`${err.message}\n\n${usage()}`);
  }
  process.exitCode = 1;
}
