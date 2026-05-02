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
