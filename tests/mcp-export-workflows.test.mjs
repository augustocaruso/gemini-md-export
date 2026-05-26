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

test('recent export job validates native lease before creating job', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const endpointBlock = source.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-missing-chats'\)/,
  )?.[0];

  assert.ok(endpointBlock, 'export recent endpoint deve existir');
  assert.match(endpointBlock, /claimNativeExportLeaseForJob/);
  assert.match(endpointBlock, /withNativeExportLease/);
  assert.match(nativeGateSource, /validateNativeExportTabLeaseForJob/);
  assert.ok(
    endpointBlock.indexOf('claimNativeExportLeaseForJob') <
      endpointBlock.indexOf('startRecentChatsExportJob'),
    'lease nativa precisa ser validada antes de criar job',
  );
});
