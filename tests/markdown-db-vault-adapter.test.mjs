import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  importRuntimeNodeDependency,
  loadMarkdownDbFixVaultRecords,
} from '../build/ts/mcp/markdown-db-vault-adapter.js';

test('MarkdownDB adapter refuses missing runtime dependencies instead of running npm install', async () => {
  const calls = [];
  const root = resolve(tmpdir(), `gme-markdown-db-runtime-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'gemini-md-export', dependencies: { mddb: '^0.9.5' } }),
    'utf-8',
  );

  const moduleDir = join(root, 'build', 'ts', 'mcp');
  mkdirSync(moduleDir, { recursive: true });
  try {
    await assert.rejects(
      importRuntimeNodeDependency('mddb', {
        moduleDir,
        importModule: async (name) => {
          calls.push(`import:${name}`);
          throw Object.assign(new Error("Cannot find package 'mddb'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        },
        installRuntimeDependencies: async (packageRoot) => {
          calls.push(`install:${packageRoot}`);
        },
      }),
      /Cannot find package 'mddb'/,
    );

    assert.deepEqual(calls, ['import:mddb']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MarkdownDB adapter indexes Gemini exports and reports missing local assets', async () => {
  const root = resolve(tmpdir(), `gme-markdown-db-${process.pid}-${Date.now()}`);
  const vault = join(root, 'vault');
  const nested = join(vault, 'Gemini');
  const chatId = 'abc123abc123';
  const chatPath = join(nested, `${chatId}.md`);
  const internalPath = join(
    vault,
    '.gemini-md-export-fix',
    'repair',
    'private-api-backups',
    '20260603-000000',
    `${chatId}.md`,
  );
  mkdirSync(nested, { recursive: true });
  mkdirSync(dirname(internalPath), { recursive: true });
  writeFileSync(
    chatPath,
    [
      '---',
      'chat_id: abc123abc123',
      'title: "Chat com imagem"',
      'url: https://gemini.google.com/app/abc123abc123',
      'tags: [gemini-export]',
      '---',
      '',
      '## 🧑 Usuário',
      '',
      'Prompt',
      '',
      '---',
      '',
      '## 🤖 Gemini',
      '',
      'Resposta com imagem ![Generated image](assets/abc123abc123/missing.png)',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    internalPath,
    [
      '---',
      'chat_id: abc123abc123',
      'title: "Backup interno nao deve entrar no vault"',
      'url: https://gemini.google.com/app/abc123abc123',
      'tags: [gemini-export]',
      '---',
      '',
      '![Backup asset](assets/abc123abc123/internal-missing.png)',
      '',
    ].join('\n'),
    'utf-8',
  );

  try {
    const result = await loadMarkdownDbFixVaultRecords({ vaultDir: vault });
    assert.equal(
      existsSync(join(vault, '.gemini-md-export', 'markdown-db')),
      false,
      'cache padrao nao deve ser criado dentro do vault sincronizado do usuario',
    );
    assert.equal(result.summary.totalMarkdownFiles, 1);
    assert.equal(result.summary.recordsWithMissingAssets, 1);
    assert.equal(existsSync(join(result.summary.cacheDir, 'markdown-db.sqlite')), true);
    assert.equal(result.summary.cacheDir.startsWith(vault), false);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].chatId, chatId);
    assert.equal(result.records[0].title, 'Chat com imagem');
    assert.equal(result.records[0].sourcePath, chatPath);
    assert.deepEqual(result.records[0].missingAssets, ['assets/abc123abc123/missing.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
