import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  runPrivateApiSelectedExport,
  summarizePrivateApiSelectedExportJob,
} from '../build/ts/cli/private-api-selected-export.js';

const snapshotFor = (chatId) => ({
  chatId,
  title: 'Private CLI export',
  url: `https://gemini.google.com/app/${chatId}`,
  turns: [
    {
      role: 'user',
      markdown: 'Prompt',
      textHash: 'hash-user',
      sourceOrder: 0,
      createdAt: '2026-05-19T21:12:04Z',
      attachments: [],
    },
    {
      role: 'assistant',
      markdown: 'Resposta privada',
      textHash: 'hash-assistant',
      sourceOrder: 1,
      createdAt: '2026-05-19T21:14:16Z',
      attachments: [
        {
          kind: 'image',
          label: 'Generated image',
          url: `assets/${chatId}/turn-0001-asset-00.png`,
        },
      ],
    },
  ],
  metadata: {
    assistantTurnCount: 1,
    dateCreated: '2026-05-19T21:12:04Z',
    dateLastMessage: '2026-05-19T21:14:16Z',
  },
  evidence: [{ source: 'gemini-private-api', kind: 'fixture', confidence: 'strong', warnings: [] }],
});

const bootstrapOk = async () => ({
  ok: true,
  adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
  transport: { source: 'gemini_webapi_python' },
  warnings: [],
});

const sessionOk = async () => ({
  ok: true,
  authenticated: true,
  adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
  transport: { source: 'gemini_webapi_python' },
  chatCount: 2,
  warnings: [],
});

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

test('private API selected export writes Markdown with dates and emits progress', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-'));
  const events = [];
  const calls = [];
  const sequence = [];
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      outputDir,
      onProgress: (event) => events.push(event),
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async () => {
        sequence.push('bootstrap');
        return bootstrapOk();
      },
      runSessionStatus: async () => {
        sequence.push('session');
        return sessionOk();
      },
      runReadChat: async (input) => {
        sequence.push('read');
        calls.push(input);
        return {
          ok: true,
          snapshot: snapshotFor('88a98a108cdcfb61'),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: 'c_88a98a108cdcfb61' },
          assetReceipts: [
            {
              ok: true,
              refId: 'turn-0001-asset-00',
              status: 'downloaded',
              filePath: 'assets/88a98a108cdcfb61/turn-0001-asset-00.png',
              contentHash: 'sha256-fixture',
            },
          ],
          mediaFiles: [
            {
              filename: 'assets/88a98a108cdcfb61/turn-0001-asset-00.png',
              contentBase64: 'AQIDBA==',
              contentType: 'image/png',
              bytes: 4,
            },
          ],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 1);
  assert.equal(job.failureCount, 0);
  assert.deepEqual(sequence, ['bootstrap', 'session', 'read']);
  assert.equal(calls[0].chatId, '88a98a108cdcfb61');
  assert.equal(calls[0].downloadAssets, true);
  assert.equal(calls[0].assetsRelDir, 'assets/88a98a108cdcfb61');
  assert.equal(events.some((event) => event.phase === 'exporting'), true);
  assert.equal(events[0].progressMessage, 'Preparando API privada');

  const filePath = resolve(outputDir, '88a98a108cdcfb61.md');
  const markdown = readFileSync(filePath, 'utf-8');
  assert.match(markdown, /date_created: 2026-05-19T21:12:04Z/);
  assert.match(markdown, /date_last_message: 2026-05-19T21:14:16Z/);
  assert.match(markdown, /## 🤖 Gemini\n\nResposta privada/);
  assert.match(
    markdown,
    /!\[Generated image\]\(assets\/88a98a108cdcfb61\/turn-0001-asset-00\.png\)/,
  );
  assert.deepEqual(
    [...readFileSync(resolve(outputDir, 'assets/88a98a108cdcfb61/turn-0001-asset-00.png'))],
    [1, 2, 3, 4],
  );
  assert.equal(job.savedFiles[0].mediaFileCount, 1);
  assert.equal(job.savedFiles[0].mediaFailureCount, 0);
  assert.equal(job.savedFiles[0].mediaBytes, 4);

  const summary = summarizePrivateApiSelectedExportJob(job);
  assert.equal(summary.ok, true);
  assert.equal(summary.files[0].filePath, filePath);
  assert.equal(summary.files[0].mediaFileCount, 1);
  assert.equal(summary.files[0].dateCreated, '2026-05-19T21:12:04Z');
});

test('private API selected export rewrites remote attachment URLs to saved local assets', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-local-assets-'));
  const remoteUrl = 'https://lh3.googleusercontent.com/gg/fixture-remote-image';
  const chatId = '88a98a108cdcfb61';

  const job = await runPrivateApiSelectedExport(
    {
      chatIds: [chatId],
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: bootstrapOk,
      runSessionStatus: sessionOk,
      runReadChat: async () => ({
        ok: true,
        snapshot: {
          ...snapshotFor(chatId),
          turns: [
            {
              role: 'user',
              markdown: 'Prompt',
              textHash: 'hash-user',
              sourceOrder: 0,
              createdAt: '2026-05-19T21:12:04Z',
              attachments: [{ kind: 'image', label: 'image.png', url: remoteUrl }],
            },
            snapshotFor(chatId).turns[1],
          ],
        },
        adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
        transport: { source: 'gemini_webapi_python', privateChatId: `c_${chatId}` },
        mediaFiles: [
          {
            filename: `assets/${chatId}/image.png`,
            contentBase64: 'AQIDBA==',
            contentType: 'image/png',
            bytes: 4,
            sourceUrl: remoteUrl,
            refId: 'asset-fixture',
          },
        ],
        mediaFailures: [],
        warnings: [],
      }),
    },
  );

  assert.equal(job.status, 'completed');
  const markdown = readFileSync(resolve(outputDir, `${chatId}.md`), 'utf-8');
  assert.doesNotMatch(markdown, /https:\/\/lh3\.googleusercontent\.com\/gg\/fixture-remote-image/);
  assert.match(markdown, /!\[image\.png\]\(assets\/88a98a108cdcfb61\/image\.png\)/);
  assert.deepEqual([...readFileSync(resolve(outputDir, `assets/${chatId}/image.png`))], [
    1, 2, 3, 4,
  ]);
});

test('private API selected export uses bridge private_read before Python sidecar', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-bridge-'));
  const requests = [];

  await withServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readRequestJson(req) : {};
    requests.push({ method: req.method, pathname: url.pathname, body });
    if (req.method === 'GET' && url.pathname === '/agent/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          connectedClients: [{ clientId: 'client-ready-1' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/agent/mcp-tool-call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  adapter: 'browserBackground',
                  snapshot: snapshotFor('88a98a108cdcfb61'),
                  transport: { source: 'extension-background-fetch' },
                  mediaFiles: [],
                  mediaFailures: [],
                  warnings: [],
                }),
              },
            ],
            isError: false,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'bridge_private_export_unavailable' }));
  }, async (bridgeUrl) => {
    const job = await runPrivateApiSelectedExport(
      {
        chatIds: ['88a98a108cdcfb61'],
        bridgeUrl,
        outputDir,
      },
      {
        now: () => new Date('2026-05-28T23:10:00Z'),
        sleep: async () => {},
        bootstrapPythonSidecar: async () => {
          throw new Error('Python sidecar should not run when bridge private_read is available');
        },
      },
    );

    assert.equal(job.status, 'completed');
    assert.equal(job.savedFiles[0].adapter, 'browserBackground');
    const markdown = readFileSync(resolve(outputDir, '88a98a108cdcfb61.md'), 'utf-8');
    assert.match(markdown, /## 🤖 Gemini\n\nResposta privada/);
  });

  assert.equal(requests[0].pathname, '/agent/ready');
  assert.equal(requests[1].pathname, '/agent/mcp-tool-call');
  assert.equal(requests[1].body.name, 'gemini_chats');
  assert.equal(requests[1].body.arguments.action, 'private_read');
  assert.equal(requests[1].body.arguments.clientId, 'client-ready-1');
  assert.equal(requests[1].body.arguments.privateApiTransport, 'browser-background');
  assert.equal(requests[1].body.arguments.downloadAssets, true);
  assert.equal(requests[1].body.arguments.allowPythonFallback, false);
  assert.equal(requests[1].body.arguments.allowDomFallback, false);
});

test('private API selected export can read through native broker without per-item bridge HTTP', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-native-'));
  const sequence = [];

  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
      bridgeUrl: 'http://127.0.0.1:1',
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      ensureBrowserKeepAlive: async () => {
        sequence.push('keepalive');
        return { ok: true };
      },
      runBrowserBackgroundReadChat: async ({ item }) => {
        sequence.push(`native-read:${item.chatId}`);
        return {
          ok: true,
          adapter: 'browserBackground',
          snapshot: snapshotFor(item.chatId),
          transport: { source: 'browser-background-native-broker' },
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
      bootstrapPythonSidecar: async () => {
        throw new Error('Python sidecar should not run for browser background export');
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.deepEqual(sequence, [
    'keepalive',
    'native-read:88a98a108cdcfb61',
    'keepalive',
    'native-read:dbe5dd4b50b09c74',
  ]);
});

test('private API selected export recovers browser-background session before retrying broker failures', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-native-recover-'));
  const sequence = [];
  let readAttempts = 0;

  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      bridgeUrl: 'http://127.0.0.1:1',
      outputDir,
      maxReadAttempts: 2,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      ensureBrowserKeepAlive: async () => {
        sequence.push('keepalive');
        return { ok: true };
      },
      recoverBrowserBackgroundSession: async ({ error }) => {
        sequence.push(`recover:${error.code}`);
        return { ok: true };
      },
      runBrowserBackgroundReadChat: async ({ item }) => {
        readAttempts += 1;
        sequence.push(`read:${readAttempts}`);
        if (readAttempts === 1) {
          throw Object.assign(new Error('native broker pipe missing'), {
            code: 'native_broker_unavailable',
          });
        }
        return {
          ok: true,
          adapter: 'browserBackground',
          snapshot: snapshotFor(item.chatId),
          transport: { source: 'browser-background-native-broker' },
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
      bootstrapPythonSidecar: async () => {
        throw new Error('Python sidecar should not run for browser background export');
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.deepEqual(sequence, ['keepalive', 'read:1', 'recover:native_broker_unavailable', 'keepalive', 'read:2']);
});

test('private API selected export retries broker failures returned as ok false payloads', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-native-payload-retry-'));
  const sequence = [];
  let readAttempts = 0;

  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      bridgeUrl: 'http://127.0.0.1:1',
      outputDir,
      maxReadAttempts: 2,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      ensureBrowserKeepAlive: async () => {
        sequence.push('keepalive');
        return { ok: true };
      },
      recoverBrowserBackgroundSession: async ({ error }) => {
        sequence.push(`recover:${error.code}`);
        return { ok: true };
      },
      runBrowserBackgroundReadChat: async ({ item }) => {
        readAttempts += 1;
        sequence.push(`read:${readAttempts}`);
        if (readAttempts === 1) {
          return {
            ok: false,
            code: 'native_broker_unavailable',
            message: 'Native broker IPC indisponivel.',
          };
        }
        return {
          ok: true,
          adapter: 'browserBackground',
          snapshot: snapshotFor(item.chatId),
          transport: { source: 'browser-background-native-broker' },
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
      bootstrapPythonSidecar: async () => {
        throw new Error('Python sidecar should not run for browser background export');
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.deepEqual(sequence, ['keepalive', 'read:1', 'recover:native_broker_unavailable', 'keepalive', 'read:2']);
});

test('private API selected export records failures and continues the batch', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-'));
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: bootstrapOk,
      runSessionStatus: sessionOk,
      runReadChat: async (input) => {
        if (input.chatId === 'dbe5dd4b50b09c74') {
          return {
            ok: false,
            code: 'fixture_failed',
            message: 'fixture failure',
            chatId: 'dbe5dd4b50b09c74',
            adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          };
        }
        return {
          ok: true,
          snapshot: snapshotFor('88a98a108cdcfb61'),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: 'c_88a98a108cdcfb61' },
          assetReceipts: [],
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.successCount, 1);
  assert.equal(job.failureCount, 1);
  assert.equal(job.failures[0].chatId, 'dbe5dd4b50b09c74');
});

test('private API selected export retries transient browser-background failures per chat', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-bridge-retry-'));
  let readAttempts = 0;

  await withServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/agent/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          connectedClients: [{ clientId: 'client-ready-1' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/agent/mcp-tool-call') {
      const body = await readRequestJson(req);
      if (body.arguments?.action === 'session_status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: true,
                    authenticated: true,
                    selectedAdapter: 'browserBackground',
                  }),
                },
              ],
              isError: false,
            },
          }),
        );
        return;
      }
      readAttempts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [
              {
                type: 'text',
                text:
                  readAttempts === 1
                    ? JSON.stringify({
                        ok: false,
                        code: 'browserBackground_failed',
                        error: { message: 'Timeout transitório do background.' },
                      })
                    : JSON.stringify({
                        ok: true,
                        adapter: 'browserBackground',
                        snapshot: snapshotFor('88a98a108cdcfb61'),
                        transport: { source: 'extension-background-fetch' },
                        mediaFiles: [],
                        mediaFailures: [],
                        warnings: [],
                      }),
              },
            ],
            isError: false,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'bridge_private_export_unavailable' }));
  }, async (bridgeUrl) => {
    const job = await runPrivateApiSelectedExport(
      {
        chatIds: ['88a98a108cdcfb61'],
        bridgeUrl,
        outputDir,
      },
      {
        now: () => new Date('2026-05-28T23:10:00Z'),
        sleep: async () => {},
      },
    );

    assert.equal(job.status, 'completed');
    assert.equal(job.successCount, 1);
    assert.equal(job.failureCount, 0);
  });

  assert.equal(readAttempts, 2);
});

test('private API selected export asks browser background to stay alive before bridge batch', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-keepalive-'));
  const sequence = [];

  await withServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/agent/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          connectedClients: [{ clientId: 'client-ready-1' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/agent/mcp-tool-call') {
      sequence.push('read');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  adapter: 'browserBackground',
                  snapshot: snapshotFor('88a98a108cdcfb61'),
                  transport: { source: 'extension-background-fetch' },
                  mediaFiles: [],
                  mediaFailures: [],
                  warnings: [],
                }),
              },
            ],
            isError: false,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'bridge_private_export_unavailable' }));
  }, async (bridgeUrl) => {
    const job = await runPrivateApiSelectedExport(
      {
        chatIds: ['88a98a108cdcfb61'],
        bridgeUrl,
        outputDir,
      },
      {
        now: () => new Date('2026-05-28T23:10:00Z'),
        sleep: async () => {},
        ensureBrowserKeepAlive: async (input) => {
          sequence.push(`keepalive:${input.reason}:${input.idleCloseMs}`);
          return { ok: true };
        },
      },
    );

    assert.equal(job.status, 'completed');
  });

  assert.deepEqual(sequence, ['keepalive:private-api-selected-export:900000', 'read']);
});

test('private API selected export reports browser-background object errors as readable text', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-bridge-error-'));

  await withServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/agent/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          ready: true,
          connectedClients: [{ clientId: 'client-ready-1' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/agent/mcp-tool-call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  code: 'browserBackground_failed',
                  error: { message: 'Timeout persistente do background.' },
                }),
              },
            ],
            isError: false,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'bridge_private_export_unavailable' }));
  }, async (bridgeUrl) => {
    const job = await runPrivateApiSelectedExport(
      {
        chatIds: ['88a98a108cdcfb61'],
        bridgeUrl,
        outputDir,
        maxReadAttempts: 1,
      },
      {
        now: () => new Date('2026-05-28T23:10:00Z'),
        sleep: async () => {},
      },
    );

    assert.equal(job.status, 'failed');
    assert.equal(job.failures[0].code, 'browserBackground_failed');
    assert.equal(job.failures[0].error, 'Timeout persistente do background.');
  });
});

test('private API recent export lists inventory before selected export without browser wake', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-recent-'));
  const listCalls = [];
  const readCalls = [];
  const sequence = [];
  const job = await runPrivateApiSelectedExport(
    {
      recent: true,
      limit: 2,
      startIndex: 2,
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async () => {
        sequence.push('bootstrap');
        return bootstrapOk();
      },
      runSessionStatus: async () => {
        sequence.push('session');
        return sessionOk();
      },
      runListChats: async (input) => {
        sequence.push('list');
        listCalls.push(input);
        return {
          ok: true,
          chats: [
            { chatId: '111111111111', title: 'Ignored first' },
            { privateChatId: 'c_88a98a108cdcfb61', title: 'Selected one' },
            { chat_id: 'dbe5dd4b50b09c74', title: 'Selected two' },
          ],
        };
      },
      runReadChat: async (input) => {
        sequence.push(`read:${input.chatId}`);
        readCalls.push(input);
        return {
          ok: true,
          snapshot: snapshotFor(input.chatId),
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
          transport: { source: 'gemini_webapi_python', privateChatId: `c_${input.chatId}` },
          assetReceipts: [],
          mediaFiles: [],
          mediaFailures: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 2);
  assert.deepEqual(sequence, [
    'bootstrap',
    'session',
    'list',
    'read:88a98a108cdcfb61',
    'read:dbe5dd4b50b09c74',
  ]);
  assert.equal(listCalls[0].limit, 3);
  assert.deepEqual(
    readCalls.map((call) => call.chatId),
    ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
  );
});

test('private API selected export fails before reads when sidecar bootstrap fails', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-bootstrap-'));
  const events = [];
  let readCalled = false;
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61'],
      outputDir,
      onProgress: (event) => events.push(event),
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async (input) => {
        assert.equal(input.timeoutMs, 180000);
        return {
          ok: false,
          code: 'gemini_webapi_python_bootstrap_timeout',
          message: 'A preparacao da API privada Python demorou demais.',
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
        };
      },
      runReadChat: async () => {
        readCalled = true;
        throw new Error('read should not run');
      },
    },
  );

  assert.equal(job.status, 'failed');
  assert.equal(job.failureCount, 1);
  assert.equal(job.failures[0].code, 'gemini_webapi_python_bootstrap_timeout');
  assert.equal(readCalled, false);
  assert.deepEqual(
    events.map((event) => event.progressMessage),
    ['Preparando API privada', 'Preparacao da API privada falhou'],
  );
});

test('private API selected export preflights auth once before reading the batch', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-private-api-selected-auth-'));
  const sequence = [];
  let readCalled = false;
  const job = await runPrivateApiSelectedExport(
    {
      chatIds: ['88a98a108cdcfb61', 'dbe5dd4b50b09c74'],
      outputDir,
    },
    {
      now: () => new Date('2026-05-28T23:10:00Z'),
      sleep: async () => {},
      bootstrapPythonSidecar: async () => {
        sequence.push('bootstrap');
        return bootstrapOk();
      },
      runSessionStatus: async () => {
        sequence.push('session');
        return {
          ok: false,
          code: 'gemini_webapi_auth_failed',
          message:
            'Account status: UNAUTHENTICATED - Session is not authenticated or cookies have expired.',
          adapterPlan: { selectedAdapter: 'privateApiGeminiWebapi' },
        };
      },
      runReadChat: async () => {
        readCalled = true;
        throw new Error('read should not run without auth');
      },
    },
  );

  assert.equal(job.status, 'failed');
  assert.equal(job.failureCount, 1);
  assert.equal(job.failures[0].chatId, null);
  assert.equal(job.failures[0].code, 'gemini_webapi_auth_failed');
  assert.equal(readCalled, false);
  assert.deepEqual(sequence, ['bootstrap', 'session']);
});

test('private API selected export is explicitly planned as private-first without browser wake', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'private-api-selected-export.ts'),
    'utf-8',
  );

  assert.match(source, /planExportAdapters/);
  assert.match(source, /'selected_export'/);
  assert.match(source, /'recent_export'/);
  assert.match(source, /browserFallbackAllowed:\s*false/);
  assert.doesNotMatch(source, /wakeBrowser:\s*true/);
});

test('CLI prepares bridge before routing selected/recent export to private API command', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const runExportBlock =
    source.match(/const runExport = async \(parsed, streams = \{\}\) => \{[\s\S]*?\n\};\n\nconst runJob/)?.[0] ||
    '';

  assert.match(source, /subcommand === 'recent'/);
  assert.match(source, /privateApiRecent/);
  assert.match(source, /runPrivateApiSelectedExportCommand/);
  assert.ok(
    runExportBlock.indexOf('ensureBridgeAvailable(flags, makeUi(flags, streams))') <
      runExportBlock.indexOf('runPrivateApiSelectedExportCommand'),
    'export selected/recent privado precisa preparar a bridge antes do runner',
  );
});
