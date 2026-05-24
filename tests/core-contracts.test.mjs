import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertChatId,
  canonicalGeminiChatUrl,
  parseChatId,
} from '../build/ts/core/chat-id.js';
import { portableIsoSeconds } from '../build/ts/core/date.js';
import { hashText } from '../build/ts/core/text-hash.js';

test('core chat id normaliza rotas, URLs e ids prefixados', () => {
  assert.equal(parseChatId('/app/B8E7C075EFFE9457?hl=pt-BR'), 'b8e7c075effe9457');
  assert.equal(
    parseChatId('https://gemini.google.com/app/B8E7C075EFFE9457'),
    'b8e7c075effe9457',
  );
  assert.equal(parseChatId('c_B8E7C075EFFE9457'), 'b8e7c075effe9457');
  assert.equal(
    canonicalGeminiChatUrl(assertChatId('b8e7c075effe9457')),
    'https://gemini.google.com/app/b8e7c075effe9457',
  );
});

test('core chat id rejeita identidades fabricadas ou curtas', () => {
  assert.equal(parseChatId('chat-0'), null);
  assert.equal(parseChatId('abc123'), null);
  assert.equal(parseChatId('https://gemini.google.com/app'), null);
  assert.throws(() => assertChatId('chat-1'), /Identidade de chat nao comprovada/);
});

test('portableIsoSeconds remove milissegundos e rejeita datas invalidas', () => {
  assert.equal(portableIsoSeconds('2026-05-17T18:55:08.245Z'), '2026-05-17T18:55:08Z');
  assert.equal(
    portableIsoSeconds(new Date('2026-05-17T18:55:08.000Z')),
    '2026-05-17T18:55:08Z',
  );
  assert.equal(portableIsoSeconds('sem data'), null);
});

test('hashText e estavel e browser-safe', () => {
  assert.equal(hashText('Mesmo texto'), hashText('Mesmo texto'));
  assert.notEqual(hashText('Mesmo texto'), hashText('Outro texto'));

  const source = readFileSync(resolve('src/core/text-hash.ts'), 'utf-8');
  assert.doesNotMatch(source, /node:crypto|createHash|crypto\.subtle/);
});

test('diagnostico Takeout usa Aho-Corasick para buscar evidencias raw', () => {
  const source = readFileSync(resolve('src/takeout/takeout-diagnostics.ts'), 'utf-8');
  assert.match(source, /import \{ AhoCorasick \}/);
  assert.match(source, /new AhoCorasick/);
  assert.doesNotMatch(source, /\.includes\(needle\.comparable\)/);
});

test('adapter Takeout nao volta para matching quadratico depois do Aho-Corasick', () => {
  const source = readFileSync(resolve('src/takeout/takeout-adapter.ts'), 'utf-8');
  assert.match(source, /import \{ AhoCorasick \}/);
  assert.match(source, /const textMatcher = buildTakeoutTextMatcher\(candidates\)/);
  assert.doesNotMatch(source, /scoreMetadataEvidence/);
});
