import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildGeminiWebapiPythonBootstrapCommand,
  buildGeminiWebapiPythonListChatsCommand,
  buildGeminiWebapiPythonReadChatCommand,
  buildGeminiWebapiPythonSessionStatusCommand,
  parseGeminiWebapiPythonBootstrapResponse,
  parseGeminiWebapiPythonListChatsResponse,
  parseGeminiWebapiPythonReadChatResponse,
  parseGeminiWebapiPythonSessionStatusResponse,
  runGeminiWebapiPythonSessionStatus,
} from '../build/ts/mcp/gemini-webapi-python-adapter.js';

const ROOT = resolve(import.meta.dirname, '..');

test('Gemini Web API Python adapter builds an isolated JSON sidecar command', () => {
  const command = buildGeminiWebapiPythonReadChatCommand({
    chatId: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
    title: 'Sidecar proof',
    cookiesJson: '/tmp/cookies.json',
    downloadAssets: true,
    assetsDir: '/tmp/gme-assets',
    assetsRelDir: 'assets/dbe5dd4b50b09c74',
    timeoutMs: 999999,
  });

  assert.equal(command.executable, 'uv');
  assert.deepEqual(command.args.slice(0, 2), ['run', '--project']);
  assert.equal(command.args.at(-1), 'gemini-md-export-gemini-webapi-adapter');
  assert.equal(command.timeoutMs, 120000);
  assert.equal(command.adapterPlan.selectedAdapter, 'privateApiGeminiWebapi');
  assert.match(command.env.PYTHONPATH, /python/);

  const request = JSON.parse(command.stdin);
  assert.equal(request.action, 'read_chat');
  assert.equal(request.chat_id, 'c_dbe5dd4b50b09c74');
  assert.equal(request.title, 'Sidecar proof');
  assert.equal(request.cookies_json, '/tmp/cookies.json');
  assert.equal(request.download_assets, true);
  assert.equal(request.assets_dir, '/tmp/gme-assets');
  assert.equal(request.assets_rel_dir, 'assets/dbe5dd4b50b09c74');
  assert.equal(JSON.stringify(request).includes('__Secure-1PSID'), false);
});

test('Gemini Web API Python adapter prewarms dependencies without cookies', () => {
  const command = buildGeminiWebapiPythonBootstrapCommand({
    timeoutMs: 999999,
  });

  assert.equal(command.executable, 'uv');
  assert.deepEqual(command.args.slice(0, 2), ['run', '--project']);
  assert.deepEqual(command.args.slice(3, 5), ['python', '-c']);
  assert.match(command.args.at(-1), /gemini_webapi/);
  assert.equal(command.timeoutMs, 300000);
  assert.equal(command.adapterPlan.selectedAdapter, 'privateApiGeminiWebapi');
  assert.equal(JSON.parse(command.stdin).action, 'bootstrap');
  assert.equal(JSON.stringify(command).includes('__Secure-1PSID'), false);
  assert.equal(JSON.stringify(command).includes('cookies_json'), false);

  const parsed = parseGeminiWebapiPythonBootstrapResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      warnings: ['venv_created'],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.transport.source, 'gemini_webapi_python');
  assert.equal(parsed.warnings[0], 'venv_created');
});

test('Gemini Web API Python adapter parses only typed JSON envelopes', () => {
  const parsed = parseGeminiWebapiPythonReadChatResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      chat_id: 'dbe5dd4b50b09c74',
      private_chat_id: 'c_dbe5dd4b50b09c74',
      title: 'Parsed sidecar',
      date_created: '2026-05-19T21:12:04Z',
      date_last_message: '2026-05-19T21:14:16Z',
      turns: [{ role: 'user', markdown: 'Prompt', attachments: [] }],
      warnings: [],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.equal(parsed.snapshot.turns[0].markdown, 'Prompt');
  assert.equal(parsed.snapshot.metadata.dateCreated, '2026-05-19T21:12:04Z');
  assert.equal(parsed.snapshot.metadata.dateLastMessage, '2026-05-19T21:14:16Z');
  assert.equal(parsed.adapterPlan.selectedAdapter, 'privateApiGeminiWebapi');
});

test('Gemini Web API Python adapter builds list/session commands without leaking cookies', () => {
  const listCommand = buildGeminiWebapiPythonListChatsCommand({
    cookiesJson: '/tmp/cookies.json',
    timeoutMs: 2000,
    limit: 50,
  });
  const statusCommand = buildGeminiWebapiPythonSessionStatusCommand({
    cookiesJson: '/tmp/cookies.json',
  });

  assert.equal(JSON.parse(listCommand.stdin).action, 'list_chats');
  assert.equal(JSON.parse(listCommand.stdin).cookies_json, '/tmp/cookies.json');
  assert.equal(JSON.parse(listCommand.stdin).limit, 50);
  assert.equal(JSON.parse(statusCommand.stdin).action, 'session_status');
  assert.equal(JSON.stringify(listCommand).includes('__Secure-1PSID'), false);
});

test('Gemini Web API Python adapter parses list and session status envelopes', () => {
  const list = parseGeminiWebapiPythonListChatsResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      chats: [
        {
          chat_id: 'dbe5dd4b50b09c74',
          private_chat_id: 'c_dbe5dd4b50b09c74',
          title: 'Listed chat',
          url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
          is_pinned: true,
          updated_at: '2026-05-29T12:00:00Z',
        },
      ],
    }),
  );
  const status = parseGeminiWebapiPythonSessionStatusResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      authenticated: true,
      chat_count: 1,
    }),
  );

  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.chats[0].chatId, 'dbe5dd4b50b09c74');
  assert.equal(list.chats[0].isPinned, true);
  assert.equal(status.ok, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.chatCount, 1);
});

test('Gemini Web API Python adapter prewarms before direct session status', async () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'gme-webapi-bootstrap-runner-'));
  const runnerPath = resolve(tempDir, 'fake-runner.mjs');
  const logPath = resolve(tempDir, 'actions.jsonl');
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf-8') || '{}');
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ action: request.action }) + '\\n');
if (request.action === 'bootstrap') {
  process.stdout.write(JSON.stringify({ ok: true, source: 'gemini_webapi_python' }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, source: 'gemini_webapi_python', authenticated: true, chat_count: 2 }) + '\\n');
`,
    'utf-8',
  );
  chmodSync(runnerPath, 0o755);
  const previousRunner = process.env.GME_GEMINI_WEBAPI_RUNNER;
  process.env.GME_GEMINI_WEBAPI_RUNNER = runnerPath;
  try {
    const result = await runGeminiWebapiPythonSessionStatus({ timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.chatCount, 2);
    assert.deepEqual(
      readFileSync(logPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).action),
      ['bootstrap', 'session_status'],
    );
  } finally {
    if (previousRunner === undefined) delete process.env.GME_GEMINI_WEBAPI_RUNNER;
    else process.env.GME_GEMINI_WEBAPI_RUNNER = previousRunner;
  }
});

test('Gemini Web API Python adapter derives snapshot dates from turn dates', () => {
  const parsed = parseGeminiWebapiPythonReadChatResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      chat_id: 'dbe5dd4b50b09c74',
      private_chat_id: 'c_dbe5dd4b50b09c74',
      title: 'Turn dated sidecar',
      turns: [
        {
          role: 'user',
          markdown: 'Prompt',
          created_at: '2026-05-19T21:12:04Z',
          attachments: [],
        },
        {
          role: 'assistant',
          markdown: 'Answer',
          created_at: '2026-05-19T21:14:16Z',
          attachments: [],
        },
      ],
      warnings: [],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.turns[0].createdAt, '2026-05-19T21:12:04Z');
  assert.equal(parsed.snapshot.metadata.dateCreated, '2026-05-19T21:12:04Z');
  assert.equal(parsed.snapshot.metadata.dateLastMessage, '2026-05-19T21:14:16Z');
});

test('Gemini Web API Python adapter turns downloaded asset receipts into media files', () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'gme-webapi-adapter-test-'));
  const assetPath = resolve(tempDir, 'turn-0001-asset-00.png');
  writeFileSync(assetPath, Buffer.from([1, 2, 3, 4]));

  const parsed = parseGeminiWebapiPythonReadChatResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      chat_id: 'dbe5dd4b50b09c74',
      private_chat_id: 'c_dbe5dd4b50b09c74',
      title: 'Asset sidecar',
      turns: [
        {
          role: 'assistant',
          markdown: 'Answer',
          attachments: [
            {
              kind: 'generated_image',
              label: 'Generated image',
              url: 'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png',
              original_url: 'https://lh3.googleusercontent.com/generated',
              asset_id: 'turn-0001-asset-00',
              sha256: 'sha256-fixture',
              bytes: 4,
              download_status: 'downloaded',
            },
          ],
        },
      ],
      asset_receipts: [
        {
          asset_id: 'turn-0001-asset-00',
          kind: 'generated_image',
          label: 'Generated image',
          status: 'downloaded',
          original_url: 'https://lh3.googleusercontent.com/generated',
          files: [
            {
              path: assetPath,
              filename: 'turn-0001-asset-00.png',
              relative_path: 'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png',
              bytes: 4,
              sha256: 'sha256-fixture',
              content_type: 'image/png',
            },
          ],
        },
        {
          asset_id: 'turn-0001-asset-01',
          kind: 'generated_video',
          label: 'Generated video',
          status: 'failed',
          error: 'fixture failure',
        },
      ],
      warnings: ['asset_failed:turn-0001-asset-01:fixture failure'],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.turns[0].attachments[0].kind, 'image');
  assert.equal(
    parsed.snapshot.turns[0].attachments[0].url,
    'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png',
  );
  assert.equal(parsed.mediaFiles[0].filename, 'assets/dbe5dd4b50b09c74/turn-0001-asset-00.png');
  assert.equal(parsed.mediaFiles[0].contentBase64, 'AQIDBA==');
  assert.equal(parsed.mediaFiles[0].contentType, 'image/png');
  assert.equal(parsed.mediaFailures[0].assetId, 'turn-0001-asset-01');
  assert.equal(parsed.assetReceipts[0].status, 'downloaded');
  assert.equal(parsed.assetReceipts[1].status, 'failed');
  assert.equal(parsed.warnings[0], 'asset_failed:turn-0001-asset-01:fixture failure');
});

test('Python sidecar is packaged as an AGPL dependency boundary, not core code', () => {
  const pyproject = readFileSync(resolve(ROOT, 'pyproject.toml'), 'utf-8');
  const sidecar = readFileSync(
    resolve(ROOT, 'python', 'gemini_md_export', 'gemini_webapi_adapter.py'),
    'utf-8',
  );

  assert.match(pyproject, /gemini-webapi\[browser\]/);
  assert.match(pyproject, /pydantic/);
  assert.match(pyproject, /ruff/);
  assert.match(pyproject, /pyrefly/);
  assert.match(sidecar, /from pydantic import BaseModel/);
  assert.match(sidecar, /from gemini_webapi import GeminiClient/);
  assert.match(sidecar, /_raw_turn_dates_latest_first/);

  const core = readFileSync(resolve(ROOT, 'src', 'core', 'chat-read-adapter.ts'), 'utf-8');
  assert.doesNotMatch(core, /gemini_webapi|python|subprocess|child_process/);
});
