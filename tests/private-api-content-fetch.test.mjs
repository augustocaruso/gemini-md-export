import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGeminiPrivateSessionFromContent,
  readGeminiPrivateChatFromContent,
} from '../build/ts/browser/shared/private-api-content-fetch.js';
import { GEMINI_PRIVATE_RPC } from '../build/ts/core/gemini-private-protocol.js';

const chatId = 'dbe5dd4b50b09c74';

const batchResponseFor = (rpcId, payload) => {
  const frame = [['wrb.fr', rpcId, JSON.stringify(payload), null, null, [200], 'generic']];
  return `)]}'\n\n${JSON.stringify(frame).length}\n${JSON.stringify(frame)}\n`;
};

test('content private API fallback validates session with page credentials', async () => {
  const calls = [];
  const result = await checkGeminiPrivateSessionFromContent({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          '{"SNlM0e":"at-token","cfb2h":"build-label","FdrFJe":"sid","TuX5cc":"pt-BR"}',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.transport.source, 'content-fetch');
  assert.equal(calls[0].url, 'https://gemini.google.com/app');
  assert.equal(calls[0].init.credentials, 'include');
});

test('content private API fallback reads chat without background service worker', async () => {
  const calls = [];
  const result = await readGeminiPrivateChatFromContent({
    chatId,
    title: 'Direct content path',
    requestId: 77,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '{"SNlM0e":"at-token","cfb2h":"build-label","FdrFJe":"sid","TuX5cc":"pt-BR"}',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          batchResponseFor(GEMINI_PRIVATE_RPC.READ_CHAT, [
            [
              [null, null, [['Prompt from content']], [[null, ['Answer from content']]]],
            ],
          ]),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.chatId, chatId);
  assert.equal(result.snapshot.turns[0].markdown, 'Prompt from content');
  assert.equal(result.snapshot.turns[1].markdown, 'Answer from content');
  assert.match(result.markdown, /^---\ntype: gemini_chat/m);
  assert.match(result.markdown, /## 🤖 Gemini\n\nAnswer from content/);
  assert.equal(result.transport.source, 'content-fetch');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.method, 'POST');
});

test('content private API fallback times out a hanging app fetch', { timeout: 250 }, async () => {
  let receivedSignal = false;
  const result = await checkGeminiPrivateSessionFromContent({
    timeoutMs: 20,
    fetchImpl: async (_url, init = {}) => {
      receivedSignal = !!init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('fetch aborted'), { name: 'AbortError' }));
        });
      });
    },
  });

  assert.equal(receivedSignal, true);
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.code, 'private_api_request_failed');
  assert.match(result.message, /tempo|timeout|aborted/i);
});
