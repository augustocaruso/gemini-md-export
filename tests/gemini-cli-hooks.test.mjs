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

test('SessionStart injeta contexto curto do exporter', () => {
  const output = runHook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
  const context = additionalContextOf(output);

  assert.equal(output.suppressOutput, true);
  assert.match(context, /gemini-md-export MCP tools/);
  assert.match(context, /mediaFailureCount/);
  assert.match(context, /Forbidden paths/);
});

test('AfterTool avisa quando mediaFailureCount e maior que zero', () => {
  const output = runHook('after-tool', {
    hook_event_name: 'AfterTool',
    tool_name: 'mcp_gemini-md-export_gemini_download_chat',
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
    tool_name: 'mcp_gemini-md-export_gemini_download_chat',
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
    tool_name: 'mcp_gemini-md-export_gemini_download_chat',
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

test('BeforeTool falha aberto para chamada normal', () => {
  const output = runHook('before-tool', {
    hook_event_name: 'BeforeTool',
    tool_name: 'mcp_gemini-md-export_gemini_browser_status',
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
      tool_name: 'mcp_gemini-md-export_gemini_list_recent_chats',
      tool_input: {},
    },
    {
      GEMINI_MCP_HOOK_LAUNCH_BROWSER: 'false',
    },
  );

  assert.equal(output.suppressOutput, true);
  assert.equal(output.decision, undefined);
});

test('BeforeTool prelaunch retorna imediatamente sem esperar o navegador', () => {
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
        tool_name: 'mcp_gemini-md-export_gemini_list_recent_chats',
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

test('BeforeTool abre Gemini direto pelo hook quando nao ha cliente conectado', async () => {
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
        tool_name: 'mcp_gemini-md-export_gemini_browser_status',
        tool_input: {},
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
    assert.equal(state.dryRun, true);
    assert.equal(state.method, 'windows-direct-spawn');
    assert.equal(state.command, 'chrome.exe');
    assert.match(state.args.join(' '), /--new-tab/);
    assert.match(state.args.join(' '), /https:\/\/gemini\.google\.com\/app/);
    assert.equal(state.fallbackCommand, 'cmd.exe');
    assert.match(state.fallbackArgs.join(' '), /start ""/);
    assert.equal(state.bridgeStatus.connectedCount, 0);
  } finally {
    await closeServer(server);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BeforeTool nao abre nova aba quando Gemini ja esta conectado', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ connectedClients: [{ clientId: 'tab-1' }] }));
  });
  const port = await listen(server);

  try {
    const output = await runHookAsync(
      'before-tool',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_gemini-md-export_gemini_list_recent_chats',
        tool_input: {},
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
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
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
        tool_name: 'mcp_gemini-md-export_gemini_browser_status',
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
    assert.equal(lastRun.toolName, 'mcp_gemini-md-export_gemini_browser_status');
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
    assert.equal(typeof output.bridgeStatus.checked, 'boolean');
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

test('BeforeTool considera browser_status como tool que acorda o navegador', () => {
  const hookSource = readFileSync(hookPath, 'utf-8');

  assert.match(hookSource, /gemini_browser_status/);
  assert.match(hookSource, /cmd\.exe/);
  assert.match(hookSource, /agent\/clients/);
  assert.doesNotMatch(hookSource, /powershell\.exe/);
  assert.doesNotMatch(hookSource, /prelaunch-browser-windows\.ps1/);
});
