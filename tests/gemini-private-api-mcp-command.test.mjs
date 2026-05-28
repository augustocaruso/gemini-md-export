import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPrivateApiReadChatCommand } from '../build/ts/mcp/private-api-read-chat-command.js';

test('private API MCP command picks explicit chat id and clamps timeout', () => {
  const command = buildPrivateApiReadChatCommand(
    { chatId: 'dbe5dd4b50b09c74', waitMs: 999999, title: 'Explicit title' },
    { page: { chatId: 'aaaaaaaaaaaa', title: 'Page title' } },
  );

  assert.equal(command.args.chatId, 'dbe5dd4b50b09c74');
  assert.equal(command.args.title, 'Explicit title');
  assert.equal(command.args.timeoutMs, 120000);
  assert.equal(command.timeoutMs, 120000);
  assert.equal(command.adapterPlan.selectedAdapter, 'browserBackground');
  assert.deepEqual(command.adapterPlan.fallbackAdapters, ['dom']);
});

test('private API MCP command falls back to selected client page identity', () => {
  const command = buildPrivateApiReadChatCommand(
    {},
    { page: { chatId: 'dbe5dd4b50b09c74', title: 'Page title' } },
  );

  assert.equal(command.args.chatId, 'dbe5dd4b50b09c74');
  assert.equal(command.args.title, 'Page title');
  assert.equal(command.args.timeoutMs, 45000);
  assert.equal(command.adapterPlan.selectedAdapter, 'browserBackground');
});
