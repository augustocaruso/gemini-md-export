import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const loadModule = async () => import('../build/ts/mcp/export-workflows.js');

const markdownFor = (chatId, body = '## 🧑 Usuário\n\nPergunta sensível\n\n---\n\n## 🤖 Gemini\n\nResposta sensível\n') => `---
type: gemini_chat
chat_id: ${chatId}
title: "Teste"
url: https://gemini.google.com/app/${chatId}
turn_count: 1
tags: [gemini-export]
---

${body}`;

test('MCP export integrity accepts proven chat snapshot before write', async () => {
  const { validateMcpExportPayloadBeforeWrite } = await loadModule();
  const result = validateMcpExportPayloadBeforeWrite(
    {
      chatId: 'b8e7c075effe9457',
      title: 'Teste',
      url: 'https://gemini.google.com/app/b8e7c075effe9457',
      filename: 'b8e7c075effe9457.md',
      content: markdownFor('b8e7c075effe9457'),
      turns: [
        { role: 'user', text: 'Pergunta sensível' },
        { role: 'assistant', text: 'Resposta sensível' },
      ],
      metrics: { counters: { turnCount: 1 } },
    },
    { expectedChatId: 'b8e7c075effe9457' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.chatId, 'b8e7c075effe9457');
  assert.equal(result.assistantTurnCount, 1);
  assert.equal(result.snapshot.turns.length, 2);
  assert.equal(result.evidence[0].confidence, 'strong');
  assert.doesNotMatch(JSON.stringify(result.evidence), /Pergunta sensível|Resposta sensível/);
});

test('MCP export integrity blocks mismatched chat identity before write', async () => {
  const { validateMcpExportPayloadBeforeWrite } = await loadModule();
  const result = validateMcpExportPayloadBeforeWrite(
    {
      chatId: 'aaaaaaaaaaaa',
      filename: 'aaaaaaaaaaaa.md',
      content: markdownFor('aaaaaaaaaaaa'),
    },
    { expectedChatId: 'bbbbbbbbbbbb' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'chat_id_mismatch');
  assert.equal(result.requestedChatId, 'bbbbbbbbbbbb');
  assert.equal(result.observedChatId, 'aaaaaaaaaaaa');
  assert.doesNotMatch(JSON.stringify(result.evidence), /Pergunta sensível|Resposta sensível/);
});

test('MCP export integrity rejects synthetic or missing chat identity', async () => {
  const { validateMcpExportPayloadBeforeWrite } = await loadModule();
  const result = validateMcpExportPayloadBeforeWrite({
    chatId: 'chat-0',
    filename: 'chat-0.md',
    content: markdownFor('chat-0'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'identity_unproven');
});

test('export workflow rejects unclaimed native broker tabs', async () => {
  const { validateExportTabLease } = await loadModule();

  assert.throws(
    () =>
      validateExportTabLease({
        tabId: 42,
        url: 'https://gemini.google.com/app/abc123456789',
      }),
    /claimed_debuggable_tab_required/,
  );
});

test('export workflow preserves native claim visual tabs for deterministic release', async () => {
  const { validateExportTabLease } = await loadModule();

  const lease = validateExportTabLease({
    claimId: 'claim-1',
    tabId: 42,
    url: 'https://gemini.google.com/app/abc123456789',
    visual: {
      mode: 'tab-group',
      tabId: 42,
      tabIds: [42, 99],
      groupId: 777,
    },
  });

  assert.deepEqual(lease.visual.tabIds, [42, 99]);
});

test('MCP validates export payload before writing files', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const dateImportRuntimeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-date-import-runtime.ts'),
    'utf-8',
  );
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0];
  const saveBlock = source.match(
    /const saveCollectedConversationPayload = async[\s\S]*?\nconst downloadConversationItemForClient/,
  )?.[0];
  assert.ok(collectBlock, 'collectConversationItemPayloadForClient deve existir');
  assert.ok(saveBlock, 'saveCollectedConversationPayload deve existir');

  const validateIndex = collectBlock.indexOf('validateMcpExportPayload(result.payload');
  const enrichIndex = dateImportRuntimeSource.indexOf('enrichExportPayloadWithDates');
  const writeIndex = dateImportRuntimeSource.indexOf('writeExportPayloadBundle(dateImport.payload');
  assert.ok(validateIndex > -1, 'MCP deve validar payload antes de gravar');
  assert.ok(enrichIndex > -1, 'MCP deve enriquecer metadata antes de gravar');
  assert.ok(writeIndex > -1, 'MCP deve gravar payload depois de validar');
  assert.ok(validateIndex > -1 && writeIndex > -1, 'validacao e escrita precisam existir');
  assert.ok(enrichIndex < writeIndex, 'datas precisam ser resolvidas antes de writeExportPayloadBundle');
  assert.match(dateImportRuntimeSource, /integrity: \{/);
  assert.match(source, /validateExportTabLeaseForJob/);
  assert.match(source, /validateNativeExportTabLeaseForJob/);
  assert.match(source, /shouldRequireNativeExportTabLease/);
});

test('MCP export prefers private read before falling back to DOM command', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0];

  assert.ok(collectBlock, 'collectConversationItemPayloadForClient deve existir');

  const privateAttemptIndex = collectBlock.indexOf('privateRead.collectExport');
  const prepareIndex = collectBlock.indexOf('ensureClientActiveForExport(client, args)');
  const domCommandIndex = collectBlock.indexOf("'get-chat-by-id'");
  assert.ok(privateAttemptIndex > -1, 'export real deve tentar private_read antes do DOM');
  assert.ok(prepareIndex > -1, 'fallback DOM ainda deve preparar a aba quando necessario');
  assert.ok(domCommandIndex > -1, 'fallback DOM deve continuar existindo');
  assert.ok(
    privateAttemptIndex < prepareIndex,
    'private_read precisa rodar antes de ativar/preparar aba para fallback DOM',
  );
  assert.ok(
    privateAttemptIndex < domCommandIndex,
    'private_read precisa rodar antes do comando DOM get-chat-by-id',
  );
  assert.match(source, /createMcpPrivateReadRuntimes/);
});

test('recent export report preserves activity companion evidence', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reportSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'export-job-reports.ts'), 'utf-8');
  const reportBlock = reportSource.match(
    /export const buildRecentChatsExportReportPayload[\s\S]*?\n\}\);/,
  )?.[0];

  assert.ok(reportBlock, 'buildRecentChatsExportReport deve existir');
  assert.match(source, /buildRecentChatsExportReportPayload/);
  assert.match(reportBlock, /activityCompanion: job\.activityCompanion \|\| null/);
});

test('recent export reloads the tab only when command client disappears before retry', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const recoveryPolicySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'conversation-retry-recovery.ts'),
    'utf-8',
  );
  const retryBlock = source.match(
    /const downloadConversationItemWithRetry = async[\s\S]*?\n\};\n\nconst downloadChatForClient/,
  )?.[0];

  assert.ok(retryBlock, 'downloadConversationItemWithRetry deve existir');
  assert.match(source, /conversation-retry-recovery\.js/);
  assert.match(retryBlock, /shouldRecoverTabBeforeConversationRetry\(retryReason\)/);
  assert.match(retryBlock, /recoverBrowserTabAfterWatchdog\(\s*job,\s*retryReason/);
  assert.match(recoveryPolicySource, /no_command_client_available['"`]/);
  assert.doesNotMatch(recoveryPolicySource, /stale_conversation_dom['"`]\s*\]/);
});

test('recent export recovery waits for a fresh matching command-ready client after reload', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const runtimeHelperSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'mcp-server-runtime-helpers.ts'),
    'utf-8',
  );
  const waitBlock = source.match(
    /const waitForContinuationClient = async[\s\S]*?\n\};\n\nconst enqueueCommandWithClientRecovery/,
  )?.[0];

  assert.ok(waitBlock, 'waitForContinuationClient deve existir');
  assert.match(operationSource, /minRuntimeSignalAt: reloadStartedAt/);
  assert.match(operationSource, /requireExpectedBrowserExtension: true/);
  assert.match(operationSource, /requireCommandReady: true/);
  assert.match(waitBlock, /waitForContinuationClientWithRecovery/);
  assert.match(runtimeHelperSource, /minRuntimeSignalAt/);
  assert.match(runtimeHelperSource, /clientRuntimeSignalAt/);
  assert.match(waitBlock, /clientMatchesExpectedBrowserExtension/);
  assert.match(source, /validateRecoveredBrowserClientLifecycle/);
  assert.match(source, /getGeminiClientLifecycle/);
  assert.match(source, /hydrateClientLifecycleFields/);
  assert.match(source, /activeClaimableGeminiClientOptions/);
  assert.match(runtimeHelperSource, /validateRecoveredClient\(liveCandidate\)\.ok !== true/);
});

test('recent export job validates native lease before creating job', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const endpointBlock = source.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-missing-chats'\)/,
  )?.[0];
  const jobArgsBlock = source.match(
    /const prepareNativeExportJobArgs = async[\s\S]*?\n\};\n\nconst assertClientClaimedReadyForSession/,
  )?.[0];

  assert.ok(endpointBlock, 'export recent endpoint deve existir');
  assert.ok(jobArgsBlock, 'helper de argumentos do export deve existir');
  assert.match(endpointBlock, /prepareNativeExportJobArgs\(client/);
  assert.match(jobArgsBlock, /claimNativeExportLeaseForJob/);
  assert.match(jobArgsBlock, /withNativeExportLease/);
  assert.match(nativeGateSource, /validateNativeExportTabLeaseForJob/);
  assert.ok(
    jobArgsBlock.indexOf('claimNativeExportLeaseForJob') <
      jobArgsBlock.indexOf('withNativeExportLease') &&
      endpointBlock.indexOf('prepareNativeExportJobArgs') <
        endpointBlock.indexOf('startRecentChatsExportJob'),
    'lease nativa precisa ser validada antes de criar job',
  );
});
