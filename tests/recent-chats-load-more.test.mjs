import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND,
  DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS,
  MAX_RECENT_CHATS_LOAD_TARGET,
  normalizeRecentChatsLoadMorePlan,
} from '../src/recent-chats-load-more.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

test('load more: ativa quando faltam conversas para o limite pedido', () => {
  const plan = normalizeRecentChatsLoadMorePlan(13, 50);
  assert.equal(plan.shouldLoadMore, true);
  assert.equal(plan.targetCount, 50);
  assert.equal(plan.rounds, DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS);
  assert.equal(plan.attemptsPerRound, DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND);
});

test('load more: não ativa quando já temos conversas suficientes', () => {
  const plan = normalizeRecentChatsLoadMorePlan(50, 50);
  assert.equal(plan.shouldLoadMore, false);
});

test('load more: não ativa quando o fim do sidebar já foi alcançado', () => {
  const plan = normalizeRecentChatsLoadMorePlan(13, 50, { reachedEnd: true });
  assert.equal(plan.shouldLoadMore, false);
});

test('load more: respeita clamps de rounds e attempts', () => {
  const plan = normalizeRecentChatsLoadMorePlan(1, 50, {
    loadMoreRounds: 999,
    loadMoreAttempts: 999,
  });
  assert.equal(plan.rounds, 30);
  assert.equal(plan.attemptsPerRound, 5);
});

test('load more: limita o alvo máximo para paginação longa', () => {
  const plan = normalizeRecentChatsLoadMorePlan(1, 5000);
  assert.equal(plan.targetCount, MAX_RECENT_CHATS_LOAD_TARGET);
  assert.equal(plan.shouldLoadMore, true);
});

test('export all mantém lista acumulada do browser a cada rodada', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const loadAllRecentChatsForClient = async[\s\S]*?\nconst parseOptionalBoolean/,
  )?.[0];
  assert.ok(block, 'loadAllRecentChatsForClient deve existir');
  assert.match(block, /includeConversations:\s*true/);
  assert.match(block, /includeModalConversations:\s*false/);
  assert.match(block, /RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS/);
  assert.match(block, /timeoutMs:\s*browserTimeoutMs/);
  assert.match(block, /\{\s*timeoutMs:\s*commandTimeoutMs\s*\}/);
  assert.match(block, /const loadTrace = \[\]/);
  assert.match(block, /beforeCount/);
  assert.match(block, /afterCount:\s*currentCount/);
  assert.match(block, /elapsedMs:\s*Date\.now\(\) - roundStartedAt/);
  assert.match(block, /browserTrace:\s*Array\.isArray\(result\.loadTrace\)/);
  assert.match(block, /Array\.isArray\(result\.conversations\)/);
  assert.match(block, /maxNoGrowthRounds/);
  assert.match(block, /args\.maxNoGrowthRounds\s*\|\|\s*5/);
  assert.doesNotMatch(block, /includeConversations:\s*false/);
});

test('export all incompleto vira aviso em vez de sucesso silencioso', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.match(block, /job\.truncated\s*=\s*job\.exportAll\s*\?\s*!job\.reachedEnd/);
  assert.match(block, /Nao consegui confirmar que cheguei ao fim do historico do Gemini/);
  assert.match(block, /failures\.length > 0 \|\| job\.truncated \|\| job\.loadMoreTimedOut/);
  assert.match(block, /completed_with_errors/);
});

test('job status diferencia lote parcial de historico inteiro verificado', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /const recentChatsExportScope = \(job\) =>/);
  assert.match(source, /scope:\s*fullHistoryRequested \? 'all-history' : 'partial'/);
  assert.match(source, /fullHistoryVerified/);
  assert.match(source, /partialLimit/);
  assert.match(source, /\.\.\.recentChatsExportScope\(job\)/);
  assert.match(source, /loadMoreTrace/);
});

test('export recent chats expõe knobs de diagnóstico para lazy-load lento', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /name: 'gemini_export_recent_chats'[\s\S]*?\n  \{\n    name: 'gemini_export_job_status'/,
  )?.[0];
  assert.ok(block, 'schema de gemini_export_recent_chats deve existir');
  for (const field of [
    'batchSize',
    'maxLoadMoreRounds',
    'loadMoreAttempts',
    'maxNoGrowthRounds',
    'loadMoreBrowserTimeoutMs',
  ]) {
    assert.match(block, new RegExp(`${field}:`));
    assert.match(source, new RegExp(`${field}: url\\.searchParams\\.get\\('${field}'\\)`));
  }
});

test('reexport de chatIds conhecidos roda como job em background', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /name: 'gemini_reexport_chats'/);
  assert.match(source, /const startDirectChatsExportJob = \(client, args = \{\}\) =>/);
  assert.match(source, /const runDirectChatsExportJob = async/);
  assert.match(source, /extractChatIdFromUrl\(idLike\)/);
  assert.match(source, /writeExportReport\(\s*'direct-chats'/);
  assert.match(source, /findRunningBrowserExportJob\(client\.clientId\)/);
  assert.match(source, /'gemini_reexport_chats'/);
  assert.match(source, /url\.pathname === '\/agent\/reexport-chats'/);
});
