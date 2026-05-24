import test from 'node:test';
import assert from 'node:assert/strict';

import { createSharedTabCommandHandlers } from '../build/ts/browser/shared/tab-commands.js';

test('shared tab commands claim e release atualizam estado local', async () => {
  const messages = [];
  const state = { tabId: 7, windowId: 3, tabClaim: null };
  const handlers = createSharedTabCommandHandlers({
    state,
    defaultReason: 'test-command',
    defaultClaimLabel: 'Conferindo',
    defaultClaimColor: 'blue',
    extensionSendMessage: async (message) => {
      messages.push(message);
      if (message.type === 'gemini-md-export/claim-tab') {
        return { ok: true, tabId: 7, windowId: 3, visual: { tabId: 7 } };
      }
      if (message.type === 'gemini-md-export/release-tab-claim') return { ok: true };
      return { ok: false };
    },
  });

  const claim = await handlers.execute({
    type: 'claim-tab',
    args: { claimId: 'claim-1', label: 'Aba em uso', explicit: true },
  });
  assert.equal(claim.ok, true);
  assert.equal(state.tabClaim.claimId, 'claim-1');
  assert.equal(messages[0].type, 'gemini-md-export/claim-tab');

  const release = await handlers.execute({
    type: 'release-tab-claim-by-tab-id',
    args: { tabId: 7, claimId: 'claim-1', explicit: true },
  });
  assert.equal(release.ok, true);
  assert.equal(state.tabClaim, null);
  assert.equal(messages[1].reason, 'test-command-tab-id-release');
});

test('shared tab commands activate atualiza isActiveTab so para a aba local', async () => {
  const state = { tabId: 7, isActiveTab: false };
  const handlers = createSharedTabCommandHandlers({
    state,
    defaultReason: 'test-command',
    defaultClaimLabel: 'Conferindo',
    defaultClaimColor: 'green',
    extensionSendMessage: async () => ({ ok: true, isActiveTab: true }),
  });

  await handlers.execute({ type: 'activate-browser-tab', args: { tabId: 8, explicit: true } });
  assert.equal(state.isActiveTab, false);

  await handlers.execute({ type: 'activate-browser-tab', args: { tabId: 7, explicit: true } });
  assert.equal(state.isActiveTab, true);
});

test('shared tab commands recusam efeito de navegador sem intencao explicita', async () => {
  const messages = [];
  const handlers = createSharedTabCommandHandlers({
    defaultReason: 'test-command',
    defaultClaimLabel: 'Conferindo',
    defaultClaimColor: 'green',
    extensionSendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });

  const result = await handlers.execute({ type: 'activate-browser-tab', args: { tabId: 7 } });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'explicit_browser_intent_required');
  assert.equal(messages.length, 0);
});
