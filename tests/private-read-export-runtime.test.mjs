import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPrivateReadExportArgs,
  privateReadExportResultToCollectedPayload,
  shouldAttemptPrivateReadExport,
} from '../build/ts/mcp/private-read-export-runtime.js';

const conversation = {
  chatId: 'dbe5dd4b50b09c74',
  title: 'Private export',
  url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
};

const snapshot = {
  chatId: 'dbe5dd4b50b09c74',
  title: 'Private export',
  url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
  turns: [
    {
      role: 'user',
      markdown: 'Prompt',
      textHash: 'hash-user',
      sourceOrder: 0,
      createdAt: '2026-05-19T21:12:04Z',
      attachments: [],
    },
    {
      role: 'assistant',
      markdown: 'Resposta privada',
      textHash: 'hash-assistant',
      sourceOrder: 1,
      createdAt: '2026-05-19T21:14:16Z',
      attachments: [
        {
          kind: 'image',
          label: 'Imagem',
          url: 'https://lh3.googleusercontent.com/image',
        },
      ],
    },
  ],
  metadata: {
    assistantTurnCount: 1,
    dateCreated: '2026-05-19T21:12:04Z',
    dateLastMessage: '2026-05-19T21:14:16Z',
  },
  evidence: [{ source: 'gemini-private-api', kind: 'fixture', confidence: 'strong', warnings: [] }],
};

test('private export is enabled by default only for conversations with a proven chatId', () => {
  assert.equal(shouldAttemptPrivateReadExport(conversation), true);
  assert.equal(shouldAttemptPrivateReadExport({ title: 'Sem id' }), false);
  assert.equal(shouldAttemptPrivateReadExport(conversation, { privateReadExport: false }), false);
  assert.equal(
    shouldAttemptPrivateReadExport(conversation, {}, { GEMINI_MCP_PRIVATE_READ_EXPORT: '0' }),
    false,
  );
});

test('private export args pin private adapters and disable the inner DOM fallback', () => {
  const args = buildPrivateReadExportArgs(conversation, {
    clientId: 'client-1',
    tabId: 42,
    claimId: 'claim-1',
    waitMs: 1234,
    privateApiTransport: 'browser-background',
  });

  assert.deepEqual(args, {
    action: 'private_read',
    chatId: 'dbe5dd4b50b09c74',
    url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
    title: 'Private export',
    clientId: 'client-1',
    tabId: 42,
    claimId: 'claim-1',
    waitMs: 1234,
    privateApiTransport: 'browser-background',
    allowDomFallback: false,
    downloadAssets: true,
    assetsRelDir: 'assets/dbe5dd4b50b09c74',
  });
});

test('private read success becomes the collected export payload shape', () => {
  const collected = privateReadExportResultToCollectedPayload({
    activeClient: { clientId: 'client-1' },
    conversation,
    privateReadStartedAt: 1_000,
    privateReadFinishedAt: 1_125,
    result: {
      ok: true,
      adapter: 'privateApiGeminiWebapi',
      snapshot,
      markdown: null,
      fallbackWarnings: [
        {
          adapter: 'browserBackground',
          code: 'not_used',
          message: 'fixture warning',
        },
      ],
      adapterAttempts: [
        {
          adapter: 'privateApiGeminiWebapi',
          status: 'succeeded',
          code: 'ok',
          message: 'adapter succeeded',
        },
      ],
      transport: { source: 'gemini_webapi_python' },
      assetReceipts: [
        {
          ok: true,
          refId: 'turn-0001-asset-00',
          status: 'downloaded',
          filePath: 'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png',
          contentHash: 'sha256-fixture',
        },
      ],
      mediaFiles: [
        {
          filename: 'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png',
          contentBase64: 'AQIDBA==',
          contentType: 'image/png',
          bytes: 4,
        },
      ],
      mediaFailures: [
        {
          assetId: 'turn-0001-asset-01',
          error: 'fixture failure',
        },
      ],
    },
  });

  assert.equal(collected.activeClient.clientId, 'client-1');
  assert.equal(collected.expectedChatId, 'dbe5dd4b50b09c74');
  assert.equal(collected.browserCommandMs, 125);
  assert.equal(collected.result.ok, true);
  assert.equal(collected.result.conversation, conversation);
  assert.equal(collected.result.privateRead.adapter, 'privateApiGeminiWebapi');
  assert.equal(collected.result.payload.chatId, 'dbe5dd4b50b09c74');
  assert.equal(collected.result.payload.filename, 'dbe5dd4b50b09c74.md');
  assert.match(collected.result.payload.content, /date_created: 2026-05-19T21:12:04Z/);
  assert.match(collected.result.payload.content, /date_last_message: 2026-05-19T21:14:16Z/);
  assert.match(collected.result.payload.content, /## 🤖 Gemini\n\nResposta privada/);
  assert.equal(collected.result.payload.metrics.timings.privateReadMs, 125);
  assert.equal(collected.result.payload.metrics.counters.turnCount, 1);
  assert.equal(collected.result.payload.metrics.counters.assetRefCount, 1);
  assert.equal(collected.result.payload.metrics.counters.assetRequestCount, 1);
  assert.equal(collected.result.payload.metrics.counters.assetReceiptCount, 1);
  assert.equal(collected.result.payload.metrics.counters.mediaFileCount, 1);
  assert.equal(collected.result.payload.metrics.counters.mediaFailureCount, 1);
  assert.equal(collected.result.payload.metrics.counters.privateReadFallbackWarningCount, 1);
  assert.equal(collected.result.payload.metrics.privateRead.adapter, 'privateApiGeminiWebapi');
  assert.equal(collected.result.payload.mediaFiles[0].contentBase64, 'AQIDBA==');
  assert.equal(collected.result.payload.mediaFailures[0].error, 'fixture failure');
});

test('private read export preserves an explicit target filename from the workflow item', () => {
  const collected = privateReadExportResultToCollectedPayload({
    activeClient: { clientId: 'client-1' },
    conversation: {
      ...conversation,
      filename: 'Estudos/Gemini/private-export-original.md',
    },
    privateReadStartedAt: 1_000,
    privateReadFinishedAt: 1_025,
    result: {
      ok: true,
      adapter: 'browserBackground',
      snapshot,
      markdown: null,
      fallbackWarnings: [],
      adapterAttempts: [],
      mediaFiles: [],
      mediaFailures: [],
    },
  });

  assert.equal(collected.result.payload.filename, 'Estudos/Gemini/private-export-original.md');
});
