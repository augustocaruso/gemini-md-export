import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBrowserAuthorityCommandAllowed,
  attachBrowserAuthorityLeaseToCommand,
  initialBrowserAuthorityState,
} from '../build/ts/mcp/browser-authority/index.js';

test('MCP runtime attaches browser authority lease marker to mutating commands', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = attachBrowserAuthorityLeaseToCommand({
    state: start,
    commandType: 'reload-page',
    operationId: 'op-1',
    args: { delayMs: 10 },
    nowMs: 1_100,
  });

  assert.equal(result.state.leases.length, 1);
  assert.equal(typeof result.args.browserAuthorityLeaseId, 'string');
  assertBrowserAuthorityCommandAllowed({
    commandType: 'reload-page',
    args: result.args,
  });
});

test('MCP runtime leaves non-mutating commands unleased', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = attachBrowserAuthorityLeaseToCommand({
    state: start,
    commandType: 'get-extension-info',
    operationId: 'op-1',
    args: {},
    nowMs: 1_100,
  });

  assert.equal(result.state.leases.length, 0);
  assert.equal(result.args.browserAuthorityLeaseId, undefined);
});

test('MCP runtime rejects mutating commands without lease marker', () => {
  assert.throws(
    () =>
      assertBrowserAuthorityCommandAllowed({
        commandType: 'open-chat',
        args: {},
      }),
    /faltou autorizacao/i,
  );
});
