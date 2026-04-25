import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecentChatsRefreshPlan,
  DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
  shouldRefreshRecentChats,
} from '../src/recent-chats-policy.mjs';

test('recent chats usa cache fresca quando heartbeat acabou de chegar', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 2_000,
    conversations: [{ chatId: 'abc123' }],
  };

  assert.equal(
    shouldRefreshRecentChats(client, {}, { now, maxAgeMs: DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS }),
    false,
  );
});

test('recent chats força refresh quando a lista está vazia', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 2_000,
    conversations: [],
  };

  assert.equal(shouldRefreshRecentChats(client, {}, { now }), true);
});

test('recent chats força refresh quando o heartbeat ficou velho', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 20_000,
    conversations: [{ chatId: 'abc123' }],
  };

  assert.equal(
    shouldRefreshRecentChats(client, {}, { now, maxAgeMs: DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS }),
    true,
  );
});

test('recent chats respeita refresh=true para forçar atualização', () => {
  const client = {
    lastSeenAt: Date.now(),
    conversations: [{ chatId: 'abc123' }],
  };

  assert.equal(shouldRefreshRecentChats(client, { refresh: true }), true);
});

test('recent chats respeita refresh=false para priorizar velocidade', () => {
  const client = {
    lastSeenAt: 0,
    conversations: [],
  };

  assert.equal(shouldRefreshRecentChats(client, { refresh: false }), false);
});

test('recent chats usa refresh com budget curto quando já existe cache', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 20_000,
    conversations: [{ chatId: 'abc123' }],
  };

  assert.deepEqual(
    buildRecentChatsRefreshPlan(client, {}, { now, maxAgeMs: DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS }),
    {
      shouldRefresh: true,
      preferFastRefresh: true,
    },
  );
});

test('recent chats não usa budget curto quando ainda não há cache', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 20_000,
    conversations: [],
  };

  assert.deepEqual(
    buildRecentChatsRefreshPlan(client, {}, { now, maxAgeMs: DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS }),
    {
      shouldRefresh: true,
      preferFastRefresh: false,
    },
  );
});
