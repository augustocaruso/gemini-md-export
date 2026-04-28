import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  launchGeminiBrowser,
  resolveGeminiBrowserLaunchPlan,
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

test('launcher Windows usa spawn direto com URL do Gemini e perfil configurado', async () => {
  const calls = [];
  const result = await launchGeminiBrowser({
    platform: 'win32',
    profileDirectory: 'Profile 1',
    env: {},
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
  assert.equal(result.method, 'windows-direct-spawn');
  assert.equal(calls[0].command, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.match(calls[0].args.join(' '), /--new-tab/);
  assert.match(calls[0].args.join(' '), /https:\/\/gemini\.google\.com\/app/);
  assert.match(calls[0].args.join(' '), /--profile-directory=Profile 1/);
  assert.equal(result.launch.ok, true);
});

test('launcher Windows cai para cmd start quando spawn direto falha', async () => {
  const calls = [];
  const result = await launchGeminiBrowser({
    platform: 'win32',
    env: {},
    exists: noExists,
    spawnSyncFn: neverProbe,
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'chrome.exe') return child({ error: 'ENOENT' });
      return child({ exitCode: 0 });
    },
    launchObserveMs: 0,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.method, 'windows-cmd-start-fallback');
  assert.equal(calls[0].command, 'chrome.exe');
  assert.equal(calls[1].command, 'cmd.exe');
  assert.match(calls[1].args.join(' '), /start ""/);
  assert.match(calls[1].args.join(' '), /chrome\.exe/);
  assert.match(calls[1].args.join(' '), /https:\/\/gemini\.google\.com\/app/);
  assert.equal(result.directLaunch.ok, false);
  assert.equal(result.launch.ok, true);
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
