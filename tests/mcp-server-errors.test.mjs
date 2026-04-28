import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBridgeListenError } from '../src/mcp-server-errors.mjs';

test('formatBridgeListenError explica EADDRINUSE como modo proxy', () => {
  const message = formatBridgeListenError(
    { code: 'EADDRINUSE', message: 'listen EADDRINUSE: address already in use 127.0.0.1:47283' },
    { host: '127.0.0.1', port: 47283 },
  );

  assert.match(message, /já está em uso/i);
  assert.match(message, /modo proxy/i);
  assert.match(message, /instância primária/i);
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
