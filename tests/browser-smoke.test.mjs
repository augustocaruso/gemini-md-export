import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SMOKE_SCRIPT = resolve(ROOT, 'scripts', 'smoke-export-integrity.mjs');
const CHAT_ID = 'b8e7c075effe9457';

const markdownFor = (chatId) => `---
type: gemini_chat
chat_id: ${chatId}
title: "Smoke"
url: https://gemini.google.com/app/${chatId}
turn_count: 1
tags: [gemini-export]
---

## 🧑 Usuário

Pergunta

---

## 🤖 Gemini

Resposta
`;

const listen = (server) =>
  new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
};

const withSmokeServer = async (handler, fn) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname, search: url.search });
    await handler(req, res, url);
  });
  const bridgeUrl = await listen(server);
  try {
    return await fn({ bridgeUrl, requests });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

const runSmoke = (args) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SMOKE_SCRIPT, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });

test('smoke export-integrity exports first proven chat and validates saved markdown', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-smoke-test-'));
  try {
    await withSmokeServer(
      async (_req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(res, 200, { ok: true, ready: true });
          return;
        }
        if (url.pathname === '/agent/recent-chats') {
          sendJson(res, 200, {
            conversations: [
              {
                chatId: CHAT_ID,
                title: 'Smoke',
                url: `https://gemini.google.com/app/${CHAT_ID}`,
              },
            ],
            pagination: { returned: 1 },
            knownLoadedCount: 1,
          });
          return;
        }
        if (url.pathname === '/agent/download-chat') {
          const targetDir = url.searchParams.get('outputDir');
          mkdirSync(targetDir, { recursive: true });
          const filePath = resolve(targetDir, `${CHAT_ID}.md`);
          writeFileSync(filePath, markdownFor(CHAT_ID), 'utf-8');
          sendJson(res, 200, {
            chatId: CHAT_ID,
            filename: `${CHAT_ID}.md`,
            filePath,
            integrity: {
              assistantTurnCount: 1,
              evidence: [
                {
                  source: 'chat-dom',
                  kind: 'mcp_export_payload_integrity',
                  confidence: 'strong',
                  textHash: 'hash',
                  sampleLength: 100,
                  warnings: [],
                },
              ],
            },
          });
          return;
        }
        await readJsonBody(_req);
        sendJson(res, 404, { error: 'not found' });
      },
      async ({ bridgeUrl, requests }) => {
        const result = await runSmoke([
          '--bridge-url',
          bridgeUrl,
          '--output-dir',
          outputDir,
          '--json',
        ]);
        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.ok, true);
        assert.equal(payload.chatId, CHAT_ID);
        assert.equal(payload.validation.assistantTurnCount, 1);
        assert.deepEqual(
          requests.map((request) => request.pathname),
          ['/agent/ready', '/agent/recent-chats', '/agent/download-chat'],
        );
      },
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('smoke export-integrity blocks when no exportable chat is available', async () => {
  await withSmokeServer(
    async (_req, res, url) => {
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, { ok: true, ready: true });
        return;
      }
      if (url.pathname === '/agent/recent-chats') {
        sendJson(res, 200, {
          conversations: [{ title: 'Sem URL real', id: 'chat-0' }],
          pagination: { returned: 1 },
          knownLoadedCount: 1,
        });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    },
    async ({ bridgeUrl, requests }) => {
      const result = await runSmoke(['--bridge-url', bridgeUrl, '--json']);
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'no_exportable_chat');
      assert.equal(requests.some((request) => request.pathname === '/agent/download-chat'), false);
    },
  );
});

test('smoke export-integrity fails when saved markdown identity does not match selected chat', async () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'gme-smoke-test-'));
  try {
    await withSmokeServer(
      async (_req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(res, 200, { ok: true, ready: true });
          return;
        }
        if (url.pathname === '/agent/recent-chats') {
          sendJson(res, 200, {
            conversations: [{ chatId: CHAT_ID, title: 'Smoke' }],
            pagination: { returned: 1 },
          });
          return;
        }
        if (url.pathname === '/agent/download-chat') {
          const wrongChatId = 'aaaaaaaaaaaa';
          const targetDir = url.searchParams.get('outputDir');
          mkdirSync(targetDir, { recursive: true });
          const filePath = resolve(targetDir, `${wrongChatId}.md`);
          writeFileSync(filePath, markdownFor(wrongChatId), 'utf-8');
          sendJson(res, 200, {
            chatId: wrongChatId,
            filename: `${wrongChatId}.md`,
            filePath,
            integrity: { assistantTurnCount: 1, evidence: [] },
          });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      },
      async ({ bridgeUrl }) => {
        const result = await runSmoke([
          '--bridge-url',
          bridgeUrl,
          '--output-dir',
          outputDir,
          '--json',
        ]);
        assert.equal(result.status, 1);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.ok, false);
        assert.equal(payload.code, 'validation_failed');
        assert.deepEqual(payload.validation.issues, [
          'frontmatter_chat_id_mismatch',
          'url_chat_id_mismatch',
          'filename_chat_id_mismatch',
        ]);
      },
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
