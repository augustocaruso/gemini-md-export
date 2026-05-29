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

test('private_read action falls back to gemini_webapi Python when no browser tab is usable', async () => {
  const calls = [];
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: () => {
      throw new Error('should not require a managed tab');
    },
    enqueueCommand: async () => {
      throw new Error('should not enqueue browser command');
    },
    summarizeClient: () => null,
    runGeminiWebapiPythonReadChat: async (input) => {
      calls.push(input);
      return {
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
      };
    },
  });

  const result = await action({
    action: 'private_read',
    chatId: 'dbe5dd4b50b09c74',
    downloadAssets: true,
    assetsRelDir: 'assets/dbe5dd4b50b09c74',
  });

  assert.equal(calls[0].downloadAssets, true);
  assert.equal(calls[0].assetsRelDir, 'assets/dbe5dd4b50b09c74');
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'privateApiGeminiWebapi');
  assert.equal(result.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.match(result.markdown, /^---\ntype: gemini_chat/m);
  assert.match(result.markdown, /## 🤖 Gemini\n\nResposta privada/);
  assert.equal(result.assetPlan.requests.length, 1);
  assert.equal(result.assetPlan.requests[0].url, 'https://lh3.googleusercontent.com/generated-image');
  assert.deepEqual(result.assetReceipts, []);
  assert.deepEqual(result.fallbackWarnings, [
    {
      adapter: 'browserBackground',
      code: 'browserBackground_failed',
      message: 'should not require a managed tab',
    },
  ]);
});

test('private_read action prefers browser-background when a logged tab is ready', async () => {
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
    runGeminiWebapiPythonReadChat: async () => {
      throw new Error('should not call Python when browser succeeds');
    },
  });

  const result = await action({ chatId: 'dbe5dd4b50b09c74', waitMs: 2000 });

  assert.equal(result.ok, true);
  assert.equal(result.via, 'browser');
  assert.equal(result.adapter, 'browserBackground');
  assert.equal(result.client.clientId, 'client-1');
  assert.equal(result.adapterPlan.selectedAdapter, 'browserBackground');
  assert.deepEqual(result.fallbackWarnings, []);
  assert.deepEqual(calls[0], [
    'requireManagedChatClient',
    { chatId: 'dbe5dd4b50b09c74', waitMs: 2000 },
    'private-api-read-chat',
  ]);
  assert.equal(calls[1][0], 'enqueueCommand');
  assert.equal(calls[1][1], 'client-1');
  assert.equal(calls[1][2], 'private-api-read-chat');
});

test('private_read action falls through to sidecar when browser read exposes assets without downloads', async () => {
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: () => client,
    enqueueCommand: async () => ({
      ok: true,
      snapshot: {
        chatId: 'dbe5dd4b50b09c74',
        title: 'Browser asset chat',
        url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
        turns: [
          {
            role: 'assistant',
            markdown: 'Resposta com asset',
            textHash: 'hash-a',
            sourceOrder: 0,
            attachments: [
              {
                kind: 'image',
                label: 'Imagem',
                url: 'https://lh3.googleusercontent.com/generated-image',
              },
            ],
          },
        ],
        metadata: { assistantTurnCount: 1 },
        evidence: [],
      },
    }),
    summarizeClient: (value) => ({ clientId: value.clientId }),
    runGeminiWebapiPythonReadChat: async () => ({
      ok: true,
      snapshot: {
        chatId: 'dbe5dd4b50b09c74',
        title: 'Sidecar asset chat',
        url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
        turns: [
          {
            role: 'assistant',
            markdown: 'Resposta com asset',
            textHash: 'hash-a',
            sourceOrder: 0,
            attachments: [],
          },
        ],
        metadata: { assistantTurnCount: 1 },
        evidence: [],
      },
      adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
      transport: { source: 'gemini_webapi_python', privateChatId: 'c_dbe5dd4b50b09c74' },
      mediaFiles: [{ filename: 'assets/dbe5dd4b50b09c74/image.png', contentBase64: 'AQ==' }],
      mediaFailures: [],
      assetReceipts: [],
      warnings: [],
    }),
  });

  const result = await action({
    chatId: 'dbe5dd4b50b09c74',
    downloadAssets: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'privateApiGeminiWebapi');
  assert.equal(result.mediaFiles.length, 1);
  assert.deepEqual(
    result.fallbackWarnings.map((warning) => [warning.adapter, warning.code]),
    [['browserBackground', 'browser_background_assets_unavailable']],
  );
});

test('private_read action falls back from private API transports to DOM export only when explicit', async () => {
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
    allowDomFallback: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'dom');
  assert.equal(result.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.deepEqual(
    result.fallbackWarnings.map((warning) => [warning.adapter, warning.code]),
    [
      ['browserBackground', 'private_api_wire_format_changed'],
      ['privateApiGeminiWebapi', 'gemini_webapi_python_failed'],
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'enqueueCommand').map((call) => call[2]),
    ['private-api-read-chat', 'get-chat-by-id'],
  );
});

test('private_read action can disable DOM fallback for export pipeline', async () => {
  const calls = [];
  const action = createMcpPrivateReadAction({
    requireManagedChatClient: (...args) => {
      calls.push(['requireManagedChatClient', ...args]);
      return client;
    },
    enqueueCommand: async (...args) => {
      calls.push(['enqueueCommand', ...args]);
      return {
        ok: false,
        code: 'private_api_wire_format_changed',
        message: 'wire drift',
      };
    },
    summarizeClient: (value) => ({ clientId: value.clientId }),
    runGeminiWebapiPythonReadChat: async () => ({
      ok: false,
      code: 'gemini_webapi_python_failed',
      message: 'cookie import failed',
    }),
  });

  const result = await action({
    chatId: 'dbe5dd4b50b09c74',
    waitMs: 2000,
    allowDomFallback: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.adapterAttempts.some((attempt) => attempt.adapter === 'dom'), false);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'enqueueCommand').map((call) => call[2]),
    ['private-api-read-chat'],
  );
});
