import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

const encodeNativeMessage = (message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

const decodeFirstNativeMessage = (buffer) => {
  assert.equal(buffer.length >= 4, true);
  const length = buffer.readUInt32LE(0);
  assert.equal(buffer.length >= 4 + length, true);
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf-8'));
};

const waitFor = async (predicate, { timeoutMs = 1000, intervalMs = 25 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return false;
};

test('native host responde ping no protocolo length-prefixed do Chrome', async () => {
  const child = spawn(process.execPath, [resolve(ROOT, 'src', 'native-host.mjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(encodeNativeMessage({ id: 't1', command: 'ping' }));

  const [chunk] = await once(child.stdout, 'data');
  const response = decodeFirstNativeMessage(chunk);
  assert.equal(response.id, 't1');
  assert.equal(response.ok, true);
  assert.equal(response.transport, 'nativeMessaging');
  assert.equal(response.nativeProtocolVersion, 1);

  child.stdin.end();
});

test('native host launcher does not depend on GUI app PATH to find Node', async () => {
  const child = spawn(resolve(ROOT, 'bin', 'gemini-md-export-native-host.mjs'), {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      GEMINI_MD_EXPORT_NODE: process.execPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(encodeNativeMessage({ id: 'launcher-path', command: 'ping' }));

  const [chunk] = await once(child.stdout, 'data');
  const response = decodeFirstNativeMessage(chunk);
  assert.equal(response.id, 'launcher-path');
  assert.equal(response.ok, true);
  assert.equal(response.transport, 'nativeMessaging');

  child.stdin.end();
});

test('native host one-shot command does not bind the browser broker IPC socket', async () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'gme-native-oneshot-'));
  const brokerIpcPath = resolve(tmp, 'broker.sock');
  const child = spawn(process.execPath, [resolve(ROOT, 'src', 'native-host.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_MD_EXPORT_NATIVE_BROKER_IPC: brokerIpcPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    child.stdin.write(encodeNativeMessage({ id: 't1', command: 'ping' }));
    const [chunk] = await once(child.stdout, 'data');
    const response = decodeFirstNativeMessage(chunk);

    assert.equal(response.ok, true);
    assert.equal(await waitFor(() => existsSync(brokerIpcPath), { timeoutMs: 150 }), false);
  } finally {
    child.stdin.end();
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('native host binds the browser broker IPC socket only after extension hello', async () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'gme-native-broker-'));
  const brokerIpcPath = resolve(tmp, 'broker.sock');
  const child = spawn(process.execPath, [resolve(ROOT, 'src', 'native-host.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_MD_EXPORT_NATIVE_BROKER_IPC: brokerIpcPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    child.stdin.write(
      encodeNativeMessage({
        id: 'hello',
        protocolVersion: 1,
        command: 'extension.hello',
        payload: { source: 'test' },
      }),
    );
    const [chunk] = await once(child.stdout, 'data');
    const response = decodeFirstNativeMessage(chunk);

    assert.equal(response.ok, true);
    assert.equal(await waitFor(() => existsSync(brokerIpcPath)), true);
  } finally {
    child.stdin.end();
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('native host runtime is implemented in TypeScript', () => {
  assert.equal(existsSync(resolve(ROOT, 'src', 'native', 'native-host-runtime.ts')), true);
  const wrapper = readFileSync(resolve(ROOT, 'src', 'native-host.mjs'), 'utf-8');
  assert.match(wrapper, /import\(['"]\.\.\/build\/ts\/native\/native-host-runtime\.js['"]\)/);
});

test('service worker expõe probe de native messaging sem acoplar ao fluxo principal', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  assert.match(source, /NATIVE_HOST_NAME\s*=\s*'com\.augustocaruso\.gemini_md_export'/);
  assert.match(source, /chrome\.runtime\.connectNative/);
  assert.match(source, /gemini-md-export\/native-host-health/);
  assert.match(source, /nativeHost:\s*lastNativeHostProbe/);
});

test('service worker opens persistent native broker port and exposes tab commands', () => {
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const brokerSource = readFileSync(
    resolve(ROOT, 'src', 'browser', 'background', 'native-broker-client.ts'),
    'utf-8',
  );
  assert.match(backgroundSource, /ensureNativeBrokerPort/);
  assert.match(backgroundSource, /createNativeBrokerPort/);
  assert.match(brokerSource, /tabs\.list/);
  assert.match(brokerSource, /tabs\.claim/);
  assert.match(brokerSource, /tabs\.group/);
  assert.match(brokerSource, /tabGroups\.update/);
  assert.match(brokerSource, /claimDebuggableGeminiTab/);
  assert.match(brokerSource, /classifyBrowserTabs/);
  assert.match(brokerSource, /visualCompanionTabIds/);
  assert.match(brokerSource, /applyNativeClaimVisual/);
});

test('native broker wake waits for persistent hello without opening a second ping port', () => {
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const brokerSource = readFileSync(
    resolve(ROOT, 'src', 'browser', 'background', 'native-broker-client.ts'),
    'utf-8',
  );
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(brokerSource, /ensureReady/);
  assert.match(backgroundSource, /ensureNativeBrokerReady/);
  assert.match(backgroundSource, /brokerOnly/);
  assert.match(contentSource, /brokerOnly:\s*true/);
});

test('service worker registra listener de mensagens antes de iniciar native broker no startup', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const startBlock =
    source.match(/const handleServiceWorkerStart = async \(\) => \{[\s\S]*?\n\};/)?.[0] || '';
  const listenerIndex = source.indexOf('chrome.runtime.onMessage.addListener');
  const startupIndex = source.indexOf('void handleServiceWorkerStart();');

  assert.match(startBlock, /ensureNativeBrokerPort\(\{ reason: 'service-worker-start' \}\)/);
  assert.ok(listenerIndex >= 0, 'listener principal de mensagens deve existir');
  assert.ok(startupIndex >= 0, 'bootstrap do service worker deve existir');
  assert.ok(
    listenerIndex < startupIndex,
    'ping/info precisam estar registrados antes de qualquer inicializacao pesada',
  );
  assert.ok(
    startBlock.indexOf("ensureNativeBrokerPort({ reason: 'service-worker-start' })") <
      startBlock.indexOf('consumePendingGeminiTabsReload()'),
    'native broker deve abrir antes do self-heal depender dele',
  );
});

test('service worker registra alarme de keepalive para acordar o native broker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const startBlock =
    source.match(/const handleServiceWorkerStart = async \(\) => \{[\s\S]*?\n\};/)?.[0] || '';

  assert.match(source, /NATIVE_BROKER_KEEPALIVE_ALARM/);
  assert.match(source, /NATIVE_BROKER_KEEPALIVE_PERIOD_MINUTES/);
  assert.match(source, /ensureNativeBrokerKeepaliveAlarm/);
  assert.match(startBlock, /ensureNativeBrokerKeepaliveAlarm\(\{\s*reason: 'service-worker-start'/);
  assert.match(
    source,
    /alarm\?\.name === NATIVE_BROKER_KEEPALIVE_ALARM[\s\S]*ensureNativeBrokerPort\(\{\s*reason: 'native-broker-keepalive-alarm'/,
  );
});

test('service worker bootstrap does not rely on delayed timer before native broker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /void handleServiceWorkerStart\(\);/);
  assert.doesNotMatch(source, /setTimeout\(\(\)\s*=>\s*\{\s*handleServiceWorkerStart\(\);\s*\},\s*250\)/);
});

test('native host forwards local ipc requests to the extension port', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'native', 'native-host-runtime.ts'), 'utf-8');
  assert.match(source, /pendingExtensionRequests/);
  assert.match(source, /sendToExtension/);
  assert.match(source, /brokerRequestTimeoutMs/);
  assert.match(source, /sendToExtension\(request,\s*brokerRequestTimeoutMs\(request\)\)/);
  assert.match(source, /extension\.hello/);
  assert.match(source, /startsWith\('extension\.'\)/);
  assert.match(source, /extension_unavailable/);
});

test('content script prefere native proxy para bridgeRequest com fallback HTTP', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  assert.match(source, /bridgeTransportState/);
  assert.match(source, /preferred:\s*'native'/);
  assert.match(source, /gemini-md-export\/native-proxy-http/);
  assert.match(source, /NATIVE_BRIDGE_TRANSPORT_COOLDOWN_MS/);
  assert.match(source, /disableNativeBridgeTransport/);
  assert.match(source, /catch \(err\)[\s\S]*?disableNativeBridgeTransport\(err\);[\s\S]*?return null;/);
  assert.match(source, /bridgeTransportState\.active\s*=\s*'http'/);
});

test('script renderiza manifesto native host com extension id informado', async () => {
  const child = spawn(
    process.execPath,
    [
      resolve(ROOT, 'scripts', 'native-host-manifest.mjs'),
      '--extension-id',
      'abcdefghijklmnopabcdefghijklmnop',
      '--print',
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const [chunk] = await once(child.stdout, 'data');
  const manifest = JSON.parse(chunk.toString('utf-8'));
  assert.equal(manifest.name, 'com.augustocaruso.gemini_md_export');
  assert.match(manifest.path, /gemini-md-export-native-host\.mjs$/);
  assert.deepEqual(manifest.allowed_origins, [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  ]);
  child.kill();
});

test('script renderiza manifesto native host com caminho Windows escapado', async () => {
  const windowsHostPath =
    'C:\\Users\\leo\\.gemini\\extensions\\gemini-md-export\\bin\\gemini-md-export-native-host.mjs';
  const child = spawn(
    process.execPath,
    [
      resolve(ROOT, 'scripts', 'native-host-manifest.mjs'),
      '--extension-id',
      'bpdmkcbcnhgbofiodbachaimkjodjpji',
      '--print',
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GEMINI_MD_EXPORT_NATIVE_HOST_PATH: windowsHostPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const [chunk] = await once(child.stdout, 'data');
  const manifest = JSON.parse(chunk.toString('utf-8'));
  assert.equal(manifest.path, windowsHostPath);
  assert.deepEqual(manifest.allowed_origins, [
    'chrome-extension://bpdmkcbcnhgbofiodbachaimkjodjpji/',
  ]);
  child.kill();
});

test('script conhece caminho Dia para native messaging no macOS', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'native', 'native-host-manifest.ts'), 'utf-8');
  assert.match(source, /chrome\|edge\|brave\|dia/);
  assert.match(source, /browser === 'dia'\s*\?\s*'Dia'/);
  assert.match(source, /Software\\\\Dia\\\\NativeMessagingHosts/);
});

test('script usa launcher exe no Windows para Native Messaging', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'native', 'native-host-manifest.ts'), 'utf-8');
  assert.match(source, /gemini-md-export-native-host\.exe/);
  assert.match(source, /CreateProcessW/);
  assert.match(source, /STARTF_USESTDHANDLES/);
});
