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

test('service worker recarrega abas Gemini antes de reinjetar apos update/reload', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(source, /GEMINI_TAB_RELOAD_SETTLE_MS/);
  assert.match(source, /reloadThenSelfHealGeminiTabs/);
  assert.match(
    source,
    /chrome\.runtime\.onInstalled\.addListener[\s\S]*reloadThenSelfHealGeminiTabs/,
  );
  assert.match(
    source,
    /const consumePendingGeminiTabsReload[\s\S]*reloadThenSelfHealGeminiTabs/,
  );

  const helperStart = source.indexOf('const reloadThenSelfHealGeminiTabs');
  const helperEnd = source.indexOf('const consumePendingGeminiTabsReload', helperStart);
  const helperSource = source.slice(helperStart, helperEnd);
  assert.ok(helperSource.indexOf('reloadGeminiTabs(reason)') < helperSource.indexOf('selfHealGeminiTabs'));
});

test('service worker recarrega abas My Activity quando o runtime da extensao muda', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(source, /ACTIVITY_TAB_URL_PATTERN = 'https:\/\/myactivity\.google\.com\/product\/gemini\*'/);
  assert.match(source, /MANAGED_CONTENT_TAB_URL_PATTERNS = \[GEMINI_TAB_URL_PATTERN, ACTIVITY_TAB_URL_PATTERN\]/);
  assert.match(source, /chrome\.tabs\.query\(\{ url: MANAGED_CONTENT_TAB_URL_PATTERNS \}/);
});

test('service worker detecta build novo no start e recarrega content scripts gerenciados', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(source, /LAST_RUNTIME_BUILD_KEY = 'gemini-md-export\.lastRuntimeBuild\.v1'/);
  assert.match(source, /refreshManagedTabsIfRuntimeChanged/);
  assert.match(
    source,
    /refreshManagedTabsIfRuntimeChanged[\s\S]*reloadThenSelfHealGeminiTabs\(\{\s*reason: 'extension-runtime-changed'/,
  );
  assert.match(source, /const consumedPendingReload = await consumePendingGeminiTabsReload\(\);/);
  assert.match(source, /if \(!consumedPendingReload\) \{[\s\S]*await refreshManagedTabsIfRuntimeChanged\(\);/);
  assert.match(
    source,
    /setTimeout\(\(\) => \{[\s\S]*handleServiceWorkerStart\(\);/,
  );
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
