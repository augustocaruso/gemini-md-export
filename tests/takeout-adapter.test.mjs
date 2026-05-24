import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import {
  loadTakeoutEvidence,
  loadTakeoutMatches,
  parseTakeoutDate,
  parseTakeoutHtmlItems,
} from '../build/ts/takeout/takeout-adapter.js';

const candidate = {
  chatId: 'b8e7c075effe9457',
  turnCount: 1,
  scoring: {
    firstPrompt: 'Primeiro prompt sensível de fixture HTML',
    lastPrompt: 'Último prompt sensível de fixture HTML',
    assistantSamples: ['Primeira resposta sensível de fixture HTML'],
  },
};

const zipBuffer = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const raw = Buffer.from(entry.content, 'utf-8');
    const compressed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
};

test('takeout adapter parseia data pt-BR em UTC portavel', () => {
  assert.equal(
    parseTakeoutDate('10 de mai. de 2026, 03:46:09 BRT'),
    '2026-05-10T06:46:09Z',
  );
});

test('takeout adapter parseia data en-US do Takeout com offset GMT', () => {
  assert.equal(
    parseTakeoutDate('May 19, 2026, 7:07:02\u202fPM GMT-03:00'),
    '2026-05-19T22:07:02Z',
  );
});

test('takeout adapter indexa HTML en-US real de Gemini Apps', () => {
  const html = `<!doctype html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;Primeiro prompt sensível de fixture HTML<br>May 19, 2026, 7:07:02\u202fPM GMT-03:00<br><p>Primeira resposta sensível de fixture HTML</p></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps</div>
</div></div>
</body></html>`;
  const items = parseTakeoutHtmlItems(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-05-19T22:07:02Z');
  assert.equal(items[0].promptText, 'Primeiro prompt sensível de fixture HTML');
});

test('takeout adapter trata Added chat from link como texto de prompt do card', () => {
  const html = `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Added chat from link:&nbsp;Quinidina fale sobre o uso na doença de brugada<br>May 2, 2026, 10:52:14 PM GMT-03:00</div><p>Resposta sobre quinidina.</p></div>
</body></html>`;
  const items = parseTakeoutHtmlItems(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].promptText, 'Quinidina fale sobre o uso na doença de brugada');
  assert.equal(items[0].date, '2026-05-03T01:52:14Z');
});

test('takeout adapter retorna evidencias sanitizadas por matching de conteudo', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>Primeira resposta sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [candidate]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, 'b8e7c075effe9457');
    assert.equal(matches[0].date, '2026-05-10T06:46:09Z');
    assert.equal(matches[0].source, 'takeout-html');
    assert.equal(matches[0].text, undefined);
    assert.match(matches[0].textHash, /^fnv1a32:/);

    const evidence = loadTakeoutEvidence({ takeoutPath, candidates: [candidate] });
    assert.equal(evidence.summary.matched, 1);
    assert.equal(evidence.byChatId.get('b8e7c075effe9457').status, 'matched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter aceita ZIP bruto do Google Takeout', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'takeout.zip');
  writeFileSync(
    takeoutPath,
    zipBuffer([
      {
        name: 'Takeout/My Activity/Gemini Apps/MyActivity.html',
        content: `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Primeiro prompt sensível de fixture HTML</div><div>Primeira resposta sensível de fixture HTML</div><div>10 de mai. de 2026, 03:46:09 BRT</div></div>
</body></html>`,
      },
    ]),
  );

  try {
    const evidence = loadTakeoutEvidence({ takeoutPath, candidates: [candidate] });
    assert.equal(evidence.summary.enabled, true);
    assert.equal(evidence.summary.sourceKind, 'zip');
    assert.equal(evidence.summary.itemsIndexed, 1);
    assert.equal(evidence.summary.matched, 1);
    assert.deepEqual(evidence.summary.sourceEntries, [
      'Takeout/My Activity/Gemini Apps/MyActivity.html',
    ]);
    assert.equal(evidence.byChatId.get('b8e7c075effe9457').status, 'matched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter prioriza chat_id deterministico quando HTML traz link da conversa', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><a href="https://gemini.google.com/app/b8e7c075effe9457">Abrir conversa</a><div>texto de outro usuario que nao deveria importar</div><div>10 de mai. de 2026, 03:46:09 BRT</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [candidate]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, 'b8e7c075effe9457');
    assert.equal(matches[0].date, '2026-05-10T06:46:09Z');
    assert.equal(matches[0].score, 1);
    assert.equal(matches[0].text, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter casa prompt curto quando ele identifica um unico chat', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  const shortPromptCandidate = {
    chatId: '02fe56823b19b511',
    scoring: {
      title: 'Síndrome Inflamatória Multissistêmica Pediátrica - Google Gemini',
      firstPrompt: 'Sd inflamatória multissistêmica',
      lastPrompt: 'Sd inflamatória multissistêmica',
      assistantSamples: [
        'A Síndrome Inflamatória Multissistêmica (SIM) é um tema de extrema relevância.',
      ],
    },
  };
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Sd inflamatória multissistêmica</div><div>2 de abr. de 2026, 17:11:05 BRT</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [shortPromptCandidate]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '02fe56823b19b511');
    assert.equal(matches[0].date, '2026-04-02T20:11:05Z');
    assert.equal(matches[0].source, 'takeout-html');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter nao aceita prompt curto ambiguo entre candidatos', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Classificação GOLD</div><div>20 de abr. de 2026, 10:00:00 BRT</div></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '0bdb1db9d39c73a3',
        scoring: {
          firstPrompt: 'Classificação GOLD',
          lastPrompt: 'Classificação GOLD',
          assistantSamples: ['Resposta sobre DPOC.'],
        },
      },
      {
        chatId: 'abcdef1234567890',
        scoring: {
          firstPrompt: 'Classificação GOLD',
          lastPrompt: 'Classificação GOLD',
          assistantSamples: ['Outra resposta sobre DPOC.'],
        },
      },
    ]);
    assert.equal(matches.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter normaliza markdown da nota contra texto plain do Takeout', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  const assistantOnlyCandidate = {
    chatId: '097661ec10389a2e',
    scoring: {
      title: 'Síndrome de Edwards: Mini-Aula e Caso - Google Gemini',
      assistantSamples: [
        'Olá! Vamos focar na **Síndrome de Edwards (Trisomia do 18)**, um tema recorrente em provas.',
      ],
    },
  };
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Sd de Edwards</div><div>30 de dez. de 2025, 15:56:05 BRT</div><p>Olá! Vamos focar na <strong>Síndrome de Edwards (Trisomia do 18)</strong>, um tema recorrente em provas.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [assistantOnlyCandidate]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '097661ec10389a2e');
    assert.equal(matches[0].date, '2025-12-30T18:56:05Z');
    assert.equal(matches[0].source, 'takeout-html');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter usa resposta longa exclusiva mesmo quando o prompt do card e ambiguo', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Paralisia de Todd</div><div>9 de mai. de 2026, 16:16:26 BRT</div><p>Olá, futuro colega! A Síndrome Miastênica de Lambert-Eaton é um tema de altíssimo rendimento para provas.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '1907bcb8250a8057',
        scoring: {
          firstPrompt: 'Lambert-Eaton',
          lastPrompt: 'Lambert-Eaton',
          assistantSamples: [
            'Olá, futuro colega! A **Síndrome Miastênica de Lambert-Eaton** é um tema de altíssimo rendimento para provas.',
          ],
        },
      },
      {
        chatId: '63ca9ef8d5a1b5ce',
        scoring: {
          firstPrompt: 'Paralisia de Todd',
          lastPrompt: 'Paralisia de Todd',
          assistantSamples: ['Resposta genérica sobre paralisia de Todd.'],
        },
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '1907bcb8250a8057');
    assert.equal(matches[0].date, '2026-05-09T19:16:26Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter usa resposta do ultimo turno como borda quando prompt final e curto', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  const shortFinalPromptCandidate = {
    chatId: '1a2bfef3c8c60d49',
    turnCount: 2,
    scoring: {
      firstPrompt: 'Como quebrar um fecaloma',
      lastPrompt: 'Sim',
      lastAssistant:
        'A resposta final exclusiva explica quando escalar a conduta e quais sinais de alarme observar.',
      assistantSamples: [
        'A resposta final exclusiva explica quando escalar a conduta e quais sinais de alarme observar.',
      ],
    },
  };
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Como quebrar um fecaloma</div><div>Feb 10, 2026, 11:47:42 AM GMT-03:00</div><p>Resposta inicial.</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Sim</div><div>Feb 10, 2026, 11:49:46 AM GMT-03:00</div><p>A resposta final exclusiva explica quando escalar a conduta e quais sinais de alarme observar.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const evidence = loadTakeoutEvidence({
      takeoutPath,
      candidates: [shortFinalPromptCandidate],
    });
    const match = evidence.byChatId.get('1a2bfef3c8c60d49');
    assert.equal(match.status, 'matched');
    assert.equal(match.dateCreated, '2026-02-10T14:47:42Z');
    assert.equal(match.dateLastMessage, '2026-02-10T14:49:46Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter desempata prompt longo compartilhado por resposta exclusiva', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  const sharedPrompt =
    'Levei uma multa por transitar na faixa exclusiva de transporte publico e precisei entrar a direita logo depois do semaforo em Brasilia sem ma fe.';
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;${sharedPrompt}</div><div>10 de nov. de 2025, 16:42:54 BRT</div><p>Compreendo perfeitamente a situação. Ser autuado quando se tinha a intenção de realizar a manobra correta exige uma defesa objetiva.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '63f62da2ec1ee2b3',
        scoring: {
          firstPrompt: sharedPrompt,
          lastPrompt: sharedPrompt,
          assistantSamples: [
            'Compreendo perfeitamente a situação. Ser autuado quando se tinha a intenção de realizar a manobra correta exige uma defesa objetiva.',
          ],
        },
      },
      {
        chatId: '7201166e9a457659',
        scoring: {
          firstPrompt: sharedPrompt,
          lastPrompt: sharedPrompt,
          assistantSamples: [
            'Compreendo perfeitamente a situação. Parece ser um caso clássico onde a sinalização não é clara.',
          ],
        },
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '63f62da2ec1ee2b3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter aceita prompt curto unico somente no campo Prompted', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Choque toxico</div><div>5 de dez. de 2025, 09:36:28 BRT</div><p>Prezado Doutor(a), aqui está a sua mini-aula.</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Outro assunto</div><div>6 de dez. de 2025, 09:36:28 BRT</div><p>Uma resposta que cita choque toxico no corpo não deve ser usada como prompt.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '678a4a44a67eafad',
        scoring: {
          firstPrompt: 'Choque toxico',
          lastPrompt: 'Choque toxico',
          assistantSamples: ['Prezado Doutor(a),'],
        },
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '678a4a44a67eafad');
    assert.equal(matches[0].date, '2025-12-05T12:36:28Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter prefere prompt exato a prompt estendido que contem a mesma borda', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;E a valvula?</div><div>20 de abr. de 2026, 13:18:21 BRT</div><p>Resposta exclusiva sobre a valvula da derivacao e a pressao intracraniana.</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;E a valvula?

Comente tbm sobre PIC.</div><div>20 de abr. de 2026, 13:19:18 BRT</div><p>Resposta exclusiva sobre a valvula da derivacao e a pressao intracraniana.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '4e99b5cbf198abec',
        turnCount: 1,
        scoring: {
          firstPrompt: 'E a valvula?',
          lastPrompt: 'E a valvula?',
          firstAssistant:
            'Resposta exclusiva sobre a valvula da derivacao e a pressao intracraniana.',
          lastAssistant:
            'Resposta exclusiva sobre a valvula da derivacao e a pressao intracraniana.',
          assistantSamples: [
            'Resposta exclusiva sobre a valvula da derivacao e a pressao intracraniana.',
          ],
        },
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '4e99b5cbf198abec');
    assert.equal(matches[0].date, '2026-04-20T16:18:21Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter aceita prompt curto exato mesmo quando o termo aparece em outra resposta', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Febre reumatica</div><div>25 de jan. de 2026, 16:11:44 BRT</div><p>A Febre Reumática é uma complicação tardia.</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Cardiologia</div><div>26 de jan. de 2026, 16:11:44 BRT</div><p>Esse outro texto também cita Febre Reumática no corpo.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: '4d345f1fcba67597',
        scoring: {
          firstPrompt: 'Febre reumatica',
          lastPrompt: 'Febre reumatica',
          assistantSamples: ['Esse texto é apenas para fins informativos.'],
        },
      },
      {
        chatId: 'aaaaaaaaaaaa',
        scoring: {
          firstPrompt: 'Outra pergunta',
          lastPrompt: 'Outra pergunta',
          assistantSamples: ['Esse outro texto também cita Febre Reumática no corpo.'],
        },
      },
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].chatId, '4d345f1fcba67597');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter ancora a mesma borda inicial em chat ramificado quando o fim e independente', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'MyActivity.html');
  const sharedPrompt =
    'Tem algum plugin que melhore a aparencia desse diagrama no Obsidian com uma caixa grande de arquitetura';
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;${sharedPrompt}</div><div>Feb 9, 2026, 4:03:13 AM GMT-03:00</div><p>Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.</p></div>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Erro Mermaid esperando DOUBLECIRCLEEND e TAGSTART</div><div>Feb 9, 2026, 4:05:11 AM GMT-03:00</div><p>Resposta final exclusiva com sintaxe Mermaid corrigida.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const evidence = loadTakeoutEvidence({
      takeoutPath,
      candidates: [
        {
          chatId: '00cc897ef77d72b7',
          turnCount: 1,
          scoring: {
            firstPrompt: sharedPrompt,
            lastPrompt: sharedPrompt,
            firstAssistant: 'Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.',
            lastAssistant: 'Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.',
            assistantSamples: ['Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.'],
          },
        },
        {
          chatId: '4c644b66e43ee1a5',
          turnCount: 2,
          scoring: {
            firstPrompt: sharedPrompt,
            lastPrompt: 'Erro Mermaid esperando DOUBLECIRCLEEND e TAGSTART',
            firstAssistant: 'Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.',
            lastAssistant: 'Resposta final exclusiva com sintaxe Mermaid corrigida.',
            assistantSamples: [
              'Resposta final exclusiva com sintaxe Mermaid corrigida.',
              'Resposta inicial exclusiva sobre renderizacao de diagramas no Obsidian.',
            ],
          },
        },
      ],
    });
    const branched = evidence.byChatId.get('4c644b66e43ee1a5');
    assert.equal(branched.status, 'matched');
    assert.equal(branched.dateCreated, '2026-02-09T07:03:13Z');
    assert.equal(branched.dateLastMessage, '2026-02-09T07:05:11Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeout adapter ignora placeholder markdown de anexo ao casar prompt textual', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-adapter-'));
  const takeoutPath = resolve(dir, 'MyActivity.html');
  writeFileSync(
    takeoutPath,
    `<!doctype html><html><body>
<div class="outer-cell"><div>Gemini Apps</div><div>Prompted&nbsp;Me ajuda a responder a mensagem desta paciente</div><div>May 7, 2026, 11:12:33 AM GMT-03:00</div><p>Resposta sugerida para paciente.</p></div>
</body></html>`,
    'utf-8',
  );

  try {
    const matches = loadTakeoutMatches(takeoutPath, [
      {
        chatId: 'dad25bd803741664',
        turnCount: 1,
        scoring: {
          firstPrompt:
            'Me ajuda a responder a mensagem desta paciente ![M4A icon](assets/dad25bd803741664/user-01-image-01.png)',
          lastPrompt:
            'Me ajuda a responder a mensagem desta paciente ![M4A icon](assets/dad25bd803741664/user-01-image-01.png)',
          assistantSamples: ['Resposta sugerida para paciente.'],
        },
      },
    ]);
    assert.equal(matches.length >= 1, true);
    assert.equal(matches.some((match) => match.chatId === 'dad25bd803741664'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
