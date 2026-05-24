import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBrowserBridgeClient,
  getOrCreateBridgeClientId,
  readPendingBridgeCommand,
  RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY,
  savePendingBridgeCommand,
} from '../build/ts/browser/shared/bridge-client.js';

test('bridge client identity persiste em storage de aba', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  let randomCalls = 0;
  const first = getOrCreateBridgeClientId({
    storage,
    storageKey: 'client-key',
    prefix: 'chat',
    randomId: () => {
      randomCalls += 1;
      return `id-${randomCalls}`;
    },
  });
  const second = getOrCreateBridgeClientId({
    storage,
    storageKey: 'client-key',
    prefix: 'chat',
    randomId: () => {
      randomCalls += 1;
      return `id-${randomCalls}`;
    },
  });

  assert.equal(first, 'chat-id-1');
  assert.equal(second, 'chat-id-1');
  assert.equal(randomCalls, 1);
});

test('bridge client persiste comando de export navegavel para retomar apos reload', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const command = {
    id: 'cmd-navigation',
    type: 'get-chat-by-id',
    args: { item: { chatId: '4a6f9af41e117e59' } },
  };

  assert.equal(savePendingBridgeCommand(storage, command, { now: 1_000 }), true);
  assert.deepEqual(readPendingBridgeCommand(storage, { now: 1_200 }), command);

  const stored = JSON.parse(values.get(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY));
  assert.equal(stored.version, 1);
  assert.equal(stored.command.id, 'cmd-navigation');
});

test('bridge client nao persiste comandos que nao atravessam navegacao', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };

  assert.equal(
    savePendingBridgeCommand(storage, { id: 'cmd-current', type: 'get-current-chat' }, { now: 1_000 }),
    false,
  );
  assert.equal(values.has(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY), false);
});

test('browser bridge client envia heartbeat e posta resultado de comando uma unica vez', async () => {
  const calls = [];
  let executions = 0;
  const client = createBrowserBridgeClient({
    kind: 'activity',
    bridgeBaseUrl: 'http://bridge.test',
    capabilities: ['activity-scan-batch-v1'],
    clientId: 'client-a',
    getPageSnapshot: () => ({ kind: 'activity', path: '/product/gemini' }),
    executeCommand: async (command) => {
      executions += 1;
      return { ok: true, commandType: command.type };
    },
    bridgeRequest: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/bridge/heartbeat') {
        return { ok: true, command: { id: 'cmd-1', type: 'activity-scan-batch' } };
      }
      return { ok: true };
    },
  });

  await client.start({ connectEvents: false, startHeartbeatTimer: false });
  await client.sendHeartbeat();
  await client.handleCommand({ id: 'cmd-1', type: 'activity-scan-batch' });

  assert.equal(executions, 1);
  assert.equal(calls.filter((call) => call.path === '/bridge/command-result').length, 2);
  assert.equal(calls[0].options.payload.clientId, 'client-a');
  assert.equal(calls[0].options.payload.capabilities[0], 'activity-scan-batch-v1');
  assert.equal(calls[1].options.payload.result.commandType, 'activity-scan-batch');
});

test('browser bridge client consome command e jobProgress do canal SSE', async () => {
  const listeners = new Map();
  const progress = [];
  const postedResults = [];
  const client = createBrowserBridgeClient({
    kind: 'chat',
    bridgeBaseUrl: 'http://bridge.test',
    capabilities: ['chat-export-v1'],
    clientId: 'client-b',
    getPageSnapshot: () => ({ kind: 'chat' }),
    executeCommand: async (command) => ({ ok: true, type: command.type }),
    onJobProgress: (snapshot) => progress.push(snapshot),
    bridgeRequest: async (path, options = {}) => {
      if (path === '/bridge/command-result') postedResults.push(options.payload);
      return { ok: true };
    },
    eventSourceFactory: (url) => {
      assert.equal(url, 'http://bridge.test/bridge/events?clientId=client-b');
      return {
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        close() {},
      };
    },
  });

  await client.start({ startHeartbeatTimer: false });
  listeners.get('open')?.({});
  await listeners.get('command')?.({
    data: JSON.stringify({ command: { id: 'cmd-sse', type: 'get-current-chat' } }),
  });
  await listeners.get('jobProgress')?.({
    data: JSON.stringify({ jobId: 'job-1', status: 'running' }),
  });

  assert.equal(client.state.eventsConnected, true);
  assert.equal(postedResults[0].commandId, 'cmd-sse');
  assert.equal(progress[0].jobId, 'job-1');
});

test('browser bridge client avisa quando heartbeat nao traz mais jobProgress', async () => {
  const progress = [];
  const heartbeats = [
    { ok: true, jobProgress: { jobId: 'job-1', status: 'cancel_requested' } },
    { ok: true },
  ];
  const client = createBrowserBridgeClient({
    kind: 'chat',
    bridgeBaseUrl: 'http://bridge.test',
    capabilities: ['chat-export-v1'],
    clientId: 'client-progress-clear',
    getPageSnapshot: () => ({ kind: 'chat' }),
    onJobProgress: (snapshot) => progress.push(snapshot),
    bridgeRequest: async (path) => {
      if (path === '/bridge/heartbeat') return heartbeats.shift() || { ok: true };
      return { ok: true };
    },
  });

  await client.start({ connectEvents: false, startHeartbeatTimer: false });
  await client.sendHeartbeat();
  await client.sendHeartbeat();

  assert.deepEqual(progress, [
    { jobId: 'job-1', status: 'cancel_requested' },
    null,
  ]);
});

test('browser bridge client mantem SSE e abre long-poll quando heartbeat exige command poll', async () => {
  const listeners = new Map();
  const calls = [];
  let closed = 0;
  let executions = 0;
  const client = createBrowserBridgeClient({
    kind: 'chat',
    bridgeBaseUrl: 'http://bridge.test',
    capabilities: ['chat-export-v1'],
    clientId: 'client-poll',
    getPageSnapshot: () => ({ kind: 'chat' }),
    executeCommand: async (command) => {
      executions += 1;
      return { ok: true, type: command.type };
    },
    bridgeRequest: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/bridge/heartbeat') {
        return { ok: true, commandPollRequired: true };
      }
      if (path === '/bridge/command?clientId=client-poll') {
        return { command: { id: 'cmd-poll', type: 'get-current-chat' } };
      }
      return { ok: true };
    },
    eventSourceFactory: () => ({
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      close() {
        closed += 1;
      },
    }),
  });

  await client.start({ startHeartbeatTimer: false });
  listeners.get('open')?.({});
  assert.equal(client.state.eventsConnected, true);

  await client.sendHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(closed, 0);
  assert.equal(client.state.eventsConnected, true);
  assert.equal(executions, 1);
  assert.ok(calls.some((call) => call.path === '/bridge/command?clientId=client-poll'));
});

test('browser bridge client reenfileira resultado quando post de command-result falha', async () => {
  const postedResults = [];
  let commandResultFailures = 1;
  const client = createBrowserBridgeClient({
    kind: 'chat',
    bridgeBaseUrl: 'http://bridge.test',
    capabilities: ['chat-export-v1', 'command-result-retry-v1'],
    clientId: 'client-c',
    getPageSnapshot: () => ({ kind: 'chat' }),
    executeCommand: async (command) => ({ ok: true, type: command.type }),
    bridgeRequest: async (path, options = {}) => {
      if (path === '/bridge/command-result') {
        postedResults.push(options.payload);
        if (commandResultFailures > 0) {
          commandResultFailures -= 1;
          throw new Error('transient command-result failure');
        }
        return { ok: true };
      }
      if (path === '/bridge/heartbeat') {
        return { ok: true };
      }
      return { ok: true };
    },
  });

  await client.start({ connectEvents: false, startHeartbeatTimer: false });
  await client.handleCommand({ id: 'cmd-retry', type: 'get-current-chat' });
  await client.sendHeartbeat();

  assert.equal(postedResults.length, 2);
  assert.equal(postedResults[0].commandId, 'cmd-retry');
  assert.equal(postedResults[1].commandId, 'cmd-retry');
  assert.equal(client.state.commandResultCache.get('cmd-retry').deliveredAt > 0, true);
});
