import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    }, 1000);
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

test('Gemini CLI extension ships no default runtime hooks', () => {
  const hooksConfig = JSON.parse(
    readFileSync(resolve(ROOT, 'gemini-cli-extension', 'hooks', 'hooks.json'), 'utf-8'),
  );

  assert.deepEqual(hooksConfig, { hooks: {} });
});

test('legacy hook entrypoint is a silent no-op for lifecycle/tool modes', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-noop-'));
  try {
    for (const mode of ['session-start', 'before-tool', 'after-tool', 'unknown-mode']) {
      const output = runHook(
        mode,
        {
          hook_event_name: 'BeforeTool',
          tool_name: 'mcp_gemini-md-export_gemini_ready',
          tool_input: { action: 'status', diagnostic: true },
        },
        {
          GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        },
      );

      assert.deepEqual(output, { suppressOutput: true });
    }

    const openStdinOutput = await runHookWithOpenStdin(
      'before-tool',
      { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' },
      {
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
      },
    );
    assert.deepEqual(openStdinOutput, { suppressOutput: true });
    assert.equal(existsSync(resolve(tmpRoot, 'hook-last-run.json')), false);
    assert.equal(existsSync(resolve(tmpRoot, 'hook-browser-launch.json')), false);
    assert.equal(existsSync(resolve(tmpRoot, 'browser-launch.json')), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('legacy hook entrypoint keeps stdout valid JSON even with invalid stdin', () => {
  const result = spawnSync(process.execPath, [hookPath, 'after-tool'], {
    input: 'isso nao e json',
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { suppressOutput: true });
});

test('hook diagnose is explicit and does not register or run hidden automation', () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-hook-diagnose-'));
  try {
    const output = runHook(
      'diagnose',
      {},
      {
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS: '30',
      },
    );

    assert.equal(output.ok, true);
    assert.equal(output.mode, 'diagnose');
    assert.equal(output.hooksRegisteredByDefault, false);
    assert.match(output.note, /Runtime hooks are intentionally disabled/);
    assert.match(output.files.browserLaunch, /browser-launch\.json$/);
    assert.equal(output.files.legacyBrowserLaunch, null);
    assert.equal(output.files.legacyHookLastRun, null);
    assert.equal(typeof output.bridge.health.checked, 'boolean');
    assert.equal(typeof output.bridge.ready.checked, 'boolean');
    assert.equal(typeof output.bridge.diagnostics.checked, 'boolean');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('hook script no longer contains runtime orchestration or guardrail logic', () => {
  const hookSource = readFileSync(hookPath, 'utf-8');

  assert.doesNotMatch(hookSource, /SessionStart aquece/);
  assert.doesNotMatch(hookSource, /Start-Process/);
  assert.doesNotMatch(hookSource, /waitForConnectedBrowserClient/);
  assert.doesNotMatch(hookSource, /hasExplicitMcpIntent/);
  assert.doesNotMatch(hookSource, /chrome\.debugger/);
  assert.doesNotMatch(hookSource, /captureVisibleTab/);
  assert.doesNotMatch(hookSource, /decision:\s*'deny'/);
  assert.doesNotMatch(hookSource, /hookSpecificOutput/);
});
