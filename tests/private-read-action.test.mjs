import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpPrivateReadAction } from '../build/ts/mcp/private-read-action.js';

const client = {
  clientId: 'client-1',
  page: { chatId: 'dbe5dd4b50b09c74', title: 'Current chat' },
};

const domPayload = {
  chatId: 'dbe5dd4b50b09c74',
  title: 'Current chat',
  url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
  content: `---
type: gemini_chat
chat_id: dbe5dd4b50b09c74
title: "Current chat"
url: https://gemini.google.com/app/dbe5dd4b50b09c74
turn_count: 1
exported_at: 2026-05-28T12:00:00Z
source: gemini-web
tags: [gemini-export]
---

## 🧑 Usuário

Prompt DOM

---

## 🤖 Gemini

Resposta DOM
`,
};

test('private_read action prefers gemini_webapi Python and does not require a managed tab on success', async () => {
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: () => {
      throw new Error('should not require a managed tab');
    },
    enqueueCommand: async () => {
      throw new Error('should not enqueue browser command');
    },
    summarizeClient: () => null,
    runGeminiWebapiPythonReadChat: async () => ({
      ok: true,
      snapshot: {
        chatId: 'dbe5dd4b50b09c74',
        title: 'Private path',
        url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
        turns: [
          {
            role: 'assistant',
            markdown: 'Resposta privada',
            textHash: 'hash-a',
            sourceOrder: 0,
            attachments: [
              {
                kind: 'image',
                label: 'Imagem gerada',
                url: 'https://lh3.googleusercontent.com/generated-image',
              },
            ],
          },
        ],
        metadata: { assistantTurnCount: 1 },
        evidence: [
          {
            source: 'gemini-private-api',
            kind: 'fixture',
            confidence: 'strong',
            warnings: [],
          },
        ],
      },
      adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
      transport: { source: 'gemini_webapi_python', privateChatId: 'c_dbe5dd4b50b09c74' },
      warnings: [],
    }),
  });

  const result = await action({
    action: 'private_read',
    chatId: 'dbe5dd4b50b09c74',
  });

  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'privateApiGeminiWebapi');
  assert.equal(result.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.match(result.markdown, /^---\ntype: gemini_chat/m);
  assert.match(result.markdown, /## 🤖 Gemini\n\nResposta privada/);
  assert.equal(result.assetPlan.requests.length, 1);
  assert.equal(result.assetPlan.requests[0].url, 'https://lh3.googleusercontent.com/generated-image');
  assert.deepEqual(result.assetReceipts, []);
  assert.deepEqual(result.fallbackWarnings, []);
});

test('private_read action falls back from gemini_webapi Python to browser-background', async () => {
  const calls = [];
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: (...args) => {
      calls.push(['requireManagedChatClient', ...args]);
      return client;
    },
    enqueueCommand: async (...args) => {
      calls.push(['enqueueCommand', ...args]);
      return { ok: true, via: 'browser' };
    },
    summarizeClient: (value) => ({ clientId: value.clientId }),
    runGeminiWebapiPythonReadChat: async () => ({
      ok: false,
      code: 'gemini_webapi_python_spawn_failed',
      message: 'uv indisponivel',
      chatId: 'dbe5dd4b50b09c74',
      adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
    }),
  });

  const result = await action({ chatId: 'dbe5dd4b50b09c74', waitMs: 2000 });

  assert.equal(result.ok, true);
  assert.equal(result.via, 'browser');
  assert.equal(result.adapter, 'browserBackground');
  assert.equal(result.client.clientId, 'client-1');
  assert.equal(result.adapterPlan.selectedAdapter, 'privateApiGeminiWebapi');
  assert.deepEqual(result.fallbackWarnings, [
    {
      adapter: 'privateApiGeminiWebapi',
      code: 'gemini_webapi_python_spawn_failed',
      message: 'uv indisponivel',
    },
  ]);
  assert.deepEqual(calls[0], [
    'requireManagedChatClient',
    { chatId: 'dbe5dd4b50b09c74', waitMs: 2000 },
    'private-api-read-chat',
  ]);
  assert.equal(calls[1][0], 'enqueueCommand');
  assert.equal(calls[1][1], 'client-1');
  assert.equal(calls[1][2], 'private-api-read-chat');
});

test('private_read action falls back from private API transports to DOM export', async () => {
  const calls = [];
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: (...args) => {
      calls.push(['requireManagedChatClient', ...args]);
      return client;
    },
    enqueueCommand: async (...args) => {
      calls.push(['enqueueCommand', ...args]);
      if (args[1] === 'private-api-read-chat') {
        return {
          ok: false,
          code: 'private_api_wire_format_changed',
          message: 'wire drift',
          chatId: 'dbe5dd4b50b09c74',
        };
      }
      return { ok: true, payload: domPayload };
    },
    summarizeClient: (value) => ({ clientId: value.clientId }),
    runGeminiWebapiPythonReadChat: async () => ({
      ok: false,
      code: 'gemini_webapi_python_failed',
      message: 'cookie import failed',
      chatId: 'dbe5dd4b50b09c74',
      adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
    }),
  });

  const result = await action({
    chatId: 'dbe5dd4b50b09c74',
    waitMs: 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'dom');
  assert.equal(result.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.deepEqual(
    result.fallbackWarnings.map((warning) => [warning.adapter, warning.code]),
    [
      ['privateApiGeminiWebapi', 'gemini_webapi_python_failed'],
      ['browserBackground', 'private_api_wire_format_changed'],
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'enqueueCommand').map((call) => call[2]),
    ['private-api-read-chat', 'get-chat-by-id'],
  );
});
