import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER_PATH = resolve(ROOT, 'src', 'mcp-server.js');

const getFreePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

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
      }, 5000);
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

test('segunda instância MCP não emite erro quando o bridge já está em uso e proxya tools', async (t) => {
  const port = await getFreePort();
  const primary = spawnMcp(port);
  await waitForHealth(port);
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

  await sleep(200);
  assert.equal(secondary.child.exitCode, null);
  assert.doesNotMatch(secondary.stderr(), /EADDRINUSE|porta já está em uso|falha no bridge/i);

  const setDir = await secondary.callRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'gemini_set_export_dir',
      arguments: {
        outputDir,
      },
    },
  });

  assert.equal(setDir.result.isError, false);

  const exportDirResponse = await fetch(`http://127.0.0.1:${port}/agent/export-dir`);
  const exportDir = await exportDirResponse.json();
  assert.equal(exportDir.outputDir, outputDir);
});
