import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

test('MCP não espera timeout longo quando comando não é entregue à aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /COMMAND_DISPATCH_TIMEOUT_MS/);
  assert.match(source, /dispatchTimer/);
  assert.match(source, /command_dispatch_timeout/);
  assert.match(source, /não abriu o canal de comandos/);
  assert.match(source, /clearTimeout\(pending\.dispatchTimer\)/);
});

test('MCP protocolo v2 usa SSE para comandos e snapshot separado', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));

  assert.equal(bridgeVersion.protocolVersion, 2);
  assert.match(source, /url\.pathname === '\/bridge\/events'/);
  assert.match(source, /text\/event-stream/);
  assert.match(source, /sendClientEvent\(client, 'command'/);
  assert.match(source, /url\.pathname === '\/bridge\/snapshot'/);
  assert.match(source, /upsertClientSnapshot/);
  assert.match(source, /snapshotRequested/);
  assert.match(source, /recordPayloadMetric\(next, 'heartbeat'/);
  assert.match(source, /recordPayloadMetric\(client, 'snapshot'/);
  assert.match(source, /summarizePayloadMetrics/);
  assert.match(source, /commandDelivery:\s*heartbeatCommand/);
  assert.match(source, /duplicate:\s*!resolved/);
  assert.match(contentSource, /heartbeat-incremental-v1/);
  assert.match(contentSource, /tab-backpressure-v1/);
  assert.match(contentSource, /const buildBridgeHeartbeatPayload = \(\) => \(\{/);
  assert.doesNotMatch(
    contentSource.match(/const buildBridgeHeartbeatPayload = \(\) => \(\{[\s\S]*?\n  \}\);/)?.[0] || '',
    /conversations:/,
  );
});

test('browser_status expõe saúde da bridge MCP/Chrome', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /const buildBridgeHealth = \(client/);
  assert.match(source, /const buildExtensionReadiness = \(\{/);
  assert.match(source, /command_channel_stuck/);
  assert.match(source, /heartbeat_delayed/);
  assert.match(source, /bridgeHealth/);
  assert.match(source, /extensionReadiness/);
  assert.match(source, /handshake/);
  assert.match(source, /gemini_browser_ready/);
  assert.match(source, /buildLightweightBrowserReady/);
  assert.match(source, /browserReadyBlockingIssue/);
  assert.match(source, /command_channel_not_ready/);
  assert.match(source, /serviceWorker/);
  assert.match(source, /contentScript/);
  assert.match(source, /diagnostics/);
});

test('MCP v0.5 lista somente as 7 tools públicas de domínio', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const publicToolsBlock = source.match(/const rawTools = \[([\s\S]*?)\n\];\n\nconst tools = rawTools;/)?.[1];
  assert.ok(publicToolsBlock, 'bloco de tools públicas deve existir');
  const names = Array.from(publicToolsBlock.matchAll(/name: '([^']+)'/g), (match) => match[1]);
  assert.deepEqual(names, [
    'gemini_ready',
    'gemini_tabs',
    'gemini_chats',
    'gemini_export',
    'gemini_job',
    'gemini_config',
    'gemini_support',
  ]);
  assert.match(source, /code: 'tool_renamed'/);
  assert.match(source, /legacyToolReplacement/);
  assert.match(source, /code: 'use_cli'/);
  assert.match(source, /cliFirstExportResult/);
});

test('MCP publico bloqueia contagem/exportacao por tools ruidosas sem intencao explicita', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const hookSource = readFileSync(
    resolve(ROOT, 'gemini-cli-extension', 'scripts', 'hooks', 'gemini-md-export-hook.mjs'),
    'utf-8',
  );

  assert.match(source, /const PUBLIC_MCP_INTENTS = new Set\(\['diagnostic', 'tab_management', 'small_page', 'one_off'\]\)/);
  assert.match(source, /explicit_mcp_intent_required/);
  assert.match(source, /use_cli_only/);
  assert.match(source, /buildCliCountCommand/);
  assert.match(source, /buildCliReexportCommand/);
  assert.match(source, /action === 'count' \|\| args\.untilEnd === true \|\| args\.countOnly === true/);
  assert.match(source, /action === 'download'/);
  assert.match(source, /diagnostic: \{ type: 'boolean' \}/);
  assert.match(source, /intent: \{ type: 'string', enum: \['diagnostic', 'tab_management'\] \}/);
  assert.match(source, /intent: \{ type: 'string', enum: \['diagnostic', 'small_page', 'one_off'\] \}/);
  assert.match(hookSource, /hasExplicitMcpIntent/);
  assert.match(hookSource, /!hasExplicitMcpIntent\(toolInput\)/);
});

test('MCP implementa afinidade confiável por claim de aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');
  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');

  assert.match(source, /name: 'gemini_list_tabs'/);
  assert.match(source, /name: 'gemini_claim_tab'/);
  assert.match(source, /name: 'gemini_release_tab'/);
  assert.match(source, /getSelectableGeminiClients/);
  assert.match(source, /diagnosticClients/);
  assert.match(source, /demotedFromTabSelection/);
  assert.match(source, /ambiguous_gemini_tabs/);
  assert.doesNotMatch(source, /em MCP, use gemini_tabs/);
  assert.match(source, /tabClaims = new Map/);
  assert.match(source, /sessionClaims = new Map/);
  assert.match(source, /allowLaunchChrome:\s*args\.openIfMissing !== false/);
  assert.match(source, /_proxySessionId/);
  assert.match(contentSource, /tab-claim-v1/);
  assert.match(contentSource, /command\.type === 'claim-tab'/);
  assert.match(contentSource, /command\.type === 'release-tab-claim'/);
  assert.match(contentSource, /isExtensionContextInvalidatedError/);
  assert.match(contentSource, /reason: 'extension-context-invalidated'/);
  assert.match(contentSource, /localOnly: true/);
  assert.match(contentSource, /TAB_CLAIM_TITLE_PREFIX_RE/);
  assert.match(contentSource, /gemini-md-export\/tab-broker-update/);
  assert.match(contentSource, /reportTabBrokerState\('operation-start'/);
  assert.match(contentSource, /reportTabBrokerState\('claim-applied'/);
  assert.match(backgroundSource, /tabBrokerRegistry = new Map/);
  assert.match(backgroundSource, /summarizeTabBrokerRegistry/);
  assert.match(backgroundSource, /message\?\.type === 'gemini-md-export\/tab-broker-update'/);
  assert.match(backgroundSource, /scheduleTabClaimExpiry/);
  assert.match(backgroundSource, /releaseTrackedTabClaimByTabId/);
  assert.match(backgroundSource, /chrome\.tabs\.group/);
  assert.match(backgroundSource, /chrome\.tabGroups\.update/);
  assert.match(backgroundSource, /tab-already-in-user-group/);
  assert.match(backgroundSource, /cleanupStaleTabClaimVisuals/);
  assert.match(backgroundSource, /stillOurGroup/);
  assert.match(backgroundSource, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(backgroundSource, /message\?\.type === 'RELOAD_SELF'/);
  assert.match(buildSource, /'tabGroups'/);
});

test('browser_status diagnostica e tenta self-heal sem depender do guard wrapper', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const statusBlock = source.match(
    /name: 'gemini_browser_status'[\s\S]*?\n  \{\n    name: 'gemini_mcp_diagnose_processes'/,
  )?.[0];
  const guardedBlock = source.match(
    /const LEGACY_BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  assert.ok(statusBlock, 'gemini_browser_status deve existir');
  assert.ok(guardedBlock, 'lista de tools com guard deve existir');
  assert.match(statusBlock, /ready:\s*matchingClients\.length > 0/);
  assert.match(statusBlock, /blockingIssue/);
  assert.match(statusBlock, /no_connected_clients/);
  assert.match(statusBlock, /selfHeal/);
  assert.match(statusBlock, /ensureBrowserExtensionReady/);
  assert.match(statusBlock, /allowReload:\s*args\.allowReload !== false/);
  assert.match(statusBlock, /reloadWaitMs/);
  assert.match(statusBlock, /buildExtensionReadiness/);
  assert.match(statusBlock, /manualReloadRequired/);
  assert.doesNotMatch(guardedBlock, /gemini_browser_status/);
});

test('MCP expõe diagnóstico e cleanup controlado de processos sem guard de browser', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const guardedBlock = source.match(
    /const LEGACY_BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  const localProxyBlock = source.match(
    /const LOCAL_PROXY_SUPPORT_ACTIONS = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];

  assert.match(source, /name: 'gemini_mcp_diagnose_processes'/);
  assert.match(source, /name: 'gemini_mcp_cleanup_stale_processes'/);
  assert.match(source, /name: 'gemini_diagnose_environment'/);
  assert.match(source, /name: 'gemini_flight_recorder'/);
  assert.match(source, /name: 'gemini_collect_support_bundle'/);
  assert.match(source, /url\.pathname === '\/agent\/diagnostics'/);
  assert.match(source, /url\.pathname === '\/agent\/support-bundle'/);
  assert.match(source, /url\.pathname === '\/agent\/flight-recorder'/);
  assert.match(source, /buildEnvironmentDiagnostics/);
  assert.match(source, /recordFlightEvent/);
  assert.match(source, /buildSupportBundle/);
  assert.match(source, /buildProcessDiagnostics/);
  assert.match(source, /cleanupStaleMcpProcesses/);
  assert.match(source, /confirm=true/);
  assert.ok(guardedBlock, 'lista de tools com guard deve existir');
  assert.ok(localProxyBlock, 'lista de tools locais em proxy deve existir');
  assert.doesNotMatch(guardedBlock, /gemini_mcp_diagnose_processes/);
  assert.doesNotMatch(guardedBlock, /gemini_mcp_cleanup_stale_processes/);
  assert.doesNotMatch(guardedBlock, /gemini_diagnose_environment/);
  assert.match(localProxyBlock, /processes/);
  assert.match(localProxyBlock, /cleanup_processes/);
  assert.match(localProxyBlock, /diagnose/);
  assert.match(localProxyBlock, /bundle/);
});

test('bridge busca mídia sem depender de CORS da extensão Chrome', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(serverSource, /const fetchAssetForBridge = async \(source\) =>/);
  assert.match(serverSource, /url\.pathname === '\/bridge\/fetch-asset'/);
  assert.match(serverSource, /isPrivateNetworkHostname/);
  assert.match(serverSource, /BRIDGE_ASSET_FETCH_MAX_BYTES/);
  assert.match(serverSource, /BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES/);
  assert.match(serverSource, /BRIDGE_ASSET_FETCH_CACHE_TTL_MS/);
  assert.match(serverSource, /BRIDGE_ASSET_FETCH_MAX_IN_FLIGHT/);
  assert.match(serverSource, /BRIDGE_ASSET_HOST_BACKOFF_FAILURE_THRESHOLD/);
  assert.match(serverSource, /const bridgeAssetCache = new Map\(\)/);
  assert.match(serverSource, /const bridgeAssetInFlight = new Map\(\)/);
  assert.match(serverSource, /const bridgeAssetHostBackoff = new Map\(\)/);
  assert.match(serverSource, /const withBridgeAssetFetchSlot = \(host, fn\) =>/);
  assert.match(serverSource, /snapshotBridgeAssetMetrics/);
  assert.match(serverSource, /cacheHit/);
  assert.match(serverSource, /inFlightDeduped/);
  assert.match(serverSource, /backoffHits/);
  assert.match(contentSource, /const fetchImageAssetViaBridge = async \(source\) =>/);
  assert.match(contentSource, /\/bridge\/fetch-asset/);
  assert.match(contentSource, /shouldFetchViaBridgeFirst/);
  assert.match(contentSource, /shouldFetchViaBackgroundFirst\(source\)/);
  assert.match(backgroundSource, /const credentialModes = isGoogleMediaHost \? \['include', 'omit'\] : \['omit'\]/);
  assert.doesNotMatch(backgroundSource, /\['omit', 'include'\]/);
});
