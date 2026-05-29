import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('extension background exposes a narrow private API read-chat message', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /readGeminiPrivateChat/);
  assert.match(source, /listGeminiPrivateChats/);
  assert.match(source, /checkGeminiPrivateSession/);
  assert.match(source, /gemini-md-export\/private-api-read-chat/);
  assert.match(source, /gemini-md-export\/private-api-list-chats/);
  assert.match(source, /gemini-md-export\/private-api-session-status/);
  assert.doesNotMatch(source, /chrome\.cookies/);
});

test('content script forwards private-api-read-chat without arbitrary eval', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /command\.type === 'private-api-read-chat'/);
  assert.match(source, /command\.type === 'private-api-list-chats'/);
  assert.match(source, /command\.type === 'private-api-session-status'/);
  assert.match(source, /gemini-md-export\/private-api-read-chat/);
  assert.doesNotMatch(source, /eval\(/);
});

test('extension modal launches the same MCP selected export job instead of local batch export', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /const startMcpSelectedExport/);
  assert.match(source, /\/agent\/reexport-chats/);
  assert.match(source, /privateReadExport: true/);
  assert.match(source, /allowDomFallback: false/);
  assert.match(source, /await startMcpSelectedExport\(selected/);
});

test('extension build publishes core modules used by background private API client', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');

  assert.match(source, /build['"], ['"]ts['"], ['"]core/);
  assert.match(source, /resolve\(extensionDir, ['"]core['"]\)/);
});

test('MCP exposes private_read as deliberate gemini_chats action', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const actionSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'private-read-action.ts'), 'utf-8');
  const inventorySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'private-inventory-runtime.ts'),
    'utf-8',
  );

  assert.match(source, /private_read/);
  assert.match(source, /createMcpPrivateReadRuntimes/);
  assert.match(source, /gemini-webapi-python/);
  assert.match(source, /action === 'private_read'/);
  assert.match(source, /privateRead\.run\(args\)/);
  assert.match(actionSource, /createMcpPrivateReadAction/);
  assert.match(actionSource, /private-api-read-chat/);
  assert.match(source, /session_status/);
  assert.match(actionSource, /runGeminiWebapiPythonReadChat/);
  assert.match(inventorySource, /checkPrivateSessionStatus/);
  assert.match(inventorySource, /private-api-session-status/);
});
