import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS,
  DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS,
  DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND,
  DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS,
  MAX_RECENT_CHATS_LOAD_TARGET,
  normalizeRecentChatsLoadMorePlan,
  recentChatsLoadMoreRuntimeConfig,
} from '../build/ts/mcp/recent-chats-load-more.js';
import { compactReportItems } from '../build/ts/mcp/export-report-resume.js';

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

test('load more: defaults de runtime vivem no modulo TypeScript', () => {
  assert.equal(DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS, 45_000);
  assert.equal(DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS, 30_000);
  assert.deepEqual(recentChatsLoadMoreRuntimeConfig({}), {
    loadMoreBudgetMs: 45_000,
    loadMoreBrowserTimeoutMs: 30_000,
  });
  assert.deepEqual(
    recentChatsLoadMoreRuntimeConfig({
      GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BUDGET_MS: '21000',
      GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS: '11000',
    }),
    {
      loadMoreBudgetMs: 21_000,
      loadMoreBrowserTimeoutMs: 11_000,
    },
  );
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
  assert.match(block, /let loadError = null/);
  assert.match(block, /beforeCount/);
  assert.match(block, /afterCount:\s*currentCount/);
  assert.match(block, /const elapsedMs = Date\.now\(\) - roundStartedAt/);
  assert.match(block, /elapsedMs,/);
  assert.match(block, /browserTrace:\s*Array\.isArray\(result\.loadTrace\)/);
  assert.match(block, /isLoadMoreCommandTimeoutError/);
  assert.match(block, /ok:\s*loadError \? false : true/);
  assert.match(block, /Array\.isArray\(result\.conversations\)/);
  assert.match(block, /resolveContinuationClient/);
  assert.match(block, /enqueueCommandWithClientRecovery/);
  const managedSelectorSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'managed-tab-selection.ts'),
    'utf-8',
  );
  assert.match(source, /requireManagedChatClient\(selector, 'recent-chats'/);
  assert.match(source, /candidateMode:\s*'recent-chats'/);
  assert.match(managedSelectorSource, /const usefulRecentClients = clients\.filter/);
  assert.match(managedSelectorSource, /usefulRecentClients\.length > 0 \? usefulRecentClients : clients/);
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

test('contagem usa timeout total sem vazar para rodada interna do browser', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const listRecentChatsForClient = async[\s\S]*?\nconst emptyTimingBucket/,
  )?.[0];
  assert.ok(block, 'listRecentChatsForClient deve existir');
  assert.match(block, /totalLoadMoreTimeoutMs/);
  assert.match(block, /const \{ loadMoreTimeoutMs: _totalLoadMoreTimeoutMs, \.\.\.loadAllArgs \} = args/);
  assert.match(block, /\.\.\.loadAllArgs/);
  assert.match(block, /withTimeout\(\s*loadAllPromise,\s*totalLoadMoreTimeoutMs/s);
  assert.match(block, /if \(loadMore\?\.client\) client = loadMore\.client/);
  assert.match(source, /RECENT_CHATS_CLIENT_RECOVERY_WAIT_MS/);
});

test('listagem curta nao espera timeout longo do browser quando refresh trava', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const listRecentChatsForClient = async[\s\S]*?\nconst emptyTimingBucket/,
  )?.[0];
  assert.ok(block, 'listRecentChatsForClient deve existir');
  assert.match(block, /const shouldBoundRefresh = refreshPlan\.preferFastRefresh \|\| !untilEnd/);
  assert.match(block, /shouldBoundRefresh\s*\?\s*await withTimeout\(refreshPromise, RECENT_CHATS_REFRESH_BUDGET_MS\)\s*:\s*await refreshPromise/s);
});

test('load more parcial tem budget maior que abertura atrasada do sidebar', () => {
  const mcpSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'recent-chats-load-more.ts'), 'utf-8');

  assert.match(contentSource, /const SIDEBAR_OPEN_WAIT_MS = 6000/);
  assert.match(mcpSource, /recentChatsLoadMoreRuntimeConfig\(process\.env\)/);
  assert.match(runtimeSource, /DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS = 45_000/);
  assert.match(runtimeSource, /DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS = 30_000/);
});

test('contagem longa aplica claim visual temporaria na aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const block = source.match(
    /url\.pathname === '\/agent\/recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-recent-chats'\)/,
  )?.[0];
  assert.ok(block, '/agent/recent-chats deve existir');
  assert.match(block, /shouldTemporarilyClaimTab/);
  assert.match(block, /const temporaryClaimArgs = \{ \.\.\.args \}/);
  assert.match(block, /ensureTabClaimForJob\(\s*client,\s*temporaryClaimArgs,\s*args\.countOnly \? TAB_CLAIM_LABELS\.count : TAB_CLAIM_LABELS\.list/);
  assert.match(block, /claimVisibleAtMs = claim \? Date\.now\(\) : null/);
  assert.match(block, /preexistingClaimId/);
  assert.match(block, /hasExplicitClaimId/);
  assert.match(block, /ownsTemporaryClaim/);
  assert.match(block, /waitForTabClaimMinimumVisibility\(claimVisibleAtMs, args\)/);
  assert.match(block, /temporaryClaimArgs\.ttlMs/);
  assert.match(block, /operationArgs/);
  assert.match(block, /claimId: claim\.claimId/);
  assert.match(block, /releaseClaimOnOperationEnd: shouldReleaseTemporaryClaim/);
  assert.match(block, /releaseClaimReason: 'recent-chats-load-more-finished'/);
  assert.match(block, /recent-chats-list-finished/);
  assert.match(block, /tabClaimRelease/);
  assert.match(nativeGateSource, /waitForContinuationClient\(\s*\{\s*clientId: claim\.clientId/);
  assert.match(nativeGateSource, /\{\s*claimId,\s*tabId: claim\.tabId/);
  assert.match(source, /Math\.min\(COMMAND_TIMEOUT_MS, browserTimeoutMs \+ 15_000\)/);
  assert.match(source, /releaseClaimOnSlowOperationMs/);
});

test('jobs renovam claim existente para recriar indicador visual ausente', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(/const ensureTabClaimForJob = async[\s\S]*?\n};/)?.[0];
  assert.ok(block, 'ensureTabClaimForJob deve existir');
  assert.match(block, /args\.renewExistingClaim === false/);
  assert.match(block, /exportTabReadinessPolicyForArgs/);
  assert.match(block, /readinessPolicy\.effects\.requireActiveTab/);
  assert.match(block, /claimClientForJob\(client/);
  assert.match(block, /claimTabForClient/);
  assert.match(block, /claimGeminiTabForClient/);
  assert.match(block, /client\.lastTabClaimWarning = warning/);
  assert.match(block, /args\.requireTabClaim === true/);
  assert.match(block, /return null/);
  assert.match(source, /tabClaimWarning: client\.lastTabClaimWarning \|\| null/);
  assert.match(source, /tabClaimWarning: job\.tabClaimWarning \|\| null/);
});

test('export pesado só ativa a aba real quando a política pede foreground', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const prepareBlock = source.match(
    /const ensureClientActiveForExport = async[\s\S]*?\n\};\n\nconst compareRecentExportClientPreference/,
  )?.[0] || '';
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0] || '';

  assert.match(source, /EXPORT_TAB_ACTIVATION_TIMEOUT_MS/);
  assert.match(source, /const activateBrowserTabById = async/);
  assert.match(source, /const tabActivationBrokerClients = \(/);
  assert.match(prepareBlock, /exportTabReadinessPolicyForArgs/);
  assert.match(prepareBlock, /exportTabReadinessPolicyForArgs\(args\)\.effects\.activateTab/);
  assert.match(prepareBlock, /activateBrowserTabById\(client\?\.tabId/);
  assert.match(source, /'activate-browser-tab'/);
  assert.match(prepareBlock, /tab_activation_failed/);
  assert.match(collectBlock, /const prepared = await ensureClientActiveForExport\(client, args\)/);
  assert.ok(
    collectBlock.indexOf('ensureClientActiveForExport') <
      collectBlock.indexOf("'get-chat-by-id'"),
    'ativacao precisa acontecer antes do comando pesado get-chat-by-id',
  );
});

test('export recente prepara automaticamente uma aba hidratada antes da claim', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const cliSource = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const prepareBlock = serverSource.match(
    /const selectRecentExportClient = async[\s\S]*?\n\};\n\nconst collectConversationItemPayloadForClient/,
  )?.[0] || '';
  const jobArgsBlock = serverSource.match(
    /const prepareNativeExportJobArgs = async[\s\S]*?\n\};\n\nconst assertClientClaimedReadyForSession/,
  )?.[0] || '';
  const recentEndpointBlock = serverSource.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-missing-chats'\)/,
  )?.[0] || '';
  const runExportBlock = cliSource.match(
    /const runExport = async[\s\S]*?\nconst runJob = async/,
  )?.[0] || '';

  assert.match(serverSource, /const prepareClientForBrowserExport = async/);
  assert.match(prepareBlock, /recentExportCandidateClients\(\)/);
  assert.match(prepareBlock, /prepareClientForBrowserExport\(candidates\[0\], selector\)/);
  assert.match(serverSource, /const assertExportClientReadyForJob = \(client, args = \{\}, options = \{\}\) =>/);
  assert.match(serverSource, /assertExportClientReadyForJobRuntime/);
  assert.match(
    readFileSync(resolve(ROOT, 'src', 'mcp', 'export-tab-readiness.ts'), 'utf-8'),
    /allowInactiveTab: readinessPolicy\.effects\.allowInactiveTab/,
  );
  assert.match(serverSource, /assertExportClientReadyForJob\(prepared\.client, args/);
  assert.match(recentEndpointBlock, /exportBrowserArgsFromSearchParams\(url\.searchParams\)/);
  assert.match(recentEndpointBlock, /const client = await selectRecentExportClient\(selector\)/);
  assert.match(recentEndpointBlock, /prepareNativeExportJobArgs\(client/);
  assert.ok(
    recentEndpointBlock.indexOf('exportBrowserArgsFromSearchParams') <
      recentEndpointBlock.indexOf('selectRecentExportClient') &&
      recentEndpointBlock.indexOf('selectRecentExportClient') <
      recentEndpointBlock.indexOf('prepareNativeExportJobArgs'),
    'export recent precisa propagar activateTab antes de ativar/validar a aba',
  );
  assert.ok(
    jobArgsBlock.indexOf('claimNativeExportLeaseForJob') <
      jobArgsBlock.indexOf('withNativeExportLease'),
    'helper de job precisa criar a claim visual antes de preparar argumentos do export',
  );
  assert.match(cliSource, /const ensureReadyForExport = async/);
  assert.match(cliSource, /canPrepareExportFromReady/);
  assert.match(runExportBlock, /await ensureReadyForExport\(flags\.bridgeUrl, flags, ui\)/);
  assert.doesNotMatch(runExportBlock, /await ensureReady\(flags\.bridgeUrl, flags, ui\)/);
});

test('export parcial carrega mais historico ate maxChats antes de fatiar', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.match(block, /const partialLoadTargetCount = Math\.min\(MAX_RECENT_CHATS_LOAD_TARGET, job\.startIndex - 1 \+ job\.maxChats\)/);
  assert.match(block, /const shouldLoadPartialHistory =/);
  assert.match(block, /!job\.exportAll[\s\S]*!job\.exportMissingOnly[\s\S]*!job\.syncMode/);
  assert.match(block, /recentConversationsForClient\(client\)\.length < partialLoadTargetCount/);
  assert.match(block, /loadMoreRecentChatsForClient\(client, partialLoadTargetCount, \{/);
  assert.ok(
    block.indexOf('partialLoadTargetCount') <
      block.indexOf('const allConversations = recentConversationsForClient(client)'),
    'lazy-load parcial precisa acontecer antes de calcular allConversations',
  );
  assert.ok(
    block.indexOf('loadMoreRecentChatsForClient(client, partialLoadTargetCount') <
      block.indexOf('conversations.slice(job.startIndex - 1, job.startIndex - 1 + job.maxChats)'),
    'export parcial nao pode fatiar antes de carregar ate maxChats',
  );
  assert.match(block, /operation: 'load-more-partial-recent-chats'/);
  assert.match(block, /job\.loadMoreRoundsCompleted = loadMore\.roundsCompleted/);
  assert.match(block, /job\.loadMoreTimedOut = loadMore\.timedOut === true && !loadMoreResolved/);
});

test('export recente passa claim visual Gemini para fallback My Activity de datas', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const runtimeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-date-import-runtime.ts'),
    'utf-8',
  );
  const startBlock = source.match(
    /const startRecentChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?\n  const job = \{/,
  )?.[0];
  assert.ok(startBlock, 'startRecentChatsExportJob deve existir');
  assert.match(startBlock, /const activeClaim = claimForClient\(client\)/);
  assert.match(startBlock, /assignExportDateImportVisualGroupTabId\(args, normalizeTabId\(activeClaim\?\.tabId \?\? client\.tabId\)\)/);
  assert.match(nativeGateSource, /args\._exportDateImportVisualGroupTabId = tabId/);
  assert.match(runtimeSource, /DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS = 45_000/);
  assert.match(runtimeSource, /DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS = 8_000/);
  assert.match(runtimeSource, /visualGroupTabId:[\s\S]*args\._exportDateImportVisualGroupTabId/);
  assert.match(runtimeSource, /const activityWaitMs = dateImportActivityWaitMs\(args\)/);
  assert.match(runtimeSource, /waitMs: activityWaitMs/);
  assert.match(runtimeSource, /activityCommandTimeoutMs:[\s\S]*activityWaitMs \+ 15_000/);
  assert.match(runtimeSource, /abortable\(\s*options\.scanActivity/);
  assert.match(runtimeSource, /throwIfAborted\(args\.abortSignal\)/);
  assert.match(runtimeSource, /preLaunchWaitMs: dateImportActivityPreLaunchWaitMs\(args\)/);
});

test('resume de export parcial preserva limite original em relatorios encadeados', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const resumeScopeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'),
    'utf-8',
  );
  const checkpointBlock = source.match(
    /const loadRecentChatsResumeCheckpoint = \(filePath\) => \{[\s\S]*?\n\};\n\nconst loadDirectChatsResumeCheckpoint/,
  )?.[0];
  const startBlock = source.match(
    /const startRecentChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?\n  exportJobs\.set/,
  )?.[0];
  const resumeCommandBlock = source.match(/const exportJobResumeCommand = \(job\) => \{[\s\S]*?\n\};/)?.[0];

  assert.ok(checkpointBlock, 'loadRecentChatsResumeCheckpoint deve existir');
  assert.ok(startBlock, 'startRecentChatsExportJob deve existir');
  assert.ok(resumeCommandBlock, 'exportJobResumeCommand deve existir');
  assert.match(checkpointBlock, /recentChatsResumeCounters/);
  assert.match(resumeScopeSource, /report\?\.resume\?\.previousCounters\?\.webConversationCount/);
  assert.match(resumeScopeSource, /webConversationCount: previousWebConversationCountForResumeReport/);
  assert.match(startBlock, /recentExportResumeScope/);
  assert.match(resumeScopeSource, /resume\?\.previousCounters\?\.webConversationCount/);
  assert.match(resumeScopeSource, /effectiveHasMaxChats: hasExplicitMaxChats \|\| resumeMaxChats !== null/);
  assert.match(startBlock, /exportAll: !effectiveHasMaxChats/);
  assert.match(startBlock, /maxChats: hasExplicitMaxChats[\s\S]*: resumeMaxChats/);
  assert.match(resumeCommandBlock, /\.\.\(!job\.exportAll && job\.maxChats \? \{ maxChats: job\.maxChats \} : \{\}\)/);
});

test('recent export builds operation targets with batch and history positions', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const importBlock = source.match(
    /const \{[\s\S]*?buildExportBatchTargets[\s\S]*?buildOperationId[\s\S]*?\} = await import\(compiledTsModuleUrl\('mcp', 'export-operation-contracts\.js'\)\)/,
  )?.[0];
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0];

  assert.ok(importBlock, 'mcp-server deve importar o contrato compilado de operacoes de export');
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.ok(collectBlock, 'collectConversationItemPayloadForClient deve existir');
  assert.match(block, /const operationTargets = buildExportBatchTargets\(selected, \{\s*batchTotal: selected\.length,\s*source: 'sidebar',\s*\}\)/);
  assert.match(block, /if \(operationTargets\.length !== selected\.length\) \{/);
  assert.match(block, /operation_target_selection_mismatch/);
  assert.match(block, /job\.requested = resumedCompletedCount \+ operationTargets\.length/);
  assert.match(block, /for \(let i = 0; i < operationTargets\.length; i \+= 1\)/);
  assert.match(block, /const target = operationTargets\[i\]/);
  assert.match(block, /const selectedItem = selected\[i\]/);
  assert.match(block, /const \{ conversation, index \} = selectedItem/);
  assert.match(block, /const operationId = buildOperationId\(\{\s*jobId: job\.jobId,\s*batchPosition: target\.batchPosition,\s*targetChatId: target\.targetChatId,\s*\}\)/);
  assert.match(block, /job\.current = \{\s*index,\s*batchPosition: target\.batchPosition,\s*batchTotal: target\.batchTotal,\s*historyIndex: target\.historyIndex,\s*operationId,\s*title: target\.title \|\| conversation\.title \|\| null,\s*chatId: target\.targetChatId,\s*\}/);
  assert.match(block, /job\.batchPosition = target\.batchPosition/);
  assert.match(block, /job\.batchTotal = target\.batchTotal/);
  assert.match(block, /job\.historyIndex = target\.historyIndex/);
  assert.match(block, /job\.operationId = operationId/);
  assert.match(operationSource, /operationId,\s*jobId: job\.jobId,\s*targetChatId: target\.targetChatId,/);
  assert.match(block, /markExportJobFinishedForReport\(job, \{/);
  assert.match(block, /clearFields: \['current', 'batchPosition', 'batchTotal', 'historyIndex', 'operationId'\]/);
  const finalizationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-job-finalization.ts'),
    'utf-8',
  );
  assert.match(finalizationSource, /for \(const field of options\.clearFields \|\| \[\]\) \{\s*job\[field\] = null;/);
  assert.match(collectBlock, /operationId: args\.operationId \|\| null/);
  assert.match(collectBlock, /jobId: args\.jobId \|\| null/);
  assert.match(collectBlock, /targetChatId: args\.targetChatId \|\| normalizeConversationChatId\(conversation\) \|\| null/);
});

test('export recente revalida lease nativa antes de comando pesado por conversa', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0];

  assert.ok(collectBlock, 'collectConversationItemPayloadForClient deve existir');
  assert.match(collectBlock, /validateNativeExportTabLeaseForJob/);
  assert.ok(
    collectBlock.indexOf('validateNativeExportTabLeaseForJob') <
      collectBlock.indexOf("'get-chat-by-id'"),
    'lease nativa precisa ser revalidada antes do get-chat-by-id',
  );
});

test('export recente prepara companion My Activity antes de iniciar job', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const helperSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'activity-companion-readiness.ts'),
    'utf-8',
  );
  const nativeBrokerSource = readFileSync(
    resolve(ROOT, 'src', 'browser', 'background', 'native-broker-client.ts'),
    'utf-8',
  );
  const helperBlock =
    helperSource.match(/export const createActivityCompanionPreparer[\s\S]*$/)?.[0] || '';
  const endpointBlock = source.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n    return;/,
  )?.[0] || '';
  const jobArgsBlock = source.match(
    /const prepareNativeExportJobArgs = async[\s\S]*?\n\};\n\nconst assertClientClaimedReadyForSession/,
  )?.[0] || '';

  assert.match(helperSource, /activityCompanionTabIdsForNativeLease/);
  assert.match(helperSource, /activityCompanionTabIdsForNativeTabs/);
  assert.match(helperSource, /shouldPrepareActivityCompanionForDateImport/);
  assert.match(helperBlock, /activityCompanionTabIdsForNativeLease/);
  assert.match(helperBlock, /tryNativeBrowserBrokerTabsAction\('list'/);
  assert.match(helperBlock, /activityCompanionTabIdsForNativeTabs/);
  assert.match(helperBlock, /tryNativeBrowserBrokerTabsAction\('claim'/);
  assert.match(helperBlock, /relatedTabIds: \[companionTabId\]/);
  assert.match(helperSource, /transitionActivityCompanionWakeFsm/);
  assert.match(helperBlock, /wakePolicy\.effects\.activateCompanion/);
  assert.match(helperBlock, /activateBrowserTabById\(\s*companionTabId/);
  assert.match(helperBlock, /tryNativeBrowserBrokerTabsAction\('reload'/);
  assert.match(helperBlock, /waitForActivityClient\(\s*\{ tabId: companionTabId \}/);
  assert.match(helperBlock, /wakePolicy\.effects\.restoreExportTab/);
  assert.match(helperBlock, /activateBrowserTabById\(\s*exportTabId/);
  assert.match(nativeBrokerSource, /relatedTabIdsFromClaimPayload/);
  assert.match(nativeBrokerSource, /applyNativeClaimVisual\(\s*[\s\S]*?relatedTabIds/);
  assert.match(endpointBlock, /prepareNativeExportJobArgs\(client/);
  assert.ok(
    jobArgsBlock.indexOf('claimNativeExportLeaseForJob') <
      jobArgsBlock.indexOf('prepareActivityCompanionForNativeExportLease') &&
      endpointBlock.indexOf('prepareNativeExportJobArgs') <
        endpointBlock.indexOf('startRecentChatsExportJob'),
    'companion My Activity precisa acordar entre a claim visual nativa e o início do job',
  );
});

test('start de export tem budget para preparar aba automaticamente', () => {
  const cliSource = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const startExportBlock = cliSource.match(
    /const startExportJob = async[\s\S]*?\n\};\n\nconst fetchJobStatus/,
  )?.[0] || '';
  const startSyncStart = cliSource.indexOf('const startSyncJob = async');
  const startExportStart = cliSource.indexOf('const startExportJob = async');
  const startSyncBlock =
    startSyncStart >= 0 && startExportStart > startSyncStart
      ? cliSource.slice(startSyncStart, startExportStart)
      : '';

  assert.match(cliSource, /const EXPORT_JOB_START_TIMEOUT_MS = 120_000/);
  assert.match(startSyncBlock, /timeoutMs: EXPORT_JOB_START_TIMEOUT_MS/);
  assert.match(startExportBlock, /timeoutMs: EXPORT_JOB_START_TIMEOUT_MS/);
  assert.doesNotMatch(startSyncBlock, /timeoutMs: 20000/);
  assert.doesNotMatch(startExportBlock, /timeoutMs: 20000/);
});

test('ativacao automatica de aba limita brokers possivelmente obsoletos', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const activationBrokerBlock = serverSource.match(
    /const tabActivationBrokerClients = \(preferredClient = null\) =>[\s\S]*?\n\};\n\nconst activateBrowserTabById/,
  )?.[0] || '';
  const activationBlock = serverSource.match(
    /const activateBrowserTabById = async[\s\S]*?\n\};\n\nconst ensureClientActiveForExport/,
  )?.[0] || '';

  assert.match(serverSource, /EXPORT_TAB_ACTIVATION_BROKER_LIMIT/);
  assert.match(serverSource, /EXPORT_TAB_ACTIVATION_CONFIRM_WAIT_MS/);
  assert.match(activationBrokerBlock, /slice\(0, EXPORT_TAB_ACTIVATION_BROKER_LIMIT\)/);
  assert.match(serverSource, /const waitForActivatedBrowserTabById = async/);
  assert.match(activationBlock, /waitForActivatedBrowserTabById\(tabId, args\)/);
  assert.match(activationBlock, /activation-inferred-from-heartbeat/);
});

test('export all incompleto vira aviso em vez de sucesso silencioso', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(block, 'runRecentChatsExportJob deve existir');
  assert.match(block, /job\.truncated\s*=\s*job\.exportAll\s*\?\s*!job\.reachedEnd/);
  assert.match(block, /loadMoreResolved/);
  assert.match(block, /job\.loadMoreTimedOut = loadMore\.timedOut === true && !loadMoreResolved/);
  assert.match(block, /job\.syncMode && job\.syncBoundary\?\.found === true/);
  assert.match(block, /Nao consegui confirmar que cheguei ao fim do historico do Gemini/);
  assert.match(block, /terminalExportStatusForDateCompleteness\(\s*job,\s*failures\.length/);
  assert.match(block, /job\.truncated \|\| job\.loadMoreTimedOut/);
  assert.match(source, /const autoReleaseTabClaimForJob = createAutoTabClaimReleaseForJob/);
  assert.match(source, /await autoReleaseTabClaimForJob\(job, `job-\$\{job\.status \|\| 'finished'\}`\)/);
  assert.match(nativeGateSource, /tryNativeBrowserBrokerTabsAction\('release'/);
  assert.match(nativeGateSource, /job\.nativeExportLease[\s\S]*?\.tabIds/);
  assert.match(nativeGateSource, /job\.nativeTabClaimRelease = await deps\.tryNativeBrowserBrokerTabsAction\('release'/);
  assert.match(source, /tabClaimRelease/);
  assert.match(source, /autoReleaseTabClaim/);
});

test('export com datas obrigatorias pendentes vira completed_with_errors e orienta fix-vault', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const dateSummarySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-job-date-summary.ts'),
    'utf-8',
  );
  const actionBlock = source.match(
    /const exportJobNextAction = \(job\) =>[\s\S]*?\n\};\n\nconst exportJobDecisionSummary/,
  )?.[0] || '';
  const recentBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0] || '';
  const directBlock = source.match(
    /const runDirectChatsExportJob = async[\s\S]*?\nconst startDirectChatsExportJob/,
  )?.[0] || '';

  assert.match(source, /dateCompletenessNextActionForJob/);
  assert.match(source, /terminalExportStatusForDateCompleteness/);
  assert.match(source, /exportJobProgressMessageForJob/);
  assert.match(dateSummarySource, /dateAction/);
  assert.match(dateSummarySource, /return dateAction\.message/);
  assert.match(actionBlock, /dateAction/);
  assert.match(actionBlock, /if \(dateAction\) return dateAction/);
  assert.match(recentBlock, /terminalExportStatusForDateCompleteness\(/);
  assert.match(directBlock, /terminalExportStatusForDateCompleteness\(job, failures\.length\)/);
});

test('jobProgress do export é espelhado para companion My Activity', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const mirrorSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'job-progress-mirror.ts'), 'utf-8');
  const mirrorBlock = source.match(
    /const broadcastRecentChatsJobProgress = \(job, client, patch = \{\}\) =>[\s\S]*?\n\};\n\nconst broadcastDirectChatsJobProgress/,
  )?.[0] || '';
  const recentBroadcastBlock = source.match(
    /const broadcastRecentChatsJobProgress = \(job, client, patch = \{\}\) =>[\s\S]*?\n\};\n\nconst broadcastDirectChatsJobProgress/,
  )?.[0] || '';
  const directBroadcastBlock = source.match(
    /const broadcastDirectChatsJobProgress = \(job, client, patch = \{\}\) =>[\s\S]*?\n\};\n\nconst maybeFinalizeStaleCancelRequestedJob/,
  )?.[0] || '';

  assert.match(source, /setJobProgressForPrimaryAndMirrors/);
  assert.match(mirrorSource, /jobProgressMirrorTabIdsForJob/);
  assert.match(mirrorSource, /shouldMirrorJobProgressToClient/);
  assert.match(mirrorSource, /job\.activityCompanion\?\.tabId/);
  assert.match(mirrorSource, /job\.nativeExportLease\?\.visual\?\.tabIds/);
  assert.match(mirrorSource, /client\.kind !== 'activity'/);
  assert.match(mirrorBlock, /clients\.values\(\)/);
  assert.match(mirrorSource, /mirroredFromClientId/);
  assert.match(recentBroadcastBlock, /setJobProgressForPrimaryAndMirrors\(/);
  assert.match(directBroadcastBlock, /setJobProgressForPrimaryAndMirrors\(/);
});

test('job status diferencia lote parcial de historico inteiro verificado', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reportSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'export-job-reports.ts'), 'utf-8');
  assert.match(source, /const recentChatsExportScope = \(job\) =>/);
  assert.match(source, /scope:\s*fullHistoryRequested \? 'all-history' : 'partial'/);
  assert.match(source, /fullHistoryVerified/);
  assert.match(source, /partialLimit/);
  assert.match(reportSource, /\.\.\.deps\.recentChatsExportScope\(job\)/);
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
  assert.match(block, /loadMoreIncomplete/);
  assert.match(block, /allowDomCountConfirmation:\s*!loadMoreBusy && !loadMoreIncomplete/);
  assert.match(block, /minimumKnownCount/);
  assert.match(block, /Nao informe esse numero como "ao todo"/);
  assert.match(block, /Nao chame gemini_chats\/gemini_ready\/gemini_tabs como fallback/);
  assert.match(block, /command: null/);
  const managedSelectorSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'managed-tab-selection.ts'),
    'utf-8',
  );
  assert.match(source, /requireManagedChatClient\(selector, 'recent-chats'/);
  assert.match(source, /candidateMode:\s*'recent-chats'/);
  assert.match(managedSelectorSource, /usefulRecentClients/);
  assert.match(managedSelectorSource, /recentConversationCount\(client, recentConversationCountForClient\) > 0/);
  assert.match(managedSelectorSource, /clientHasChatId\(client\)/);
  assert.match(source, /const hasExportableRecentConversationIdentity = \(conversation = \{\}\) =>/);
  assert.match(source, /filter\(hasExportableRecentConversationIdentity\)/);
  assert.match(source, /action:\s*\{\s*type:\s*'string',\s*enum:\s*\['list', 'count'/);
});

test('export total registra métricas de performance no status e relatório', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const retryRecoverySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'conversation-retry-recovery.ts'),
    'utf-8',
  );
  const recordingSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-job-recording.ts'),
    'utf-8',
  );
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
  assert.match(operationSource, /recordConversationExportSuccess/);
  assert.match(recordingSource, /finishConversationMetric/);
  assert.match(recordingSource, /mediaWarnings/);
  assert.match(recordingSource, /assetTimeouts/);
  assert.match(recordingSource, /result\.metrics/);
  assert.match(contentSource, /openConversationMs/);
  assert.match(contentSource, /hydrateDomMs/);
  assert.match(contentSource, /extractMarkdownMs/);
  assert.match(contentSource, /fetchAssetsMs/);
  assert.match(contentSource, /mediaCandidateCount/);
});

test('export jobs registram sessao de aba e trace sanitizado por job', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /createTabSessionManager/);
  assert.match(source, /attachExportJobTabSession/);
  assert.match(source, /recordExportJobCleanup/);
  assert.match(source, /finishExportJobTabSession/);
  assert.match(source, /createJobTrace/);
  assert.match(source, /appendExportJobTrace/);
  assert.match(source, /finalizeExportJobTrace/);
  assert.match(source, /url\.pathname === '\/agent\/export-job-trace'/);
  assert.match(source, /summarizeTraceEvents/);
  assert.match(source, /traceFile/);
  assert.match(source, /tabSession/);
});

test('export jobs bloqueiam novo export ativo antes de tentar claim-tab', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /const exportJobInProgressError = \(job\) =>/);
  assert.match(source, /err\.code = 'export_job_in_progress'/);
  assert.match(source, /statusCliCommand: `gemini-md-export job status \$\{job\.jobId\} --plain`/);
  assert.match(source, /url\.pathname === '\/agent\/export-jobs'/);
  for (const route of [
    '/agent/export-recent-chats',
    '/agent/export-missing-chats',
    '/agent/sync-vault',
    '/agent/reexport-chats',
  ]) {
    const escaped = route.replaceAll('/', '\\/');
    const block = source.match(new RegExp(`url\\.pathname === '${escaped}'[\\s\\S]*?catch \\(err\\)`))?.[0];
    assert.ok(block, `${route} deve existir`);
    assert.match(block, /exportBrowserArgsFromSearchParams/);
    assert.match(block, /const client = await selectRecentExportClient\(selector\)/);
    assert.match(block, /assertNoRunningBrowserExportJob\(client\);[\s\S]*?prepareNativeExportJobArgs[\s\S]*?start(?:Recent|Direct)ChatsExportJob/);
  }
  assert.match(source, /const prepareNativeExportJobArgs = async[\s\S]*?claimNativeExportLeaseForJob/);
  assert.match(source, /const assertClientClaimedReadyForSession = \(client, args = \{\}\) =>/);
  assert.match(source, /const startRecentChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?assertClientClaimedReadyForSession\(client, args\)/);
  assert.match(source, /const startDirectChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?assertClientClaimedReadyForSession\(client, args\)/);
  assert.match(source, /sendAgentError\(res, 503, err\)/);
});

test('export missing oferece UX guiada para importação completa do vault', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = readFileSync(resolve(ROOT, 'src', 'mcp', 'export-job-date-summary.ts'), 'utf-8');
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
  assert.match(summaryBlock, /dateImportPending/);
  assert.match(summaryBlock, /metadataDateWarnings/);
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
  assert.match(source, /const skipExisting =[\s\S]*!effectiveHasMaxChats/);
  assert.match(source, /skippedExisting:/);
  assert.match(source, /skippedCount:/);
});

test('export total consegue retomar a partir do relatório incremental', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reportSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'export-job-reports.ts'), 'utf-8');
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  const recentToolBlock = source.match(
    /name: 'gemini_export_recent_chats'[\s\S]*?\n  \{\n    name: 'gemini_export_missing_chats'/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.ok(recentToolBlock, 'schema de gemini_export_recent_chats deve existir');
  assert.match(source, /compactReportItems[\s\S]*compiledTsModuleUrl\('mcp', 'export-report-resume\.js'\)/);
  assert.doesNotMatch(source, /const compactReportItems = \(items, kind\) =>/);
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
  assert.match(reportSource, /previousFailures: job\.resume\.previousFailures/);
});

test('resume compacta sucessos antigos preservando recibo de dateImport', () => {
  const items = compactReportItems(
    [
      {
        chatId: 'c_2c52369234b6f57a',
        title: 'Sem evidência de data',
        filename: '2c52369234b6f57a.md',
        dateImport: {
          enabled: true,
          status: 'unresolved',
          source: 'takeout+my-activity',
        },
      },
    ],
    'success',
  );

  assert.deepEqual(items, [
    {
      kind: 'success',
      index: null,
      chatId: '2c52369234b6f57a',
      title: 'Sem evidência de data',
      filename: '2c52369234b6f57a.md',
      filePath: null,
      relativePath: null,
      bytes: null,
      reason: 'success',
      mediaFileCount: null,
      mediaFailureCount: null,
      turns: null,
      overwritten: null,
      error: null,
      dateImport: {
        enabled: true,
        status: 'unresolved',
        source: 'takeout+my-activity',
      },
    },
  ]);
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
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const retryRecoverySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'conversation-retry-recovery.ts'),
    'utf-8',
  );
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(source, /const isTransientTabBusyError = \(err\) =>/);
  assert.match(source, /const retryableConversationExportReason = \(err\) =>/);
  assert.match(source, /evaluateConversationRetryDelayForJobFsm/);
  assert.match(retryRecoverySource, /evaluateConversationRetryDelayForJobFsm/);
  assert.match(retryRecoverySource, /GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_LIMIT/);
  assert.match(source, /tab_operation_in_progress/);
  assert.match(source, /stale_conversation_dom/);
  assert.match(source, /conversation_not_ready/);
  assert.match(source, /const downloadConversationItemWithRetry = async/);
  assert.match(source, /RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT/);
  assert.doesNotMatch(source, /RECENT_CHATS_TAB_BUSY_RETRY_LIMIT/);
  assert.match(
    operationSource,
    /downloadConversationItemWithRetry\(\s*job,\s*client,\s*conversation/,
  );
  assert.match(jobBlock, /const key = normalizeConversationChatId\(conversation\);/);
  assert.doesNotMatch(
    jobBlock,
    /stripGeminiPrefix\(conversation\.chatId \|\| conversation\.id\)\s*\|\|\s*conversation\.url/,
    'export recente nao pode deduplicar/exportar conversa sem chatId real',
  );
});

test('recent export loop delegates one item to conversation operation runner', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(operationSource, /conversation-operation-runner\.js/);
  assert.match(operationSource, /runConversationOperation/);
  assert.match(operationSource, /runConversationOperation\(\{/);
  assert.match(operationSource, /resolveDates:/);
  assert.match(operationSource, /save:/);
  assert.match(operationSource, /buildExportDateImportBatchEvidenceForPayloads\(/);
  assert.match(operationSource, /_exportDateImportGroupedEvidence: batchEvidence\?\.groupedByKey/);
  assert.match(operationSource, /job\.dateImport = \{/);
  assert.match(operationSource, /myActivity: args\._exportDateImportActivitySummary/);
  assert.match(operationSource, /const failure = \{\s*\.\.\.deps\.buildConversationExportFailure/);
  assert.match(operationSource, /operationId,/);
  assert.match(operationSource, /batchPosition: target\.batchPosition/);
  assert.match(operationSource, /historyIndex: target\.historyIndex/);
  assert.match(operationSource, /receipts: err\?\.data\?\.receipts \|\| err\?\.receipts \|\| null/);
});

test('reexport de chatIds conhecidos roda como job em background', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const selectionSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'direct-reexport-selection.ts'),
    'utf-8',
  );
  const jobBlock = source.match(
    /const runDirectChatsExportJob = async[\s\S]*?\nconst startDirectChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runDirectChatsExportJob deve existir');
  assert.match(source, /name: 'gemini_reexport_chats'/);
  assert.match(source, /const startDirectChatsExportJob = \(client, args = \{\}\) =>/);
  assert.match(source, /const runDirectChatsExportJob = async/);
  assert.match(source, /normalizeDirectReexportSelection\(args/);
  assert.match(selectionSource, /parseChatId\(idLike\)/);
  assert.match(selectionSource, /canonicalGeminiChatUrl\(chatId\)/);
  assert.match(source, /writeExportReport\(\s*'direct-chats'/);
  assert.match(source, /findRunningBrowserExportJob\(client\)/);
  assert.match(source, /DIRECT_REEXPORT_RETRY_LIMIT/);
  assert.match(jobBlock, /downloadConversationItemWithRetry\(job, client, conversation/);
  assert.match(source, /'gemini_reexport_chats'/);
  assert.match(source, /url\.pathname === '\/agent\/reexport-chats'/);
});

test('reexport direto retoma pelo relatório sem baixar tudo de novo', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const jobBlock = source.match(
    /const runDirectChatsExportJob = async[\s\S]*?\nconst startDirectChatsExportJob/,
  )?.[0];
  const startBlock = source.match(
    /const startDirectChatsExportJob = \(client, args = \{\}\) =>[\s\S]*?\nconst downloadNotebookChatForClient/,
  )?.[0];
  const endpointBlock = source.match(
    /url\.pathname === '\/agent\/reexport-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-jobs'\)/,
  )?.[0];
  assert.ok(jobBlock, 'runDirectChatsExportJob deve existir');
  assert.ok(startBlock, 'startDirectChatsExportJob deve existir');
  assert.ok(endpointBlock, 'endpoint de reexport deve existir');
  assert.match(source, /const loadDirectChatsResumeCheckpoint = \(filePath\) =>/);
  assert.match(source, /report\.job\.type !== 'direct-chats-export'/);
  assert.match(startBlock, /const resumeReportFile = args\.resumeReportFile \|\| args\.reportFile/);
  assert.match(startBlock, /loadDirectChatsResumeCheckpoint\(resumeReportFile\)/);
  assert.match(startBlock, /const resumedCompletedChatIds = new Set/);
  assert.match(startBlock, /items\.filter\(\(item\) => !resumedCompletedChatIds\.has\(item\.chatId\)\)/);
  assert.match(startBlock, /pendingItems,/);
  assert.match(startBlock, /completed: resumedCompletedCount/);
  assert.match(jobBlock, /const successes = Array\.isArray\(job\.resumedSuccesses\)/);
  assert.match(jobBlock, /const pendingItems = Array\.isArray\(job\.pendingItems\)/);
  assert.match(jobBlock, /for \(let i = 0; i < pendingItems\.length; i \+= 1\)/);
  assert.match(jobBlock, /rebindExportJobToClient\(job, resultClient, 'conversation-download'\)/);
  assert.match(jobBlock, /job\.completed = Math\.min\(job\.requested, resumedCompletedCount \+ i \+ 1\)/);
  assert.match(endpointBlock, /\.\.\.bodySelector/);
  assert.match(source, /action: 'reexport'/);
  assert.match(source, /selectionFile: job\.selectionFile/);
  assert.match(source, /expectedCount: job\.expectedCount/);
});

test('reexport direto preserva destino por item para reparos do vault', () => {
  const selectionSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'direct-reexport-selection.ts'),
    'utf-8',
  );
  const recordingSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-job-recording.ts'),
    'utf-8',
  );
  const dateImportRuntimeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-date-import-runtime.ts'),
    'utf-8',
  );

  assert.match(selectionSource, /outputDirForDirectReexportItem/);
  assert.match(
    dateImportRuntimeSource,
    /outputDirForDirectReexportItem\(collected\.conversation, args\.outputDir\)/,
  );
  assert.match(
    recordingSource,
    /outputDirForDirectReexportItem\(conversation, input\.job\.outputDir\)/,
  );
});

test('reexport direto preserva origem sidebar para navegação SPA', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp', 'direct-reexport-selection.ts'), 'utf-8');
  const normalizeBlock = source.match(
    /export const normalizeDirectReexportSelection = \([\s\S]*?\n\};/,
  )?.[0];
  assert.ok(normalizeBlock, 'normalizeDirectReexportSelection deve existir');
  assert.match(normalizeBlock, /source: item\.source \|\| 'direct-url'/);
  assert.doesNotMatch(
    normalizeBlock,
    /source: 'direct-url'/,
    'selection-file vindo do sidebar nao pode ser degradado para direct-url',
  );
});

test('job em lote reata progresso ao client novo quando a mesma aba reconecta', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const matchBlock = source.match(
    /const browserExportJobMatchesClient = \(job, clientOrId\) => \{[\s\S]*?\n\};/,
  )?.[0];
  const rebindBlock = source.match(
    /const rebindExportJobToClient = \(job, client, reason = 'client-reconnected'\) => \{[\s\S]*?\n\};/,
  )?.[0];
  const rebroadcastBlock = source.match(
    /const rebroadcastActiveBrowserExportJobForClient = \(client, reason = 'client-upsert'\) => \{[\s\S]*?\n\};/,
  )?.[0];
  const upsertBlock = source.match(
    /const upsertClient = \(payload, meta = \{\}\) => \{[\s\S]*?\n\};\n\nconst upsertClientSnapshot/,
  )?.[0];

  assert.ok(matchBlock, 'matcher de job por client deve existir');
  assert.ok(rebindBlock, 'rebind de job por client deve existir');
  assert.ok(rebroadcastBlock, 'rebroadcast de progresso deve existir');
  assert.ok(upsertBlock, 'upsertClient deve existir');
  assert.match(matchBlock, /job\.tabClaimId/);
  assert.match(matchBlock, /exportJobTabId\(job\)/);
  assert.match(rebindBlock, /job_client_rebound/);
  assert.match(rebindBlock, /job\.clientId = client\.clientId/);
  assert.match(rebindBlock, /job\.tabSession\.clientId = client\.clientId/);
  assert.match(rebroadcastBlock, /findRunningBrowserExportJob\(client\)/);
  assert.match(rebroadcastBlock, /broadcastDirectChatsJobProgress\(job, client\)/);
  assert.match(rebroadcastBlock, /broadcastRecentChatsJobProgress\(job, client\)/);
  assert.match(upsertBlock, /rebroadcastActiveBrowserExportJobForClient\(next, 'client-upsert'\)/);
});

test('cancelamento preso vira terminal depois da janela de seguranca', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /EXPORT_CANCEL_REQUEST_STALE_MS/);
  assert.match(source, /const maybeFinalizeStaleCancelRequestedJob = \(job, client = null/);
  assert.match(source, /job\.status = 'cancelled'/);
  assert.match(source, /job_cancel_finalized/);
  assert.match(source, /maybeFinalizeStaleCancelRequestedJob\(running, client, 'cancel-stale-before-new-job'\)/);
  assert.match(source, /maybeFinalizeStaleCancelRequestedJob\(job, clients\.get\(job\.clientId\), 'cancel-stale-status'\)/);
});

test('progresso visual de reexport selecionado usa linguagem humana', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const broadcastDirectChatsJobProgress = \(job, client, patch = \{\}\) =>[\s\S]*?\n};/,
  )?.[0];
  assert.ok(block, 'broadcastDirectChatsJobProgress deve existir');
  assert.match(block, /Baixando conversa selecionada/);
  assert.match(block, /Preparando conversas selecionadas/);
  assert.match(block, /const current = patch\.current \?\? completed/);
  assert.match(block, /workflow:\s*'direct-reexport'/);
  assert.doesNotMatch(block, /MCP reexportando/);
  assert.doesNotMatch(block, /reexportando/);
});
