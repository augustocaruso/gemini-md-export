import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildGeminiWebapiPythonReadChatCommand,
  parseGeminiWebapiPythonReadChatResponse,
} from '../build/ts/mcp/gemini-webapi-python-adapter.js';

const ROOT = resolve(import.meta.dirname, '..');

test('Gemini Web API Python adapter builds an isolated JSON sidecar command', () => {
  const command = buildGeminiWebapiPythonReadChatCommand({
    chatId: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
    title: 'Sidecar proof',
    cookiesJson: '/tmp/cookies.json',
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
  assert.equal(JSON.stringify(request).includes('__Secure-1PSID'), false);
});

test('Gemini Web API Python adapter parses only typed JSON envelopes', () => {
  const parsed = parseGeminiWebapiPythonReadChatResponse(
    JSON.stringify({
      ok: true,
      source: 'gemini_webapi_python',
      chat_id: 'dbe5dd4b50b09c74',
      private_chat_id: 'c_dbe5dd4b50b09c74',
      title: 'Parsed sidecar',
      turns: [{ role: 'user', markdown: 'Prompt', attachments: [] }],
      warnings: [],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.chatId, 'dbe5dd4b50b09c74');
  assert.equal(parsed.snapshot.turns[0].markdown, 'Prompt');
  assert.equal(parsed.adapterPlan.selectedAdapter, 'privateApiGeminiWebapi');
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

  const core = readFileSync(resolve(ROOT, 'src', 'core', 'chat-read-adapter.ts'), 'utf-8');
  assert.doesNotMatch(core, /gemini_webapi|python|subprocess|child_process/);
});
