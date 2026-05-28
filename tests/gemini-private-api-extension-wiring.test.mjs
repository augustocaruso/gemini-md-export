import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('extension background exposes a narrow private API read-chat message', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /readGeminiPrivateChat/);
  assert.match(source, /gemini-md-export\/private-api-read-chat/);
  assert.doesNotMatch(source, /chrome\.cookies/);
});

test('content script forwards private-api-read-chat without arbitrary eval', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /command\.type === 'private-api-read-chat'/);
  assert.match(source, /gemini-md-export\/private-api-read-chat/);
  assert.doesNotMatch(source, /eval\(/);
});

test('extension build publishes core modules used by background private API client', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');

  assert.match(source, /build['"], ['"]ts['"], ['"]core/);
  assert.match(source, /resolve\(extensionDir, ['"]core['"]\)/);
});

test('MCP exposes private_read as deliberate gemini_chats action', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const actionSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'private-read-action.ts'), 'utf-8');

  assert.match(source, /private_read/);
  assert.match(source, /createMcpPrivateReadAction/);
  assert.match(source, /gemini-webapi-python/);
  assert.match(source, /action === 'private_read'/);
  assert.match(source, /runMcpPrivateReadAction\(args\)/);
  assert.match(actionSource, /private-api-read-chat/);
  assert.match(actionSource, /runGeminiWebapiPythonReadChat/);
});
