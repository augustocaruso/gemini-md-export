import test from 'node:test';
import assert from 'node:assert/strict';

import { createCdpRuntimeSessionOwner } from '../build/ts/cdp/runtime-session-owner.js';

const jsonResponse = (payload, { status = 200, text = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'ERROR',
  async json() {
    return payload;
  },
  async text() {
    return text ?? JSON.stringify(payload);
  },
});

const makeFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const key = `${options.method || 'GET'} ${parsed.pathname}${parsed.search}`;
    calls.push({ key, url: String(url), options });
    const route = routes[key] ?? routes[parsed.pathname];
    if (!route) throw new Error(`unexpected fetch ${key}`);
    return typeof route === 'function' ? route(url, options) : route;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

class FakeBrowserWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeBrowserWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.({ type: 'open' }));
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    if (message.method === 'Target.getTargets') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [
                {
                  targetId: 'chat-target',
                  type: 'page',
                  title: 'Gemini',
                  url: 'https://gemini.google.com/app/88a98a108cdcfb61',
                },
                {
                  targetId: 'extensions',
                  type: 'page',
                  title: 'Extensions',
                  url: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
                },
              ],
            },
          }),
        });
      });
      return;
    }
    if (message.method === 'Target.activateTarget') {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) });
      });
      return;
    }
    if (message.method === 'Target.attachToTarget') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ id: message.id, result: { sessionId: 'session-extensions' } }),
        });
      });
      return;
    }
    if (message.method === 'Runtime.evaluate') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            result: { result: { type: 'string', value: '{"ok":true}' } },
          }),
        });
      });
      return;
    }
    throw new Error(`unexpected CDP method ${message.method}`);
  }

  close() {
    this.closed = true;
    this.onclose?.({ type: 'close' });
  }
}

test('CDP runtime session owner reutiliza o mesmo Browser WebSocket entre snapshot e ativacao', async () => {
  FakeBrowserWebSocket.instances = [];
  const fetchImpl = makeFetch({
    'GET /json/version': jsonResponse({
      Browser: 'Dia/126',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    }),
  });
  const owner = createCdpRuntimeSessionOwner({
    WebSocketImpl: FakeBrowserWebSocket,
    fetchImpl,
    timeoutMs: 1000,
  });
  try {
    const snapshot = await owner.buildSnapshot({ endpoint: 'http://127.0.0.1:9222' });
    const activated = await owner.activateTarget(snapshot.targets[0], {
      endpoint: 'http://127.0.0.1:9222',
    });
    const secondSnapshot = await owner.buildSnapshot({ endpoint: 'http://127.0.0.1:9222' });

    assert.equal(snapshot.ok, true);
    assert.equal(activated.ok, true);
    assert.equal(secondSnapshot.ok, true);
    assert.equal(FakeBrowserWebSocket.instances.length, 1);
    assert.deepEqual(
      FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
      ['Target.getTargets', 'Target.activateTarget', 'Target.getTargets'],
    );
    assert.equal(fetchImpl.calls.every((call) => call.key === 'GET /json/version'), true);
  } finally {
    owner.closeAll();
  }
  assert.equal(FakeBrowserWebSocket.instances[0].closed, true);
});

test('CDP runtime session owner usa DevToolsActivePort quando /json/version nao informa Browser WebSocket', async () => {
  FakeBrowserWebSocket.instances = [];
  const fetchImpl = makeFetch({
    'GET /json/version': jsonResponse({
      Browser: 'Chrome/148',
    }),
  });
  const owner = createCdpRuntimeSessionOwner({
    WebSocketImpl: FakeBrowserWebSocket,
    fetchImpl,
    timeoutMs: 1000,
  });
  try {
    const snapshot = await owner.buildSnapshot({
      endpoint: 'http://127.0.0.1:60268',
      devToolsActivePortContents: '60268\n/devtools/browser/from-file\n',
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.targets.length, 2);
    assert.equal(FakeBrowserWebSocket.instances.length, 1);
    assert.equal(
      FakeBrowserWebSocket.instances[0].url,
      'ws://127.0.0.1:60268/devtools/browser/from-file',
    );
    assert.deepEqual(
      FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
      ['Target.getTargets'],
    );
  } finally {
    owner.closeAll();
  }
});

test('CDP runtime session owner reutiliza attach de reload da extensao entre chamadas', async () => {
  FakeBrowserWebSocket.instances = [];
  const owner = createCdpRuntimeSessionOwner({
    WebSocketImpl: FakeBrowserWebSocket,
    timeoutMs: 1000,
  });
  try {
    const args = {
      extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
      devToolsActivePortContents: '9222\n/devtools/browser/abc\n',
    };
    const first = await owner.reloadExtensionFromDevToolsActivePort(args);
    const second = await owner.reloadExtensionFromDevToolsActivePort(args);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(FakeBrowserWebSocket.instances.length, 1);
    assert.deepEqual(
      FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
      [
        'Target.getTargets',
        'Target.attachToTarget',
        'Runtime.evaluate',
        'Target.getTargets',
        'Runtime.evaluate',
      ],
    );
  } finally {
    owner.closeAll();
  }
});
