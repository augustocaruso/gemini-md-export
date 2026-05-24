import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBrowserReadyForRepair,
  connectedClientsFromReadyStatus,
} from '../build/ts/core/browser-ready-contract.js';

test('browser ready contract aceita schema clients atual do gemini_ready', () => {
  const status = {
    ready: true,
    blockingIssue: null,
    clients: [{ clientId: 'chat-1' }],
  };
  assert.deepEqual(connectedClientsFromReadyStatus(status), [{ clientId: 'chat-1' }]);
  assert.doesNotThrow(() => assertBrowserReadyForRepair(status));
});

test('browser ready contract ainda aceita connectedClients legado', () => {
  const status = {
    ready: true,
    blockingIssue: null,
    connectedClients: [{ clientId: 'chat-legacy' }],
  };
  assert.deepEqual(connectedClientsFromReadyStatus(status), [{ clientId: 'chat-legacy' }]);
  assert.doesNotThrow(() => assertBrowserReadyForRepair(status));
});
