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
  assert.equal(DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS, 15_000);
  assert.equal(DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS, 10_000);
  assert.deepEqual(recentChatsLoadMoreRuntimeConfig({}), {
    loadMoreBudgetMs: 15_000,
    loadMoreBrowserTimeoutMs: 10_000,
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
  assert.match(source, /const commandReadyClients = liveClients\.filter\(commandChannelReadyForClient\)/);
  assert.match(source, /if \(selector\.preferActive === true\)[\s\S]*?activeClients\.length === 1\) return activeClients\[0\]/);
  assert.match(source, /const candidateClients = usefulRecentClients\.length > 0 \? usefulRecentClients : selectableClients/);
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
  assert.match(runtimeSource, /DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS = 15_000/);
  assert.match(runtimeSource, /DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS = 10_000/);
});

test('contagem longa aplica claim visual temporaria na aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /url\.pathname === '\/agent\/recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-recent-chats'\)/,
  )?.[0];
  assert.ok(block, '/agent/recent-chats deve existir');
  assert.match(block, /shouldTemporarilyClaimTab/);
  assert.match(block, /const temporaryClaimArgs = \{ \.\.\.args \}/);
  assert.match(block, /ensureTabClaimForJob\(\s*client,\s*temporaryClaimArgs,\s*args\.countOnly \? TAB_CLAIM_LABELS\.count : TAB_CLAIM_LABELS\.list/);
  assert.match(block, /claimVisibleAtMs = claim \? Date\.now\(\) : null/);
  assert.match(block, /waitForTabClaimMinimumVisibility\(claimVisibleAtMs, args\)/);
  assert.match(block, /temporaryClaimArgs\.ttlMs/);
  assert.match(block, /operationArgs/);
  assert.match(block, /claimId: claim\.claimId/);
  assert.match(block, /releaseClaimOnOperationEnd: shouldAutoReleaseTabClaim\(args\)/);
  assert.match(block, /releaseClaimReason: 'recent-chats-load-more-finished'/);
  assert.match(block, /recent-chats-list-finished/);
  assert.match(block, /tabClaimRelease/);
  assert.match(source, /waitForContinuationClient\(\s*\{\s*clientId: claim\.clientId/);
  assert.match(source, /claimId,\s*tabId: claim\.tabId/);
  assert.match(source, /Math\.min\(COMMAND_TIMEOUT_MS, browserTimeoutMs \+ 15_000\)/);
  assert.match(source, /releaseClaimOnSlowOperationMs/);
});

test('jobs renovam claim existente para recriar indicador visual ausente', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(/const ensureTabClaimForJob = async[\s\S]*?\n};/)?.[0];
  assert.ok(block, 'ensureTabClaimForJob deve existir');
  assert.match(block, /args\.renewExistingClaim === false/);
  assert.match(block, /claimGeminiTabForClient\(client/);
  assert.match(block, /client\.lastTabClaimWarning = warning/);
  assert.match(block, /args\.requireTabClaim === true/);
  assert.match(block, /return null/);
  assert.match(source, /tabClaimWarning: client\.lastTabClaimWarning \|\| null/);
  assert.match(source, /tabClaimWarning: job\.tabClaimWarning \|\| null/);
});

test('export pesado ativa a aba real antes de hidratar conversa', () => {
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
  assert.match(prepareBlock, /activateBrowserTabById\(client\?\.tabId/);
  assert.match(source, /'activate-browser-tab'/);
  assert.match(prepareBlock, /activateTabBeforeExport === true \|\| args\.activateTab === true/);
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
  const recentEndpointBlock = serverSource.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-missing-chats'\)/,
  )?.[0] || '';
  const runExportBlock = cliSource.match(
    /const runExport = async[\s\S]*?\nconst runJob = async/,
  )?.[0] || '';

  assert.match(serverSource, /const prepareClientForBrowserExport = async/);
  assert.match(prepareBlock, /recentExportCandidateClients\(\)/);
  assert.match(prepareBlock, /prepareClientForBrowserExport\(candidates\[0\], selector\)/);
  assert.match(serverSource, /assertActiveClaimableGeminiClient\(\s*\n\s*hydrateClientLifecycleFields\(prepared\.client\)/);
  assert.match(recentEndpointBlock, /const client = await selectRecentExportClient\(selector\)/);
  assert.ok(
    recentEndpointBlock.indexOf('selectRecentExportClient') <
      recentEndpointBlock.indexOf('ensureTabClaimForJob'),
    'export recent precisa ativar/validar a aba antes de criar claim visual',
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
    block.indexOf('partialLoadTargetCount') < block.indexOf('const allConversations = recentConversationsForClient(client)'),
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
  const runtimeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-date-import-runtime.ts'),
    'utf-8',
  );
  const startBlock = source.match(
    /const startRecentChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?\n  const job = \{/,
  )?.[0];
  assert.ok(startBlock, 'startRecentChatsExportJob deve existir');
  assert.match(startBlock, /const activeClaim = claimForClient\(client\)/);
  assert.match(startBlock, /const exportDateImportVisualGroupTabId = normalizeTabId\(activeClaim\?\.tabId \?\? client\.tabId\)/);
  assert.match(startBlock, /args\._exportDateImportVisualGroupTabId = exportDateImportVisualGroupTabId/);
  assert.match(runtimeSource, /DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS = 45_000/);
  assert.match(runtimeSource, /DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS = 8_000/);
  assert.match(runtimeSource, /visualGroupTabId:[\s\S]*args\._exportDateImportVisualGroupTabId/);
  assert.match(runtimeSource, /waitMs: dateImportActivityWaitMs\(args\)/);
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
  assert.match(block, /job\.current = null;\s*job\.batchPosition = null;\s*job\.batchTotal = null;\s*job\.historyIndex = null;\s*job\.operationId = null;/);
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
  assert.match(block, /loadMoreIncomplete/);
  assert.match(block, /allowDomCountConfirmation:\s*!loadMoreBusy && !loadMoreIncomplete/);
  assert.match(block, /minimumKnownCount/);
  assert.match(block, /Nao informe esse numero como "ao todo"/);
  assert.match(block, /Nao chame gemini_chats\/gemini_ready\/gemini_tabs como fallback/);
  assert.match(block, /command: null/);
  assert.match(source, /preferActive/);
  assert.match(source, /activeClients\.length === 1/);
  assert.match(source, /usefulRecentClients/);
  assert.match(source, /recentConversationCountForClient\(client\) > 0 \|\| !!client\.page\?\.chatId/);
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
    assert.match(block, /const client = (?:await selectRecentExportClient\(selector\)|requireClient\(selector\));[\s\S]*?assertNoRunningBrowserExportJob\(client\);[\s\S]*?ensureTabClaimForJob[\s\S]*?start(?:Recent|Direct)ChatsExportJob/);
  }
  assert.match(source, /const assertClientClaimedReadyForSession = \(client, args = \{\}\) =>/);
  assert.match(source, /const startRecentChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?assertClientClaimedReadyForSession\(client, args\)/);
  assert.match(source, /const startDirectChatsExportJob = \(client, args = \{\}\) => \{[\s\S]*?assertClientClaimedReadyForSession\(client, args\)/);
  assert.match(source, /sendAgentError\(res, 503, err\)/);
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
  assert.match(source, /const skipExisting =[\s\S]*!effectiveHasMaxChats/);
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
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const jobBlock = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runRecentChatsExportJob deve existir');
  assert.match(source, /const isTransientTabBusyError = \(err\) =>/);
  assert.match(source, /const retryableConversationExportReason = \(err\) =>/);
  assert.match(source, /tab_operation_in_progress/);
  assert.match(source, /stale_conversation_dom/);
  assert.match(source, /conversation_not_ready/);
  assert.match(source, /const downloadConversationItemWithRetry = async/);
  assert.match(source, /RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT/);
  assert.match(operationSource, /downloadConversationItemWithRetry\(job, client, conversation/);
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
  const jobBlock = source.match(
    /const runDirectChatsExportJob = async[\s\S]*?\nconst startDirectChatsExportJob/,
  )?.[0];
  assert.ok(jobBlock, 'runDirectChatsExportJob deve existir');
  assert.match(source, /name: 'gemini_reexport_chats'/);
  assert.match(source, /const startDirectChatsExportJob = \(client, args = \{\}\) =>/);
  assert.match(source, /const runDirectChatsExportJob = async/);
  assert.match(source, /extractChatIdFromUrl\(idLike\)/);
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

test('reexport direto preserva origem sidebar para navegação SPA', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const normalizeBlock = source.match(
    /const normalizeDirectReexportSelection = \(args = \{\}\) => \{[\s\S]*?\nconst normalizeDirectReexportItems/,
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
