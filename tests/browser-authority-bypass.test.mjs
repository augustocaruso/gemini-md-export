import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf-8');

test('MCP mutating browser commands receive browser authority lease markers', () => {
  const source = read('src/mcp-server.js');
  const sideEffects = read('src/mcp/browser-side-effects.ts');

  assert.match(source, /markBrowserSideEffectCommandArgs/);
  assert.match(sideEffects, /browserAuthorityLeaseId/);
  assert.match(sideEffects, /explicit-\$\{String\(commandType/);
});

test('browser authority is the only new module allowed to mint browser authority lease ids', () => {
  const server = read('src/mcp-server.js');
  const runtime = read('src/mcp/browser-authority/mcp-runtime.ts');

  assert.doesNotMatch(server, /browserAuthorityLeaseId:\s*`/);
  assert.match(runtime, /browserAuthorityLeaseId:\s*leased\.lease\.leaseId/);
});
