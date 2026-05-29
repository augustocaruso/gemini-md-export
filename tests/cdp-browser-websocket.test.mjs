import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExtensionReloadExpression,
  createBrowserWebSocketSession,
  findExtensionManagementTarget,
  listBrowserTargetsViaWebSocket,
  parseDevToolsActivePort,
  reloadExtensionFromDevToolsActivePort,
  reloadExtensionFromManagementTarget,
} from '../build/ts/cdp/browser-websocket.js';

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
    if (message.method === 'Target.attachToTarget') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ id: message.id, result: { sessionId: 'session-1' } }),
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
    if (message.method === 'Target.getTargets') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [
                { targetId: 'gemini', type: 'page', url: 'https://gemini.google.com/app' },
                {
                  targetId: 'extensions',
                  type: 'page',
                  url: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
                },
              ],
            },
          }),
        });
      });
      return;
    }
    throw new Error(`unexpected CDP method ${message.method}`);
  }

  close() {
    this.closed = true;
  }
}

test('parseia DevToolsActivePort como browser WebSocket direto', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc\n'), {
    port: 9222,
    browserPath: '/devtools/browser/abc',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
  });
});

test('lista targets via Browser WebSocket sem endpoint HTTP /json/list', async () => {
  FakeBrowserWebSocket.instances = [];

  const targets = await listBrowserTargetsViaWebSocket({
    browserWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    WebSocketImpl: FakeBrowserWebSocket,
    timeoutMs: 1000,
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[1].targetId, 'extensions');
  assert.deepEqual(
    FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
    ['Target.getTargets'],
  );
});

test('recarrega extensao a partir de DevToolsActivePort e target de gerenciamento', async () => {
  FakeBrowserWebSocket.instances = [];

  const result = await reloadExtensionFromDevToolsActivePort({
    devToolsActivePortContents: '9222\n/devtools/browser/abc\n',
    extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
    WebSocketImpl: FakeBrowserWebSocket,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cdp-browser-websocket');
  assert.equal(result.targetId, 'extensions');
  assert.equal(FakeBrowserWebSocket.instances.length, 1);
  assert.deepEqual(
    FakeBrowserWebSocket.instances.flatMap((instance) =>
      instance.sent.map((message) => message.method),
    ),
    ['Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate'],
  );
});

test('seleciona target chrome://extensions da extensao carregada', () => {
  const target = findExtensionManagementTarget(
    [
      { targetId: 'other', type: 'page', url: 'https://gemini.google.com/app' },
      {
        targetId: 'extensions',
        type: 'page',
        url: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
      },
    ],
    'ikjanjokpogoakdlikhcgfgcjbgoogkc',
  );

  assert.equal(target?.targetId, 'extensions');
});

test('expressao de reload usa developerPrivate sem callback que pode travar no Dia', () => {
  const expression = buildExtensionReloadExpression('ikjanjokpogoakdlikhcgfgcjbgoogkc');

  assert.match(expression, /chrome\.developerPrivate\.reload/);
  assert.match(expression, /ikjanjokpogoakdlikhcgfgcjbgoogkc/);
  assert.doesNotMatch(expression, /new Promise/);
});

test('recarrega extensao via target chrome://extensions usando Browser WebSocket', async () => {
  FakeBrowserWebSocket.instances = [];

  const result = await reloadExtensionFromManagementTarget({
    browserWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
    target: {
      targetId: 'extensions',
      type: 'page',
      url: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
    },
    WebSocketImpl: FakeBrowserWebSocket,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'cdp-browser-websocket');
  assert.equal(result.targetId, 'extensions');
  assert.deepEqual(
    FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
    ['Target.attachToTarget', 'Runtime.evaluate'],
  );
  assert.equal(FakeBrowserWebSocket.instances[0].sent[1].sessionId, 'session-1');
});

test('sessao WebSocket persistente reutiliza attach no mesmo target', async () => {
  FakeBrowserWebSocket.instances = [];

  const session = createBrowserWebSocketSession({
    browserWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    WebSocketImpl: FakeBrowserWebSocket,
    timeoutMs: 1000,
  });
  try {
    const target = {
      targetId: 'extensions',
      type: 'page',
      url: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
    };
    const first = await session.reloadExtensionFromManagementTarget({
      extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
      target,
    });
    const second = await session.reloadExtensionFromManagementTarget({
      extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
      target,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(FakeBrowserWebSocket.instances.length, 1);
    assert.deepEqual(
      FakeBrowserWebSocket.instances[0].sent.map((message) => message.method),
      ['Target.attachToTarget', 'Runtime.evaluate', 'Runtime.evaluate'],
    );
  } finally {
    session.close();
  }
});
