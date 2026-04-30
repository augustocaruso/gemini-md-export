import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

test('MCP não espera timeout longo quando comando não é entregue à aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /COMMAND_DISPATCH_TIMEOUT_MS/);
  assert.match(source, /dispatchTimer/);
  assert.match(source, /command_dispatch_timeout/);
  assert.match(source, /não abriu o canal de comandos/);
  assert.match(source, /clearTimeout\(pending\.dispatchTimer\)/);
});

test('browser_status diagnostica bridge desconectado sem depender do guard', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const statusBlock = source.match(
    /name: 'gemini_browser_status'[\s\S]*?\n  \{\n    name: 'gemini_get_export_dir'/,
  )?.[0];
  const guardedBlock = source.match(
    /const BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  assert.ok(statusBlock, 'gemini_browser_status deve existir');
  assert.ok(guardedBlock, 'lista de tools com guard deve existir');
  assert.match(statusBlock, /ready:\s*matchingClients\.length > 0/);
  assert.match(statusBlock, /blockingIssue/);
  assert.match(statusBlock, /no_connected_clients/);
  assert.doesNotMatch(guardedBlock, /gemini_browser_status/);
});
