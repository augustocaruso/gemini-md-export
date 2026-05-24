import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildActivityProgressViewModel,
  buildExportJobProgressViewModel,
  buildFixVaultProgressViewModel,
  buildProgressViewModel,
  mergeProgressViewModel,
  normalizeProgressDisplayPercent,
} from '../build/ts/core/progress-view-model.js';

test('progress view model shows in-flight export item without completing the bar', () => {
  const view = buildExportJobProgressViewModel({
    status: 'running',
    phase: 'exporting',
    requested: 10,
    completed: 3,
    current: { index: 4, title: 'Caso CPRE', chatId: 'abc123' },
    successCount: 3,
    skippedCount: 1,
    failureCount: 0,
    progressMessage: 'Baixando conversa',
  });

  assert.equal(view.sourceKind, 'export-job');
  assert.equal(view.mode, 'determinate');
  assert.equal(view.status, 'running');
  assert.equal(view.phase, 'exporting');
  assert.equal(view.total, 10);
  assert.equal(view.current, 3);
  assert.equal(view.displayCurrent, 4);
  assert.equal(view.barCurrent, 3.62);
  assert.equal(view.percent, 30);
  assert.equal(view.terminal, false);
  assert.equal(view.statusLabel, 'Exportando');
  assert.equal(view.label, 'Baixando conversa');
  assert.deepEqual(view.currentItem, {
    title: 'Caso CPRE',
    chatId: 'abc123',
  });
  assert.deepEqual(view.counts, {
    downloaded: 3,
    skipped: 1,
    failed: 0,
    warnings: 0,
    webSeen: null,
    existing: null,
    missing: null,
  });
});

test('progress view model normalizes terminal export status to one hundred percent', () => {
  const view = buildExportJobProgressViewModel({
    status: 'completed',
    phase: 'writing-report',
    requested: 10,
    completed: 10,
    successCount: 8,
    skippedCount: 2,
    failureCount: 0,
  });

  assert.equal(view.mode, 'determinate');
  assert.equal(view.statusLabel, 'Concluido');
  assert.equal(view.current, 10);
  assert.equal(view.displayCurrent, 10);
  assert.equal(view.barCurrent, 10);
  assert.equal(view.percent, 100);
  assert.equal(view.displayPercent, 100);
  assert.equal(view.terminal, true);
  assert.equal(view.successful, true);
  assert.equal(view.failed, false);
});

test('progress view model represents ready and count waits as indeterminate', () => {
  const ready = buildProgressViewModel({
    sourceKind: 'ready',
    status: 'running',
    phase: 'preparing',
    title: 'Gemini Markdown Export · preparando',
    label: 'Verificando Gemini Web',
  });

  const count = buildProgressViewModel({
    sourceKind: 'count',
    status: 'running',
    phase: 'loading-history',
    title: 'Gemini Markdown Export · contagem',
    label: 'Procurando conversas no historico',
    counts: { webSeen: 12 },
  });

  assert.equal(ready.mode, 'indeterminate');
  assert.equal(ready.percent, 0);
  assert.equal(ready.barCurrent, 0);
  assert.equal(ready.statusLabel, 'Preparando');

  assert.equal(count.mode, 'indeterminate');
  assert.equal(count.label, 'Procurando conversas no historico');
  assert.equal(count.countLabel, '12 encontradas');
});

test('activity progress view model marks pending completed scan as failed', () => {
  const view = buildActivityProgressViewModel({
    status: 'completed',
    candidateTotal: 5,
    resolvedCount: 3,
    scannedCardCount: 20,
    loadedCardCount: 25,
    maxCards: 50,
  });

  assert.equal(view.sourceKind, 'activity-scan');
  assert.equal(view.status, 'failed');
  assert.equal(view.mode, 'determinate');
  assert.equal(view.current, 3);
  assert.equal(view.total, 5);
  assert.equal(view.label, '2 pendente(s)');
  assert.equal(view.countLabel, '3 de 5');
  assert.equal(view.failed, true);
});

test('fix-vault progress view model keeps five-step determinate progress', () => {
  const view = buildFixVaultProgressViewModel({
    current: 2,
    total: 5,
    message: 'Conferindo datas e exports raw',
  });

  assert.equal(view.sourceKind, 'fix-vault');
  assert.equal(view.mode, 'determinate');
  assert.equal(view.current, 2);
  assert.equal(view.total, 5);
  assert.equal(view.displayCurrent, 2);
  assert.equal(view.percent, 40);
  assert.equal(view.label, 'Conferindo datas e exports raw');
  assert.equal(view.countLabel, '2/5');
});

test('progress view model merge rejects older non-terminal snapshots', () => {
  const previous = buildExportJobProgressViewModel({
    status: 'running',
    phase: 'exporting',
    requested: 10,
    completed: 5,
    current: { index: 6, title: 'Atual' },
    progressMessage: 'Baixando conversa atual',
  });

  const stale = buildExportJobProgressViewModel({
    status: 'running',
    phase: 'exporting',
    requested: 10,
    completed: 3,
    current: { index: 4, title: 'Antiga' },
    progressMessage: 'Baixando conversa antiga',
  });

  const merged = mergeProgressViewModel(previous, stale);

  assert.equal(merged.current, 5);
  assert.equal(merged.displayCurrent, 6);
  assert.equal(merged.barCurrent, 5.62);
  assert.equal(merged.label, 'Baixando conversa atual');
  assert.equal(merged.currentItem?.title, 'Atual');
});

test('progress display percent resets when placeholder total expands', () => {
  const previous = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: 'running',
    phase: 'loading-history',
    current: 0,
    total: 1,
    displayPercent: 82,
  });
  const next = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: 'running',
    phase: 'loading-history',
    current: 0,
    total: 50,
  });

  assert.equal(normalizeProgressDisplayPercent(previous, next, 82), 0);
});

test('progress view model is the only CLI progress position contract', () => {
  const cliSource = readFileSync(resolve('bin', 'gemini-md-export.mjs'), 'utf-8');
  const buildSource = readFileSync(resolve('scripts', 'build.mjs'), 'utf-8');

  assert.match(cliSource, /buildExportJobProgressViewModel/);
  assert.match(cliSource, /buildProgressViewModel/);
  assert.doesNotMatch(cliSource, /const displayProgressPosition\b/);
  assert.doesNotMatch(cliSource, /const barProgressPosition\b/);
  assert.match(buildSource, /core['"], ['"]progress-view-model\.js/);
});
