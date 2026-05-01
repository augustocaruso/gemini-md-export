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
  assert.match(block, /const elapsedMs = Date\.now\(\) - roundStartedAt/);
  assert.match(block, /elapsedMs,/);
  assert.match(block, /browserTrace:\s*Array\.isArray\(result\.loadTrace\)/);
  assert.match(block, /Array\.isArray\(result\.conversations\)/);
  assert.match(block, /maxNoGrowthRounds/);
  assert.match(block, /args\.maxNoGrowthRounds\s*\|\|\s*8/);
  assert.match(block, /untilEnd:\s*args\.untilEndInBrowser !== false/);
  assert.match(block, /ignoreFailureCap:\s*true/);
  assert.match(block, /resetReachedEnd:\s*round === 0/);
  assert.match(block, /loadMoreBrowserRounds/);
  assert.match(block, /RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS/);
  assert.match(block, /let adaptiveBatchSize = batchSize/);
  assert.match(block, /adaptiveLoad = args\.adaptiveLoad !== false/);
  assert.match(block, /targetCount = previousCount \+ adaptiveBatchSize/);
  assert.match(block, /adaptiveBatchSize = Math\.max\(10, Math\.floor\(adaptiveBatchSize \/ 2\)\)/);
  assert.match(block, /adaptiveBatchSize = Math\.min\(200, Math\.ceil\(adaptiveBatchSize \* 1\.5\)\)/);
  assert.doesNotMatch(block, /includeConversations:\s*false/);
});

test('export all incompleto vira aviso em vez de sucesso silencioso', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.match(block, /job\.truncated\s*=\s*job\.exportAll\s*\?\s*!job\.reachedEnd/);
  assert.match(block, /loadMoreResolved/);
  assert.match(block, /job\.loadMoreTimedOut = loadMore\.timedOut === true && !loadMoreResolved/);
  assert.match(block, /job\.syncMode && job\.syncBoundary\?\.found === true/);
  assert.match(block, /Nao consegui confirmar que cheguei ao fim do historico do Gemini/);
  assert.match(block, /failures\.length > 0 \|\| job\.truncated \|\| job\.loadMoreTimedOut/);
  assert.match(block, /completed_with_errors/);
  assert.match(source, /const autoReleaseTabClaimForJob = async/);
  assert.match(source, /await autoReleaseTabClaimForJob\(job, `job-\$\{job\.status \|\| 'finished'\}`\)/);
  assert.match(source, /tabClaimRelease/);
  assert.match(source, /autoReleaseTabClaim/);
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

test('listagem de chats expõe contagem parcial sem fingir total', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const listRecentChatsForClient = async[\s\S]*?\nconst emptyTimingBucket/,
  )?.[0];
  assert.ok(block, 'listRecentChatsForClient deve existir');
  assert.match(block, /countStatus/);
  assert.match(block, /countIsTotal/);
  assert.match(block, /totalKnown/);
  assert.match(block, /totalCount/);
  assert.match(block, /inferRecentChatsCountStatus/);
  assert.match(block, /countSource/);
  assert.match(block, /countConfidence/);
  assert.match(block, /browser_dom_count_match/);
  assert.match(block, /DOM do sidebar/);
  assert.match(block, /minimumKnownCount/);
  assert.match(block, /Nao informe esse numero como "ao todo"/);
  assert.match(block, /Nao chame gemini_chats\/gemini_ready\/gemini_tabs como fallback/);
  assert.match(block, /command: null/);
  assert.match(source, /preferActive/);
  assert.match(source, /activeClients\.length === 1/);
  assert.match(source, /action:\s*\{\s*type:\s*'string',\s*enum:\s*\['list', 'count'/);
});

test('export total registra métricas de performance no status e relatório', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  const jobBlock = serverSource.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(serverSource, /const createExportJobMetrics = \(\) =>/);
  assert.match(serverSource, /summarizeExportJobMetrics/);
  assert.match(serverSource, /measureJobTiming\(job, 'loadSidebarMs'/);
  assert.match(serverSource, /recordJobTimingFrom\(job, 'refreshSidebarMs'/);
  assert.match(serverSource, /recordJobTimingFrom\(job, 'exportConversationsMs'/);
  assert.match(serverSource, /recordJobTimingFrom\(job, 'writeReportMs'/);
  assert.match(serverSource, /scanVaultMs/);
  assert.match(serverSource, /phaseTimings/);
  assert.match(serverSource, /payloads:\s*summarizePayloadMetrics\(client\)/);
  assert.match(serverSource, /lazyLoad:\s*summarizeLoadMoreMetrics/);
  assert.match(serverSource, /assets:\s*\{/);
  assert.match(jobBlock, /startConversationMetric/);
  assert.match(jobBlock, /finishConversationMetric/);
  assert.match(jobBlock, /mediaWarnings/);
  assert.match(jobBlock, /assetTimeouts/);
  assert.match(jobBlock, /result\.metrics/);
  assert.match(contentSource, /openConversationMs/);
  assert.match(contentSource, /hydrateDomMs/);
  assert.match(contentSource, /extractMarkdownMs/);
  assert.match(contentSource, /fetchAssetsMs/);
  assert.match(contentSource, /mediaCandidateCount/);
});

test('export missing oferece UX guiada para importação completa do vault', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = source.match(
    /const exportJobProgressMessage = \(job\) =>[\s\S]*?\nconst exportJobNextAction/,
  )?.[0];
  const summaryBlock = source.match(
    /const exportJobDecisionSummary = \(job\) =>[\s\S]*?\nconst setClientJobProgressAndNotify/,
  )?.[0];
  const toolBlock = source.match(
    /name: 'gemini_export_missing_chats'[\s\S]*?\n  \{\n    name: 'gemini_reexport_chats'/,
  )?.[0];
  assert.ok(jobBlock, 'mensagens humanas do job devem existir');
  assert.ok(summaryBlock, 'decisionSummary deve existir');
  assert.ok(toolBlock, 'gemini_export_missing_chats deve existir');
  assert.match(jobBlock, /Listando histórico do Gemini/);
  assert.match(jobBlock, /Cruzando histórico do Gemini com o vault/);
  assert.match(jobBlock, /Baixando somente o que falta no vault/);
  assert.match(jobBlock, /Retomando do relatório anterior/);
  assert.match(jobBlock, /Histórico inteiro verificado/);
  assert.match(jobBlock, /Não consegui confirmar o fim do histórico/);
  assert.match(summaryBlock, /workflow:\s*exportJobWorkflow\(job\)/);
  assert.match(summaryBlock, /geminiWebSeen/);
  assert.match(summaryBlock, /existingInVault/);
  assert.match(summaryBlock, /missingInVault/);
  assert.match(summaryBlock, /downloadedNow/);
  assert.match(summaryBlock, /mediaWarnings/);
  assert.match(summaryBlock, /resumeCommand/);
  assert.match(source, /exportJobResumeCommand/);
  assert.match(source, /gemini_export_missing_chats/);
  assert.match(source, /nextAction:\s*exportJobNextAction\(job\)/);
  assert.match(toolBlock, /outputDir:\s*args\.outputDir \|\| args\.vaultDir/);
  assert.match(toolBlock, /exportMissingOnly:\s*true/);
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
    'loadMoreBrowserRounds',
    'loadMoreBrowserTimeoutMs',
    'loadMoreTimeoutMs',
    'skipExisting',
    'adaptiveLoad',
  ]) {
    assert.match(block, new RegExp(`${field}:`));
  }
  for (const field of [
    'batchSize',
    'maxLoadMoreRounds',
    'loadMoreAttempts',
    'maxNoGrowthRounds',
    'loadMoreBrowserRounds',
    'loadMoreBrowserTimeoutMs',
    'loadMoreTimeoutMs',
  ]) {
    assert.match(source, new RegExp(`${field}: url\\.searchParams\\.get\\('${field}'\\)`));
  }
  assert.match(source, /adaptiveLoad:\s*parseOptionalBoolean\(url\.searchParams\.get\('adaptiveLoad'\)\)/);
  assert.match(source, /skipExisting:\s*parseOptionalBoolean\(url\.searchParams\.get\('skipExisting'\)\)/);
});

test('export total pula arquivos existentes por padrão', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.match(source, /const existingMarkdownExportForConversation = \(conversation/);
  assert.match(block, /if \(job\.skipExisting\)/);
  assert.match(block, /existingMarkdownExportForConversation\(conversation/);
  assert.match(block, /reason: 'existing-file'/);
  assert.match(block, /job\.skippedExisting\.push\(skipped\)/);
  assert.match(source, /const skipExisting =[\s\S]*!hasExplicitMaxChats/);
  assert.match(source, /skippedExisting:/);
  assert.match(source, /skippedCount:/);
});

test('export total consegue retomar a partir do relatório incremental', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  const recentToolBlock = source.match(
    /name: 'gemini_export_recent_chats'[\s\S]*?\n  \{\n    name: 'gemini_export_missing_chats'/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.ok(recentToolBlock, 'schema de gemini_export_recent_chats deve existir');
  assert.match(source, /const loadRecentChatsResumeCheckpoint = \(filePath\) =>/);
  assert.match(source, /resumeReportFile:\s*\{/);
  assert.match(source, /reportFile:\s*\{/);
  assert.match(source, /const resumeReportFile = args\.resumeReportFile \|\| args\.reportFile/);
  assert.match(source, /loadRecentChatsResumeCheckpoint\(resumeReportFile\)/);
  assert.match(jobBlock, /const successes = job\.resume \? \[\.\.\.job\.resume\.previousSuccesses\] : \[\]/);
  assert.match(jobBlock, /resumedCompletedChatIds/);
  assert.match(jobBlock, /remainingAfterResume/);
  assert.match(jobBlock, /!resumedCompletedChatIds\.has\(chatId\)/);
  assert.match(jobBlock, /job\.completed = resumedCompletedCount \+ i \+ 1/);
  assert.match(source, /previousFailures: job\.resume\.previousFailures/);
});

test('export missing cruza histórico completo com exports raw no vault', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  const toolBlock = source.match(
    /name: 'gemini_export_missing_chats'[\s\S]*?\n  \{\n    name: 'gemini_reexport_chats'/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.ok(toolBlock, 'schema de gemini_export_missing_chats deve existir');
  assert.match(source, /const scanDownloadedGeminiExportsInVault = \(vaultDir\) =>/);
  assert.match(source, /looksLikeRawGeminiExport/);
  assert.match(source, /FRONTMATTER_FIELD_RE/);
  assert.match(jobBlock, /phase = 'scanning-vault'/);
  assert.match(jobBlock, /scanDownloadedGeminiExportsInVault\(job\.existingScanDir\)/);
  assert.match(jobBlock, /reason: 'existing-vault-export'/);
  assert.match(jobBlock, /job\.webConversationCount = loadedItems\.length/);
  assert.match(jobBlock, /job\.existingVaultCount = existingInVault\.length/);
  assert.match(jobBlock, /job\.missingCount = missing\.length/);
  assert.match(toolBlock, /resumeReportFile/);
  assert.match(source, /Informe vaultDir\/existingScanDir ou resumeReportFile/);
  assert.match(toolBlock, /outputDir:\s*args\.outputDir \|\| args\.vaultDir/);
  assert.match(toolBlock, /Default: vaultDir/);
  assert.match(toolBlock, /exportMissingOnly:\s*true/);
  assert.match(toolBlock, /skipExisting:\s*true/);
  assert.match(source, /url\.pathname === '\/agent\/export-missing-chats'/);
  assert.match(source, /resumeReportFile:\s*url\.searchParams\.get\('resumeReportFile'\)/);
  assert.match(source, /url\.searchParams\.get\('outputDir'\)[\s\S]*url\.searchParams\.get\('vaultDir'\)/);
  assert.match(source, /'gemini_export_missing_chats'/);
});

test('sync incremental do vault usa fronteira conhecida e estado local', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const toolBlock = source.match(
    /name: 'gemini_sync_vault'[\s\S]*?\n  \{\n    name: 'gemini_reexport_chats'/,
  )?.[0];
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(toolBlock, 'gemini_sync_vault deve existir');
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(source, /const resolveVaultSyncStateFile = \(vaultDir, syncStateFile = null\) =>/);
  assert.match(source, /sync-state\.json/);
  assert.match(source, /const findSyncBoundary = \(conversations = \[\]/);
  assert.match(source, /known-vault-sequence/);
  assert.match(source, /sync-state-boundary/);
  assert.match(source, /loadRecentChatsUntilSyncBoundaryForClient/);
  assert.match(source, /untilEnd:\s*args\.untilEndInBrowser !== false/);
  assert.match(source, /maxNoGrowthRounds/);
  assert.match(source, /browserTrace:\s*Array\.isArray\(result\.loadTrace\)/);
  assert.match(source, /if \(!grew && noGrowthRounds >= maxNoGrowthRounds\) break/);
  assert.match(source, /maybeUpdateSyncState/);
  assert.match(jobBlock, /preloadedVaultScan/);
  assert.match(jobBlock, /job\.syncBoundary = loadMore\.boundary/);
  assert.match(jobBlock, /allConversations\.slice\(0, syncBoundaryIndex\)/);
  assert.match(source, /workflow:\s*exportJobWorkflow\(job\)/);
  assert.match(source, /vault-incremental-sync/);
  assert.match(toolBlock, /syncMode:\s*true/);
  assert.match(toolBlock, /exportMissingOnly:\s*true/);
  assert.match(toolBlock, /knownBoundaryCount/);
  assert.match(source, /url\.pathname === '\/agent\/sync-vault'/);
});

test('export recente faz retry para aba ocupada antes de registrar falha', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(source, /const isTransientTabBusyError = \(err\) =>/);
  assert.match(source, /tab_operation_in_progress/);
  assert.match(source, /const downloadConversationItemWithRetry = async/);
  assert.match(source, /RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT/);
  assert.match(jobBlock, /downloadConversationItemWithRetry\(job, client, conversation/);
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
