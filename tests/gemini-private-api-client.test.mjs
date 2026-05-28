import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractGeminiPrivateSessionFields,
  readGeminiPrivateChat,
} from '../build/ts/browser/background/gemini-private-api-client.js';
import { GEMINI_PRIVATE_RPC } from '../build/ts/core/gemini-private-protocol.js';

const chatId = 'dbe5dd4b50b09c74';

const batchResponseFor = (rpcId, payload) => {
  const frame = [['wrb.fr', rpcId, JSON.stringify(payload), null, null, [200], 'generic']];
  return `)]}'\n\n${JSON.stringify(frame).length}\n${JSON.stringify(frame)}\n`;
};

test('private API background adapter extracts Gemini session fields from app HTML', () => {
  const session = extractGeminiPrivateSessionFields(`
    <script nonce="abc">
      window.WIZ_global_data = {"SNlM0e":"at-token","cfb2h":"build-label","FdrFJe":"sid","TuX5cc":"pt-BR"};
    </script>
  `);

  assert.deepEqual(session, {
    at: 'at-token',
    bl: 'build-label',
    fSid: 'sid',
    hl: 'pt-BR',
  });
});

test('private API background adapter reads a chat with browser credentials and redacts secrets', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
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
            [null, null, [['Prompt from API']], [[null, ['Answer from API']]]],
          ],
        ]),
    };
  };

  const result = await readGeminiPrivateChat({
    chatId,
    title: 'Private path',
    fetchImpl,
    requestId: 77,
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.chatId, chatId);
  assert.equal(result.snapshot.turns[0].markdown, 'Prompt from API');
  assert.equal(result.snapshot.turns[1].markdown, 'Answer from API');
  assert.match(result.markdown, /^---\ntype: gemini_chat/m);
  assert.match(result.markdown, /## 🤖 Gemini\n\nAnswer from API/);
  assert.equal(result.adapterPlan.selectedAdapter, 'browserBackground');
  assert.deepEqual(result.adapterPlan.fallbackAdapters, ['dom']);
  assert.equal(calls[0].url, `https://gemini.google.com/app/${chatId}`);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.method, 'POST');
  assert.match(String(calls[1].url), /batchexecute/);
  assert.equal(JSON.stringify(result).includes('at-token'), false);
  assert.equal(JSON.stringify(result).includes('build-label'), false);
  assert.equal(JSON.stringify(result).includes('sid'), false);
});

test('private API background adapter returns typed auth failure when token is missing', async () => {
  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<html></html>',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'private_api_token_missing');
  assert.equal(result.chatId, chatId);
  assert.equal(result.adapterPlan.selectedAdapter, 'browserBackground');
});

test('private API background adapter treats unparseable batch response as wire-format drift', async () => {
  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl: async (_url, init = {}) => {
      if (!init.method) {
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
        text: async () => `)]}'\n\nnot-json\nstill-not-json\n`,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'private_api_wire_format_changed');
  assert.equal(result.chatId, chatId);
  assert.equal(result.diagnostics.parseableFrameCount, 0);
  assert.equal(result.diagnostics.malformedLineCount, 0);
});

test('private API background adapter keeps parseable empty RPC distinct from wire drift', async () => {
  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl: async (_url, init = {}) => {
      if (!init.method) {
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
        text: async () => `)]}'\n\n${JSON.stringify([['noop']])}\n`,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'private_api_rpc_empty');
  assert.equal(result.diagnostics.parseableFrameCount, 1);
});

test('private API background adapter maps Google verification HTML to blocker failure', async () => {
  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl: async (_url, init = {}) => {
      if (!init.method) {
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
        text: async () => '<html><title>Sorry...</title><form action="CaptchaRedirect"></form>',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'google_verification_required');
});

test('private API background adapter renders HTML chunks through Turndown', async () => {
  const result = await readGeminiPrivateChat({
    chatId,
    title: 'Private HTML',
    requestId: 99,
    fetchImpl: async (_url, init = {}) => {
      if (!init.method) {
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
              [
                null,
                null,
                [['<p>Prompt <strong>HTML</strong></p>']],
                [[null, ['<h2>Resposta</h2><p>Com <em>enfase</em></p>']]],
              ],
            ],
          ]),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.turns[0].markdown, 'Prompt **HTML**');
  assert.match(result.snapshot.turns[1].markdown, /^## Resposta/m);
  assert.match(result.snapshot.turns[1].markdown, /Com _enfase_/);
});
