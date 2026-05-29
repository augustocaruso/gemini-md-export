import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateCdpTarget,
  buildCdpBrowserSnapshot,
  classifyCdpTargetUrl,
  listCdpTargets,
  navigateCdpTarget,
  normalizeCdpEndpoint,
  selectCdpTarget,
} from '../build/ts/cdp/browser-control.js';

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
    const route = routes[key] ?? routes[parsed.pathname] ?? routes[key.replace(/^PUT /, 'GET ')];
    if (!route) {
      throw new Error(`unexpected fetch ${key}`);
    }
    return typeof route === 'function' ? route(url, options) : route;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
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
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({
          id: message.id,
          result:
            message.method === 'Runtime.evaluate'
              ? { result: { type: 'string', value: 'ok' } }
              : { frameId: 'frame-1' },
        }),
      });
    });
  }

  close() {
    this.closed = true;
    this.onclose?.({ type: 'close' });
  }
}

test('normaliza endpoint CDP sem barra final', () => {
  assert.equal(normalizeCdpEndpoint('127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.equal(normalizeCdpEndpoint('http://localhost:9222///'), 'http://localhost:9222');
});

test('classifica URLs Gemini, login e bloqueio do Google pelo alvo CDP', () => {
  assert.equal(
    classifyCdpTargetUrl('https://gemini.google.com/app/88a98a108cdcfb61').kind,
    'gemini_chat',
  );
  assert.equal(classifyCdpTargetUrl('https://gemini.google.com/app').kind, 'gemini_home');
  assert.equal(classifyCdpTargetUrl('https://accounts.google.com/v3/signin').kind, 'google_login');
  assert.equal(
    classifyCdpTargetUrl('https://www.google.com/sorry/index?continue=https://gemini.google.com/app').kind,
    'google_sorry',
  );
});

test('lista targets CDP e monta snapshot com bloqueio acionavel', async () => {
  const fetchImpl = makeFetch({
    'GET /json/version': jsonResponse({ Browser: 'Chrome/126' }),
    'GET /json/list': jsonResponse([
      {
        id: 'sorry-target',
        type: 'page',
        title: 'Sorry',
        url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app',
        webSocketDebuggerUrl: 'ws://target/sorry',
      },
      {
        id: 'chat-target',
        type: 'page',
        title: 'Gemini',
        url: 'https://gemini.google.com/app/88a98a108cdcfb61',
        webSocketDebuggerUrl: 'ws://target/chat',
      },
    ]),
  });

  const targets = await listCdpTargets({ endpoint: 'http://127.0.0.1:9222', fetchImpl });
  assert.equal(targets.length, 2);
  assert.equal(targets[1].chatId, '88a98a108cdcfb61');

  const snapshot = await buildCdpBrowserSnapshot({ endpoint: 'http://127.0.0.1:9222', fetchImpl });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.controlPlane, 'cdp');
  assert.equal(snapshot.blocker?.code, 'google_verification_required');
  assert.equal(snapshot.geminiTargets.length, 1);
});

test('snapshot CDP usa Browser WebSocket primeiro quando o navegador anuncia websocket', async () => {
  FakeWebSocket.instances = [];
  const fetchImpl = makeFetch({
    'GET /json/version': jsonResponse({
      Browser: 'Dia/126',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    }),
  });

  const snapshot = await buildCdpBrowserSnapshot({
    endpoint: 'http://127.0.0.1:9222',
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    timeoutMs: 1000,
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.targets[0].id, 'chat-target');
  assert.equal(snapshot.targets[0].browserWebSocketUrl, 'ws://127.0.0.1:9222/devtools/browser/abc');
  assert.deepEqual(
    FakeWebSocket.instances[0].sent.map((message) => message.method),
    ['Target.getTargets'],
  );
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.key),
    ['GET /json/version'],
  );
});

test('seleciona target Gemini por chatId e ativa pelo endpoint CDP HTTP', async () => {
  const targets = [
    {
      id: 'home',
      type: 'page',
      url: 'https://gemini.google.com/app',
      title: 'Gemini',
      classification: { kind: 'gemini_home', terminal: false },
    },
    {
      id: 'chat',
      type: 'page',
      url: 'https://gemini.google.com/app/88a98a108cdcfb61',
      title: 'Gemini chat',
      chatId: '88a98a108cdcfb61',
      classification: { kind: 'gemini_chat', terminal: false },
    },
  ];
  const selected = selectCdpTarget(targets, { chatId: '88a98a108cdcfb61' });
  assert.equal(selected?.id, 'chat');

  const fetchImpl = makeFetch({
    'GET /json/activate/chat': jsonResponse(null, { text: 'Target activated' }),
  });
  const activated = await activateCdpTarget(selected, {
    endpoint: 'http://127.0.0.1:9222',
    fetchImpl,
  });
  assert.equal(activated.ok, true);
  assert.equal(fetchImpl.calls[0].key, 'GET /json/activate/chat');
});

test('ativa target CDP por Browser WebSocket quando o snapshot veio do browser endpoint', async () => {
  FakeWebSocket.instances = [];
  const activated = await activateCdpTarget(
    {
      id: 'chat-target',
      type: 'page',
      url: 'https://gemini.google.com/app/88a98a108cdcfb61',
      browserWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      classification: { kind: 'gemini_chat', terminal: false },
    },
    { endpoint: 'http://127.0.0.1:9222', WebSocketImpl: FakeWebSocket, timeoutMs: 1000 },
  );

  assert.equal(activated.ok, true);
  assert.equal(activated.targetId, 'chat-target');
  assert.deepEqual(
    FakeWebSocket.instances[0].sent.map((message) => message.method),
    ['Target.activateTarget'],
  );
});

test('navega target CDP por WebSocket sem depender da bridge HTTP', async () => {
  FakeWebSocket.instances = [];
  const result = await navigateCdpTarget(
    {
      id: 'chat',
      type: 'page',
      url: 'https://gemini.google.com/app',
      title: 'Gemini',
      webSocketDebuggerUrl: 'ws://target/chat',
      classification: { kind: 'gemini_home', terminal: false },
    },
    'https://gemini.google.com/app/88a98a108cdcfb61',
    { WebSocketImpl: FakeWebSocket, timeoutMs: 1000 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.result.frameId, 'frame-1');
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(
    FakeWebSocket.instances[0].sent.map((message) => message.method),
    ['Page.navigate'],
  );
  assert.equal(FakeWebSocket.instances[0].closed, true);
});
