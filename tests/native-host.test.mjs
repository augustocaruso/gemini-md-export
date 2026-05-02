import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

test('service worker expõe probe de native messaging sem acoplar ao fluxo principal', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');
  assert.match(source, /NATIVE_HOST_NAME\s*=\s*'com\.augustocaruso\.gemini_md_export'/);
  assert.match(source, /chrome\.runtime\.connectNative/);
  assert.match(source, /gemini-md-export\/native-host-health/);
  assert.match(source, /nativeHost:\s*lastNativeHostProbe/);
});

test('content script prefere native proxy para bridgeRequest com fallback HTTP', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  assert.match(source, /bridgeTransportState/);
  assert.match(source, /preferred:\s*'native'/);
  assert.match(source, /gemini-md-export\/native-proxy-http/);
  assert.match(source, /NATIVE_BRIDGE_TRANSPORT_COOLDOWN_MS/);
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

test('script conhece caminho Dia para native messaging no macOS', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'native-host-manifest.mjs'), 'utf-8');
  assert.match(source, /chrome\|edge\|brave\|dia/);
  assert.match(source, /browser === 'dia'\s*\?\s*'Dia'/);
  assert.match(source, /Software\\\\Dia\\\\NativeMessagingHosts/);
});
