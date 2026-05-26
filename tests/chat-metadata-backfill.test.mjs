import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('gemini-cli-extension', 'scripts', 'chat-metadata-backfill.mjs');

const makeVault = () => mkdtempSync(resolve(tmpdir(), 'gme-metadata-backfill-'));

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

const writeChat = (vault, chatId, content) => {
  const path = resolve(vault, `${chatId}.md`);
  writeFileSync(path, content, 'utf-8');
  return path;
};

test('metadata backfill normaliza YAML mesmo sem datas confiáveis e não vaza texto no relatório', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
exported_at: 2026-05-17T18:55:08.245Z
model: "2.5 Pro"
source: gemini-web
tags: [gemini-export]
---

## 🧑 Usuário

Texto sensível sobre ISRS

---

## 🤖 Gemini

Resposta sensível da IA sobre serotonina
`,
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        assert.match(error.stdout, /1 pendente/);
        return true;
      },
    );

    const updated = readFileSync(chatPath, 'utf-8');
    assert.match(updated, /^---\ntype: gemini_chat\nchat_id: b8e7c075effe9457\n/);
    assert.match(updated, /\ndate_exported: 2026-05-17T18:55:08Z\n/);
    assert.match(updated, /\nturn_count: 1\n/);
    assert.doesNotMatch(updated, /\nsource:/);
    assert.doesNotMatch(updated, /\nexported_at:/);
    assert.doesNotMatch(updated, /\ndate_created:/);
    assert.doesNotMatch(updated, /\ndate_last_message:/);

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.ok, false);
    assert.deepEqual(report.contract, {
      ok: false,
      status: 'blocked',
      code: 'metadata_unresolved',
      message: '1 chat sem datas completas.',
      unresolvedChatIds: ['b8e7c075effe9457'],
    });
    assert.equal(report.summary.totalChats, 1);
    assert.equal(report.summary.filesRewritten, 1);
    assert.equal(report.summary.datesMatched, 0);
    assert.equal(report.summary.exportErrors, 0);
    assert.equal(report.items[0].status, 'unresolved');
    assert.doesNotMatch(reportText, /Texto sensível/);
    assert.doesNotMatch(reportText, /serotonina/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill pode diagnosticar sem escrever datas nem normalizar YAML', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
url: https://gemini.google.com/app/b8e7c075effe9457
exported_at: 2026-05-17T18:55:08.245Z
source: gemini-web
tags: [gemini-export]
---

## 🧑 Usuário

Texto sensível sobre ISRS

---

## 🤖 Gemini

Resposta sensível da IA sobre serotonina
`,
  );
  const before = readFileSync(chatPath, 'utf-8');

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--report', reportPath, '--diagnose-only'], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        return true;
      },
    );

    assert.equal(readFileSync(chatPath, 'utf-8'), before);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.diagnoseOnly, true);
    assert.equal(report.summary.filesRewritten, 0);
    assert.equal(report.items[0].status, 'unresolved');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill bloqueia quando qualquer chat fica sem data completa', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  writeChat(
    vault,
    'aaaaaaaaaaaa',
    `---
chat_id: aaaaaaaaaaaa
title: "Completo"
url: https://gemini.google.com/app/aaaaaaaaaaaa
date_created: 2026-05-10T06:46:09Z
date_last_message: 2026-05-10T07:12:31Z
tags: [gemini-export]
---

## 🧑 Usuário

chat completo

---

## 🤖 Gemini

resposta completa
`,
  );
  writeChat(
    vault,
    'bbbbbbbbbbbb',
    `---
chat_id: bbbbbbbbbbbb
title: "Pendente"
url: https://gemini.google.com/app/bbbbbbbbbbbb
tags: [gemini-export]
---

## 🧑 Usuário

chat pendente

---

## 🤖 Gemini

resposta pendente
`,
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /1\/2 com datas completas/);
        assert.match(error.stdout, /1 pendente/);
        return true;
      },
    );

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.ok, false);
    assert.equal(report.contract.status, 'blocked');
    assert.equal(report.contract.code, 'metadata_unresolved');
    assert.deepEqual(report.contract.unresolvedChatIds, ['bbbbbbbbbbbb']);
    assert.equal(report.summary.filesRewritten, 2);
    assert.equal(report.summary.datesMatched, 1);
    assert.equal(report.summary.unresolved, 1);
    assert.equal(report.summary.exportErrors, 0);
    assert.equal(report.items.find((item) => item.chatId === 'aaaaaaaaaaaa').status, 'matched');
    assert.equal(report.items.find((item) => item.chatId === 'bbbbbbbbbbbb').status, 'unresolved');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill usa My Activity via bridge e grava checkpoint retomável', async () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Primeiro prompt sensível

---

## 🤖 Gemini

Primeira resposta sensível

---

## 🧑 Usuário

Último prompt sensível

---

## 🤖 Gemini

Última resposta sensível
`,
  );

  let activityPayload = null;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/agent/activity-scan') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    activityPayload = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        matches: [
          {
            chatId: 'b8e7c075effe9457',
            date: '2026-05-10T06:46:09Z',
            score: 0.96,
            kind: 'created',
            textHash: 'hash-created',
          },
          {
            chatId: 'b8e7c075effe9457',
            date: '2026-05-10T07:12:31Z',
            score: 0.91,
            kind: 'last_message',
            textHash: 'hash-last',
          },
        ],
        checkpoint: {
          lastSeenActivityToken: 'token-2',
          loadedCardCount: 42,
          resolvedChatIds: ['b8e7c075effe9457'],
        },
      }),
    );
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    await execFileAsync(
      process.execPath,
      [
        SCRIPT,
        vault,
        '--use-my-activity',
        '--bridge-url',
        `http://127.0.0.1:${port}`,
        '--report',
        reportPath,
      ],
      { cwd: resolve('.'), stdio: 'pipe', encoding: 'utf-8' },
    );

    assert.equal(activityPayload.candidates[0].chatId, 'b8e7c075effe9457');
    assert.equal(activityPayload.candidates[0].title, 'Exemplo');
    assert.match(activityPayload.candidates[0].firstPrompt, /Primeiro prompt sensível/);
    assert.equal(activityPayload.openDetails, true);
    assert.equal(activityPayload.openIfMissing, true);

    const updated = readFileSync(chatPath, 'utf-8');
    assert.match(updated, /\ndate_created: 2026-05-10T06:46:09Z\n/);
    assert.match(updated, /\ndate_last_message: 2026-05-10T07:12:31Z\n/);
    assert.match(updated, /\nturn_count: 2\n/);

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.activityCheckpoint.lastSeenActivityToken, 'token-2');
    assert.equal(report.items[0].status, 'matched');
    assert.doesNotMatch(reportText, /Primeiro prompt sensível/);
    assert.doesNotMatch(reportText, /Última resposta sensível/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill aborta My Activity travado e ainda escreve relatório acionável', async () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Primeiro prompt sensível

---

## 🤖 Gemini

Primeira resposta sensível
`,
  );

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/agent/activity-scan') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          SCRIPT,
          vault,
          '--use-my-activity',
          '--bridge-url',
          `http://127.0.0.1:${port}`,
          '--report',
          reportPath,
        ],
        {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
          env: {
            ...process.env,
            GEMINI_MD_EXPORT_ACTIVITY_SCAN_TIMEOUT_MS: '60',
          },
        },
      ),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        return true;
      },
    );

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.ok, false);
    assert.equal(report.activityError.code, 'activity_scan_timeout');
    assert.equal(report.contract.code, 'activity_scan_failed');
    assert.equal(report.items[0].status, 'unresolved');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill usa Takeout HTML de Gemini Apps sem chat_id por matching de conteúdo', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
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
`,
  );

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Primeiro prompt sensível de fixture HTML<br>10 de mai. de 2026, 03:46:09 BRT<br><p>Primeira resposta sensível de fixture HTML</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Último prompt sensível de fixture HTML<br>10 de mai. de 2026, 04:12:31 BRT<br><p>Última resposta sensível de fixture HTML</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
      cwd: resolve('.'),
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const updated = readFileSync(chatPath, 'utf-8');
    assert.match(updated, /\ndate_created: 2026-05-10T06:46:09Z\n/);
    assert.match(updated, /\ndate_last_message: 2026-05-10T07:12:31Z\n/);

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.items[0].status, 'matched');
    assert.equal(report.items[0].evidence[0].source, 'takeout-html');
    assert.equal(report.summary.exportErrors, 0);
    assert.doesNotMatch(reportText, /Primeiro prompt sensível/);
    assert.doesNotMatch(reportText, /Última resposta sensível/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill nao completa chat multi-turn usando uma unica evidencia Takeout unknown', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
title: "Exemplo com bordas incompletas"
url: https://gemini.google.com/app/b8e7c075effe9457
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Primeiro prompt sensível que nao aparece no Takeout

---

## 🤖 Gemini

Primeira resposta sensível que nao aparece no Takeout

---

## 🧑 Usuário

Último prompt sensível que também nao aparece no Takeout

---

## 🤖 Gemini

Última resposta sensível exclusiva usada como amostra
`,
  );

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Texto de outro card sem borda do chat<br>10 de mai. de 2026, 04:12:31 BRT<br><p>Exemplo com bordas incompletas</p><p>Última resposta sensível exclusiva usada como amostra</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        return true;
      },
    );

    const updated = readFileSync(chatPath, 'utf-8');
    assert.doesNotMatch(updated, /\ndate_created:/);
    assert.doesNotMatch(updated, /\ndate_last_message:/);

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.ok, false);
    assert.equal(report.items[0].status, 'export_error');
    assert.equal(report.items[0].dateCreated, null);
    assert.equal(report.items[0].dateLastMessage, null);
    assert.equal(report.items[0].dateResolution.chatShape, 'multi_turn');
    assert.equal(report.items[0].dateResolution.unknownEvidencePolicy, 'ignored_for_multi_turn');
    assert.equal(report.items[0].dateResolution.hasCreatedEdge, false);
    assert.equal(report.items[0].dateResolution.hasLastMessageEdge, false);
    assert.equal(report.items[0].evidence[0].kind, 'unknown');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill permite evidencia Takeout unknown completar apenas chat de um turno', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const chatPath = writeChat(
    vault,
    'b8e7c075effe9457',
    `---
chat_id: b8e7c075effe9457
title: "Exemplo single-turn"
url: https://gemini.google.com/app/b8e7c075effe9457
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Prompt que nao aparece no Takeout

---

## 🤖 Gemini

Resposta single-turn exclusiva usada como amostra
`,
  );

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Texto de card sem prompt do chat<br>10 de mai. de 2026, 04:12:31 BRT<br><p>Exemplo single-turn</p><p>Resposta single-turn exclusiva usada como amostra</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
      cwd: resolve('.'),
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const updated = readFileSync(chatPath, 'utf-8');
    assert.match(updated, /\ndate_created: 2026-05-10T07:12:31Z\n/);
    assert.match(updated, /\ndate_last_message: 2026-05-10T07:12:31Z\n/);

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.items[0].status, 'matched');
    assert.equal(report.items[0].dateResolution.chatShape, 'single_turn');
    assert.equal(report.items[0].dateResolution.unknownEvidencePolicy, 'used_for_single_turn');
    assert.equal(report.items[0].dateResolution.hasCreatedEdge, false);
    assert.equal(report.items[0].dateResolution.hasLastMessageEdge, false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill diagnostica raw export suspeito quando Takeout nao contem evidencia', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  writeChat(
    vault,
    'cccccccccccc',
    `---
chat_id: cccccccccccc
title: "Raw suspeito"
url: https://gemini.google.com/app/cccccccccccc
date_exported: 2026-05-17T18:55:08Z
tags: [gemini-export]
---

## 🧑 Usuário

Texto sensível raw exclusivo que não está no Takeout

---

## 🤖 Gemini

Resposta sensível raw exclusiva que também não está no Takeout
`,
  );

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Conteúdo de outro chat totalmente diferente<br>10 de mai. de 2026, 03:46:09 BRT<br><p>Resposta de outro chat diferente</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        assert.match(error.stdout, /1 export raw suspeito/);
        assert.match(error.stdout, /export raw inconsistente/);
        return true;
      },
    );

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.ok, false);
    assert.equal(report.contract.code, 'raw_export_suspected');
    assert.equal(report.summary.exportErrors, 1);
    assert.equal(report.summary.unresolved, 0);
    assert.equal(report.rawExportDiagnostics.enabled, true);
    assert.equal(report.rawExportDiagnostics.diagnosed, 1);
    assert.equal(report.rawExportDiagnostics.byCode.takeout_no_evidence_for_raw_chat, 1);
    assert.equal(report.items[0].status, 'export_error');
    assert.equal(report.items[0].diagnostic.status, 'raw_export_suspected');
    assert.equal(report.items[0].diagnostic.code, 'takeout_no_evidence_for_raw_chat');
    assert.equal(report.items[0].diagnostic.repair.action, 'reexport_chat');
    assert.doesNotMatch(reportText, /Texto sensível raw exclusivo/);
    assert.doesNotMatch(reportText, /Resposta sensível raw exclusiva/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill diferencia Takeout de fonte errada de raw export corrompido em massa', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const chatIds = [
    'aaa000000001',
    'aaa000000002',
    'aaa000000003',
    'aaa000000004',
    'aaa000000005',
    'aaa000000006',
    'aaa000000007',
    'aaa000000008',
    'aaa000000009',
    'aaa00000000a',
  ];

  for (const [index, chatId] of chatIds.entries()) {
    writeChat(
      vault,
      chatId,
      `---
chat_id: ${chatId}
title: "Chat ${index + 1}"
url: https://gemini.google.com/app/${chatId}
date_exported: 2026-05-17T18:55:08Z
turn_count: 1
tags: [gemini-export]
---

## 🧑 Usuário

Prompt unico do export web ${index + 1} com texto identificavel

---

## 🤖 Gemini

Resposta unica do export web ${index + 1}
`,
    );
  }

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Prompt unico do export web 1 com texto identificavel<br>10 de mai. de 2026, 03:46:09 BRT<br><p>Resposta unica do export web 1</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /1\/10 com datas completas/);
        assert.match(error.stdout, /9 fonte incompatível/);
        return true;
      },
    );

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.ok, false);
    assert.equal(report.contract.code, 'takeout_source_mismatch');
    assert.match(report.contract.message, /nao pertencer ao Takeout informado/);
    assert.equal(report.summary.matched, 1);
    assert.equal(report.summary.exportErrors, 0);
    assert.equal(report.summary.sourceMismatches, 9);
    assert.equal(report.rawExportDiagnostics.byCode.takeout_source_mismatch_for_raw_chat, 9);
    assert.equal(report.items[0].status, 'matched');
    assert.equal(report.items[1].status, 'source_mismatch');
    assert.equal(report.items[1].diagnostic.status, 'takeout_source_mismatch');
    assert.equal(report.items[1].diagnostic.repair.action, 'use_matching_takeout_or_browser_profile');
    assert.equal(report.items[1].diagnostic.evidence.corpus.sourceMismatchLikely, true);
    assert.doesNotMatch(reportText, /Prompt unico do export web 2/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('metadata backfill separa chat sem atividade do usuario de export raw corrompido', () => {
  const vault = makeVault();
  const reportPath = resolve(vault, 'report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  writeChat(
    vault,
    'dddddddddddd',
    `---
chat_id: dddddddddddd
title: "Boas-vindas"
url: https://gemini.google.com/app/dddddddddddd
date_exported: 2026-05-17T18:55:08Z
turn_count: 1
tags: [gemini-export]
---

## 🤖 Gemini

Resposta de boas-vindas gerada sem prompt do usuario e ausente do Takeout
`,
  );

  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Conteúdo de outro chat totalmente diferente<br>10 de mai. de 2026, 03:46:09 BRT<br><p>Resposta de outro chat diferente</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, vault, '--takeout', takeoutPath, '--report', reportPath], {
          cwd: resolve('.'),
          stdio: 'pipe',
          encoding: 'utf-8',
        }),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(error.stdout, /0\/1 com datas completas/);
        assert.match(error.stdout, /1 lacuna/);
        assert.match(error.stdout, /falta de atividade do usuario/);
        return true;
      },
    );

    const reportText = readFileSync(reportPath, 'utf-8');
    const report = JSON.parse(reportText);
    assert.equal(report.ok, false);
    assert.equal(report.contract.code, 'takeout_source_gap');
    assert.equal(report.summary.exportErrors, 0);
    assert.equal(report.summary.sourceGaps, 1);
    assert.equal(report.rawExportDiagnostics.byCode.takeout_no_user_activity_for_assistant_only_chat, 1);
    assert.equal(report.items[0].status, 'source_gap');
    assert.equal(report.items[0].diagnostic.status, 'takeout_source_gap');
    assert.equal(report.items[0].diagnostic.code, 'takeout_no_user_activity_for_assistant_only_chat');
    assert.equal(report.items[0].diagnostic.repair.action, 'inspect_takeout_source');
    assert.doesNotMatch(reportText, /Resposta de boas-vindas/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
