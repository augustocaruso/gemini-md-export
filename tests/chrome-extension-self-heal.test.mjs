import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('service worker implementa self-heal por scripting com cooldown', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS/);
  assert.match(source, /chrome\.scripting\?\.executeScript/);
  assert.match(source, /files:\s*\[scriptFile\]/);
  assert.match(source, /gemini-md-export\/content-ping/);
  assert.match(source, /selfHealGeminiTabs/);
  assert.match(source, /chrome\.runtime\.onStartup/);
});

test('service worker agenda self-heal quando uma aba gerenciada nasce, carrega ou ativa', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /GOOGLE_BLOCKER_CONTENT_SCRIPT_FILE/);
  assert.match(source, /ACTIVITY_CONTENT_SCRIPT_FILE/);
  assert.match(source, /managedContentScriptFileForUrl/);
  assert.match(source, /scheduleManagedTabSelfHeal/);
  assert.match(
    source,
    /chrome\.tabs\?\.onCreated\?\.addListener\?\.\([\s\S]*scheduleManagedTabSelfHeal/,
  );
  assert.match(
    source,
    /chrome\.tabs\?\.onUpdated\?\.addListener\?\.\([\s\S]*scheduleManagedTabSelfHeal/,
  );
  assert.match(
    source,
    /chrome\.tabs\?\.onActivated\?\.addListener\?\.\([\s\S]*scheduleManagedTabSelfHeal/,
  );
});

test('google blocker content script responde ping do service worker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'google-blocker-content-script.ts'), 'utf-8');

  assert.match(source, /CONTENT_SCRIPT_PING_TYPE/);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(source, /contentScriptRuntimeStatus/);
  assert.match(source, /kind: 'blocker'/);
});

test('my activity content script responde ping do service worker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'activity-content-script.ts'), 'utf-8');

  assert.match(source, /CONTENT_SCRIPT_PING_TYPE/);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(source, /contentScriptRuntimeStatus/);
  assert.match(source, /kind: 'activity'/);
});

test('service worker recarrega abas Gemini antes de reinjetar apos update/reload', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

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
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /ACTIVITY_TAB_URL_PATTERN = 'https:\/\/myactivity\.google\.com\/product\/gemini\*'/);
  assert.match(source, /GOOGLE_SORRY_TAB_URL_PATTERN = 'https:\/\/www\.google\.com\/sorry\/\*'/);
  assert.match(source, /GOOGLE_ACCOUNT_TAB_URL_PATTERN = 'https:\/\/accounts\.google\.com\/\*'/);
  assert.match(source, /MANAGED_CONTENT_TAB_URL_PATTERNS = \[[\s\S]*GEMINI_TAB_URL_PATTERN[\s\S]*ACTIVITY_TAB_URL_PATTERN[\s\S]*GOOGLE_SORRY_TAB_URL_PATTERN[\s\S]*GOOGLE_ACCOUNT_TAB_URL_PATTERN[\s\S]*\]/);
  assert.match(source, /chrome\.tabs\.query\(\{ url: MANAGED_CONTENT_TAB_URL_PATTERNS \}/);
});

test('service worker detecta build novo no start e recarrega content scripts gerenciados', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

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

test('service worker faz self-heal no start mesmo quando o build nao mudou', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

  assert.match(source, /const startManagedContentSelfHeal = \(\{[\s\S]*selfHealGeminiTabs/);
  assert.match(
    source,
    /if \(!consumedPendingReload\) \{[\s\S]*const refresh = await refreshManagedTabsIfRuntimeChanged\(\);[\s\S]*if \(refresh\?\.status === 'unchanged'\) \{[\s\S]*startManagedContentSelfHeal\(\{[\s\S]*reason: 'service-worker-start'/,
  );
});

test('content script responde ping do service worker e evita dupla injecao do mesmo build', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /RUNTIME_GUARD_KEY/);
  assert.match(source, /__geminiMdExportModernRuntime/);
  assert.match(source, /gemini-md-export\/content-ping/);
  assert.match(source, /contentScriptRuntimeStatus/);
  assert.match(source, /installContentScriptMessageListener/);
  assert.match(source, /installContentScriptMessageListener\(\);/);
});

test('service worker ativa a aba do proprio content script para export pesado', () => {
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(backgroundSource, /activateTabWithDebugger/);
  assert.match(backgroundSource, /const activateSenderTab = async \(message, sender = \{\}\) =>/);
  assert.match(backgroundSource, /message\.tabId/);
  assert.match(backgroundSource, /debuggerActivation\.ok === true/);
  assert.match(backgroundSource, /chromeUpdateTab\(tabId, \{ active: true \}\)/);
  assert.match(backgroundSource, /message\.focusWindow === true \? await chromeFocusWindow/);
  assert.match(backgroundSource, /gemini-md-export\/activate-tab/);
  assert.match(contentSource, /command\.type === 'activate-tab'/);
  assert.match(contentSource, /command\.type === 'activate-browser-tab'/);
  assert.match(contentSource, /type: 'gemini-md-export\/activate-tab'/);
  assert.match(contentSource, /bridgeState\.isActiveTab = response\.isActiveTab/);
});
