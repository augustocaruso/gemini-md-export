import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBridgeListenError } from '../src/mcp-server-errors.mjs';

test('formatBridgeListenError explica EADDRINUSE com contexto útil', () => {
  const message = formatBridgeListenError(
    { code: 'EADDRINUSE', message: 'listen EADDRINUSE: address already in use 127.0.0.1:47283' },
    { host: '127.0.0.1', port: 47283 },
  );

  assert.match(message, /porta já está em uso/i);
  assert.match(message, /instância antiga do MCP/i);
  assert.match(message, /127\.0\.0\.1:47283/);
});

test('formatBridgeListenError preserva mensagem original em erros genéricos', () => {
  const message = formatBridgeListenError(
    { code: 'EACCES', message: 'permission denied' },
    { host: '127.0.0.1', port: 47283 },
  );

  assert.match(message, /permission denied/);
  assert.match(message, /127\.0\.0\.1:47283/);
});
