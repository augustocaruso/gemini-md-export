import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  markExportJobFinishedForReport,
  normalizeFinishedExportJobStatus,
} from '../build/ts/mcp/export-job-finalization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

test('finished export job cannot remain cancel_requested', () => {
  const job = {
    status: 'cancel_requested',
    phase: 'exporting',
    cancelRequested: true,
    current: { chatId: 'abc123' },
  };

  const result = normalizeFinishedExportJobStatus(job, { nowIso: '2026-05-26T07:41:27.718Z' });

  assert.deepEqual(result, {
    changed: true,
    fromStatus: 'cancel_requested',
    status: 'cancelled',
    reason: 'pending-cancel-at-finish',
  });
  assert.equal(job.status, 'cancelled');
  assert.equal(job.phase, 'cancelled');
  assert.equal(job.cancelRequested, true);
  assert.equal(job.cancelledAt, '2026-05-26T07:41:27.718Z');
  assert.equal(job.current, null);
});

test('finished export job keeps real terminal status', () => {
  const job = {
    status: 'completed_with_errors',
    phase: 'done',
    cancelRequested: false,
    current: null,
  };

  const result = normalizeFinishedExportJobStatus(job, { nowIso: '2026-05-26T07:41:27.718Z' });

  assert.deepEqual(result, {
    changed: false,
    fromStatus: 'completed_with_errors',
    status: 'completed_with_errors',
    reason: null,
  });
  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.phase, 'done');
  assert.equal(job.cancelledAt, undefined);
});

test('mark finished export job clears volatile fields before report', () => {
  const job = {
    status: 'cancel_requested',
    phase: 'exporting',
    cancelRequested: true,
    current: { chatId: 'abc123' },
    operationId: 'op-1',
  };
  const trace = [];
  let touched = false;

  const result = markExportJobFinishedForReport(job, {
    nowIso: '2026-05-26T07:41:27.718Z',
    clearFields: ['current', 'operationId'],
    appendTrace: (_job, event, payload) => trace.push({ event, payload }),
    touch: () => {
      touched = true;
    },
  });

  assert.equal(result.statusNormalization.changed, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.finishedAt, '2026-05-26T07:41:27.718Z');
  assert.equal(job.current, null);
  assert.equal(job.operationId, null);
  assert.equal(touched, true);
  assert.deepEqual(trace.map((item) => item.event), ['job_status_normalized_at_finish']);
});

test('mcp server normalizes cancel before final report and claim release', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const finalizationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'export-job-finalization.ts'),
    'utf-8',
  );
  const directFinallyBlock = source.match(
    /finally \{\n    markExportJobFinishedForReport\(job,[\s\S]*?broadcastDirectChatsJobProgress\(job, client\);\n  \}/,
  )?.[0] || '';
  const recentFinallyBlock = source.match(
    /finally \{\n    markExportJobFinishedForReport\(job,[\s\S]*?broadcastRecentChatsJobProgress\(job, client\);\n  \}/,
  )?.[0] || '';

  assert.match(source, /export-job-finalization\.js/);
  assert.match(finalizationSource, /normalizeFinishedExportJobStatus\(job/);
  assert.match(directFinallyBlock, /markExportJobFinishedForReport\(job/);
  assert.match(recentFinallyBlock, /markExportJobFinishedForReport\(job/);
  assert.ok(
    directFinallyBlock.indexOf('markExportJobFinishedForReport(job') <
      directFinallyBlock.indexOf('persistDirectChatsExportReport'),
    'direct report must see terminal cancel status',
  );
  assert.ok(
    directFinallyBlock.indexOf('markExportJobFinishedForReport(job') <
      directFinallyBlock.indexOf('autoReleaseTabClaimForJob'),
    'direct claim release reason must use terminal cancel status',
  );
  assert.ok(
    recentFinallyBlock.indexOf('markExportJobFinishedForReport(job') <
      recentFinallyBlock.indexOf('persistRecentChatsExportReport'),
    'recent report must see terminal cancel status',
  );
  assert.ok(
    recentFinallyBlock.indexOf('markExportJobFinishedForReport(job') <
      recentFinallyBlock.indexOf('autoReleaseTabClaimForJob'),
    'recent claim release reason must use terminal cancel status',
  );
});
