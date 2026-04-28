import assert from 'node:assert/strict';
import test from 'node:test';
import {
  launchGeminiBrowser,
  resolveGeminiBrowserLaunchPlan,
} from '../src/browser-launch.mjs';

const noExists = () => false;

const whereOnly = (matches) => (command, args) => {
  const wanted = args?.[0];
  const stdout = matches[wanted] || '';
  return {
    status: stdout ? 0 : 1,
    stdout,
  };
};

test('Windows prefere Chrome encontrado no PATH ao abrir Gemini pela tool MCP', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: {},
    exists: noExists,
    spawnSyncFn: whereOnly({
      'chrome.exe': 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe\r\n',
      'msedge.exe': 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\r\n',
    }),
  });

  assert.equal(plan.browserName, 'Chrome');
  assert.equal(plan.binary, 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(plan.fallbackFrom, null);
});

test('Windows cai para Edge quando Chrome não existe, inclusive via msedge.exe no PATH', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: {},
    exists: noExists,
    spawnSyncFn: whereOnly({
      'msedge.exe': 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\r\n',
    }),
  });

  assert.equal(plan.browserName, 'Edge');
  assert.equal(plan.binary, 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(plan.fallbackFrom, 'Chrome');
});

test('Windows respeita GEMINI_MCP_BROWSER=edge para perfil que usa Edge', () => {
  const plan = resolveGeminiBrowserLaunchPlan({
    platform: 'win32',
    env: { GEMINI_MCP_BROWSER: 'edge' },
    exists: noExists,
    spawnSyncFn: whereOnly({
      'msedge.exe': 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\r\n',
      'chrome.exe': 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n',
    }),
  });

  assert.equal(plan.browserName, 'Edge');
  assert.equal(plan.fallbackFrom, null);
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

test('launcher Windows usa cmd start com URL do Gemini e perfil configurado', async () => {
  const calls = [];
  const result = await launchGeminiBrowser({
    platform: 'win32',
    profileDirectory: 'Profile 1',
    env: {},
    exists: noExists,
    spawnSyncFn: whereOnly({
      'chrome.exe': 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n',
    }),
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.browserName, 'Chrome');
  assert.equal(result.method, 'windows-cmd-start');
  assert.equal(calls[0].command, 'cmd.exe');
  assert.match(calls[0].args.join(' '), /start ""/);
  assert.match(calls[0].args.join(' '), /https:\/\/gemini\.google\.com\/app/);
  assert.match(calls[0].args.join(' '), /--profile-directory=Profile 1/);
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
