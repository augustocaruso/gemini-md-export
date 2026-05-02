import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const hookPath = resolve(
  ROOT,
  'gemini-cli-extension',
  'scripts',
  'hooks',
  'gemini-md-export-hook.mjs',
);

const runHook = (mode, payload = {}, env = {}) => {
  const result = spawnSync(process.execPath, [hookPath, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);

  return JSON.parse(result.stdout);
};

const runHookAsync = (mode, payload = {}, env = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [hookPath, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, stderr);
        assert.doesNotThrow(() => JSON.parse(stdout), stdout);
        resolveRun(JSON.parse(stdout));
      } catch (err) {
        rejectRun(err);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });

const runHookWithOpenStdin = (mode, payload, env = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [hookPath, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`hook did not exit with open stdin; stderr=${stderr}`));
    }, 1500);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, stderr);
        assert.doesNotThrow(() => JSON.parse(stdout), stdout);
        resolveRun(JSON.parse(stdout));
      } catch (err) {
        rejectRun(err);
      }
    });
    if (payload !== undefined) {
      child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  });

const additionalContextOf = (output) => output?.hookSpecificOutput?.additionalContext || '';

const listen = (server) =>
  new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen(server.address().port);
    });
  });

const closeServer = (server) =>
  new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });

test('SessionStart aquece somente a bridge local, sem contexto estatico', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-session-'));
  const probe = createServer((_req, res) => res.end('probe'));
  const port = await listen(probe);
  await closeServer(probe);
  let bridgePid = null;

  try {
    const output = await runHookAsync(
      'session-start',
      { hook_event_name: 'SessionStart', source: 'startup' },
      {
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS: '80',
        GEMINI_MCP_HOOK_SESSION_BRIDGE_WAIT_MS: '2500',
        GEMINI_MCP_HOOK_HARD_EXIT_MS: '3500',
        GEMINI_MD_EXPORT_BRIDGE_KEEP_ALIVE_MS: '60000',
      },
    );

    assert.equal(output.suppressOutput, true);
    assert.equal(output.hookSpecificOutput, undefined);
    assert.equal(output.systemMessage, undefined);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
    bridgePid = health.pid;
    assert.equal(health.bridgeOnly, true);
    assert.equal(health.process.bridgeOnly, true);
    assert.equal(health.idleLifecycle.enabled, true);
  } finally {
    if (bridgePid) {
      try {
        process.kill(bridgePid, 'SIGTERM');
      } catch {
        // Bridge may have already exited.
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('AfterTool avisa quando mediaFailureCount e maior que zero', () => {
  const output = runHook('after-tool', {
    hook_event_name: 'AfterTool',
    tool_name: 'mcp_gemini-md-export_gemini_chats',
    tool_response: {
      structuredContent: {
        filename: 'abc.md',
        mediaFileCount: 1,
        mediaFailureCount: 2,
      },
    },
  });

  assert.match(additionalContextOf(output), /mediaFailureCount=2/);
});

test('AfterTool avisa quando ha warning de midia e nenhum arquivo salvo', () => {
  const output = runHook('after-tool', {
    hook_event_name: 'AfterTool',
    tool_name: 'mcp_gemini-md-export_gemini_chats',
    tool_response: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            content: '> [!warning] Mídia não importada\n> Descrição: Uploaded image preview',
            mediaFileCount: 0,
            mediaFailureCount: 0,
          }),
        },
      ],
    },
  });

  assert.match(additionalContextOf(output), /mediaFileCount=0/);
  assert.match(additionalContextOf(output), /falha real/);
});

test('AfterTool fica silencioso quando midia foi salva corretamente', () => {
  const output = runHook('after-tool', {
    hook_event_name: 'AfterTool',
    tool_name: 'mcp_gemini-md-export_gemini_chats',
    tool_response: {
      structuredContent: {
        filename: 'abc.md',
        mediaFileCount: 2,
        mediaFailureCount: 0,
      },
    },
  });

  assert.equal(output.suppressOutput, true);
  assert.equal(output.hookSpecificOutput, undefined);
});

test('BeforeTool bloqueia caminhos proibidos', () => {
  const output = runHook('before-tool', {
    hook_event_name: 'BeforeTool',
    tool_name: 'write_file',
    tool_input: {
      file_path: 'src/extension-background.js',
      content: 'chrome.debugger.attach(tabId); await chrome.tabs.captureVisibleTab();',
    },
  });

  assert.equal(output.decision, 'deny');
  assert.match(output.reason, /fora do escopo combinado/);
});

test('hooks.json aplica guardrail em ferramentas que podem editar', () => {
  const hooksConfig = JSON.parse(
    readFileSync(resolve(ROOT, 'gemini-cli-extension', 'hooks', 'hooks.json'), 'utf-8'),
  );
  const guard = hooksConfig.hooks.BeforeTool.find(
    (entry) => entry.hooks?.[0]?.name === 'gemini-md-export-scope-guard',
  );
  const matcher = new RegExp(guard.matcher);

  assert.equal(guard.hooks[0].timeout, 3000);
  for (const toolName of ['write_file', 'replace', 'run_shell_command', 'shell', 'apply_patch']) {
    assert.equal(matcher.test(toolName), true, toolName);
  }
  assert.equal(matcher.test('read_file'), false);
  assert.equal(matcher.test('mcp_gemini-md-export_gemini_ready'), false);
});

test('BeforeTool falha aberto para chamada normal', () => {
  const output = runHook('before-tool', {
    hook_event_name: 'BeforeTool',
    tool_name: 'mcp_gemini-md-export_gemini_ready',
    tool_input: {},
  });

  assert.equal(output.suppressOutput, true);
  assert.equal(output.decision, undefined);
});

test('BeforeTool permite desativar prelaunch do navegador para tools do exporter', () => {
  const output = runHook(
    'before-tool',
    {
      hook_event_name: 'BeforeTool',
      tool_name: 'mcp_gemini-md-export_gemini_chats',
      tool_input: {},
    },
    {
      GEMINI_MCP_HOOK_LAUNCH_BROWSER: 'false',
    },
  );

  assert.equal(output.suppressOutput, true);
  assert.equal(output.decision, undefined);
});

test('BeforeTool respeita cooldown sem abrir nem esperar navegador', () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  mkdirSync(resolve(tmpRoot, 'gemini-md-export'), { recursive: true });
  writeFileSync(
    resolve(tmpRoot, 'gemini-md-export', 'hook-browser-launch.json'),
    JSON.stringify({ lastAttemptAt: Date.now() }),
    'utf-8',
  );

  try {
    const startedAt = Date.now();
    const output = runHook(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_chats',
        tool_input: {},
      },
      {
        TMPDIR: tmpRoot,
        TEMP: tmpRoot,
        TMP: tmpRoot,
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '60000',
      },
    );

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.equal(Date.now() - startedAt < 1000, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool abre Gemini pelo launcher PowerShell quando nao ha cliente conectado', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ready: false,
      connectedClientCount: 0,
      selectableTabCount: 0,
      matchingClientCount: 0,
      commandReadyClientCount: 0,
      blockingIssue: 'no_connected_clients',
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_ready',
        tool_input: { action: 'status', diagnostic: true },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /dry-run do hook/);
    assert.match(output.systemMessage, /Chrome/);
    assert.equal(state.status, 'dry-run');
    assert.equal(state.dryRun, true);
    assert.equal(state.launch.plan.method, 'windows-powershell-minimized-restore-focus');
    assert.equal(state.launch.plan.command, 'powershell.exe');
    assert.match(state.launch.plan.args.join(' '), /open-gemini-restore-focus\.ps1/);
    assert.equal(state.launch.plan.browserCommand, 'chrome.exe');
    assert.match(state.launch.plan.browserArgs.join(' '), /--new-tab/);
    assert.match(state.launch.plan.browserArgs.join(' '), /https:\/\/gemini\.google\.com\/app/);
    assert.equal(state.launch.plan.focusingFallbackAllowed, false);
    assert.equal(state.fallbackCommand, undefined);
    assert.equal(state.fallbackArgs, undefined);
    assert.equal(state.bridgeStatus.connectedCount, 0);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool normaliza prefixo MCP com underscores duplos', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ connectedClients: [] }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp__gemini_md_export__gemini_ready',
        tool_input: { action: 'status', diagnostic: true },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.match(output.systemMessage, /dry-run do hook/);
    assert.equal(state.status, 'dry-run');
    assert.equal(state.launch.plan.browserCommand, 'chrome.exe');
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool espera a aba Gemini conectar depois de abrir pelo hook', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    const ready = requests >= 2;
    res.end(JSON.stringify({
      ready,
      connectedClientCount: ready ? 1 : 0,
      selectableTabCount: ready ? 1 : 0,
      matchingClientCount: ready ? 1 : 0,
      commandReadyClientCount: ready ? 1 : 0,
      blockingIssue: ready ? null : 'no_connected_clients',
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_ready',
        tool_input: { action: 'status', diagnostic: true },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_CHROME_EXE: '/usr/bin/true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
        GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS: '1500',
        GEMINI_MCP_HOOK_CONNECT_POLL_MS: '50',
        GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK: 'true',
      },
    );
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /aba Gemini conectou/);
    assert.match(output.systemMessage, /fallback opt-in/);
    assert.equal(state.status, 'connected');
    assert.equal(state.launch.fallbackPlan.method, 'windows-direct-spawn');
    assert.equal(state.launch.fallbackPlan.command, '/usr/bin/true');
    assert.equal(state.connectWait.connected, true);
    assert.equal(state.connectWait.status.connectedCount, 1);
    assert.equal(requests >= 2, true);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao abre segunda aba durante launch em progresso', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  writeFileSync(
    resolve(tmpRoot, 'hook-browser-launch.json'),
    JSON.stringify({
      source: 'hook',
      launchId: 'existing-launch',
      status: 'launching',
      expiresAt: Date.now() + 5000,
      lastAttemptAt: Date.now(),
      launch: { plan: { method: 'windows-powershell-minimized-restore-focus' } },
    }),
    'utf-8',
  );
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    const ready = requests >= 2;
    res.end(JSON.stringify({
      ready,
      connectedClientCount: ready ? 1 : 0,
      selectableTabCount: ready ? 1 : 0,
      matchingClientCount: ready ? 1 : 0,
      commandReadyClientCount: ready ? 1 : 0,
      blockingIssue: ready ? null : 'no_connected_clients',
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        session_id: 'session-a',
        tool_name: 'mcp_gemini-md-export_gemini_chats',
        tool_input: { intent: 'small_page' },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS: '1000',
        GEMINI_MCP_HOOK_CONNECT_POLL_MS: '50',
      },
    );
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.match(output.systemMessage, /outra chamada ja estava acordando/);
    assert.match(output.systemMessage, /conectou/);
    assert.equal(state.launchId, 'existing-launch');
    assert.equal(state.status, 'connected');
    assert.equal(state.connectWait.connected, true);
    assert.equal(state.launch.plan.method, 'windows-powershell-minimized-restore-focus');
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao abre browser as cegas quando bridge esta inalcançavel', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        session_id: 'session-a',
        tool_name: 'mcp_gemini-md-export_gemini_ready',
        tool_input: { action: 'status', diagnostic: true },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: '9',
        GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS: '30',
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.match(output.systemMessage, /bridge MCP local nao respondeu/);
    assert.match(output.systemMessage, /nao abri o navegador as cegas/);
    assert.equal(state.status, 'skipped');
    assert.equal(state.reason, 'bridge-unreachable');
    assert.equal(state.launch, undefined);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool timeout de conexao sai antes do hard exit da CLI', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ready: false,
      connectedClientCount: 0,
      selectableTabCount: 0,
      matchingClientCount: 0,
      commandReadyClientCount: 0,
      blockingIssue: 'no_connected_clients',
    }));
  });
  const port = await listen(server);

  try {
    const startedAt = Date.now();
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_ready',
        tool_input: { action: 'status', diagnostic: true },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_CHROME_EXE: '/usr/bin/true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
        GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS: '120',
        GEMINI_MCP_HOOK_CONNECT_POLL_MS: '40',
        GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK: 'true',
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const state = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-browser-launch.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.match(output.systemMessage, /extensao nao conectou/);
    assert.match(output.systemMessage, /chrome:\/\/extensions/);
    assert.equal(elapsedMs < 1500, true);
    assert.equal(state.status, 'timeout');
    assert.equal(state.connectWait.connected, false);
    assert.equal(state.connectWait.timeoutMs, 120);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao preabre navegador para gemini_export CLI-first', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ready: false,
      connectedClientCount: 0,
      selectableTabCount: 0,
      matchingClientCount: 0,
      commandReadyClientCount: 0,
      blockingIssue: 'no_connected_clients',
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_export',
        tool_input: { action: 'sync' },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );

    assert.equal(output.suppressOutput, true);
    assert.equal(output.systemMessage, undefined);
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao abre nova aba quando Gemini ja esta conectado', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ready: true,
      connectedClientCount: 1,
      selectableTabCount: 1,
      matchingClientCount: 1,
      commandReadyClientCount: 1,
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_chats',
        tool_input: { intent: 'small_page' },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.equal(output.systemMessage, undefined);
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
    assert.match(paths[0] || '', /\/agent\/ready/);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao abre aba duplicada quando ha client conectado mas nao pronto', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ready: false,
      connectedClientCount: 1,
      selectableTabCount: 1,
      matchingClientCount: 0,
      commandReadyClientCount: 0,
      blockingIssue: 'extension_version_mismatch',
    }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_chats',
        tool_input: { intent: 'small_page' },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );
    const lastRun = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-last-run.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.equal(output.systemMessage, undefined);
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
    assert.equal(lastRun.reason, 'connected-but-not-ready');
    assert.equal(lastRun.bridgeStatus.blockingIssue, 'extension_version_mismatch');
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool cai para /agent/clients quando bridge antigo nao tem /agent/ready', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/agent/ready')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.end(JSON.stringify({ connectedClients: [{ clientId: 'tab-legacy' }] }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_chats',
        tool_input: { intent: 'small_page' },
      },
      {
        GEMINI_MCP_HOOK_PLATFORM: 'win32',
        GEMINI_MCP_HOOK_DRY_RUN: 'true',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_BRIDGE_PORT: String(port),
        GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS: '0',
      },
    );

    assert.equal(output.suppressOutput, true);
    assert.equal(output.systemMessage, undefined);
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
    assert.equal(paths.some((path) => path?.startsWith('/agent/ready')), true);
    assert.equal(paths.some((path) => path?.startsWith('/agent/clients')), true);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao trava se o Gemini CLI deixar stdin aberto', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));

  try {
    const startedAt = Date.now();
    const output = await runHookWithOpenStdin(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_ready',
        tool_input: {},
      },
      {
        GEMINI_MCP_HOOK_LAUNCH_BROWSER: 'false',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
      },
    );
    const lastRun = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-last-run.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.equal(lastRun.stdinStatus, 'ok');
    assert.equal(lastRun.toolName, 'mcp_gemini-md-export_gemini_ready');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool falha aberto quando stdin fica aberto sem payload', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));

  try {
    const output = await runHookWithOpenStdin(
      'before-tool',
      undefined,
      {
        GEMINI_MCP_HOOK_LAUNCH_BROWSER: 'false',
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_HOOK_STDIN_TIMEOUT_MS: '30',
      },
    );
    const lastRun = JSON.parse(readFileSync(resolve(tmpRoot, 'hook-last-run.json'), 'utf-8'));

    assert.equal(output.suppressOutput, true);
    assert.equal(output.decision, undefined);
    assert.equal(lastRun.stdinStatus, 'timeout');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('hook diagnose retorna estado e caminhos de depuracao', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));

  try {
    const output = await runHookAsync(
      'diagnose',
      {},
      {
        GEMINI_MCP_HOOK_STATE_DIR: tmpRoot,
        GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS: '30',
      },
    );

    assert.equal(output.ok, true);
    assert.equal(output.mode, 'diagnose');
    assert.match(output.files.lastRun, /hook-last-run\.json$/);
    assert.match(output.files.browserLaunch, /hook-browser-launch\.json$/);
    assert.equal(typeof output.timeouts.connectMs, 'number');
    assert.equal(typeof output.bridgeHealth.checked, 'boolean');
    assert.equal(typeof output.bridgeStatus.checked, 'boolean');
    assert.equal(typeof output.environmentDiagnostics.checked, 'boolean');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('hook emite JSON valido mesmo com stdin invalido', () => {
  const result = spawnSync(process.execPath, [hookPath, 'after-tool'], {
    input: 'isso nao e json',
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);
});

test('BeforeTool so acorda navegador para gemini_ready com intencao explicita', () => {
  const hookSource = readFileSync(hookPath, 'utf-8');

  assert.match(hookSource, /gemini_ready/);
  assert.match(hookSource, /gemini_ready:\s+new Set\(\['status'\]\)/);
  assert.match(hookSource, /hasExplicitMcpIntent/);
  assert.match(hookSource, /\['gemini_ready', 'gemini_tabs', 'gemini_chats'\]/);
  assert.doesNotMatch(hookSource, /gemini_export:\s+new Set/);
  assert.match(hookSource, /open-gemini-restore-focus\.ps1/);
  assert.match(hookSource, /SetForegroundWindow/);
  assert.match(hookSource, /waitForConnectedBrowserClient/);
  assert.match(hookSource, /agent\/ready/);
  assert.match(hookSource, /agent\/clients/);
  assert.doesNotMatch(hookSource, /cmd\.exe/);
  assert.doesNotMatch(hookSource, /wscript\.exe/);
  assert.doesNotMatch(hookSource, /\bwhere\b/);
  assert.doesNotMatch(hookSource, /start chrome/i);
  assert.doesNotMatch(hookSource, /prelaunch-browser-windows\.ps1/);
});
