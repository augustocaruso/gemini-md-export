import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  importRuntimeNodeDependency,
  loadMarkdownDbFixVaultRecords,
} from '../build/ts/mcp/markdown-db-vault-adapter.js';

test('MarkdownDB adapter bootstraps runtime npm dependencies when mddb is not installed', async () => {
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
    const result = await importRuntimeNodeDependency('mddb', {
      moduleDir,
      importModule: async (name) => {
        calls.push(`import:${name}`);
        if (calls.length === 1) {
          throw Object.assign(new Error("Cannot find package 'mddb'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        }
        return { MarkdownDB: class FixtureMarkdownDb {} };
      },
      installRuntimeDependencies: async (packageRoot) => {
        calls.push(`install:${packageRoot}`);
      },
    });

    assert.equal(typeof result.MarkdownDB, 'function');
    assert.deepEqual(calls, ['import:mddb', `install:${root}`, 'import:mddb']);
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
  mkdirSync(nested, { recursive: true });
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

  try {
    const result = await loadMarkdownDbFixVaultRecords({ vaultDir: vault });
    assert.equal(result.summary.totalMarkdownFiles, 1);
    assert.equal(result.summary.recordsWithMissingAssets, 1);
    assert.equal(existsSync(join(vault, '.gemini-md-export', 'markdown-db', 'markdown-db.sqlite')), true);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].chatId, chatId);
    assert.equal(result.records[0].title, 'Chat com imagem');
    assert.equal(result.records[0].sourcePath, chatPath);
    assert.deepEqual(result.records[0].missingAssets, ['assets/abc123abc123/missing.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
