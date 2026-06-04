import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGeminiPrivateSession,
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
  assert.deepEqual(result.adapterPlan.fallbackAdapters, []);
  assert.equal(calls[0].url, 'https://gemini.google.com/app');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.method, 'POST');
  assert.match(String(calls[1].url), /batchexecute/);
  assert.equal(JSON.stringify(result).includes('at-token'), false);
  assert.equal(JSON.stringify(result).includes('build-label'), false);
  assert.equal(JSON.stringify(result).includes('sid'), false);
});

test('private API background adapter downloads asset files through browser credentials', async () => {
  const imageUrl =
    'https://lh3.googleusercontent.com/gg/AEir0wLQOPbc_yGvp12iftQL84kO1cTnEpEqvtn1CDKka56Yz';
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
    if (String(url) === imageUrl) {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        text: async () => '',
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
              [
                [
                  [
                    'Prompt com imagem',
                    'Screenshot_20260424_153354_com.android.chrome.jpg',
                    imageUrl,
                    '$AQbORABynmwCyobLCy1IE1nJsFSvEa6thJvoRwJcUPOcfOikGQ7Acci',
                    'image/jpeg',
                  ],
                ],
              ],
              [[null, ['Answer from API']]],
            ],
          ],
        ]),
    };
  };

  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl,
    requestId: 77,
    downloadAssets: true,
    assetsRelDir: `assets/${chatId}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.turns[0].attachments.length, 1);
  assert.equal(result.mediaFiles.length, 1);
  assert.equal(
    result.mediaFiles[0].filename,
    `assets/${chatId}/Screenshot_20260424_153354_com.android.chrome.jpg`,
  );
  assert.equal(result.mediaFiles[0].contentBase64, 'AQIDBA==');
  assert.equal(result.mediaFiles[0].contentType, 'image/jpeg');
  assert.deepEqual(result.mediaFailures, []);
  assert.equal(calls[2].url, imageUrl);
  assert.equal(calls[2].init.credentials, 'include');
});

test('private API background adapter gives duplicate asset labels unique filenames', async () => {
  const imageUrlA = 'https://lh3.googleusercontent.com/gg/asset-a';
  const imageUrlB = 'https://lh3.googleusercontent.com/gg/asset-b';
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
    if (String(url) === imageUrlA || String(url) === imageUrlB) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Uint8Array.from(String(url).endsWith('asset-a') ? [1] : [2]).buffer,
        text: async () => '',
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
              [
                [
                  ['Prompt com imagens', 'image.png', imageUrlA, '$asset-a', 'image/png'],
                  ['Mais imagens', 'image.png', imageUrlB, '$asset-b', 'image/png'],
                ],
              ],
              [[null, ['Answer from API']]],
            ],
          ],
        ]),
    };
  };

  const result = await readGeminiPrivateChat({
    chatId,
    fetchImpl,
    requestId: 77,
    downloadAssets: true,
    assetsRelDir: `assets/${chatId}`,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.mediaFiles.map((file) => file.filename),
    [`assets/${chatId}/image.png`, `assets/${chatId}/image-02.png`],
  );
  assert.deepEqual(
    result.mediaFiles.map((file) => file.contentBase64),
    ['AQ==', 'Ag=='],
  );
  assert.deepEqual(result.mediaFailures, []);
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

test('private API background session status aborts a slow app fetch', { timeout: 250 }, async () => {
  let receivedSignal = false;
  const result = await checkGeminiPrivateSession({
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

test('private API background session status times out a slow app body read', { timeout: 250 }, async () => {
  const result = await checkGeminiPrivateSession({
    timeoutMs: 20,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => new Promise(() => {}),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.code, 'private_api_request_failed');
  assert.match(result.message, /tempo|timeout/i);
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
