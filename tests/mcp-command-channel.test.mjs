import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeAgentJsonValue, stringifyAgentPayload } from '../build/ts/mcp/agent-json.js';

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

test('MCP sanitiza erro de endpoint agent antes de serializar JSON', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const sendAgentJsonBlock = source.match(
    /const sendAgentJson = \(res, statusCode, payload\) => \{[\s\S]*?\n\};/,
  )?.[0] || '';
  const sendAgentErrorBlock = source.match(
    /const sendAgentError = \(res, statusCode, err\) =>[\s\S]*?\n  \}\);/,
  )?.[0] || '';
  const circular = { ok: true };
  circular.self = circular;

  assert.match(source, /agent-json\.js/);
  assert.equal(sanitizeAgentJsonValue(circular).self, '[Circular]');
  assert.deepEqual(JSON.parse(stringifyAgentPayload({ circular })), {
    circular: { ok: true, self: '[Circular]' },
  });
  assert.match(sendAgentJsonBlock, /agentJson\.stringifyAgentPayload\(payload\)/);
  assert.match(sendAgentErrorBlock, /data: agentJson\.sanitizeAgentJsonValue\(err\?\.data\) \?\? null/);
});

test('MCP aborta export se a aba para de enviar heartbeat durante comando pesado', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const cleanupBlock = source.match(
    /const cleanupStaleClients = \(\) => \{[\s\S]*?\n\};/,
  )?.[0] || '';
  const reconnectBlock = source.match(
    /const preserveReconnectConversationCache = \(client, payload = \{\}\) => \{[\s\S]*?\n\};\n\nconst upsertClient/,
  )?.[0] || '';
  const enqueueBlock = source.match(
    /const enqueueCommand = \(clientId, type, args = \{\}, options = \{\}\) => \{[\s\S]*?\n\};\n\nconst resolveCommand/,
  )?.[0] || '';
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0] || '';

  assert.match(source, /EXPORT_COMMAND_STALE_ABORT_MS/);
  assert.match(enqueueBlock, /staleAbortMs/);
  assert.match(enqueueBlock, /staleTimer/);
  assert.match(enqueueBlock, /client_stale_during_command/);
  assert.match(enqueueBlock, /markClientCommandTimeout\(clientId, type,[\s\S]*client_stale_during_command/);
  assert.match(collectBlock, /staleAbortMs:\s*exportCommandStaleAbortMs\(args\)/);
  assert.match(cleanupBlock, /retainedByPendingCommandAt/);
  assert.doesNotMatch(
    cleanupBlock,
    /client\.lastSeenAt\s*=\s*now/,
    'cleanup nao pode renovar lastSeenAt de cliente morto, senao o stale abort nunca dispara',
  );
  assert.match(source, /const abortPendingCommandsForClient = \(/);
  assert.match(source, /selectReconnectSourcesForTab/);
  assert.match(reconnectBlock, /for \(const source of abortClients\)/);
  assert.match(reconnectBlock, /abortPendingCommandsForClient\(source\.clientId/);
  assert.match(reconnectBlock, /client_reconnected_during_command/);
  assert.match(source, /err\?\.code === 'client_reconnected_during_command'/);
  assert.match(source, /err\?\.code === 'client_stale_during_command'/);
});

test('MCP propaga cancelamento de job para operação ativa no navegador', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /requestActiveBrowserOperationCancelForJob/);
  assert.match(source, /'cancel-active-operation'/);
  assert.match(source, /browser_operation_cancel_requested/);
  assert.match(source, /browser_operation_cancel_result/);
  assert.match(source, /requestExportJobCancel\(job, 'tool-cancel'\)/);
  assert.match(source, /requestExportJobCancel\(job, 'agent-cancel'\)/);
  assert.match(contentSource, /command\.type === 'cancel-active-operation'/);
  assert.match(contentSource, /activeTabOperationCancelRequested/);
  assert.match(contentSource, /operation_cancelled/);
});

test('MCP usa SSE para progresso, mas exige long-poll para comandos por padrão', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const flushBlock = source.match(
    /const flushQueuedCommand = \(client[\s\S]*?\n\};\n\nconst removeQueuedCommand/,
  )?.[0] || '';
  const enqueueBlock = source.match(
    /const enqueueCommand = \(clientId, type, args = \{\}, options = \{\}\) => \{[\s\S]*?\n\};\n\nconst resolveCommand/,
  )?.[0] || '';
  const heartbeatBlock = source.match(
    /url\.pathname === '\/bridge\/heartbeat'[\s\S]*?sendBridgeJson\(req, res, 200,[\s\S]*?\n      \}\);/,
  )?.[0] || '';

  assert.match(source, /SSE_COMMAND_FAILURE_BACKOFF_MS/);
  assert.match(source, /SSE_COMMAND_DELIVERY_ENABLED/);
  assert.match(source, /const clientEventStreamUsable = \(client\) =>/);
  assert.match(source, /const clientCommandEventStreamUsable = \(client\) =>/);
  assert.match(flushBlock, /clientCommandEventStreamUsable\(client\)/);
  assert.doesNotMatch(flushBlock, /clientEventStreamUsable\(client\) && sendClientEvent\(client, 'command'/);
  assert.match(flushBlock, /pending\.delivery = 'sse'/);
  assert.ok(
    flushBlock.indexOf('if (client.pendingPoll)') <
      flushBlock.indexOf('clientCommandEventStreamUsable(client)'),
    'long-poll pendente deve ganhar de qualquer fallback SSE para comandos',
  );
  assert.match(enqueueBlock, /disableClientSseCommandChannel\(clientId/);
  assert.match(source, /closeEventStream\(client\)/);
  assert.match(heartbeatBlock, /const eventStreamUsable = clientEventStreamUsable\(client\)/);
  assert.match(heartbeatBlock, /const commandStreamUsable = clientCommandEventStreamUsable\(client\)/);
  assert.match(heartbeatBlock, /transport:\s*\{[\s\S]*eventsConnected: eventStreamUsable/);
  assert.match(heartbeatBlock, /commandPollRequired: !client\.pendingPoll && !commandStreamUsable/);
  assert.match(heartbeatBlock, /shouldIncludeHeartbeatJobProgress/);
  assert.doesNotMatch(heartbeatBlock, /eventStreamUsable \? null : buildJobProgressBroadcast/);
  assert.doesNotMatch(contentSource, /response\?\.commandPollRequired === true \|\| !response\?\.transport\?\.eventsConnected[\s\S]*?closeBridgeEvents\(\)/);
  assert.match(contentSource, /pollBridgeCommands\(true, \{ force: commandPollRequired \}\)/);
  assert.match(contentSource, /bridgeState\.eventsConnected && !force/);
  assert.match(contentSource, /while \(bridgeState\.started && \(!bridgeState\.eventsConnected \|\| force\)\)/);
});

test('MCP não envia comando de self-reload pelo heartbeat', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const heartbeatBlock = source.match(
    /url\.pathname === '\/bridge\/heartbeat'[\s\S]*?sendBridgeJson\(req, res, 200,[\s\S]*?\n      \}\);/,
  )?.[0] || '';

  assert.doesNotMatch(source, /const buildHeartbeatExtensionReload = \(client\) =>/);
  assert.doesNotMatch(heartbeatBlock, /extensionReload/);
  assert.doesNotMatch(heartbeatBlock, /reload-extension-self/);
});

test('MCP nao usa heartbeat como transporte de comandos', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const heartbeatBlock = source.match(
    /url\.pathname === '\/bridge\/heartbeat'[\s\S]*?sendBridgeJson\(req, res, 200,[\s\S]*?\n      \}\);/,
  )?.[0] || '';

  assert.doesNotMatch(heartbeatBlock, /takeQueuedCommand\(client\)/);
  assert.doesNotMatch(heartbeatBlock, /command:\s*heartbeatCommand/);
  assert.doesNotMatch(heartbeatBlock, /commandDelivery:\s*heartbeatCommand/);
  assert.match(heartbeatBlock, /flushQueuedCommand\(client\)/);
  assert.match(heartbeatBlock, /commandPollRequired: !client\.pendingPoll && !commandStreamUsable/);
});

test('MCP nao transforma tabId nulo em aba zero ao renormalizar selector', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const normalizeTabIdBlock = source.match(
    /const normalizeTabId = \(value\) => \{[\s\S]*?\n\};/,
  )?.[0] || '';

  assert.match(normalizeTabIdBlock, /value === null/);
  assert.match(normalizeTabIdBlock, /value === undefined/);
  assert.match(normalizeTabIdBlock, /value === ''/);
  assert.match(normalizeTabIdBlock, /return null/);
});

test('MCP prefere build stamp do content script quando service worker esta stale', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /next\.buildStamp = payload\.page\?\.buildStamp \|\| payload\.buildStamp \|\| next\.buildStamp \|\| null/);
  assert.match(source, /String\(client\?\.page\?\.buildStamp \|\| client\?\.buildStamp \|\| ''\)/);
  assert.match(source, /const actualBuildStamp = client\.page\?\.buildStamp \|\| client\.buildStamp \|\| null/);
  assert.match(source, /const clientBuildStamp = \(client\) => client\?\.page\?\.buildStamp \|\| client\?\.buildStamp \|\| null/);
});

test('MCP reavalia build stamp esperado em runtime para auto-reload', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeInfoSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'runtime-version-info.ts'),
    'utf-8',
  );

  assert.match(source, /createExpectedChromeExtensionInfo/);
  assert.match(runtimeInfoSource, /export const readCurrentBridgeVersion/);
  assert.match(runtimeInfoSource, /const currentBridgeVersion = readCurrentBridgeVersion\(\{ root, bridgeVersion \}\)/);
  assert.match(runtimeInfoSource, /\.gemini', 'extensions', 'gemini-md-export'/);
  assert.match(runtimeInfoSource, /buildStamp: detectExpectedBrowserBuildStamp\(options\)/);
  assert.match(runtimeInfoSource, /Object\.defineProperty\(info, key,[\s\S]*get: \(\) => snapshot\(\)\[key\]/);
  assert.doesNotMatch(source, /buildStamp:\s*detectExpectedBrowserBuildStamp\(\),\n\};/);
});

test('MCP dá timeout maior e knobs de hidratação para export de conversa gigante', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /DEFAULT_EXPORT_HYDRATION_MAX_TOTAL_MS = 10 \* 60_000/);
  assert.match(source, /EXPORT_COMMAND_TIMEOUT_MS/);
  assert.match(source, /const exportHydrationArgs = \(args = \{\}\) =>/);
  assert.match(source, /hydrationMaxTotalMs/);
  assert.match(source, /hydrationStallTimeoutMs/);
  assert.match(source, /exportCommandTimeoutMs/);
  assert.match(source, /'get-chat-by-id'[\s\S]*\.\.\.hydrationArgs/);
  assert.match(source, /\{ timeoutMs: commandTimeoutMs \}/);
});

test('MCP protocolo v2 usa SSE para comandos e snapshot separado', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const bridgeOriginSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'bridge-origin.ts'), 'utf-8');
  const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));
  const eventsBlock = source.match(
    /url\.pathname === '\/bridge\/events'[\s\S]*?sendClientEvent\(client, 'hello'/,
  )?.[0] || '';

  assert.equal(bridgeVersion.protocolVersion, 2);
  assert.match(source, /url\.pathname === '\/bridge\/events'/);
  assert.match(source, /text\/event-stream/);
  assert.match(eventsBlock, /tabId:\s*url\.searchParams\.has\('tabId'\)/);
  assert.match(eventsBlock, /buildStamp:\s*url\.searchParams\.get\('buildStamp'\)/);
  assert.match(eventsBlock, /claimId:\s*url\.searchParams\.get\('claimId'\)/);
  assert.match(eventsBlock, /const client = upsertClient\(\{/);
  assert.match(source, /sendClientEvent\(client, 'command'/);
  assert.match(source, /url\.pathname === '\/bridge\/snapshot'/);
  assert.match(source, /upsertClientSnapshot/);
  assert.match(source, /snapshotRequested/);
  assert.match(source, /recordPayloadMetric\(next, 'heartbeat'/);
  assert.match(source, /recordPayloadMetric\(client, 'snapshot'/);
  assert.match(source, /summarizePayloadMetrics/);
  assert.doesNotMatch(source, /commandDelivery:\s*heartbeatCommand/);
  assert.doesNotMatch(source, /pending\.delivery = 'heartbeat'/);
  assert.match(source, /duplicate:\s*!resolved/);
  assert.match(contentSource, /heartbeat-incremental-v1/);
  assert.match(contentSource, /tab-backpressure-v1/);
  assert.match(contentSource, /const buildBridgeHeartbeatPayload = \(\) => \(\{/);
  assert.doesNotMatch(
    contentSource.match(/const buildBridgeHeartbeatPayload = \(\) => \(\{[\s\S]*?\n  \}\);/)?.[0] || '',
    /conversations:/,
  );
  assert.match(source, /compiledTsModuleUrl\('mcp', 'bridge-origin\.js'\)/);
  assert.match(bridgeOriginSource, /GEMINI_BRIDGE_PAGE_ORIGIN = 'https:\/\/gemini\.google\.com'/);
  assert.match(bridgeOriginSource, /parsed\.protocol === 'chrome-extension:'/);
  assert.match(bridgeOriginSource, /CHROMIUM_EXTENSION_ID_RE\.test\(parsed\.hostname\)/);
});

test('MCP nao conta event stream sem evidência de aba como cliente vivo', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const getLiveClientsBlock = source.match(
    /const getLiveClients = \(\) => \{[\s\S]*?\n\};/,
  )?.[0] || '';

  assert.match(source, /clientHasLiveRuntimeEvidence/);
  assert.match(source, /const clientHasLiveRuntimeEvidenceForServer = \(client, now = Date\.now\(\)\) =>/);
  assert.match(getLiveClientsBlock, /clientHasLiveRuntimeEvidenceForServer\(client, now\)/);
  assert.doesNotMatch(
    getLiveClientsBlock,
    /\.filter\(\(client\) => now - client\.lastSeenAt <= CLIENT_STALE_MS\)/,
  );
});

test('MCP permite cliente My Activity sem liberar endpoints de escrita', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const bridgeOriginSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'bridge-origin.ts'), 'utf-8');

  assert.match(source, /GEMINI_BRIDGE_PAGE_ORIGIN = 'https:\/\/gemini\.google\.com'/);
  assert.match(source, /ACTIVITY_BRIDGE_PAGE_ORIGIN = 'https:\/\/myactivity\.google\.com'/);
  assert.match(bridgeOriginSource, /isAllowedActivityBridgeOrigin/);
  assert.match(source, /requireGeminiBridgeOrigin/);
  assert.match(source, /url\.pathname === '\/agent\/activity-scan'/);
  assert.match(source, /'activity-scan-batch'/);
  assert.match(source, /claimTabForClient\(client,[\s\S]*TAB_CLAIM_LABELS\.count/);
  assert.match(source, /releaseTabClaim\(\{[\s\S]*activity-scan-complete/);
  assert.match(source, /activity_client_missing/);

  const pickDirectoryBlock = source.match(
    /req\.method === 'POST' && url\.pathname === '\/bridge\/pick-directory'[\s\S]*?return;\n  \}/,
  )?.[0] || '';
  const saveFilesBlock = source.match(
    /req\.method === 'POST' && url\.pathname === '\/bridge\/save-files'[\s\S]*?return;\n  \}/,
  )?.[0] || '';
  assert.match(pickDirectoryBlock, /requireGeminiBridgeOrigin\(req\)/);
  assert.match(saveFilesBlock, /requireGeminiBridgeOrigin\(req\)/);
});

test('MCP nao escolhe cliente My Activity de build antigo apos reload da extensao', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const buildHealthBlock = source.match(
    /const buildBridgeHealth = \(client, now = Date\.now\(\)\) => \{[\s\S]*?return \{[\s\S]*?\n  \};\n\};/,
  )?.[0] || '';
  const getActivityClientsBlock = source.match(
    /const getActivityClients = \(\) =>[\s\S]*?;\n\nconst activityClientMissingError/,
  )?.[0] || '';
  const requireActivityClientBlock = source.match(
    /const requireActivityClient = \(selector = \{\}\) => \{[\s\S]*?\n\};\n\nconst scanActivityWithClient/,
  )?.[0] || '';

  assert.match(buildHealthBlock, /const versionMatches = clientMatchesExpectedBrowserExtension\(client\)/);
  assert.match(buildHealthBlock, /evaluateBridgeHealth\(client/);
  assert.doesNotMatch(buildHealthBlock, /activityClient\s*\|\|\s*clientMatchesExpectedBrowserExtension/);
  assert.match(getActivityClientsBlock, /Number\(clientMatchesExpectedBrowserExtension\(b\)\)/);
  assert.match(getActivityClientsBlock, /Number\(clientMatchesExpectedBrowserExtension\(a\)\)/);
  assert.match(source, /activity_client_version_mismatch/);
  assert.match(requireActivityClientBlock, /const matchingClients = activityClients\.filter\(clientMatchesExpectedBrowserExtension\)/);
  assert.match(requireActivityClientBlock, /if \(selected && clientMatchesExpectedBrowserExtension\(selected\)\) return selected/);
  assert.match(requireActivityClientBlock, /if \(selected\) throw activityClientVersionMismatchError\(\[selected\]\)/);
  assert.match(requireActivityClientBlock, /matchingClients\.find/);
  assert.doesNotMatch(requireActivityClientBlock, /if \(activityClients\[0\]\) return activityClients\[0\]/);
});

test('MCP só reivindica abas Gemini ativas por contrato TS', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const selectClaimableBlock = source.match(
    /const selectClaimableClient = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst claimTabForClient/,
  )?.[0] || '';
  const claimGeminiTabBlock = source.match(
    /const claimGeminiTabForClient = async \(client, args = \{\}\) =>[\s\S]*?\n\nconst releaseTabClaim/,
  )?.[0] || '';
  const listTabsBlock = source.match(
    /name: 'gemini_list_tabs'[\s\S]*?\n  \},\n  \{\n    name: 'gemini_claim_tab'/,
  )?.[0] || '';

  assert.match(source, /toActiveClaimableGeminiClient/);
  assert.match(source, /getActiveClaimableGeminiClients/);
  assert.match(source, /assertActiveClaimableGeminiClient/);
  assert.match(source, /activateBrowserTabWithCdp/);
  assert.match(source, /activateRuntimeExtensionClientWithCdp/);
  assert.match(source, /buildRuntimeCdpControlSnapshot/);
  assert.doesNotMatch(source, /const cdpUrlForArgs/);
  assert.match(selectClaimableBlock, /getActiveClaimableGeminiClients/);
  assert.match(selectClaimableBlock, /selectClaimActivationCandidate/);
  assert.match(selectClaimableBlock, /activateBrowserTabById/);
  assert.match(selectClaimableBlock, /inactiveGeminiTabClaimNotAllowedError/);
  assert.match(claimGeminiTabBlock, /claimTabForClient\(client, args, \{ requireActiveGemini: true \}\)/);
  assert.match(listTabsBlock, /claimableClients/);
  assert.match(listTabsBlock, /const diagnosticClients = tabSelectionDiagnostics\(allLiveClients, claimableClients\)/);
});

test('MCP expõe lifecycle diagnostics para readiness de abas', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /classifyGeminiClientLifecycle/);
  assert.match(source, /getGeminiClientLifecycle/);
  assert.match(source, /hydrateClientLifecycleFields/);
  assert.match(source, /clientHasPageBlocker/);
  assert.match(source, /evaluateBridgeHealth/);
  assert.match(source, /evaluateBrowserReadiness/);
  assert.match(source, /claimableTabCount/);
  assert.match(source, /lifecycle:\s*lifecycleSummaryForClient/);
});

test('MCP acorda My Activity reaproveitando aba existente antes de abrir outra', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const ensureActivityBlock = source.match(
    /const ensureActivityClientForScan = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst scanActivityWithClient/,
  )?.[0] || '';

  assert.match(source, /ACTIVITY_GEMINI_URL = 'https:\/\/myactivity\.google\.com\/product\/gemini'/);
  assert.match(source, /ACTIVITY_PRE_LAUNCH_WAIT_MS/);
  assert.match(source, /const waitForActivityClient = async/);
  assert.match(source, /targetUrl:\s*ACTIVITY_GEMINI_URL/);
  assert.match(source, /openIfMissing !== true/);
  assert.match(source, /reason:\s*'activity-client-already-connected'/);
  assert.match(ensureActivityBlock, /const existingClient = await waitForActivityClient/);
  assert.match(ensureActivityBlock, /args\.preLaunchWaitMs \?\? ACTIVITY_PRE_LAUNCH_WAIT_MS/);
  assert.match(ensureActivityBlock, /reason:\s*'activity-client-connected-before-launch'/);
  assert.match(source, /const launchMatchesTarget = \(launch = \{\}\) => \{[\s\S]*?return launch\.targetUrl === targetUrl;/);
  assert.doesNotMatch(source, /return !launch\.targetUrl \|\| launch\.targetUrl === targetUrl/);
  assert.ok(
    ensureActivityBlock.indexOf('activity-client-connected-before-launch') <
      ensureActivityBlock.indexOf('launchChromeForGemini'),
  );
});

test('browser_status expõe saúde da bridge MCP/Chrome', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const bridgeHealthSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'bridge-health.ts'), 'utf-8');

  assert.match(source, /const buildBridgeHealth = \(client/);
  assert.match(source, /const buildExtensionReadiness = \(\{/);
  assert.match(bridgeHealthSource, /command_channel_stuck/);
  assert.match(bridgeHealthSource, /runtime_signal_delayed/);
  assert.match(source, /bridgeHealth/);
  assert.match(source, /extensionReadiness/);
  assert.match(source, /handshake/);
  assert.match(source, /gemini_browser_ready/);
  assert.match(source, /buildLightweightBrowserReady/);
  assert.match(source, /evaluateBrowserReadiness/);
  assert.match(source, /evaluateBridgeHealth/);
  assert.match(source, /serviceWorker/);
  assert.match(source, /contentScript/);
  assert.match(source, /diagnostics/);
  assert.match(source, /const clientHasOpenCommandChannel = \(client\) =>\s*clientCommandEventStreamUsable\(client\) \|\|/);
  assert.match(source, /const commandChannelReadyForClient = \(client\) =>\s*clientHasOpenCommandChannel\(client\) &&\s*!clientHasRecentCommandFailure\(client\);/);
  assert.match(source, /recentCommandFailure:\s*clientHasRecentCommandFailure\(client, now\)/);
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

test('MCP publico bloqueia contagem/exportacao por tools ruidosas sem depender de hooks', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const hooksConfig = JSON.parse(
    readFileSync(resolve(ROOT, 'gemini-cli-extension', 'hooks', 'hooks.json'), 'utf-8'),
  );

  assert.match(source, /const PUBLIC_MCP_INTENTS = new Set\(\['diagnostic', 'tab_management', 'small_page', 'one_off'\]\)/);
  assert.match(source, /explicit_mcp_intent_required/);
  assert.match(source, /use_cli_only/);
  assert.match(source, /buildCliCountCommand/);
  assert.match(source, /buildCliReexportCommand/);
  assert.match(source, /const commandArgs = \[CLI_BIN_PATH, 'export', 'selected'\]/);
  assert.match(source, /name: 'gemini_job'[\s\S]*?enum: \['list', 'status', 'cancel'\]/);
  assert.match(source, /'gemini_export_job_list'/);
  const countCommandStart = source.indexOf('const buildCliCountCommand');
  const countCommandEnd = source.indexOf('const buildCliTabsCommand', countCommandStart);
  assert.ok(countCommandStart >= 0 && countCommandEnd > countCommandStart);
  const countCommandBlock = source.slice(countCommandStart, countCommandEnd);
  assert.match(countCommandBlock, /--client-id/);
  assert.match(countCommandBlock, /--tab-id/);
  assert.match(countCommandBlock, /--claim-id/);
  assert.doesNotMatch(countCommandBlock, /loadMore|load-more/);
  assert.match(source, /action === 'count' \|\| args\.untilEnd === true \|\| args\.countOnly === true/);
  assert.match(source, /action === 'download'/);
  assert.match(source, /diagnostic: \{ type: 'boolean' \}/);
  assert.match(source, /intent: \{ type: 'string', enum: \['diagnostic', 'tab_management'\] \}/);
  assert.match(source, /intent: \{ type: 'string', enum: \['diagnostic', 'small_page', 'one_off'\] \}/);
  assert.deepEqual(hooksConfig, { hooks: {} });
});

test('MCP implementa afinidade confiável por claim de aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');

  assert.match(source, /name: 'gemini_list_tabs'/);
  assert.match(source, /name: 'gemini_claim_tab'/);
  assert.match(source, /name: 'gemini_release_tab'/);
  assert.match(source, /getSelectableGeminiClients/);
  assert.match(source, /clientHasConcreteTabIdentity\(client\)/);
  assert.match(source, /const clientHasFreshPageHeartbeat = \(client, now = Date\.now\(\)\) =>/);
  assert.match(source, /!!client\?\.page && !!client\?\.lastHeartbeatAt/);
  assert.match(source, /dedupeSelectableClientsByTabId/);
  assert.match(source, /compareSelectableClientPreference/);
  assert.match(source, /byTabId\.set\(tabKey, client\)/);
  assert.match(source, /return dedupeSelectableClientsByTabId\(liveClients\.filter\(clientIsSelectableGeminiTab\)\)/);
  assert.match(source, /clientHasFreshPageHeartbeat\(client\)/);
  assert.match(source, /selectUnambiguousImplicitGeminiClient/);
  assert.match(source, /activeUsefulClients\.length === 1/);
  assert.match(source, /diagnosticClients/);
  assert.match(source, /demotedFromTabSelection/);
  assert.match(source, /missing-tab-id/);
  assert.match(source, /ambiguous_gemini_tabs/);
  assert.doesNotMatch(source, /em MCP, use gemini_tabs/);
  assert.match(source, /tabClaims = new Map/);
  assert.match(source, /sessionClaims = new Map/);
  assert.match(source, /TAB_CLAIM_LABELS = Object\.freeze\(\{/);
  assert.match(source, /generic: '✨ Em uso'/);
  assert.match(source, /count: '🔎 Conferindo'/);
  assert.match(source, /list: '🔎 Conferindo'/);
  assert.match(source, /export: '📥 Exportando'/);
  assert.match(source, /sync: '🔄 Sincroniza'/);
  assert.match(source, /findReplacementClientForClaim/);
  assert.match(source, /rebindTabClaimToClient/);
  assert.match(source, /tab_claim_rebound/);
  assert.match(source, /release-tab-claim-by-tab-id/);
  assert.match(source, /hasPendingCommandForClient/);
  assert.match(source, /retainedByPendingCommandAt/);
  assert.match(source, /lastCommandResultAt/);
  assert.match(source, /COMMAND_CHANNEL_FAILURE_COOLDOWN_MS/);
  assert.match(source, /markClientCommandTimeout/);
  assert.match(source, /clientHasRecentCommandFailure/);
  assert.match(source, /evaluateBridgeHealth/);
  assert.match(source, /releaseClaimOnOperationEnd/);
  assert.match(source, /releaseClaimOnSlowOperationMs/);
  assert.match(source, /allowLaunchChrome:\s*args\.openIfMissing === true/);
  assert.match(source, /_proxySessionId/);
  assert.match(contentSource, /tab-claim-v1/);
  assert.match(contentSource, /command\.type === 'claim-tab'/);
  assert.match(contentSource, /command\.type === 'release-tab-claim'/);
  assert.match(contentSource, /command\.type === 'release-tab-claim-by-tab-id'/);
  assert.match(contentSource, /requestedTabId === currentTabId/);
  assert.match(contentSource, /claim-released-by-tab-id/);
  assert.match(contentSource, /isExtensionContextInvalidatedError/);
  assert.match(contentSource, /reason: 'extension-context-invalidated'/);
  assert.match(contentSource, /localOnly: true/);
  assert.match(contentSource, /TAB_CLAIM_DEFAULT_LABEL = '✨ Em uso'/);
  assert.match(contentSource, /TAB_CLAIM_TITLE_PREFIX_RE/);
  assert.match(contentSource, /LEGACY_TAB_CLAIM_TITLE_PREFIX_RE/);
  assert.match(contentSource, /gemini-md-export\/tab-broker-update/);
  assert.match(contentSource, /reportTabBrokerState\('operation-start'/);
  assert.match(contentSource, /reportTabBrokerState\('claim-applied'/);
  assert.match(contentSource, /maybeReleaseClaimAfterTabOperation/);
  assert.match(contentSource, /releaseClaimOnOperationTerminalOnly/);
  assert.match(backgroundSource, /tabBrokerRegistry = new Map/);
  assert.match(backgroundSource, /TAB_CLAIM_DEFAULT_LABEL = '✨ Em uso'/);
  assert.match(backgroundSource, /TAB_CLAIM_BADGE_TEXT = '✓'/);
  assert.match(backgroundSource, /Array\.from\([\s\S]*String\(value \|\| ''\)[\s\S]*\.replace/);
  assert.match(backgroundSource, /MANAGED_TAB_CLAIM_GROUP_TITLE_RE/);
  assert.match(backgroundSource, /summarizeTabBrokerRegistry/);
  assert.match(backgroundSource, /message\?\.type === 'gemini-md-export\/tab-broker-update'/);
  assert.match(backgroundSource, /requestedTabId/);
  assert.match(backgroundSource, /scheduleTabClaimExpiry/);
  assert.match(backgroundSource, /TAB_CLAIM_ALARM_PREFIX/);
  assert.match(backgroundSource, /chrome\.alarms\.create/);
  assert.match(backgroundSource, /chrome\.alarms\?\.onAlarm/);
  assert.match(backgroundSource, /restoreTabClaimExpiryAlarms/);
  assert.match(backgroundSource, /tab-claim-expiry-watch/);
  assert.match(backgroundSource, /ensureOffscreenDocument\(\{\s*reason: 'tab-claim-expiry-watch'/);
  assert.match(backgroundSource, /looksLikeManagedClaimGroupTitle/);
  assert.match(backgroundSource, /setActionBadge\(tabId, TAB_CLAIM_BADGE_TEXT/);
  assert.doesNotMatch(backgroundSource, /setActionBadge\(tabId, 'GME'/);
  assert.match(backgroundSource, /releaseTrackedTabClaimByTabId/);
  assert.match(backgroundSource, /chrome\.tabs\.group/);
  assert.match(backgroundSource, /chrome\.tabGroups\.update/);
  assert.match(backgroundSource, /tab-already-in-user-group/);
  assert.match(backgroundSource, /cleanupStaleTabClaimVisuals/);
  assert.match(backgroundSource, /stillOurGroup/);
  assert.match(backgroundSource, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(backgroundSource, /message\?\.type === 'RELOAD_SELF'/);
  assert.match(buildSource, /'tabGroups'/);
  assert.doesNotMatch(buildSource, /'alarms'/);
});

test('MCP prefere native browser broker antes de fallback por heartbeat', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /createNativeBrowserBrokerClient/);
  assert.match(source, /shouldUseNativeBrowserBroker/);
  assert.match(source, /tryNativeBrowserBrokerTabsAction/);
  assert.match(source, /nativeBrowserBroker\.listTabs/);
  assert.match(source, /nativeBrowserBroker\.claim/);
  assert.doesNotMatch(source, /lastHeartbeatAt[^\n]+claimGeminiTabForClient/);
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
  assert.match(statusBlock, /const readiness = evaluateBrowserReadiness/);
  assert.match(statusBlock, /ready:\s*readiness\.ready/);
  assert.match(statusBlock, /claimableTabCount/);
  assert.match(statusBlock, /blockingIssue/);
  assert.match(source, /evaluateBrowserReadiness/);
  assert.match(statusBlock, /selfHeal/);
  assert.match(statusBlock, /ensureBrowserExtensionReady/);
  assert.match(statusBlock, /allowReload:\s*args\.allowReload === true/);
  assert.doesNotMatch(statusBlock, /allowReload:\s*args\.allowReload !== false/);
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
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const backgroundSource = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');

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
