import test from 'node:test';
import assert from 'node:assert/strict';

import { createNavigationEngine } from '../build/ts/browser/navigation/navigation-engine.js';

const chatId = 'b8e7c075effe9457';
const otherChatId = 'aaaaaaaaaaaa';

const fakeAdapter = ({ routeChatId = null, rows = [], turnCount = 1 } = {}) => ({
  getRouteState: () => ({
    kind: routeChatId ? 'chat' : 'home',
    url: routeChatId ? `https://gemini.google.com/app/${routeChatId}` : 'https://gemini.google.com/app',
    path: routeChatId ? `/app/${routeChatId}` : '/app',
    chatId: routeChatId,
    notebookId: null,
    warnings: routeChatId ? [] : ['missing_chat_id'],
    evidence: [],
  }),
  listConversationRows: () => rows,
  getHydrationState: () => ({
    turnCount,
    isLoading: false,
    warnings: turnCount ? [] : ['empty_chat_dom'],
    evidence: [],
  }),
  getCurrentSnapshot: () => ({
    ok: false,
    code: 'adapter_contract_missing',
    message: 'not used by navigation test',
    evidence: [],
  }),
});

const row = (patch) => ({
  source: 'sidebar',
  index: 0,
  title: 'Conversa',
  url: `https://gemini.google.com/app/${chatId}`,
  chatId,
  exportable: true,
  current: false,
  warnings: [],
  evidence: [],
  ...patch,
});

test('navigation engine bloqueia linha sem chatId sem abrir URL', async () => {
  const opened = [];
  const engine = createNavigationEngine({
    adapter: fakeAdapter({
      rows: [
        row({
          title: 'titulo que parece id aaaaaaaaaaaa',
          url: null,
          chatId: null,
          exportable: false,
          warnings: ['missing_chat_id'],
        }),
      ],
    }),
    openUrl: async (url) => opened.push(url),
  });

  const result = await engine.openChat({ rowIndex: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'identity_unproven');
  assert.deepEqual(opened, []);
});

test('navigation engine abre linha exportavel e espera hidratacao', async () => {
  const events = [];
  const engine = createNavigationEngine({
    adapter: fakeAdapter({ rows: [row({})] }),
    openUrl: async (url) => events.push(['openUrl', url]),
    waitForHydration: async () => {
      events.push(['hydrate']);
      return { ok: true, turnCount: 3 };
    },
  });

  const result = await engine.openChat({ chatId });

  assert.equal(result.ok, true);
  assert.equal(result.chatId, chatId);
  assert.deepEqual(events, [['openUrl', `https://gemini.google.com/app/${chatId}`], ['hydrate']]);
});

test('navigation engine retorna current quando a rota atual ja e o alvo', async () => {
  const opened = [];
  const engine = createNavigationEngine({
    adapter: fakeAdapter({ routeChatId: chatId, rows: [row({ current: true })] }),
    openUrl: async (url) => opened.push(url),
  });

  const result = await engine.openChat({ chatId });

  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.equal(result.reason, 'already-current');
  assert.deepEqual(opened, []);
});

test('navigation engine espera hidratacao quando rota atual ainda nao tem turnos', async () => {
  const events = [];
  const engine = createNavigationEngine({
    adapter: fakeAdapter({ routeChatId: chatId, rows: [row({ current: true })], turnCount: 0 }),
    openUrl: async (url) => events.push(['openUrl', url]),
    waitForHydration: async ({ chatId: hydratedChatId }) => {
      events.push(['hydrate', hydratedChatId]);
      return { ok: true, turnCount: 2 };
    },
  });

  const result = await engine.openChat({ chatId });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-current');
  assert.equal(result.turnCount, 2);
  assert.deepEqual(events, [['hydrate', chatId]]);
});

test('navigation engine bloqueia quando a aba esta ocupada', async () => {
  const engine = createNavigationEngine({
    adapter: fakeAdapter({ rows: [row({ chatId: otherChatId })] }),
    isBusy: () => true,
  });

  const result = await engine.openChat({ chatId: otherChatId });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'busy_tab');
});
