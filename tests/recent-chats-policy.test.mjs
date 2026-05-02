import test from 'node:test';
import assert from 'node:assert/strict';

import {
  browserSidebarCountEvidenceGroups,
  buildRecentChatsRefreshPlan,
  DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
  inferRecentChatsCountStatus,
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

test('recent chats evita refresh quando o cache ja cobre a pagina pedida', () => {
  const now = 100_000;
  const client = {
    lastSeenAt: now - 20_000,
    conversations: Array.from({ length: 30 }, (_, index) => ({ chatId: `chat${index}` })),
  };

  assert.equal(
    shouldRefreshRecentChats(client, {}, {
      now,
      maxAgeMs: DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
      requestedCount: 20,
    }),
    false,
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

test('contagem usa DOM do sidebar quando counts do browser concordam', () => {
  const client = {
    page: {
      kind: 'chat',
      listedConversationCount: 277,
      bridgeConversationCount: 277,
      sidebarConversationCount: 277,
      reachedSidebarEnd: false,
    },
  };

  assert.deepEqual(inferRecentChatsCountStatus(client, 277), {
    countStatus: 'complete',
    totalKnown: true,
    totalCount: 277,
    countSource: 'browser_dom_count_match',
    countConfidence: 'dom-counts-agree',
    countEvidence: [
      {
        source: 'client.page',
        pageKind: 'chat',
        evidence: [
          { field: 'sidebarConversationCount', count: 277, kind: 'sidebar' },
          { field: 'bridgeConversationCount', count: 277, kind: 'sidebar' },
          { field: 'listedConversationCount', count: 277, kind: 'listed' },
        ],
      },
    ],
  });
});

test('contagem não promove DOM concordante quando caller bloqueia confirmação por DOM', () => {
  const result = inferRecentChatsCountStatus(
    {
      page: {
        kind: 'chat',
        listedConversationCount: 13,
        bridgeConversationCount: 13,
        sidebarConversationCount: 13,
      },
    },
    13,
    {
      allowDomCountConfirmation: false,
    },
  );

  assert.equal(result.totalKnown, false);
  assert.equal(result.totalCount, null);
  assert.equal(result.countSource, 'unconfirmed');
  assert.equal(result.countConfidence, 'partial');
});

test('contagem não promove parcial quando cache carregado diverge do DOM', () => {
  const result = inferRecentChatsCountStatus(
    {
      page: {
        kind: 'chat',
        listedConversationCount: 277,
        bridgeConversationCount: 277,
        sidebarConversationCount: 277,
      },
    },
    93,
  );

  assert.equal(result.totalKnown, false);
  assert.equal(result.totalCount, null);
  assert.equal(result.countSource, 'unconfirmed');
});

test('contagem ignora listedConversationCount de caderno e usa sidebar global', () => {
  const result = inferRecentChatsCountStatus(
    {
      page: {
        kind: 'notebook',
        listedConversationCount: 8,
        bridgeConversationCount: 277,
        sidebarConversationCount: 277,
      },
    },
    277,
  );

  assert.equal(result.totalKnown, true);
  assert.equal(result.totalCount, 277);
  assert.equal(result.countSource, 'browser_dom_count_match');
  assert.deepEqual(browserSidebarCountEvidenceGroups({
    page: {
      kind: 'notebook',
      listedConversationCount: 8,
      bridgeConversationCount: 277,
      sidebarConversationCount: 277,
    },
  })[0].evidence, [
    { field: 'sidebarConversationCount', count: 277, kind: 'sidebar' },
    { field: 'bridgeConversationCount', count: 277, kind: 'sidebar' },
  ]);
});
