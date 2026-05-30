import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  runPrivateApiSelectedExport,
  summarizePrivateApiSelectedExportJob,
} from '../build/ts/cli/private-api-selected-export.js';

const snapshotFor = (chatId) => ({
  chatId,
  title: 'Private CLI export',
  url: `https://gemini.google.com/app/${chatId}`,
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
          label: 'Generated image',
          url: `assets/${chatId}/turn-0001-asset-00.png`,
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
});

const bootstrapOk = async () => ({
  ok: true,
  adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
  transport: { source: 'gemini_webapi_python' },
  warnings: [],
});

test('private API selected export writes Markdown with dates and emits progress', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-'));
  const events = [];
  const calls = [];
  const sequence = [];
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      outputDir,
      onProgress: (event) => events.push(event),
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async () => {
        sequence.push('bootstrap');
        return bootstrapOk();
      },
      runReadChat: async (input) => {
        sequence.push('read');
        calls.push(input);
        return {
          ok: true,
          snapshot: snapshotFor('88a98a108cdcfb61'),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: 'c_88a98a108cdcfb61' },
          assetReceipts: [
            {
              ok: true,
              refId: 'turn-0001-asset-00',
              status: 'downloaded',
              filePath: 'assets/88a98a108cdcfb61/turn-0001-asset-00.png',
              contentHash: 'sha256-fixture',
            },
          ],
          mediaFiles: [
            {
              filename: 'assets/88a98a108cdcfb61/turn-0001-asset-00.png',
              contentBase64: 'AQIDBA==',
              contentType: 'image/png',
              bytes: 4,
            },
          ],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 1);
  assert.equal(job.failureCount, 0);
  assert.deepEqual(sequence, ['bootstrap', 'read']);
  assert.equal(calls[0].chatId, '88a98a108cdcfb61');
  assert.equal(calls[0].downloadAssets, true);
  assert.equal(calls[0].assetsRelDir, 'assets/88a98a108cdcfb61');
  assert.equal(events.some((event) => event.phase === 'exporting'), true);
  assert.equal(events[0].progressMessage, 'Preparando API privada');

  const filePath = resolve(outputDir, '88a98a108cdcfb61.md');
  const markdown = readFileSync(filePath, 'utf-8');
  assert.match(markdown, /date_created: 2026-05-19T21:12:04Z/);
  assert.match(markdown, /date_last_message: 2026-05-19T21:14:16Z/);
  assert.match(markdown, /## 🤖 Gemini\n\nResposta privada/);
  assert.match(
    markdown,
    /!\[Generated image\]\(assets\/88a98a108cdcfb61\/turn-0001-asset-00\.png\)/,
  );
  assert.deepEqual(
    [...readFileSync(resolve(outputDir, 'assets/88a98a108cdcfb61/turn-0001-asset-00.png'))],
    [1, 2, 3, 4],
  );
  assert.equal(job.savedFiles[0].mediaFileCount, 1);
  assert.equal(job.savedFiles[0].mediaFailureCount, 0);
  assert.equal(job.savedFiles[0].mediaBytes, 4);

  const summary = summarizePrivateApiSelectedExportJob(job);
  assert.equal(summary.ok, true);
  assert.equal(summary.files[0].filePath, filePath);
  assert.equal(summary.files[0].mediaFileCount, 1);
  assert.equal(summary.files[0].dateCreated, '2026-05-19T21:12:04Z');
});

test('private API selected export records failures and continues the batch', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-'));
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: bootstrapOk,
      runReadChat: async (input) => {
        if (input.chatId === 'dbe5dd4b50b09c74') {
          return {
            ok: false,
            code: 'fixture_failed',
            message: 'fixture failure',
            chatId: 'dbe5dd4b50b09c74',
            adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          };
        }
        return {
          ok: true,
          snapshot: snapshotFor('88a98a108cdcfb61'),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: 'c_88a98a108cdcfb61' },
          assetReceipts: [],
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.successCount, 1);
  assert.equal(job.failureCount, 1);
  assert.equal(job.failures[0].chatId, 'dbe5dd4b50b09c74');
});

test('private API recent export lists inventory before selected export without browser wake', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-recent-'));
  const listCalls = [];
  const readCalls = [];
  const sequence = [];
  const job = await runPrivateApiSelectedExport(
    {
      recent: true,
      limit: 2,
      startIndex: 2,
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async () => {
        sequence.push('bootstrap');
        return bootstrapOk();
      },
      runListChats: async (input) => {
        sequence.push('list');
        listCalls.push(input);
        return {
          ok: true,
          chats: [
            { chatId: '111111111111', title: 'Ignored first' },
            { privateChatId: 'c_88a98a108cdcfb61', title: 'Selected one' },
            { chat_id: 'dbe5dd4b50b09c74', title: 'Selected two' },
          ],
        };
      },
      runReadChat: async (input) => {
        sequence.push(`read:${input.chatId}`);
        readCalls.push(input);
        return {
          ok: true,
          snapshot: snapshotFor(input.chatId),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: `c_${input.chatId}` },
          assetReceipts: [],
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 2);
  assert.deepEqual(sequence, [
    'bootstrap',
    'list',
    'read:88a98a108cdcfb61',
    'read:dbe5dd4b50b09c74',
  ]);
  assert.equal(listCalls[0].limit, 3);
  assert.deepEqual(
    readCalls.map((call) => call.chatId),
    ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
  );
});

test('private API selected export fails before reads when sidecar bootstrap fails', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-bootstrap-'));
  const events = [];
  let readCalled = false;
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      outputDir,
      onProgress: (event) => events.push(event),
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async (input) => {
        assert.equal(input.timeoutMs, 180000);
        return {
          ok: false,
          code: 'gemini_webapi_python_bootstrap_timeout',
          message: 'A preparacao da API privada Python demorou demais.',
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
        };
      },
      runReadChat: async () => {
        readCalled = true;
        throw new Error('read should not run');
      },
    },
  );

  assert.equal(job.status, 'failed');
  assert.equal(job.failureCount, 1);
  assert.equal(job.failures[0].code, 'gemini_webapi_python_bootstrap_timeout');
  assert.equal(readCalled, false);
  assert.deepEqual(
    events.map((event) => event.progressMessage),
    ['Preparando API privada', 'Preparacao da API privada falhou'],
  );
});

test('private API selected export is explicitly planned as private-first without browser wake', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'private-api-selected-export.ts'),
    'utf-8',
  );

  assert.match(source, /planExportAdapters/);
  assert.match(source, /'selected_export'/);
  assert.match(source, /'recent_export'/);
  assert.match(source, /browserFallbackAllowed:\s*false/);
  assert.doesNotMatch(source, /wakeBrowser:\s*true/);
});

test('CLI routes recent export to private API command before bridge readiness', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'bin', 'gemini-md-export.mjs'), 'utf-8');

  assert.match(source, /subcommand === 'recent'/);
  assert.match(source, /privateApiRecent/);
  assert.match(source, /runPrivateApiSelectedExportCommand/);
});
