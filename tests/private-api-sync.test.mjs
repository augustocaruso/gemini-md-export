import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  runPrivateApiSync,
  selectPrivateSyncItems,
  summarizePrivateApiSyncJob,
} from '../build/ts/cli/private-api-sync.js';

const chat = (chatId, title = chatId) => ({
  chatId,
  title,
  url: `https://gemini.google.com/app/${chatId}`,
});

const completedPrivateExportJob = ({ outputDir, item }) => ({
  jobId: 'private-api-fixture',
  type: 'private-api-selected-export',
  sourceKind: 'export-job',
  status: 'completed',
  phase: 'writing-report',
  requested: 1,
  completed: 1,
  batchTotal: 1,
  successCount: 1,
  failureCount: 0,
  outputDir,
  current: null,
  progressMessage: 'Export privado concluido',
  operationMessage: 'Export privado concluido',
  decisionSummary: {
    headline: 'Export privado concluido',
    totals: {
      downloadedNow: 1,
      failed: 0,
      skipped: 0,
      geminiWebSeen: 1,
      missingInVault: 1,
    },
  },
  savedFiles: [
    {
      chatId: item.chatId,
      title: item.title,
      filePath: resolve(outputDir, `${item.chatId}.md`),
      filename: `${item.chatId}.md`,
      bytes: 42,
      overwritten: false,
      mediaFileCount: 0,
      mediaFailureCount: 0,
      mediaBytes: 0,
      dateCreated: '2026-06-01T10:00:00Z',
      dateLastMessage: '2026-06-01T10:05:00Z',
      adapter: 'browserBackground',
    },
  ],
  failures: [],
  startedAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:01.000Z',
  finishedAt: '2026-06-04T00:00:01.000Z',
});

test('selectPrivateSyncItems stops at sync-state boundary and exports only new chats', () => {
  const decision = selectPrivateSyncItems({
    inventory: [
      chat('1111111111111111', 'Novo 1'),
      chat('2222222222222222', 'Novo 2'),
      chat('aaaaaaaaaaaaaaaa', 'Antigo'),
      chat('bbbbbbbbbbbbbbbb', 'Mais antigo'),
    ],
    existingChatIds: new Set(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']),
    syncState: { topChatId: 'aaaaaaaaaaaaaaaa' },
    knownBoundaryCount: 2,
    maxChats: 10,
  });

  assert.equal(decision.boundary.found, true);
  assert.equal(decision.boundary.type, 'sync-state-boundary');
  assert.equal(decision.boundary.index, 2);
  assert.deepEqual(
    decision.itemsToExport.map((item) => item.chatId),
    ['1111111111111111', '2222222222222222'],
  );
  assert.equal(decision.existingInVaultBeforeBoundary, 0);
});

test('selectPrivateSyncItems does not count max-chats capped missing items as skipped existing', () => {
  const decision = selectPrivateSyncItems({
    inventory: [
      chat('1111111111111111', 'Novo 1'),
      chat('2222222222222222', 'Novo 2'),
      chat('3333333333333333', 'Novo 3'),
    ],
    existingChatIds: new Set(),
    syncState: null,
    knownBoundaryCount: 1,
    maxChats: 1,
  });

  assert.equal(decision.boundary.found, false);
  assert.deepEqual(
    decision.itemsToExport.map((item) => item.chatId),
    ['1111111111111111'],
  );
  assert.equal(decision.skippedExisting, 0);
});

test('private sync lists via private inventory, exports missing chats, and writes sync state', async () => {
  const vaultDir = mkdtempSync(resolve(tmpdir(), 'gme-private-sync-'));
  const oldChatId = 'aaaaaaaaaaaaaaaa';
  writeFileSync(
    resolve(vaultDir, `${oldChatId}.md`),
    `---\nchat_id: ${oldChatId}\nsource: gemini-web\n---\n\n## Gemini\n\nOld\n`,
    'utf-8',
  );

  const exported = [];
  const job = await runPrivateApiSync(
    {
      vaultDir,
      bridgeUrl: 'http://127.0.0.1:47283',
      knownBoundaryCount: 3,
      maxChats: 5,
    },
    {
      now: () => new Date('2026-06-04T00:00:00.000Z'),
      listChats: async () => ({
        ok: true,
        source: 'browser-background',
        chats: [chat('1111111111111111', 'Novo'), chat(oldChatId, 'Antigo')],
      }),
      exportSelected: async (args) => {
        exported.push(args);
        return completedPrivateExportJob({ outputDir: vaultDir, item: args.items[0] });
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 1);
  assert.equal(job.decisionSummary.fullHistoryVerified, true);
  assert.equal(exported.length, 1);
  assert.deepEqual(
    exported[0].items.map((item) => item.chatId),
    ['1111111111111111'],
  );
  assert.equal(exported[0].bridgeUrl, 'http://127.0.0.1:47283');

  const statePath = resolve(vaultDir, '.gemini-md-export', 'sync-state.json');
  assert.equal(existsSync(statePath), true);
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.equal(state.adapter, 'private_api');
  assert.equal(state.topChatId, '1111111111111111');
  assert.equal(state.lastDownloadedCount, 1);
  assert.deepEqual(state.boundaryChatIds, ['1111111111111111', oldChatId]);

  const summary = summarizePrivateApiSyncJob(job);
  assert.equal(summary.ok, true);
  assert.equal(summary.adapter, 'private_api');
  assert.equal(summary.downloadedCount, 1);
  assert.equal(summary.fullHistoryVerified, true);
});

test('private sync completes without export when the newest private chat is already known', async () => {
  const vaultDir = mkdtempSync(resolve(tmpdir(), 'gme-private-sync-noop-'));
  const knownChatId = 'cccccccccccccccc';
  mkdirSync(resolve(vaultDir, '.gemini-md-export'), { recursive: true });
  writeFileSync(resolve(vaultDir, `${knownChatId}.md`), `---\nchat_id: ${knownChatId}\n---\n`, 'utf-8');
  writeFileSync(
    resolve(vaultDir, '.gemini-md-export', 'sync-state.json'),
    JSON.stringify({ topChatId: knownChatId, boundaryChatIds: [knownChatId] }),
    'utf-8',
  );

  let exportCalled = false;
  const job = await runPrivateApiSync(
    { vaultDir, knownBoundaryCount: 1 },
    {
      now: () => new Date('2026-06-04T00:00:00.000Z'),
      listChats: async () => ({
        ok: true,
        source: 'browser-background',
        chats: [chat(knownChatId, 'Conhecido')],
      }),
      exportSelected: async () => {
        exportCalled = true;
        throw new Error('export should not run');
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.requested, 0);
  assert.equal(job.successCount, 0);
  assert.equal(exportCalled, false);
  assert.equal(job.progressMessage, 'Vault ja estava atualizado pela API privada');
});

test('private sync reads sync-state files with UTF-8 BOM from Windows PowerShell', async () => {
  const vaultDir = mkdtempSync(resolve(tmpdir(), 'gme-private-sync-bom-'));
  const knownChatId = 'dddddddddddddddd';
  mkdirSync(resolve(vaultDir, '.gemini-md-export'), { recursive: true });
  writeFileSync(
    resolve(vaultDir, '.gemini-md-export', 'sync-state.json'),
    `\uFEFF${JSON.stringify({ topChatId: knownChatId, boundaryChatIds: [knownChatId] })}`,
    'utf-8',
  );

  let exportCalled = false;
  const job = await runPrivateApiSync(
    { vaultDir, knownBoundaryCount: 1 },
    {
      now: () => new Date('2026-06-04T00:00:00.000Z'),
      listChats: async () => ({
        ok: true,
        source: 'browser-background',
        chats: [chat(knownChatId, 'Conhecido')],
      }),
      exportSelected: async () => {
        exportCalled = true;
        throw new Error('export should not run');
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.requested, 0);
  assert.equal(exportCalled, false);
  assert.equal(job.decisionSummary.boundary.type, 'sync-state-boundary');
});
