import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildWindowsRestoreFocusLaunchScript,
  browserLaunchStatePath,
  describeRecentBrowserLaunch,
  detectBrowserWithLoadedExtension,
  launchGeminiBrowser,
  readBrowserLaunchState,
  resolveGeminiBrowserLaunchPlan,
  writeBrowserLaunchState,
} from '../src/browser-launch.mjs';

const noExists = () => false;

const neverProbe = () => {
  throw new Error('spawnSync/where must not run in Windows launch path');
};

const child = ({ pid = 123, error = null, exitCode = null } = {}) => {
  const emitter = new EventEmitter();
  emitter.pid = pid;
  emitter.unref = () => {};
  process.nextTick(() => {
    if (error) emitter.emit('error', new Error(error));
    if (exitCode !== null) emitter.emit('exit', exitCode, null);
  });
  return emitter;
};

test('auto-detect escolhe browser onde a extensao unpacked esta carregada', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'gme-browser-detect-test-'));
  const packageRoot = resolve(home, 'gemini-md-export');
  const extensionDir = resolve(packageRoot, 'browser-extension');
  const prefsDir = resolve(
    home,
    'Library',
    'Application Support',
    'Dia',
    'User Data',
    'Default',
  );
  try {
    mkdirSync(extensionDir, { recursive: true });
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(
      resolve(extensionDir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Gemini Chat -> Markdown Export',
        version: '0.8.9',
      }),
    );
    writeFileSync(
      resolve(prefsDir, 'Secure Preferences'),
      JSON.stringify({
        extensions: {
          settings: {
            ikjanjokpogoakdlikhcgfgcjbgoogkc: {
              location: 4,
              path: extensionDir,
            },
          },
        },
      }),
    );

    const detected = detectBrowserWithLoadedExtension({
      platform: 'darwin',
      home,
      packageRoot,
      browserKeys: ['chrome', 'dia'],
    });

    assert.equal(detected.browserKey, 'dia');
    assert.equal(detected.extension.version, '0.8.9');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows prefere Chrome encontrado em caminho conhecido sem chamar where', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: (candidate) =>
      candidate === 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    spawnSyncFn: neverProbe,
  });

  assert.equal(plan.browserName, 'Chrome');
  assert.equal(plan.binary, 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(plan.binarySource, 'known-path');
  assert.equal(plan.fallbackFrom, null);
});

test('Windows cai para Edge quando Chrome não existe mas Edge está em caminho conhecido', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: {},
    exists: (candidate) => candidate === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    spawnSyncFn: neverProbe,
  });

  assert.equal(plan.browserName, 'Edge');
  assert.equal(plan.binary, 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(plan.binarySource, 'known-path');
  assert.equal(plan.fallbackFrom, 'Chrome');
});

test('Windows respeita GEMINI_MCP_BROWSER=edge para perfil que usa Edge', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: { GEMINI_MCP_BROWSER: 'edge' },
    exists: (candidate) =>
      candidate === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' ||
      candidate === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    spawnSyncFn: neverProbe,
  });

  assert.equal(plan.browserName, 'Edge');
  assert.equal(plan.fallbackFrom, null);
});

test('Windows usa comando preferido como fallback sem chamar where', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: {},
    exists: noExists,
    spawnSyncFn: neverProbe,
  });

  assert.equal(plan.browserName, 'Chrome');
  assert.equal(plan.binary, 'chrome.exe');
  assert.equal(plan.binarySource, 'command-fallback');
  assert.equal(plan.method, 'windows-command-fallback');
});

test('macOS abre Google Chrome por padrão em vez do navegador padrão', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'darwin',
    env: {},
    exists: (candidate) => candidate === '/Applications/Google Chrome.app',
  });

  assert.equal(plan.browserName, 'Chrome');
  assert.equal(plan.app, 'Google Chrome');
  assert.equal(plan.method, 'macos-open-app');
});

test('macOS permite selecionar Edge por variável de ambiente', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'darwin',
    env: { GEMINI_MCP_BROWSER: 'edge' },
    exists: (candidate) => candidate === '/Applications/Microsoft Edge.app',
  });

  assert.equal(plan.browserName, 'Edge');
  assert.equal(plan.app, 'Microsoft Edge');
  assert.equal(plan.fallbackFrom, null);
});

test('launcher Windows usa PowerShell minimizado e restaura foco anterior', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-browser-launch-test-'));
  const calls = [];
  try {
    const result = await launchGeminiBrowser({
      platform: 'win32',
      profileDirectory: 'Profile 1',
      env: { GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot },
      exists: (candidate) => candidate === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      spawnSyncFn: neverProbe,
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options });
        return child();
      },
      launchObserveMs: 0,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.browserName, 'Chrome');
    assert.equal(result.method, 'windows-powershell-minimized-restore-focus');
    assert.equal(calls[0].command, 'powershell.exe');
    assert.match(calls[0].args.join(' '), /open-gemini-restore-focus\.ps1/);
    assert.equal(result.browserCommand, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.match(result.browserArgs.join(' '), /--new-tab/);
    assert.match(result.browserArgs.join(' '), /https:\/\/gemini\.google\.com\/app/);
    assert.match(result.browserArgs.join(' '), /--profile-directory=Profile 1/);
    assert.equal(result.launch.ok, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('launcher Windows nao cai para cmd start quando spawn direto falha', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-browser-launch-test-'));
  const calls = [];
  try {
    const result = await launchGeminiBrowser({
      platform: 'win32',
      env: { GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot },
      exists: noExists,
      spawnSyncFn: neverProbe,
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === 'powershell.exe') return child({ error: 'powershell failed' });
        if (command === 'chrome.exe') return child({ error: 'ENOENT' });
        return child({ exitCode: 0 });
      },
      launchObserveMs: 0,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.method, 'windows-direct-spawn-failed');
    assert.equal(calls[0].command, 'powershell.exe');
    assert.equal(calls[1].command, 'chrome.exe');
    assert.equal(calls.length, 2);
    assert.equal(result.directLaunch.ok, false);
    assert.equal(result.launch.ok, false);
    assert.equal(result.reason, 'browser-launch-failed');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('estado compartilhado de launch identifica tentativa recente da CLI', () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-browser-launch-test-'));
  const env = { GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot };
  const now = Date.now();
  const state = {
    source: 'cli',
    lastAttemptAt: now - 100,
    method: 'windows-direct-spawn',
    browserName: 'Chrome',
  };

  try {
    writeBrowserLaunchState(state, { env });
    const loaded = readBrowserLaunchState({ env });
    const recent = describeRecentBrowserLaunch(loaded, { now, cooldownMs: 60_000 });

    assert.equal(browserLaunchStatePath(env), resolve(tmpRoot, 'browser-launch.json'));
    assert.equal(recent.source, 'cli');
    assert.equal(recent.reason, undefined);
    assert.equal(recent.previousLaunch.method, 'windows-direct-spawn');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('script Windows captura janela ativa, abre minimizado e tenta devolver foco', () => {
  const script = buildWindowsRestoreFocusLaunchScript('C:\\Chrome\\chrome.exe', [
    '--profile-directory=Profile 1',
    '--new-tab',
    'https://gemini.google.com/app',
  ]);

  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /-WindowStyle Minimized/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /--profile-directory=Profile 1/);
});

test('launcher macOS usa open -g -a Chrome para reduzir troca de foco', async () => {
  const calls = [];
  const result = await launchGeminiBrowser({
    platform: 'darwin',
    profileDirectory: 'Default',
    env: {},
    exists: (candidate) => candidate === '/Applications/Google Chrome.app',
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.equal(result.browserName, 'Chrome');
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args, [
    '-g',
    '-a',
    'Google Chrome',
    'https://gemini.google.com/app',
    '--args',
    '--profile-directory=Default',
  ]);
});

test('launcher macOS não envia profile arg quando perfil não foi configurado', async () => {
  const calls = [];
  const result = await launchGeminiBrowser({
    platform: 'darwin',
    env: {},
    exists: (candidate) => candidate === '/Applications/Google Chrome.app',
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.equal(result.browserName, 'Chrome');
  assert.deepEqual(calls[0].args, ['-g', '-a', 'Google Chrome', 'https://gemini.google.com/app']);
});
