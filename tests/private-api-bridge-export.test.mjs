import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runPrivateApiSelectedExportViaBridge } from '../build/ts/cli/private-api-bridge-export.js';

const readRequestJson = (req) =>
  new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('error', rejectRequest);
    req.on('end', () => {
      try {
        resolveRequest(body ? JSON.parse(body) : {});
      } catch (err) {
        rejectRequest(err);
      }
    });
  });

const withServer = async (handler, run) => {
  const server = createServer(handler);
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolveServer) => server.close(resolveServer));
  }
};

test('bridge private export starts the same direct reexport job and returns the private export viewmodel', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gme-private-bridge-'));
  const outputDir = join(root, 'vault');
  const reportFile = join(root, 'direct-report.json');
  const requests = [];

  await withServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/agent/reexport-chats') {
      const body = await readRequestJson(req);
      requests.push(body);
      writeFileSync(
        reportFile,
        JSON.stringify({
          successCount: 1,
          failureCount: 0,
          successes: [
            {
              chatId: '88a98a108cdcfb61',
              title: 'Reparado pela extensao',
              filename: 'original.md',
              filePath: join(outputDir, 'original.md'),
              bytes: 123,
              overwritten: true,
              mediaFileCount: 1,
              mediaFailureCount: 0,
              metrics: {
                counters: {
                  savedMediaBytes: 4,
                },
                privateRead: {
                  adapter: 'browserBackground',
                },
              },
            },
          ],
          failures: [],
        }),
        'utf-8',
      );
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jobId: 'job-1',
          type: 'direct-chats-export',
          status: 'running',
          phase: 'exporting',
          requested: 1,
          completed: 0,
          successCount: 0,
          failureCount: 0,
          outputDir,
          current: {
            index: 1,
            chatId: '88a98a108cdcfb61',
            title: 'Reparado pela extensao',
          },
          progressMessage: 'Lendo conversa pela API privada',
          createdAt: '2026-05-30T12:00:00Z',
          updatedAt: '2026-05-30T12:00:00Z',
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/agent/export-job-status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jobId: url.searchParams.get('jobId'),
          type: 'direct-chats-export',
          status: 'completed',
          phase: 'done',
          requested: 1,
          completed: 1,
          successCount: 1,
          failureCount: 0,
          outputDir,
          reportFile,
          progressMessage: 'Export privado concluido',
          createdAt: '2026-05-30T12:00:00Z',
          updatedAt: '2026-05-30T12:00:02Z',
          finishedAt: '2026-05-30T12:00:02Z',
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  }, async (bridgeUrl) => {
    const progress = [];
    const job = await runPrivateApiSelectedExportViaBridge({
      bridgeUrl,
      items: [
        {
          chatId: '88a98a108cdcfb61',
          title: 'Reparado pela extensao',
          url: 'https://gemini.google.com/app/88a98a108cdcfb61',
          outputDir,
          filename: 'original.md',
          sourcePath: join(outputDir, 'original.md'),
        },
      ],
      expectedCount: 1,
      outputDir,
      pollMs: 5,
      timeoutMs: 1_000,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].privateReadExport, true);
    assert.equal(requests[0].allowDomFallback, false);
    assert.equal(requests[0].privateApiTransport, undefined);
    assert.equal(requests[0].items[0].outputDir, outputDir);
    assert.equal(requests[0].items[0].filename, 'original.md');
    assert.equal(job.type, 'private-api-selected-export');
    assert.equal(job.status, 'completed');
    assert.equal(job.savedFiles[0].adapter, 'browserBackground');
    assert.equal(job.savedFiles[0].filePath, join(outputDir, 'original.md'));
    assert.equal(job.savedFiles[0].mediaBytes, 4);
    assert.equal(progress.some((event) => event.progressMessage === 'Lendo conversa pela API privada'), true);
  });

  assert.match(readFileSync(reportFile, 'utf-8'), /Reparado pela extensao/);
});
