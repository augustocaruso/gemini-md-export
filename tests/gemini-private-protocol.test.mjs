import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  GEMINI_PRIVATE_RPC,
  buildGeminiPrivateBatchRequest,
  buildGeminiPrivateListChatsPayload,
  buildGeminiPrivateReadChatPayload,
  decodeGeminiBatchExecuteResponse,
  decodeGeminiBatchExecuteResponseWithDiagnostics,
  extractGeminiBatchRpcPayload,
  extractGeminiPrivateListChatIds,
  normalizeGeminiPrivateReadChatSnapshot,
  toGeminiPrivateChatId,
} from '../build/ts/core/gemini-private-protocol.js';
import { assetRefsFromChatSnapshot, buildAssetFetchPlan } from '../build/ts/core/assets.js';
import { createTurndownMarkdownRenderer } from '../build/ts/core/markdown-renderer/turndown-renderer.js';

const chatId = 'dbe5dd4b50b09c74';
const privateChatId = `c_${chatId}`;
const fixtureDir = resolve(import.meta.dirname, 'fixtures', 'gemini-private-api');

const batchResponseFor = (rpcId, payload) => {
  const frame = [
    [
      'wrb.fr',
      rpcId,
      JSON.stringify(payload),
      null,
      null,
      [200],
      'generic',
    ],
  ];
  return `)]}'\n\n${JSON.stringify(frame).length}\n${JSON.stringify(frame)}\n`;
};

test('private protocol builds READ_CHAT batchexecute request without cookies or fetch', () => {
  const request = buildGeminiPrivateBatchRequest({
    rpcId: GEMINI_PRIVATE_RPC.READ_CHAT,
    payload: buildGeminiPrivateReadChatPayload(chatId),
    session: {
      at: 'at-token',
      bl: 'boq-build',
      fSid: 'session-id',
      hl: 'pt-BR',
    },
    requestId: 42,
    sourcePath: '/app',
  });

  const url = new URL(request.url);
  const form = new URLSearchParams(request.body);
  const fReq = JSON.parse(String(form.get('f.req')));
  const call = fReq[0][0];

  assert.equal(request.method, 'POST');
  assert.equal(url.origin, 'https://gemini.google.com');
  assert.equal(url.pathname, '/_/BardChatUi/data/batchexecute');
  assert.equal(url.searchParams.get('rpcids'), GEMINI_PRIVATE_RPC.READ_CHAT);
  assert.equal(url.searchParams.get('source-path'), '/app');
  assert.equal(url.searchParams.get('bl'), 'boq-build');
  assert.equal(url.searchParams.get('f.sid'), 'session-id');
  assert.equal(form.get('at'), 'at-token');
  assert.equal(call[0], GEMINI_PRIVATE_RPC.READ_CHAT);
  assert.deepEqual(JSON.parse(call[1]), [privateChatId, 10, null, 1, [1], [4], null, 1]);
  assert.equal(request.headers['X-Same-Domain'], '1');
  assert.equal('cookie' in request.headers, false);
});

test('private protocol decodes READ_CHAT batch frame into a ChatSnapshot', () => {
  const artifactCandidate = [];
  artifactCandidate[1] = ['Second answer with an artifact'];
  artifactCandidate[12] = ['artifact', 'artifact_id'];
  const responseBody = [
    [
      [
        null,
        null,
        [['First prompt']],
        [[null, ['First answer']]],
      ],
      [
        null,
        null,
        [['Second prompt']],
        [artifactCandidate],
      ],
    ],
  ];
  const raw = batchResponseFor(GEMINI_PRIVATE_RPC.READ_CHAT, responseBody);

  const frames = decodeGeminiBatchExecuteResponse(raw);
  const payload = extractGeminiBatchRpcPayload(frames, GEMINI_PRIVATE_RPC.READ_CHAT);
  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: chatId,
    payload,
    title: 'Private API proof',
  });

  assert.equal(snapshot.chatId, chatId);
  assert.equal(snapshot.url, `https://gemini.google.com/app/${chatId}`);
  assert.equal(snapshot.title, 'Private API proof');
  assert.equal(snapshot.metadata.assistantTurnCount, 2);
  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.role, turn.markdown]),
    [
      ['user', 'First prompt'],
      ['assistant', 'First answer'],
      ['user', 'Second prompt'],
      ['assistant', 'Second answer with an artifact'],
    ],
  );
  assert.equal(snapshot.turns[3].attachments.length, 1);
  assert.equal(snapshot.turns[3].attachments[0].kind, 'artifact');
  assert.equal(snapshot.evidence[0].source, 'gemini-private-api');
  assert.equal(snapshot.evidence[0].confidence, 'strong');
});

test('private protocol reads assistant candidates nested in the current READ_CHAT shape', () => {
  const responseBody = [
    [
      [
        ['conversation', 'reply-1'],
        null,
        [['Prompt from current wire shape']],
        [
          [
            [
              'candidate-1',
              ['Answer from current wire shape'],
              null,
              null,
              null,
              null,
              null,
              null,
              [2],
            ],
          ],
        ],
      ],
    ],
  ];

  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: privateChatId,
    payload: responseBody,
    title: 'Current shape',
  });

  assert.equal(snapshot.metadata.assistantTurnCount, 1);
  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.role, turn.markdown]),
    [
      ['user', 'Prompt from current wire shape'],
      ['assistant', 'Answer from current wire shape'],
    ],
  );
  assert.equal(snapshot.evidence[0].confidence, 'strong');
});

test('private protocol preserves READ_CHAT turn timestamps in the shared snapshot', () => {
  const responseBody = [
    [
      [
        ['conversation', 'reply-1'],
        null,
        [['First prompt']],
        [[['candidate-1', ['First answer']]]],
        [1_779_225_124],
      ],
      [
        ['conversation', 'reply-2'],
        null,
        [['Second prompt']],
        [[['candidate-2', ['Second answer']]]],
        [1_779_225_256_000],
      ],
    ],
  ];

  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: privateChatId,
    payload: responseBody,
    title: 'Dated private API chat',
  });

  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.role, turn.createdAt]),
    [
      ['user', '2026-05-19T21:12:04Z'],
      ['assistant', '2026-05-19T21:12:04Z'],
      ['user', '2026-05-19T21:14:16Z'],
      ['assistant', '2026-05-19T21:14:16Z'],
    ],
  );
  assert.equal(snapshot.metadata.dateCreated, '2026-05-19T21:12:04Z');
  assert.equal(snapshot.metadata.dateLastMessage, '2026-05-19T21:14:16Z');
});

test('private protocol extracts user image attachments from READ_CHAT asset text blocks', () => {
  const imageUrl =
    'https://lh3.googleusercontent.com/gg/AEir0wLQOPbc_yGvp12iftQL84kO1cTnEpEqvtn1CDKka56Yz';
  const responseBody = [
    [
      [
        null,
        null,
        [
          [
            [
              'Me mostre supra de st com infra de pr',
              'Screenshot_20260424_153354_com.android.chrome.jpg',
              imageUrl,
              '$AQbORABynmwCyobLCy1IE1nJsFSvEa6thJvoRwJcUPOcfOikGQ7Acci',
              'image/jpeg',
            ],
          ],
        ],
        [[null, ['Resposta com analise do ECG']]],
      ],
    ],
  ];

  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: privateChatId,
    payload: responseBody,
    title: 'ECG com imagem',
  });

  assert.equal(snapshot.turns[0].markdown, 'Me mostre supra de st com infra de pr');
  assert.equal(snapshot.turns[0].attachments.length, 1);
  assert.deepEqual(snapshot.turns[0].attachments[0], {
    kind: 'image',
    label: 'Screenshot_20260424_153354_com.android.chrome.jpg',
    url: imageUrl,
  });
  const plan = buildAssetFetchPlan(assetRefsFromChatSnapshot(snapshot));
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].url, imageUrl);
});

test('private protocol reports parse diagnostics separately from RPC emptiness', () => {
  const validFrame = [
    ['wrb.fr', GEMINI_PRIVATE_RPC.READ_CHAT, JSON.stringify([[[]]]), null, null, [200], 'generic'],
  ];
  const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(
    `)]}'\n\n${JSON.stringify(validFrame).length}\n{broken-json\n${JSON.stringify(validFrame)}\n`,
  );

  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.parseableFrameCount, 1);
  assert.equal(decoded.malformedLineCount, 1);
  assert.deepEqual(decoded.warnings, ['malformed_json_frame']);
});

test('private protocol extracts LIST_CHATS ids and normalizes c-prefixed ids', () => {
  const listPayload = buildGeminiPrivateListChatsPayload({ limit: 3 });
  const raw = batchResponseFor(GEMINI_PRIVATE_RPC.LIST_CHATS, [
    ['ignored'],
    [privateChatId, 'Python Libraries in iOS Apps'],
    ['c_88a98a108cdcfb61'],
    ['not-a-chat-id'],
  ]);
  const payload = extractGeminiBatchRpcPayload(
    decodeGeminiBatchExecuteResponse(raw),
    GEMINI_PRIVATE_RPC.LIST_CHATS,
  );

  assert.deepEqual(listPayload, [3, null, [0, null, 1]]);
  assert.equal(toGeminiPrivateChatId(chatId), privateChatId);
  assert.equal(toGeminiPrivateChatId(privateChatId), privateChatId);
  assert.deepEqual(extractGeminiPrivateListChatIds(payload), [
    { privateChatId, chatId },
    { privateChatId: 'c_88a98a108cdcfb61', chatId: '88a98a108cdcfb61' },
  ]);
});

test('private protocol preserves ordered multi-chunk text from READ_CHAT fixtures', () => {
  const responseBody = JSON.parse(
    readFileSync(resolve(fixtureDir, 'read-chat-multichunk.json'), 'utf-8'),
  );
  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: privateChatId,
    payload: responseBody,
  });

  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.role, turn.markdown]),
    [
      ['user', 'Prompt line one\n\nPrompt line two'],
      ['assistant', 'Answer paragraph one\n\nAnswer paragraph two'],
    ],
  );
});

test('private protocol can use a pluggable Markdown renderer for HTML chunks', () => {
  const responseBody = [
    [
      [
        null,
        null,
        [['<p>Prompt com <strong>HTML</strong></p>']],
        [[null, ['<h2>Resposta</h2><p>Com <a href="https://example.com">link</a></p>']]],
      ],
    ],
  ];
  const snapshot = normalizeGeminiPrivateReadChatSnapshot({
    requestedChatId: privateChatId,
    payload: responseBody,
    markdownRenderer: createTurndownMarkdownRenderer(),
  });

  assert.equal(snapshot.turns[0].markdown, 'Prompt com **HTML**');
  assert.match(snapshot.turns[1].markdown, /^## Resposta/m);
  assert.match(snapshot.turns[1].markdown, /\[link\]\(https:\/\/example\.com\)/);
});
