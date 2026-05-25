import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildExportDateImportActivityScanCandidates,
  buildExportDateImportBatchEvidence,
  buildExportDateImportBatchEvidenceFromMatches,
  createExportDateImportContext,
  enrichExportPayloadWithMetadataDates,
  mergeExportDateImportBatchEvidenceWithMatches,
} from '../build/ts/mcp/export-metadata.js';
import {
  DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS,
  DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS,
  buildExportDateImportBatchEvidenceWithActivityFallback,
  defaultDateImportSummary,
  hasDateImportSource,
  shouldUseMyActivityForDateImport,
} from '../build/ts/mcp/export-date-import-runtime.js';
import { validateMcpExportPayloadBeforeWrite } from '../build/ts/mcp/export-workflows.js';

const markdown = `---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Primeiro prompt sensível de fixture HTML

---

## 🤖 Gemini

Primeira resposta sensível de fixture HTML

---

## 🧑 Usuário

Último prompt sensível de fixture HTML

---

## 🤖 Gemini

Última resposta sensível de fixture HTML
`;

const payload = {
  chatId: 'b8e7c075effe9457',
  title: 'Exemplo',
  url: 'https://gemini.google.com/app/b8e7c075effe9457',
  filename: 'b8e7c075effe9457.md',
  content: markdown,
  metrics: { counters: { turnCount: 2 } },
};

test('export date import usa My Activity como fonte default', () => {
  assert.equal(shouldUseMyActivityForDateImport({}), true);
  assert.equal(hasDateImportSource({}), true);
  assert.deepEqual(defaultDateImportSummary({}), {
    enabled: true,
    source: 'my-activity',
    sourceFile: null,
    fallback: 'my-activity',
    pending: true,
  });
  assert.equal(shouldUseMyActivityForDateImport({ noMyActivity: true }), false);
  assert.equal(hasDateImportSource({ noMyActivity: true }), false);
  assert.deepEqual(defaultDateImportSummary({ takeout: '/tmp/Minhaatividade.html' }), {
    enabled: true,
    source: 'takeout+my-activity',
    sourceFile: 'Minhaatividade.html',
    fallback: 'my-activity',
    pending: true,
  });
});

test('export metadata injeta datas do Takeout antes da escrita do Markdown', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-export-metadata-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div><p>Primeira resposta sensível de fixture HTML</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Último prompt sensível de fixture HTML</div><div>10 de mai. de 2026, 04:12:31 BRT</div><p>Última resposta sensível de fixture HTML</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const integrity = validateMcpExportPayloadBeforeWrite(payload, {
      expectedChatId: 'b8e7c075effe9457',
    });
    assert.equal(integrity.ok, true);
    const context = createExportDateImportContext({ takeoutPath });
    const result = enrichExportPayloadWithMetadataDates({ payload, context, integrity });

    assert.equal(result.ok, true);
    assert.equal(result.receipt.status, 'matched');
    assert.equal(result.receipt.dateCreated, '2026-05-10T06:46:09Z');
    assert.equal(result.receipt.dateLastMessage, '2026-05-10T07:12:31Z');
    assert.match(result.payload.content, /\ndate_created: 2026-05-10T06:46:09Z\n/);
    assert.match(result.payload.content, /\ndate_last_message: 2026-05-10T07:12:31Z\n/);

    const finalIntegrity = validateMcpExportPayloadBeforeWrite(result.payload, {
      expectedChatId: 'b8e7c075effe9457',
    });
    assert.equal(finalIntegrity.ok, true);
    assert.equal(finalIntegrity.snapshot.metadata.assistantTurnCount, 2);
    assert.equal(finalIntegrity.snapshot.metadata.dateCreated, '2026-05-10T06:46:09Z');
    assert.equal(finalIntegrity.snapshot.metadata.dateLastMessage, '2026-05-10T07:12:31Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export metadata bloqueia escrita quando Takeout nao fecha datas completas', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-export-metadata-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div><p>Primeira resposta sensível de fixture HTML</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const integrity = validateMcpExportPayloadBeforeWrite(payload, {
      expectedChatId: 'b8e7c075effe9457',
    });
    assert.equal(integrity.ok, true);
    const context = createExportDateImportContext({ takeoutPath });
    const result = enrichExportPayloadWithMetadataDates({ payload, context, integrity });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'metadata_unresolved');
    assert.equal(result.receipt.status, 'partial');
    assert.equal(result.receipt.dateCreated, '2026-05-10T06:46:09Z');
    assert.equal(result.receipt.dateLastMessage, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export metadata usa o lote como universo para desambiguar prompts iguais', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-export-metadata-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  const longAssistantA =
    'Resposta exclusiva alfa com detalhes clínicos suficientes para ancorar este item no Takeout sem vazar conteúdo no relatório.';
  const longAssistantB =
    'Resposta exclusiva beta com detalhes operacionais suficientes para ancorar este outro item no Takeout sem vazar conteúdo.';
  const sharedPrompt = 'Explique este tema';
  const payloadA = {
    chatId: 'aaaaaaaaaaaa',
    filename: 'aaaaaaaaaaaa.md',
    content: `---
chat_id: aaaaaaaaaaaa
title: "A"
url: https://gemini.google.com/app/aaaaaaaaaaaa
tags: [gemini-export]
---

## 🧑 Usuário

${sharedPrompt}

---

## 🤖 Gemini

${longAssistantA}
`,
  };
  const payloadB = {
    chatId: 'bbbbbbbbbbbb',
    filename: 'bbbbbbbbbbbb.md',
    content: payloadA.content
      .replaceAll('aaaaaaaaaaaa', 'bbbbbbbbbbbb')
      .replace('title: "A"', 'title: "B"')
      .replace(longAssistantA, longAssistantB),
  };
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;${sharedPrompt}</div><div>10 de mai. de 2026, 03:46:09 BRT</div><p>${longAssistantA}</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;${sharedPrompt}</div><div>10 de mai. de 2026, 03:47:09 BRT</div><p>${longAssistantB}</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const context = createExportDateImportContext({ takeoutPath });
    const integrityA = validateMcpExportPayloadBeforeWrite(payloadA, { expectedChatId: 'aaaaaaaaaaaa' });
    const integrityB = validateMcpExportPayloadBeforeWrite(payloadB, { expectedChatId: 'bbbbbbbbbbbb' });
    assert.equal(integrityA.ok, true);
    assert.equal(integrityB.ok, true);

    const batch = buildExportDateImportBatchEvidence({
      context,
      entries: [
        { key: 'aaaaaaaaaaaa', payload: payloadA, integrity: integrityA },
        { key: 'bbbbbbbbbbbb', payload: payloadB, integrity: integrityB },
      ],
    });
    assert.equal(batch.candidates, 2);
    assert.equal(batch.groupedByKey.size, 2);
    const enrichedA = enrichExportPayloadWithMetadataDates({
      payload: payloadA,
      context,
      integrity: integrityA,
      groupedEvidence: batch.groupedByKey.get('aaaaaaaaaaaa'),
    });
    assert.equal(enrichedA.ok, true);
    assert.equal(enrichedA.receipt.dateCreated, '2026-05-10T06:46:09Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export metadata injeta datas vindas de My Activity', () => {
  const integrity = validateMcpExportPayloadBeforeWrite(payload, {
    expectedChatId: 'b8e7c075effe9457',
  });
  assert.equal(integrity.ok, true);
  const context = createExportDateImportContext({ useMyActivity: true });
  const batch = buildExportDateImportBatchEvidenceFromMatches({
    context,
    entries: [{ key: 'b8e7c075effe9457', payload, integrity }],
    matches: [
      {
        chatId: 'b8e7c075effe9457',
        source: 'my-activity-web',
        kind: 'created',
        dateKind: 'created',
        confidence: 'strong',
        date: '2026-05-10T06:46:09Z',
        warnings: [],
      },
      {
        chatId: 'b8e7c075effe9457',
        source: 'my-activity-web',
        kind: 'last_message',
        dateKind: 'last_message',
        confidence: 'strong',
        date: '2026-05-10T07:12:31Z',
        warnings: [],
      },
    ],
  });
  const result = enrichExportPayloadWithMetadataDates({
    payload,
    context,
    integrity,
    groupedEvidence: batch.groupedByKey.get('b8e7c075effe9457'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.status, 'matched');
  assert.equal(result.receipt.source, 'my-activity');
  assert.equal(result.receipt.sourceFile, null);
  assert.equal(result.receipt.dateCreated, '2026-05-10T06:46:09Z');
  assert.equal(result.receipt.dateLastMessage, '2026-05-10T07:12:31Z');
  assert.match(result.payload.content, /\ndate_created: 2026-05-10T06:46:09Z\n/);
  assert.match(result.payload.content, /\ndate_last_message: 2026-05-10T07:12:31Z\n/);
});

test('export metadata usa My Activity como fallback quando Takeout fica parcial', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-export-metadata-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div><p>Primeira resposta sensível de fixture HTML</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const integrity = validateMcpExportPayloadBeforeWrite(payload, {
      expectedChatId: 'b8e7c075effe9457',
    });
    assert.equal(integrity.ok, true);
    const context = createExportDateImportContext({ takeoutPath });
    const entries = [{ key: 'b8e7c075effe9457', payload, integrity }];
    const batch = buildExportDateImportBatchEvidence({ context, entries });
    const activityCandidates = buildExportDateImportActivityScanCandidates({
      entries,
      groupedByKey: batch.groupedByKey,
    });

    assert.equal(activityCandidates.length, 1);
    assert.equal(activityCandidates[0].chatId, 'b8e7c075effe9457');

    const merged = mergeExportDateImportBatchEvidenceWithMatches({
      entries,
      context,
      previous: batch,
      matches: [
        {
          chatId: 'b8e7c075effe9457',
          source: 'my-activity-web',
          kind: 'last_message',
          dateKind: 'last_message',
          confidence: 'strong',
          date: '2026-05-10T07:12:31Z',
          warnings: [],
        },
      ],
    });
    const result = enrichExportPayloadWithMetadataDates({
      payload,
      context,
      integrity,
      groupedEvidence: merged.groupedByKey.get('b8e7c075effe9457'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.receipt.source, 'my-activity');
    assert.equal(result.receipt.dateCreated, '2026-05-10T06:46:09Z');
    assert.equal(result.receipt.dateLastMessage, '2026-05-10T07:12:31Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export metadata fallback passa claim visual e espera longa para My Activity', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-export-metadata-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div><p>Primeira resposta sensível de fixture HTML</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const integrity = validateMcpExportPayloadBeforeWrite(payload, {
      expectedChatId: 'b8e7c075effe9457',
    });
    const entries = [{ key: 'b8e7c075effe9457', payload, integrity }];
    let scanArgs = null;
    const batch = await buildExportDateImportBatchEvidenceWithActivityFallback(
      entries,
      {
        takeout: takeoutPath,
        _exportDateImportVisualGroupTabId: 713803072,
      },
      {
        claimLabel: '🔄 Sincroniza',
        scanActivity: async (args) => {
          scanArgs = args;
          return {
            matches: [
              {
                chatId: 'b8e7c075effe9457',
                source: 'my-activity-web',
                kind: 'last_message',
                dateKind: 'last_message',
                confidence: 'strong',
                date: '2026-05-10T07:12:31Z',
                warnings: [],
              },
            ],
            checkpoint: { loadedCardCount: 12 },
            browserWake: { attempted: false },
          };
        },
      },
    );

    assert.equal(scanArgs.visualGroupTabId, 713803072);
    assert.equal(scanArgs.waitMs, DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_WAIT_MS);
    assert.equal(scanArgs.preLaunchWaitMs, DEFAULT_EXPORT_DATE_IMPORT_ACTIVITY_PRE_LAUNCH_WAIT_MS);
    assert.equal(scanArgs.openIfMissing, true);
    assert.equal(scanArgs.openDetails, false);
    assert.equal(scanArgs.claimLabel, '🔄 Sincroniza');
    assert.equal(scanArgs.candidates.length, 1);

    const result = enrichExportPayloadWithMetadataDates({
      payload,
      integrity,
      context: createExportDateImportContext({ takeoutPath, useMyActivity: true }),
      groupedEvidence: batch.groupedByKey.get('b8e7c075effe9457'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.source, 'my-activity');
    assert.equal(result.receipt.dateLastMessage, '2026-05-10T07:12:31Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
