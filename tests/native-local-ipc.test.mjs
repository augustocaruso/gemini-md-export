import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBrokerIpcServer,
  defaultBrokerIpcPath,
  requestBrokerIpc,
} from '../build/ts/native/local-ipc.js';

test('broker ipc uses a non-http local endpoint', () => {
  const path = defaultBrokerIpcPath({ platform: 'darwin', runtimeDir: '/tmp/gme-test' });
  assert.match(path, /gemini-md-export/);
  assert.doesNotMatch(path, /^http/);
});

test('broker ipc request/response preserves ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gme-ipc-'));
  const socketPath = join(dir, 'broker.sock');
  const server = await createBrokerIpcServer({
    path: socketPath,
    handleRequest: async (request) => ({
      id: request.id,
      ok: true,
      result: { command: request.command },
    }),
  });

  const response = await requestBrokerIpc(socketPath, {
    id: 'ipc-1',
    protocolVersion: 1,
    command: 'ping',
    payload: {},
  });

  assert.deepEqual(response, { id: 'ipc-1', ok: true, result: { command: 'ping' } });
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});
