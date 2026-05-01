import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER_PATH = resolve(ROOT, 'src', 'mcp-server.js');
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;

const getFreePort = async () => {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

const listenHttp = async (server, port) =>
  new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });

const closeHttp = async (server) =>
  new Promise((resolveClose) => server.close(resolveClose));

const waitForHealth = async (port) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return await response.json();
    } catch {
      // Server is still starting.
    }
    await sleep(50);
  }
  throw new Error(`MCP bridge did not become healthy on port ${port}`);
};

const spawnMcp = (port) => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_MCP_BRIDGE_PORT: String(port),
      GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
      GEMINI_MCP_PORT_OWNER_DIAGNOSTIC_TIMEOUT_MS: '1000',
      GEMINI_MCP_PROCESS_DIAGNOSTIC_TIMEOUT_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdoutBuffer = '';
  const pending = new Map();

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolver = pending.get(message.id);
      if (!resolver) continue;
      pending.delete(message.id);
      resolver(message);
    }
  });

  const callRpc = (message) =>
    new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        rejectCall(new Error(`timeout waiting for RPC response ${message.id}`));
      }, 10000);
      pending.set(message.id, (response) => {
        clearTimeout(timer);
        resolveCall(response);
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      sleep(1000).then(() => child.kill('SIGKILL')),
    ]);
  };

  return {
    child,
    callRpc,
    stop,
    stderr: () => stderr,
  };
};

const spawnFakeStaleExporter = async (port) => {
  const script = `
    const { createServer } = require('node:http');
    const port = Number(process.env.TEST_MCP_PORT);
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (req.url === '/healthz') {
        res.end(JSON.stringify({
          ok: true,
          name: 'gemini-md-export',
          version: '0.0.1',
          protocolVersion: 1,
          pid: process.pid,
          process: {
            pid: process.pid,
            ppid: process.ppid,
            platform: process.platform,
            processName: 'node',
            commandLine: process.argv.join(' '),
            bridgeRole: 'primary'
          },
          clients: 0
        }));
        return;
      }
      if (req.url === '/agent/clients') {
        res.end(JSON.stringify({ connectedClients: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(port, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['-e', script, 'gemini-md-export', 'mcp-server.js'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TEST_MCP_PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf-8');
  });
  await waitForHealth(port);
  return {
    child,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        sleep(1000).then(() => child.kill('SIGKILL')),
      ]);
    },
  };
};

test('segunda instância MCP não emite erro quando o bridge já está em uso e proxya tools', async (t) => {
  const port = await getFreePort();
  const primary = spawnMcp(port);
  const health = await waitForHealth(port);
  const secondary = spawnMcp(port);
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-proxy-'));

  t.after(async () => {
    await secondary.stop();
    await primary.stop();
    rmSync(outputDir, { recursive: true, force: true });
  });

  const initialized = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });

  assert.equal(initialized.result.serverInfo.name, 'gemini-md-export');
  assert.equal(typeof health.pid, 'number');
  assert.equal(typeof health.ppid, 'number');
  assert.equal(typeof health.uptimeMs, 'number');
  assert.equal(health.bridgeRole, 'primary');
  assert.equal(health.process.pid, health.pid);
  assert.equal(Array.isArray(health.argv), true);

  await sleep(200);
  assert.equal(secondary.child.exitCode, null);
  assert.doesNotMatch(secondary.stderr(), /EADDRINUSE|porta já está em uso|falha no bridge/i);

  const listedTools = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/list',
    params: {},
  });
  assert.deepEqual(
    listedTools.result.tools.map((tool) => tool.name),
    [
      'gemini_ready',
      'gemini_tabs',
      'gemini_chats',
      'gemini_export',
      'gemini_job',
      'gemini_config',
      'gemini_support',
    ],
  );

  const legacyCall = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: {
      name: 'gemini_list_recent_chats',
      arguments: { limit: 20 },
    },
  });
  assert.equal(legacyCall.result.isError, true);
  assert.equal(legacyCall.result.structuredContent.code, 'tool_renamed');
  assert.deepEqual(legacyCall.result.structuredContent.replacement, {
    tool: 'gemini_chats',
    arguments: { action: 'list', source: 'recent', limit: 20 },
  });

  const processDiagnosis = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'gemini_support',
      arguments: { action: 'processes', detail: 'full' },
    },
  });
  assert.equal(processDiagnosis.result.isError, false);
  assert.equal(processDiagnosis.result.structuredContent.proxyState, 'proxy_healthy');
  assert.equal(processDiagnosis.result.structuredContent.cleanupPlan.eligible, false);
  assert.equal(processDiagnosis.result.structuredContent.primaryBridge.process.pid, primary.child.pid);

  const setDir = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'gemini_config',
      arguments: {
        action: 'set_export_dir',
        outputDir,
      },
    },
  });

  assert.equal(setDir.result.isError, false);

  const exportDirResponse = await fetch(`http://127.0.0.1:${port}/agent/export-dir`);
  const exportDir = await exportDirResponse.json();
  assert.equal(exportDir.outputDir, outputDir);
});

test('cleanup exige alvo seguro e promove a segunda instância após encerrar primário antigo', async (t) => {
  const port = await getFreePort();
  const fakePrimary = await spawnFakeStaleExporter(port);
  const secondary = spawnMcp(port);

  t.after(async () => {
    await secondary.stop();
    await fakePrimary.stop();
  });

  await sleep(200);

  const diagnosis = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'gemini_support',
      arguments: { action: 'processes', detail: 'full' },
    },
  });

  assert.equal(diagnosis.result.isError, false);
  assert.equal(diagnosis.result.structuredContent.proxyState, 'primary_incompatible');
  assert.equal(diagnosis.result.structuredContent.cleanupPlan.eligible, true);
  assert.equal(diagnosis.result.structuredContent.cleanupPlan.targets[0].pid, fakePrimary.child.pid);
  assert.match(
    diagnosis.result.structuredContent.cleanupPlan.targets[0].commandLine,
    /gemini-md-export/,
  );

  const dryRun = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'gemini_support',
      arguments: { action: 'cleanup_processes', detail: 'full' },
    },
  });

  assert.equal(dryRun.result.isError, false);
  assert.equal(dryRun.result.structuredContent.dryRun, true);
  assert.equal(dryRun.result.structuredContent.wouldTerminate[0].pid, fakePrimary.child.pid);
  assert.equal(fakePrimary.child.exitCode, null);

  const cleanup = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'gemini_support',
      arguments: {
        action: 'cleanup_processes',
        detail: 'full',
        confirm: true,
        waitMs: 1500,
      },
    },
  });

  assert.equal(cleanup.result.isError, false);
  assert.equal(cleanup.result.structuredContent.ok, true);
  assert.equal(cleanup.result.structuredContent.terminated[0].pid, fakePrimary.child.pid);
  assert.equal(cleanup.result.structuredContent.terminated[0].exited, true);
  assert.equal(cleanup.result.structuredContent.bridgeRetry.ok, true);

  const promotedHealth = await waitForHealth(port);
  assert.equal(promotedHealth.version, PACKAGE_VERSION);
  assert.equal(promotedHealth.bridgeRole, 'primary');
  assert.equal(promotedHealth.pid, secondary.child.pid);
});

test('segunda instância MCP diagnostica bridge primário com versão antiga', async (t) => {
  const port = await getFreePort();
  const primary = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/healthz') {
      res.end(JSON.stringify({
        ok: true,
        name: 'gemini-md-export',
        version: '0.0.1',
        protocolVersion: 1,
        pid: 12345,
        process: {
          pid: 12345,
          bridgeRole: 'primary',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
        clients: 0,
      }));
      return;
    }
    if (req.url === '/agent/clients') {
      res.end(JSON.stringify({ expectedChromeExtension: {}, connectedClients: [] }));
      return;
    }
    if (req.url === '/agent/mcp-tool-call') {
      res.end(JSON.stringify({ ok: true, result: { shouldNotProxy: true } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await listenHttp(primary, port);
  const secondary = spawnMcp(port);
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-old-primary-'));

  t.after(async () => {
    await secondary.stop();
    await closeHttp(primary);
    rmSync(outputDir, { recursive: true, force: true });
  });

  const status = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'gemini_ready',
      arguments: { action: 'status' },
    },
  });

  assert.equal(status.result.isError, true);
  assert.equal(status.result.structuredContent.code, 'primary_bridge_version_mismatch');
  assert.equal(status.result.structuredContent.data.mismatch.actualVersion, '0.0.1');
  assert.equal(status.result.structuredContent.data.mismatch.process.pid, 12345);
  assert.equal(status.result.structuredContent.data.primaryBridge.process.pid, 12345);

  const setDir = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'gemini_config',
      arguments: {
        action: 'set_export_dir',
        outputDir,
      },
    },
  });

  assert.equal(setDir.result.isError, true);
  assert.equal(setDir.result.structuredContent.code, 'primary_bridge_version_mismatch');
  assert.match(setDir.result.structuredContent.error, /PID 12345/);
  assert.match(setDir.result.structuredContent.error, /MCP 0\.0\.1/);
  assert.equal(setDir.result.structuredContent.data.mismatch.process.pid, 12345);
});

test('segunda instância MCP diagnostica bridge primário com protocolo antigo', async (t) => {
  const port = await getFreePort();
  const primary = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/healthz') {
      res.end(JSON.stringify({
        ok: true,
        name: 'gemini-md-export',
        version: PACKAGE_VERSION,
        protocolVersion: 1,
        pid: 23456,
        process: {
          pid: 23456,
          bridgeRole: 'primary',
        },
        clients: 0,
      }));
      return;
    }
    if (req.url === '/agent/clients') {
      res.end(JSON.stringify({ expectedChromeExtension: {}, connectedClients: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await listenHttp(primary, port);
  const secondary = spawnMcp(port);

  t.after(async () => {
    await secondary.stop();
    await closeHttp(primary);
  });

  const status = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'gemini_ready',
      arguments: { action: 'status' },
    },
  });

  assert.equal(status.result.isError, true);
  assert.equal(status.result.structuredContent.code, 'primary_bridge_version_mismatch');
  assert.equal(status.result.structuredContent.data.mismatch.kind, 'protocol');
  assert.equal(status.result.structuredContent.data.mismatch.actualProtocolVersion, 1);
  assert.equal(status.result.structuredContent.data.mismatch.process.pid, 23456);
  assert.match(status.result.structuredContent.error, /protocolo 1/);
});

test('segunda instância MCP diferencia porta ocupada por outro serviço', async (t) => {
  const port = await getFreePort();
  const primary = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.url === '/healthz') {
      res.end(JSON.stringify({
        ok: true,
        name: 'outro-servico',
        version: '9.9.9',
        pid: 43210,
      }));
      return;
    }
    if (req.url === '/agent/clients') {
      res.end(JSON.stringify({ connectedClients: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await listenHttp(primary, port);
  const secondary = spawnMcp(port);

  t.after(async () => {
    await secondary.stop();
    await closeHttp(primary);
  });

  const status = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'gemini_ready',
      arguments: { action: 'status' },
    },
  });

  assert.equal(status.result.isError, true);
  assert.equal(status.result.structuredContent.code, 'primary_bridge_version_mismatch');
  assert.equal(status.result.structuredContent.data.mismatch.kind, 'name');
  assert.equal(status.result.structuredContent.data.mismatch.actualName, 'outro-servico');
  assert.match(status.result.structuredContent.error, /outro-servico/);
  assert.match(status.result.structuredContent.error, /não pelo gemini-md-export/);
});

test('segunda instância MCP diagnostica porta ocupada sem healthz HTTP', async (t) => {
  const port = await getFreePort();
  const sockets = new Set();
  const blocker = createNetServer((socket) => {
    // Mantém a conexão aberta o bastante para o healthz do proxy estourar timeout.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolveListen, rejectListen) => {
    blocker.once('error', rejectListen);
    blocker.listen(port, '127.0.0.1', resolveListen);
  });
  const secondary = spawnMcp(port);

  t.after(async () => {
    await secondary.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => blocker.close(resolveClose));
  });

  const status = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'gemini_ready',
      arguments: { action: 'status' },
    },
  });

  assert.equal(status.result.isError, true);
  assert.equal(status.result.structuredContent.code, 'primary_bridge_version_mismatch');
  assert.equal(status.result.structuredContent.data.mismatch.kind, 'unreachable');
  assert.match(status.result.structuredContent.error, /parece ocupada/);
});
