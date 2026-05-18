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
    execFileSync(process.execPath, [SCRIPT, vault, '--report', reportPath], {
      cwd: resolve('.'),
      stdio: 'pipe',
      encoding: 'utf-8',
    });

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
    assert.equal(report.summary.totalChats, 1);
    assert.equal(report.items[0].status, 'unresolved');
    assert.doesNotMatch(reportText, /Texto sensível/);
    assert.doesNotMatch(reportText, /serotonina/);
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
    assert.match(activityPayload.candidates[0].firstPrompt, /Primeiro prompt sensível/);
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
    assert.doesNotMatch(reportText, /Primeiro prompt sensível/);
    assert.doesNotMatch(reportText, /Última resposta sensível/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
