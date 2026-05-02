import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  appendJobTraceEvent,
  createJobTrace,
  finalizeJobTrace,
  readJobTraceTail,
  summarizeJobTrace,
  summarizeTraceEvents,
} from '../src/job-trace.mjs';

test('job trace sanitiza conteudo sensivel e resume eventos', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-trace-'));
  const trace = createJobTrace({ jobId: 'job-a', directory: dir });

  appendJobTraceEvent(trace, 'job_created', {
    title: 'Diagnostico sensivel',
    chatId: 'abc123abc123',
    error: 'timeout',
  });
  appendJobTraceEvent(trace, 'job_state', { phase: 'loading-history' });

  const events = readJobTraceTail(trace.filePath, 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].data.title, '[redigido]');
  assert.equal(events[0].data.chatId, 'abc123abc123');
  assert.equal(summarizeTraceEvents(events).byType.job_state, 1);
});

test('job trace remove arquivo de sucesso quando retencao padrao e on_failure', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-trace-'));
  const trace = createJobTrace({ jobId: 'job-success', directory: dir });

  appendJobTraceEvent(trace, 'job_created', {});
  assert.equal(existsSync(trace.filePath), true);
  finalizeJobTrace(trace, { status: 'completed' });

  const summary = summarizeJobTrace(trace);
  assert.equal(summary.retained, false);
  assert.equal(summary.filePath, null);
});

