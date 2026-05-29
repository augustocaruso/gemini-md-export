import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadMarkdownDbFixVaultRecords } from '../build/ts/mcp/markdown-db-vault-adapter.js';

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
