import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const additionalContextOf = (output) => output?.hookSpecificOutput?.additionalContext || '';

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
  const prelaunchSource = readFileSync(
    resolve(ROOT, 'gemini-cli-extension', 'scripts', 'hooks', 'prelaunch-browser-windows.ps1'),
    'utf-8',
  );

  assert.match(hookSource, /gemini_browser_status/);
  assert.match(prelaunchSource, /method = 'cmd-start'/);
  assert.match(prelaunchSource, /lastFailureAt/);
});
