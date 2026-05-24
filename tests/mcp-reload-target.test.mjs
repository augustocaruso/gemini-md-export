import assert from 'node:assert/strict';
import test from 'node:test';

import { selectExplicitReloadClient } from '../build/ts/mcp/reload-target.js';

test('reload por clientId aceita cliente vivo mesmo sem pagina hidratada', () => {
  const staleButLive = {
    clientId: 'chat-stale',
    tabId: null,
    page: null,
    lastSeenAt: Date.now(),
  };
  const active = {
    clientId: 'chat-active',
    tabId: 123,
    page: { kind: 'chat' },
    lastSeenAt: Date.now(),
  };

  assert.equal(
    selectExplicitReloadClient([staleButLive, active], { clientId: 'chat-stale' }),
    staleButLive,
  );
});

test('reload por clientId nao escolhe fallback implicito quando o alvo nao existe', () => {
  const active = {
    clientId: 'chat-active',
    tabId: 123,
    page: { kind: 'chat' },
    lastSeenAt: Date.now(),
  };

  assert.equal(selectExplicitReloadClient([active], { clientId: 'missing' }), null);
});
