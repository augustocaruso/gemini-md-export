import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('service worker implementa self-heal por scripting com cooldown', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(source, /CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS/);
  assert.match(source, /chrome\.scripting\?\.executeScript/);
  assert.match(source, /files:\s*\[CONTENT_SCRIPT_FILE\]/);
  assert.match(source, /gemini-md-export\/content-ping/);
  assert.match(source, /selfHealGeminiTabs/);
  assert.match(source, /chrome\.runtime\.onStartup/);
});

test('content script responde ping do service worker e evita dupla injecao do mesmo build', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');

  assert.match(source, /RUNTIME_GUARD_KEY/);
  assert.match(source, /__geminiMdExportModernRuntime/);
  assert.match(source, /gemini-md-export\/content-ping/);
  assert.match(source, /contentScriptRuntimeStatus/);
  assert.match(source, /installContentScriptMessageListener/);
  assert.match(source, /installContentScriptMessageListener\(\);/);
});
