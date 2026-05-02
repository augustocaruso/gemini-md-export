import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('service worker cria offscreen sob demanda e expõe diagnóstico', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(source, /OFFSCREEN_DOCUMENT_PATH\s*=\s*'offscreen\.html'/);
  assert.match(source, /chrome\.offscreen\.createDocument/);
  assert.match(source, /gemini-md-export\/offscreen-status/);
  assert.match(source, /gemini-md-export\/offscreen-ping/);
  assert.match(source, /offscreen:\s*lastOffscreenStatus/);
});

test('offscreen document responde ping sem tocar no DOM do Gemini', () => {
  const html = readFileSync(resolve(ROOT, 'src', 'offscreen.html'), 'utf-8');
  const script = readFileSync(resolve(ROOT, 'src', 'offscreen.js'), 'utf-8');

  assert.match(html, /offscreen\.js/);
  assert.match(script, /gemini-md-export\/offscreen-ping/);
  assert.doesNotMatch(script, /gemini\.google\.com/);
  assert.doesNotMatch(script, /querySelector/);
});
