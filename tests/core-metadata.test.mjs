import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCanonicalFrontmatter, parseFrontmatter } from '../build/ts/core/yaml.js';
import { buildMarkdownChatNote } from '../build/ts/core/markdown-note.js';
import {
  groupMetadataEvidence,
  normalizeComparableText,
  scoreMetadataEvidence,
} from '../build/ts/core/metadata-evidence.js';
import { resolveMetadataDatesForCandidate } from '../build/ts/core/metadata-date-resolution.js';

const rawChat = `---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
exported_at: 2026-05-17T18:55:08.245Z
model: "2.5 Pro"
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

test('core monta nota markdown canonica sem vazar corpo para evidencia', () => {
  const note = buildMarkdownChatNote({
    filePath: '/vault/b8e7c075effe9457.md',
    relativePath: 'b8e7c075effe9457.md',
    raw: rawChat,
  });
  assert.equal(note.chatId, 'b8e7c075effe9457');
  assert.equal(note.metadata.assistantTurnCount, 2);
  assert.equal(note.metadata.dateExported, '2026-05-17T18:55:08Z');
  assert.match(note.scoring.firstPrompt, /Primeiro prompt/);

  const frontmatter = buildCanonicalFrontmatter(note, {
    dateCreated: '2026-05-10T06:46:09Z',
    dateLastMessage: '2026-05-10T07:12:31Z',
  });
  const parsed = parseFrontmatter(frontmatter + note.body);
  assert.equal(parsed.data.type, 'gemini_chat');
  assert.equal(parsed.data.turn_count, 2);
  assert.equal(parsed.data.date_created, '2026-05-10T06:46:09Z');
});

test('core preserva prompts multi-linha com hifens que parecem separador visual', () => {
  const note = buildMarkdownChatNote({
    filePath: '/vault/c0a5e997c32dc1fe.md',
    relativePath: 'c0a5e997c32dc1fe.md',
    raw: `---
chat_id: c0a5e997c32dc1fe
url: https://gemini.google.com/app/c0a5e997c32dc1fe
tags: [gemini-export]
---

## 🧑 Usuário

Parse error on line 3:
...      UI[View Layer (SwiftUI / Dioxus)]
-----------------------^
Expecting 'SQE', 'DOUBLECIRCLEEND', got 'PS'

---

## 🤖 Gemini

Resposta com correção do diagrama.
`,
  });

  assert.match(note.scoring.firstPrompt, /View Layer/);
  assert.match(note.scoring.firstPrompt, /Expecting 'SQE'/);
  assert.equal(note.metadata.assistantTurnCount, 1);
});

test('core ignora embeds locais de midia ao montar texto comparavel', () => {
  assert.equal(
    normalizeComparableText(
      'Me ajuda com isto ![M4A icon](assets/chat/user-01-image-01.png)',
    ),
    'me ajuda com isto',
  );
});

test('evidencias My Activity e Takeout entram no mesmo agrupamento sanitizado', () => {
  const note = buildMarkdownChatNote({
    filePath: '/vault/b8e7c075effe9457.md',
    relativePath: 'b8e7c075effe9457.md',
    raw: rawChat,
  });
  const takeout = scoreMetadataEvidence(note, {
    source: 'takeout-html',
    date: '2026-05-10T06:46:09Z',
    text: 'Gemini Apps Primeiro prompt sensível de fixture HTML Primeira resposta sensível de fixture HTML',
  });
  const activity = scoreMetadataEvidence(note, {
    source: 'my-activity-web',
    date: '2026-05-10T07:12:31Z',
    text: 'Gemini Apps Último prompt sensível de fixture HTML Última resposta sensível de fixture HTML',
  });

  const grouped = groupMetadataEvidence([takeout, activity]);
  const result = grouped.get('b8e7c075effe9457');
  assert.equal(result.dateCreated, '2026-05-10T06:46:09Z');
  assert.equal(result.dateLastMessage, '2026-05-10T07:12:31Z');
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[0].text?.includes('sensível'), undefined);
  assert.match(result.evidence[0].textHash, /^fnv1a32:/);
  assert.match(result.evidence[0].sampleHash, /^fnv1a32:/);
});

test('metadata evidence usa título e amostra do assistente quando não há prompt do usuário', () => {
  const note = buildMarkdownChatNote({
    filePath: '/vault/2c52369234b6f57a.md',
    relativePath: '2c52369234b6f57a.md',
    raw: `---
chat_id: 2c52369234b6f57a
title: "Personalizado Ecossistema Produtividade: Próximos Passos"
url: https://gemini.google.com/app/2c52369234b6f57a
tags: [gemini-export]
---

## 🤖 Gemini

Aqui estão próximos passos para o ecossistema de produtividade.
`,
  });

  const evidence = scoreMetadataEvidence(note, {
    source: 'takeout-html',
    date: '2026-05-19T22:07:02Z',
    text: 'Gemini Apps Personalizado Ecossistema Produtividade: Próximos Passos Aqui estão próximos passos para o ecossistema de produtividade.',
  });

  assert.equal(evidence.chatId, '2c52369234b6f57a');
  assert.equal(evidence.dateKind, 'unknown');
  assert.equal(evidence.confidence, 'strong');
});

test('metadata date resolution não fecha multi-turn com borda empatada em datas diferentes', () => {
  const resolution = resolveMetadataDatesForCandidate({
    candidate: {
      chatId: 'b8e7c075effe9457',
      turnCount: 2,
    },
    evidence: [
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'created',
        dateKind: 'created',
        date: '2026-05-10T06:46:09Z',
        score: 1,
      },
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'last_message',
        dateKind: 'last_message',
        date: '2026-05-10T07:12:31Z',
        score: 0.62,
      },
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'last_message',
        dateKind: 'last_message',
        date: '2026-05-11T07:12:31Z',
        score: 0.62,
      },
    ],
  });

  assert.equal(resolution.status, 'partial');
  assert.equal(resolution.dateCreated, '2026-05-10T06:46:09Z');
  assert.equal(resolution.dateLastMessage, null);
  assert.deepEqual(resolution.warnings, ['last_message_date_ambiguous_for_non_single_turn']);
});

test('metadata date resolution ignora bordas secundarias quando a melhor evidencia e unica', () => {
  const resolution = resolveMetadataDatesForCandidate({
    candidate: {
      chatId: 'b8e7c075effe9457',
      turnCount: 2,
    },
    evidence: [
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'created',
        dateKind: 'created',
        date: '2026-05-10T06:46:09Z',
        score: 1,
      },
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'created',
        dateKind: 'created',
        date: '2026-04-10T06:46:09Z',
        score: 0.62,
      },
      {
        chatId: 'b8e7c075effe9457',
        source: 'takeout-html',
        kind: 'last_message',
        dateKind: 'last_message',
        date: '2026-05-10T07:12:31Z',
        score: 1,
      },
    ],
  });

  assert.equal(resolution.status, 'matched');
  assert.equal(resolution.dateCreated, '2026-05-10T06:46:09Z');
  assert.equal(resolution.dateLastMessage, '2026-05-10T07:12:31Z');
  assert.deepEqual(resolution.warnings, []);
});

test('metadata date resolution bloqueia fechamento com ordem cronologica impossivel', () => {
  const resolution = resolveMetadataDatesForCandidate({
    candidate: {
      chatId: '45d719a56c5d9961',
      turnCount: 4,
    },
    evidence: [
      {
        chatId: '45d719a56c5d9961',
        source: 'takeout-html',
        kind: 'created',
        dateKind: 'created',
        date: '2026-05-09T19:36:53Z',
        score: 1,
      },
      {
        chatId: '45d719a56c5d9961',
        source: 'takeout-html',
        kind: 'last_message',
        dateKind: 'last_message',
        date: '2026-05-09T19:35:15Z',
        score: 1,
      },
    ],
  });

  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.complete, null);
  assert.deepEqual(resolution.warnings, ['date_created_after_date_last_message']);
});

test('core extrai turnos mesmo quando markdown importado usa CRLF no corpo', () => {
  const note = buildMarkdownChatNote({
    filePath: '/vault/2fca91a39f1b4f94.md',
    relativePath: '2fca91a39f1b4f94.md',
    raw: `---
chat_id: 2fca91a39f1b4f94
url: https://gemini.google.com/app/2fca91a39f1b4f94
tags: [gemini-export]
---

---\r
tipo: medicina\r
status: processado\r
---\r
\r
## 🧑 Usuário\r
\r
Iridociclite aguda\r
\r
---\r
\r
## 🤖 Gemini\r
\r
Olá, Leonardo. Vamos dar continuidade aos seus estudos para a residência com um tema fundamental.\r
`,
  });

  assert.equal(note.scoring.firstPrompt, 'Iridociclite aguda');
  assert.match(note.scoring.assistantSamples[0], /Olá, Leonardo/);
});
