import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { diagnoseRawExportAgainstTakeout } from '../build/ts/takeout/takeout-diagnostics.js';

const writeTakeout = (body) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-takeout-diagnostics-'));
  const takeoutPath = resolve(dir, 'Minhaatividade.html');
  writeFileSync(takeoutPath, `<!doctype html><html><body>${body}</body></html>`, 'utf-8');
  return { dir, takeoutPath };
};

const card = ({ prompt, date = '10 de mai. de 2026, 03:46:09 BRT', body = '' }) => `
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;${prompt}<br>${date}<br><p>${body}</p><br></div>
<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Produtos:</b><br>&emsp;Gemini Apps</div>
</div></div>`;

const candidate = {
  chatId: 'b8e7c075effe9457',
  title: 'Diagnostico de truncamento',
  turnCount: 2,
  attachmentCount: 0,
  scoring: {
    title: 'Diagnostico de truncamento',
    firstPrompt: 'Primeiro prompt exclusivo para detectar inicio preservado',
    lastPrompt: 'Ultimo prompt exclusivo para detectar fim preservado',
    assistantSamples: ['Resposta longa exclusiva para o diagnostico de truncamento do raw export.'],
  },
};

test('diagnostico Takeout marca truncamento de fim quando so a primeira borda existe', () => {
  const { dir, takeoutPath } = writeTakeout(
    card({
      prompt: candidate.scoring.firstPrompt,
      body: 'Resposta do primeiro turno preservada no Takeout.',
    }),
  );
  try {
    const diagnostics = diagnoseRawExportAgainstTakeout({
      takeoutPath,
      pendingCandidates: [candidate],
      allCandidates: [candidate],
    });
    const diagnostic = diagnostics.get(candidate.chatId);
    assert.equal(diagnostic.code, 'takeout_last_edge_missing_for_raw_chat');
    assert.equal(diagnostic.evidence.edgeIntegrity.hasFirstPromptEdge, true);
    assert.equal(diagnostic.evidence.edgeIntegrity.hasLastPromptEdge, false);
    assert.equal(diagnostic.evidence.truncation?.direction, 'tail');
    assert.equal(diagnostic.repair.action, 'reexport_chat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostico Takeout marca truncamento de começo quando so a ultima borda existe', () => {
  const { dir, takeoutPath } = writeTakeout(
    card({
      prompt: candidate.scoring.lastPrompt,
      date: '10 de mai. de 2026, 04:12:31 BRT',
      body: 'Resposta do ultimo turno preservada no Takeout.',
    }),
  );
  try {
    const diagnostics = diagnoseRawExportAgainstTakeout({
      takeoutPath,
      pendingCandidates: [candidate],
      allCandidates: [candidate],
    });
    const diagnostic = diagnostics.get(candidate.chatId);
    assert.equal(diagnostic.code, 'takeout_first_edge_missing_for_raw_chat');
    assert.equal(diagnostic.evidence.edgeIntegrity.hasFirstPromptEdge, false);
    assert.equal(diagnostic.evidence.edgeIntegrity.hasLastPromptEdge, true);
    assert.equal(diagnostic.evidence.truncation?.direction, 'head');
    assert.equal(diagnostic.repair.action, 'reexport_chat');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostico Takeout marca bordas multiplas como possivel encadeamento ou duplicata', () => {
  const { dir, takeoutPath } = writeTakeout(
    [
      card({
        prompt: candidate.scoring.firstPrompt,
        date: '10 de mai. de 2026, 03:46:09 BRT',
        body: 'Primeira ocorrencia da borda inicial.',
      }),
      card({
        prompt: candidate.scoring.firstPrompt,
        date: '10 de mai. de 2026, 04:46:09 BRT',
        body: 'Segunda ocorrencia da mesma borda inicial.',
      }),
      card({
        prompt: candidate.scoring.lastPrompt,
        date: '10 de mai. de 2026, 05:12:31 BRT',
        body: 'Borda final preservada.',
      }),
    ].join('\n'),
  );
  try {
    const diagnostics = diagnoseRawExportAgainstTakeout({
      takeoutPath,
      pendingCandidates: [candidate],
      allCandidates: [candidate],
    });
    const diagnostic = diagnostics.get(candidate.chatId);
    assert.equal(diagnostic.code, 'takeout_multiple_edge_candidates_for_raw_chat');
    assert.deepEqual(diagnostic.evidence.edgeIntegrity.firstPromptDates, [
      '2026-05-10T06:46:09Z',
      '2026-05-10T07:46:09Z',
    ]);
    assert.deepEqual(diagnostic.evidence.edgeIntegrity.lastPromptDates, [
      '2026-05-10T08:12:31Z',
    ]);
    assert.equal(diagnostic.evidence.truncation, null);
    assert.equal(diagnostic.repair.action, 'dedupe_or_reexport');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
