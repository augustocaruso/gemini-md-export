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
  const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));

  assert.equal(bridgeVersion.protocolVersion, 2);
  assert.match(source, /url\.pathname === '\/bridge\/events'/);
  assert.match(source, /text\/event-stream/);
  assert.match(source, /sendClientEvent\(client, 'command'/);
  assert.match(source, /url\.pathname === '\/bridge\/snapshot'/);
  assert.match(source, /upsertClientSnapshot/);
  assert.match(source, /snapshotRequested/);
  assert.match(source, /commandDelivery:\s*heartbeatCommand/);
  assert.match(source, /duplicate:\s*!resolved/);
});

test('browser_status expõe saúde da bridge MCP/Chrome', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /const buildBridgeHealth = \(client/);
  assert.match(source, /command_channel_stuck/);
  assert.match(source, /heartbeat_delayed/);
  assert.match(source, /bridgeHealth/);
  assert.match(source, /diagnostics/);
});

test('browser_status diagnostica e tenta self-heal sem depender do guard wrapper', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const statusBlock = source.match(
    /name: 'gemini_browser_status'[\s\S]*?\n  \{\n    name: 'gemini_mcp_diagnose_processes'/,
  )?.[0];
  const guardedBlock = source.match(
    /const BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
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
  assert.doesNotMatch(guardedBlock, /gemini_browser_status/);
});

test('MCP expõe diagnóstico e cleanup controlado de processos sem guard de browser', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const guardedBlock = source.match(
    /const BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  const localProxyBlock = source.match(
    /const LOCAL_PROXY_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];

  assert.match(source, /name: 'gemini_mcp_diagnose_processes'/);
  assert.match(source, /name: 'gemini_mcp_cleanup_stale_processes'/);
  assert.match(source, /buildProcessDiagnostics/);
  assert.match(source, /cleanupStaleMcpProcesses/);
  assert.match(source, /confirm=true/);
  assert.ok(guardedBlock, 'lista de tools com guard deve existir');
  assert.ok(localProxyBlock, 'lista de tools locais em proxy deve existir');
  assert.doesNotMatch(guardedBlock, /gemini_mcp_diagnose_processes/);
  assert.doesNotMatch(guardedBlock, /gemini_mcp_cleanup_stale_processes/);
  assert.match(localProxyBlock, /gemini_mcp_diagnose_processes/);
  assert.match(localProxyBlock, /gemini_mcp_cleanup_stale_processes/);
});

test('bridge busca mídia sem depender de CORS da extensão Chrome', () => {
  const serverSource = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.js'), 'utf-8');
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.js'), 'utf-8');

  assert.match(serverSource, /const fetchAssetForBridge = async \(source\) =>/);
  assert.match(serverSource, /url\.pathname === '\/bridge\/fetch-asset'/);
  assert.match(serverSource, /isPrivateNetworkHostname/);
  assert.match(serverSource, /BRIDGE_ASSET_FETCH_MAX_BYTES/);
  assert.match(contentSource, /const fetchImageAssetViaBridge = async \(source\) =>/);
  assert.match(contentSource, /\/bridge\/fetch-asset/);
  assert.match(contentSource, /shouldFetchViaBridgeFirst/);
  assert.match(contentSource, /shouldFetchViaBackgroundFirst\(source\)/);
  assert.match(backgroundSource, /const credentialModes = isGoogleMediaHost \? \['include', 'omit'\] : \['omit'\]/);
  assert.doesNotMatch(backgroundSource, /\['omit', 'include'\]/);
});
