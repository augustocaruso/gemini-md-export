import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeAgentJsonValue, stringifyAgentPayload } from '../build/ts/mcp/agent-json.js';
import {
  evaluateEventStreamReconnectCommandFsm,
  isCommandSseDeliveryEnabled,
  shouldAbortDispatchedCommandsOnEventStreamReconnect,
  shouldAbortPendingSseCommandsOnEventStreamReconnect,
} from '../build/ts/mcp/command-channel.js';

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
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const contentSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /requestActiveBrowserOperationCancelForJob/);
  assert.match(source, /abortActiveConversationOperationForJob/);
  assert.match(operationSource, /conversation_operation_abort_requested/);
  assert.match(source, /abortActiveConversationOperationForJob\(job, reason, recentExportOperationDeps\)/);
  assert.match(source, /'cancel-active-operation'/);
  assert.match(source, /browser_operation_cancel_requested/);
  assert.match(source, /browser_operation_cancel_result/);
  assert.match(source, /requestExportJobCancel\(job, 'tool-cancel'\)/);
  assert.match(source, /requestExportJobCancel\(job, 'agent-cancel'\)/);
  assert.match(contentSource, /command\.type === 'cancel-active-operation'/);
  assert.match(contentSource, /activeTabOperationCancelRequested/);
  assert.match(contentSource, /abortController\.abort/);
  assert.match(contentSource, /operationId/);
  assert.match(contentSource, /operation_cancelled/);
});

test('recent export has per-conversation no-progress watchdog', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const operationSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'recent-export-operation-runtime.ts'),
    'utf-8',
  );
  const runRecentBlock = source.match(
    /const runRecentChatsExportJob = async \(job, client, args = \{\}\) => \{[\s\S]*?\n\};\n\nconst startRecentChatsExportJob/,
  )?.[0] || '';

  assert.match(operationSource, /export-operation-watchdog\.js/);
  assert.match(operationSource, /evaluateConversationOperationWatchdog/);
  assert.match(source, /DEFAULT_CONVERSATION_NO_PROGRESS_MS/);
  assert.match(source, /const conversationNoProgressMs = \(args = \{\}\) =>/);
  assert.match(runRecentBlock, /const noProgressMs = conversationNoProgressMs\(args\)/);
  assert.match(runRecentBlock, /runRecentExportConversationOperation/);
  assert.match(operationSource, /let operationLastProgressAt = Date\.now\(\)/);
  assert.match(operationSource, /const markOperationProgress = \([^)]*\) => \{/);
  assert.match(operationSource, /Promise\.race/);
  assert.match(operationSource, /evaluateConversationOperationWatchdog/);
  assert.match(operationSource, /conversation_no_progress_timeout/);
  assert.match(operationSource, /const operationAbortController = new AbortController\(\)/);
  assert.match(operationSource, /__activeConversationAbortController/);
  assert.match(operationSource, /enumerable:\s*false/);
  assert.match(operationSource, /abortSignal: operationAbortController\.signal/);
  assert.match(operationSource, /operationAbortController\.abort\(watchdogError\)/);
  assert.match(operationSource, /status: 'watchdog'/);
  assert.match(operationSource, /if \(downloadSettlement\.status === 'watchdog'\) \{/);
  assert.match(operationSource, /requestActiveBrowserOperationCancelForJob\(job, decision\.code\)/);
  assert.match(operationSource, /await drainTimedOutConversationOperation/);
  assert.doesNotMatch(operationSource, /setInterval\(async \(\) =>/);
  assert.doesNotMatch(operationSource, /const watchdogPromise = new Promise\(\(_, reject\)/);
  assert.doesNotMatch(operationSource, /void deps\.requestActiveBrowserOperationCancelForJob\(job, decision\.code\)/);
  assert.match(operationSource, /onOperationProgress: markOperationProgress/);
  assert.match(source, /const assertConversationOperationNotAborted = \(args = \{\}\) =>/);
  assert.match(source, /operation_cancelled/);
  assert.match(operationSource, /conversation_watchdog_drain_timeout/);
  assert.match(operationSource, /recoverBrowserTabAfterWatchdog/);
  assert.match(operationSource, /operation_cancel_failed_after_watchdog/);
});

test('MCP usa SSE para comandos por padrão, mantendo long-poll como prioridade quando aberto', () => {
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

test('MCP preserva comando despachado quando a mesma aba reabre o event stream', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const eventsBlock = source.match(
    /url\.pathname === '\/bridge\/events'[\s\S]*?if \(req\.method === 'POST' && url\.pathname === '\/bridge\/snapshot'\)/,
  )?.[0] || '';

  assert.deepEqual(
    evaluateEventStreamReconnectCommandFsm({
      existingEventStreamUsable: true,
      hasDispatchedPendingCommand: true,
    }),
    {
      state: 'transport_reconnected_with_dispatched_command',
      action: 'preserve_dispatched_command',
      reason: 'same-client-event-stream-reconnect-is-transport-only',
    },
  );
  assert.equal(
    shouldAbortDispatchedCommandsOnEventStreamReconnect({
      existingEventStreamUsable: true,
      hasDispatchedPendingCommand: true,
    }),
    false,
  );
  assert.equal(
    shouldAbortDispatchedCommandsOnEventStreamReconnect({
      existingEventStreamUsable: false,
      hasDispatchedPendingCommand: true,
    }),
    false,
  );
  assert.equal(
    shouldAbortPendingSseCommandsOnEventStreamReconnect({
      existingEventStreamUsable: true,
      hasDispatchedSsePendingCommand: true,
    }),
    false,
  );
  assert.equal(
    shouldAbortPendingSseCommandsOnEventStreamReconnect({
      existingEventStreamUsable: false,
      hasDispatchedSsePendingCommand: true,
    }),
    false,
  );
  assert.match(source, /hasDispatchedPendingCommandForClient/);
  assert.match(source, /abortPendingCommandsAfterEventStreamReconnect/);
  assert.match(eventsBlock, /shouldAbortDispatchedCommandsOnEventStreamReconnect/);
  assert.ok(
    eventsBlock.indexOf('abortPendingCommandsAfterEventStreamReconnect') <
      eventsBlock.indexOf('closeEventStream(client)'),
    'decisao de politica precisa acontecer antes de substituir o stream antigo',
  );
});

test('SSE command delivery is enabled unless explicitly disabled', () => {
  assert.equal(isCommandSseDeliveryEnabled({}), true);
  assert.equal(isCommandSseDeliveryEnabled({ GEMINI_MCP_SSE_COMMAND_DELIVERY: '1' }), true);
  assert.equal(isCommandSseDeliveryEnabled({ GEMINI_MCP_SSE_COMMAND_DELIVERY: 'false' }), false);
  assert.equal(isCommandSseDeliveryEnabled({ GEMINI_MCP_SSE_COMMAND_DELIVERY: '0' }), false);
});

test('browser export command dispatch is abortable by the conversation watchdog', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  assert.match(source, /const abortSignal = options\.abortSignal/);
  assert.match(source, /command_aborted/);
  assert.match(source, /abortSignal:\s*args\.abortSignal/);
  assert.match(source, /conversation_no_progress_timeout/);
  assert.match(source, /operation_cancelled/);
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
  assert.match(runtimeInfoSource, /\.gemini'[\s\S]*'extensions'[\s\S]*'gemini-md-export'/);
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
  const reloadContractsSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'),
    'utf-8',
  );

  assert.match(source, /GEMINI_BRIDGE_PAGE_ORIGIN = 'https:\/\/gemini\.google\.com'/);
  assert.match(source, /ACTIVITY_BRIDGE_PAGE_ORIGIN = 'https:\/\/myactivity\.google\.com'/);
  assert.match(bridgeOriginSource, /isAllowedActivityBridgeOrigin/);
  assert.match(source, /requireGeminiBridgeOrigin/);
  assert.match(source, /url\.pathname === '\/agent\/activity-scan'/);
  assert.match(source, /'activity-scan-batch'/);
  assert.match(source, /claimTabForClient\(client,[\s\S]*TAB_CLAIM_LABELS\.count/);
  assert.match(source, /buildActivityClaimAffinity/);
  assert.match(reloadContractsSource, /existingGeminiSessionClaim\?\.claimId/);
  assert.match(source, /shouldApplyActivityClaimVisual/);
  assert.match(source, /activityClaimAffinity\.joinsExistingGeminiClaim !== true/);
  assert.match(source, /visualGroupTabId: activityClaimAffinity\.visualGroupTabId/);
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
  const runtimeHelperSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'mcp-server-runtime-helpers.ts'),
    'utf-8',
  );
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
  assert.match(runtimeHelperSource, /reload-activity-client-version-mismatch/);
  assert.match(runtimeHelperSource, /tryNativeBrowserBrokerTabsAction\('reload'/);
  assert.match(runtimeHelperSource, /const selectorTabId = deps\.normalizeTabId\(selector\.tabId\)/);
  assert.match(requireActivityClientBlock, /const selectedActivityClients = activityClients\.filter/);
  assert.match(source, /activityClientMatchesSelector\(client, \{ tabId: selector\.tabId \}/);
  assert.match(runtimeHelperSource, /normalizeTabId\(client\.tabId\) !== selectorTabId/);
  assert.match(requireActivityClientBlock, /const matchingClients = selectedActivityClients\.filter\(clientMatchesExpectedBrowserExtension\)/);
  assert.match(requireActivityClientBlock, /if \(selected && clientMatchesExpectedBrowserExtension\(selected\)\) return selected/);
  assert.match(requireActivityClientBlock, /if \(selected\) throw activityClientVersionMismatchError\(\[selected\]\)/);
  assert.match(requireActivityClientBlock, /matchingClients\.find/);
  assert.doesNotMatch(requireActivityClientBlock, /if \(activityClients\[0\]\) return activityClients\[0\]/);
});

test('MCP só reivindica abas Gemini ativas por contrato TS', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const tabRuntimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'tab-runtime.ts'), 'utf-8');
  const extensionReloadRuntimeSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'extension-reload-runtime.ts'),
    'utf-8',
  );
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
  assert.match(source, /cdpRuntime\.activateClient/);
  assert.match(tabRuntimeSource, /tryNativeBrowserBrokerTabsAction\('activate'/);
  assert.match(source, /cdpRuntime/);
  assert.doesNotMatch(source, /createOwnedCdpRuntimePorts/);
  assert.match(source, /cdpRuntime\.buildSnapshot\(args\)/);
  assert.match(source, /cdpRuntime\.activateClient\(preferredClient, args\)/);
  assert.match(source, /cdpRuntime\.close\(\)/);
  assert.match(source, /\/agent\/cdp\/extension-reload/);
  assert.match(source, /runBridgeCdpExtensionReloadHttpRequest/);
  assert.match(extensionReloadRuntimeSource, /runLocalExtensionCdpReload/);
  assert.match(extensionReloadRuntimeSource, /reloadExtensionFromOwnedDevToolsActivePort/);
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
  const scanActivityBlock = source.match(
    /const scanActivityWithClient = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst tabSelectionDiagnostics/,
  )?.[0] || '';

  assert.match(source, /ACTIVITY_GEMINI_URL = 'https:\/\/myactivity\.google\.com\/product\/gemini'/);
  assert.match(source, /ACTIVITY_PRE_LAUNCH_WAIT_MS/);
  assert.match(source, /const waitForActivityClient = async/);
  assert.match(source, /targetUrl:\s*ACTIVITY_GEMINI_URL/);
  assert.match(ensureActivityBlock, /const selector = \{ clientId: args\.activityClientId, tabId: args\.activityTabId \}/);
  assert.doesNotMatch(ensureActivityBlock, /args\.activityClientId \|\| args\.clientId/);
  assert.match(source, /openIfMissing !== true/);
  assert.match(source, /reason:\s*'activity-client-already-connected'/);
  assert.match(ensureActivityBlock, /const existingClient = await waitForActivityClient/);
  assert.match(ensureActivityBlock, /args\.preLaunchWaitMs \?\? ACTIVITY_PRE_LAUNCH_WAIT_MS/);
  assert.match(ensureActivityBlock, /reason:\s*'activity-client-connected-before-launch'/);
  assert.match(scanActivityBlock, /args\.activateActivityTabBeforeScan === true/);
  assert.match(scanActivityBlock, /activateBrowserTabById\(\s*scanClient\.tabId/);
  assert.match(scanActivityBlock, /activateTabReason:\s*'wake-activity-before-scan'/);
  assert.match(scanActivityBlock, /focusWindow:\s*false/);
  assert.ok(
    scanActivityBlock.indexOf('activateActivityTabBeforeScan') <
      scanActivityBlock.indexOf('wake-activity-before-scan') &&
      scanActivityBlock.indexOf('wake-activity-before-scan') <
      scanActivityBlock.indexOf("'activity-scan-batch'"),
  );
  assert.match(scanActivityBlock, /restoreTabId !== activityTabId &&\s*activation/);
  assert.match(scanActivityBlock, /activateTabReason:\s*'restore-gemini-after-activity-scan'/);
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
  assert.match(source, /isRecentCommandFailureBlocking/);
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
  assert.match(source, /const commandArgs = \[CLI_BIN_PATH, 'export', 'selected', '--private-api'\]/);
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
  assert.match(backgroundSource, /looksLikeManagedClaimGroupTitle/);
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
  assert.match(backgroundSource, /visualGroupTabId/);
  assert.match(backgroundSource, /chromeGroupTabs\(tabIdsToGroup, targetGroupId\)/);
  assert.match(backgroundSource, /tabIds: targetTabIds/);
  assert.match(backgroundSource, /tab-already-in-user-group/);
  assert.match(backgroundSource, /related-tab-already-in-user-group/);
  assert.match(backgroundSource, /cleanupStaleTabClaimVisuals/);
  assert.match(backgroundSource, /stillOurGroup/);
  assert.match(backgroundSource, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(backgroundSource, /message\?\.type === 'RELOAD_SELF'/);
  assert.match(buildSource, /'tabGroups'/);
  assert.match(buildSource, /'alarms'/);
});

test('MCP prefere native browser broker antes de fallback por heartbeat', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');

  assert.match(source, /createNativeBrowserBrokerClient/);
  assert.match(source, /shouldUseNativeBrowserBroker/);
  assert.match(source, /tryNativeBrowserBrokerTabsAction/);
  assert.match(nativeGateSource, /nativeBrowserBroker\.listTabs/);
  assert.match(nativeGateSource, /nativeBrowserBroker\.claim/);
  assert.doesNotMatch(source, /lastHeartbeatAt[^\n]+claimGeminiTabForClient/);
});

test('MCP libera claim viva pelo service worker antes do fallback nativo', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const block =
    source.match(/export const createTabClaimRelease[\s\S]*?\nexport const createAutoTabClaimReleaseForJob/)?.[0] ||
    '';
  const liveClaimReleaseBlock =
    block.match(/let visual:[\s\S]*?const nativeRelease = releaseSucceeded\(\);/)?.[0] || '';

  assert.ok(block, 'createTabClaimRelease deve existir');
  assert.match(liveClaimReleaseBlock, /'release-tab-claim'/);
  assert.match(liveClaimReleaseBlock, /releaseTabClaimVisualByTabId/);
  assert.match(liveClaimReleaseBlock, /tryNativeBrowserBrokerTabsAction\('release'/);
  assert.ok(
    liveClaimReleaseBlock.indexOf("'release-tab-claim'") <
      liveClaimReleaseBlock.indexOf("deps.tryNativeBrowserBrokerTabsAction('release'"),
    'release de claim viva deve usar storage da extensao antes do fallback nativo',
  );
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

test('browser readiness expõe status estruturado do native broker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const browserReadyDiagnosticsSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'browser-ready-diagnostics.ts'),
    'utf-8',
  );
  const readyBlock = source.match(
    /const buildLightweightBrowserReady = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst normalizeLimit/,
  )?.[0];

  assert.ok(readyBlock, 'buildLightweightBrowserReady deve existir');
  assert.match(source, /createNativeBrokerStatusProbe\(/);
  assert.match(readyBlock, /const nativeBrokerReadyWakeDecision = decideNativeBrokerReadyWake\(/);
  assert.match(readyBlock, /allowWake:\s*nativeBrokerReadyWakeDecision\.allowWake/);
  assert.doesNotMatch(
    readyBlock,
    /probeNativeBrowserBrokerStatus\(\{\s*allowWake:\s*true/,
    'ready/status nao deve acordar o broker nativo incondicionalmente',
  );
  assert.match(readyBlock, /nativeBroker:\s*nativeBrokerStatus/);
  assert.match(readyBlock, /nativeBrokerBlockingIssueForReady/);
  assert.match(readyBlock, /nextAction,\s*\n\s*mode/);
  assert.match(source, /diagnoseNativeHost/);
  assert.match(source, /enrichNativeBrokerStatusWithInstallDiagnostic/);
  assert.match(browserReadyDiagnosticsSource, /native_host_manifest_target_missing/);
  assert.match(source, /browserReadyNextAction/);
  assert.match(browserReadyDiagnosticsSource, /extension_control_channel_unavailable/);
  assert.match(nativeGateSource, /nativeBrokerStatus\.available !== true/);
});

test('browser readiness inclui diagnostico do tab orchestrator FSM', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const readyBlock = source.match(
    /const buildLightweightBrowserReady = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst normalizeLimit/,
  )?.[0] || '';

  assert.match(source, /buildMcpTabOrchestratorPlan/);
  assert.match(source, /executeTabOrchestratorEffects/);
  assert.match(source, /summarizeTabOrchestratorPlan/);
  assert.match(source, /tabOrchestratorBlockingIssueForReady/);
  assert.match(source, /const tabOrchestratorClientDeps = \{/);
  assert.match(readyBlock, /const tabOrchestratorPlan = buildTabOrchestratorPlan\(\{/);
  assert.match(readyBlock, /mode:\s*'diagnostic'/);
  assert.match(readyBlock, /desiredPageKind:\s*'chat'/);
  assert.match(readyBlock, /const tabOrchestratorBlockingIssue = tabOrchestratorBlockingIssueForReady\(/);
  assert.match(readyBlock, /const effectiveBlockingIssue = tabOrchestratorBlockingIssue \|\| blockingIssue/);
  assert.match(readyBlock, /blockingIssue: effectiveBlockingIssue/);
  assert.match(readyBlock, /tabOrchestrator:\s*summarizeTabOrchestratorPlan\(tabOrchestratorPlan\)/);
});

test('comandos pesados usam seletor gerenciado de aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /createManagedChatClientSelector/);
  const recentSelectorBlock = source.match(
    /const requireRecentChatsClient = \(selector = \{\}\) => \{[\s\S]*?\n\};/,
  )?.[0] || '';
  assert.match(recentSelectorBlock, /requireManagedChatClient\(selector, 'recent-chats'/);
  assert.match(recentSelectorBlock, /candidateMode:\s*'recent-chats'/);
  assert.doesNotMatch(recentSelectorBlock, /getSelectableGeminiClients/);
  assert.doesNotMatch(recentSelectorBlock, /ambiguousTabsError/);

  for (const toolName of [
    'gemini_get_current_chat',
    'gemini_download_chat',
    'gemini_export_recent_chats',
    'gemini_export_missing_chats',
    'gemini_sync_vault',
    'gemini_reexport_chats',
    'gemini_diagnose_page',
    'gemini_snapshot',
  ]) {
    const block = source.match(
      new RegExp(`name: '${toolName}'[\\s\\S]*?call: async \\(args = \\{\\}\\) => \\{[\\s\\S]*?\\n    \\},`),
    )?.[0] || '';
    assert.match(block, /requireManagedChatClient\(args\)/, `${toolName} deve passar pelo tab orchestrator`);
    assert.doesNotMatch(block, /const client = requireClient\(args\)/);
  }
});

test('browser readiness ativa aba Gemini inativa existente antes de reportar falha de wake', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'), 'utf-8');
  const readyBlock = source.match(
    /const buildLightweightBrowserReady = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst normalizeLimit/,
  )?.[0] || '';

  assert.match(runtimeSource, /evaluateBrowserReadyInactiveTabActivationFsm/);
  assert.match(runtimeSource, /maybeActivateBrowserReadyInactiveTab/);
  assert.match(readyBlock, /maybeActivateBrowserReadyInactiveTab/);
  assert.match(runtimeSource, /args\.wakeBrowser === true/);
  assert.match(readyBlock, /\{ activateBrowserTabById, summarizeClient \}/);
  assert.match(readyBlock, /readyTabActivation\.shouldRefreshClientSets/);
  assert.match(readyBlock, /cleanupStaleClients\(\);[\s\S]*allLiveClients = getLiveClients\(\)/);
  assert.match(readyBlock, /extensionReadiness: buildExtensionReadiness/);
});

test('endpoint HTTP de browser readiness preserva parametros de ativacao de aba', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const endpointBlock = source.match(
    /if \(req\.method === 'GET' && url\.pathname === '\/agent\/ready'\) \{[\s\S]*?\n  \}/,
  )?.[0] || '';

  assert.match(endpointBlock, /activateTab:\s*parseOptionalBoolean\(url\.searchParams\.get\('activateTab'\)\)/);
});

test('My Activity scan readiness passa pelo tab orchestrator antes de iniciar scan', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const ensureActivityBlock = source.match(
    /const ensureActivityClientForScan = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst scanActivityWithClient/,
  )?.[0] || '';

  assert.match(ensureActivityBlock, /const activityTabOrchestratorPlan = buildTabOrchestratorPlan\(\{/);
  assert.match(ensureActivityBlock, /mode:\s*'activity_scan'/);
  assert.match(ensureActivityBlock, /desiredPageKind:\s*'activity'/);
  assert.match(ensureActivityBlock, /await throwActivityTabOrchestratorBlocker/);
  assert.match(source, /const throwActivityTabOrchestratorBlocker = async \(plan, activityClients = \[\]\) =>/);
  assert.match(source, /const activityTabOrchestratorExecution = await executeTabOrchestratorPlanEffects\(plan\)/);
  assert.match(source, /effectExecution:\s*activityTabOrchestratorExecution/);
});

test('My Activity scan recovery cobre mismatch detectado pelo tab orchestrator', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const ensureActivityBlock = source.match(
    /const ensureActivityClientForScan = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst scanActivityWithClient/,
  )?.[0] || '';

  assert.match(
    ensureActivityBlock,
    /try \{[\s\S]*await throwActivityTabOrchestratorBlocker\(activityTabOrchestratorPlan, activityClientsForPlan\);[\s\S]*const client = requireActivityClient\(selector\);[\s\S]*\} catch \(err\) \{[\s\S]*recoverActivityClientAfterVersionMismatch/,
  );
});

test('reload de abas retorna diagnostico de recovery do tab orchestrator', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0] || '';

  assert.match(reloadBlock, /const tabOrchestratorPlan = buildTabOrchestratorPlan\(\{/);
  assert.match(reloadBlock, /mode:\s*'interactive'/);
  assert.match(reloadBlock, /desiredPageKind:\s*'chat'/);
  assert.match(reloadBlock, /const summarizeReloadTabOrchestrator = \(\) =>/);
  assert.match(reloadBlock, /buildTabOrchestratorReloadRecovery\(\{/);
  assert.match(reloadBlock, /clients:\s*getLiveClients\(\)/);
  assert.match(reloadBlock, /clientDeps:\s*tabOrchestratorClientDeps/);
  assert.match(reloadBlock, /tabOrchestrator:\s*summarizeReloadTabOrchestrator\(\)/);
});

test('MCP possui adapter injetavel para executar efeitos do tab orchestrator', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const adapterBlock = source.match(
    /const createTabOrchestratorMcpAdapter = \(\) =>[\s\S]*?\n  \}\);\n\nconst executeTabOrchestratorPlanEffects/,
  )?.[0] || '';

  assert.ok(adapterBlock, 'adapter do tab orchestrator deve existir antes do ready');
  assert.match(adapterBlock, /createMcpTabOrchestratorEffectAdapter/);
  assert.match(adapterBlock, /reloadChromeExtensionForClient/);
  assert.match(adapterBlock, /tryNativeBrowserBrokerTabsAction/);
  assert.match(adapterBlock, /launchChromeForGemini/);
  assert.match(adapterBlock, /claimTabForClient/);
  assert.match(adapterBlock, /waitForLiveClients/);
  assert.match(adapterBlock, /buildTabOrchestratorPlan/);
  assert.match(adapterBlock, /processSessionId:\s*PROCESS_SESSION_ID/);
  assert.match(source, /const executeTabOrchestratorPlanEffects = \(plan\) =>\s*executeTabOrchestratorEffects/);
});

test('browser readiness and reload endpoints defer extension reload while export job is active', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeHelperSource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'mcp-server-runtime-helpers.ts'),
    'utf-8',
  );
  const readyBlock = source.match(
    /const buildLightweightBrowserReady = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst normalizeLimit/,
  )?.[0] || '';
  const ensureBlock = source.match(
    /const ensureBrowserExtensionReady = \(args = \{\}, options = \{\}\) => \{[\s\S]*?\n\};\n\nconst selectorHasExplicitTabTarget/,
  )?.[0] || '';
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0] || '';

  assert.match(source, /activeExportJobReloadError/);
  assert.match(runtimeHelperSource, /extension_reload_deferred_active_export_job/);
  assert.match(ensureBlock, /activeExportJobReloadError\('extension-reload'\)/);
  assert.match(readyBlock, /activeReloadBlockedByJobs/);
  assert.match(readyBlock, /allowReload:\s*args\.allowReload === true && !activeReloadBlockedByJobs/);
  assert.match(reloadBlock, /activeExportJobReloadResult\('tab-reload'\)/);
  assert.match(runtimeHelperSource, /browser_reload_deferred_active_export_job/);
});

test('MCP acorda native broker pelo service worker antes de declarar socket morto', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const probeBlock = source.match(
    /const probeNativeBrowserBrokerStatus = createNativeBrokerStatusProbe\([\s\S]*?\n\);/,
  )?.[0] || '';
  const readyBlock = source.match(
    /const buildLightweightBrowserReady = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst normalizeLimit/,
  )?.[0] || '';

  assert.match(nativeGateSource, /shouldAttemptNativeBrokerWake/);
  assert.match(nativeGateSource, /createNativeBrokerWakeController/);
  assert.match(nativeGateSource, /clientSupportsNativeBrokerWakeCommand/);
  assert.match(nativeGateSource, /wakeNativeBrowserBrokerViaExtension/);
  assert.match(nativeGateSource, /enqueueNativeBrokerWakeCommand/);
  assert.match(nativeGateSource, /reason:\s*'mcp-native-broker-wake'/);
  assert.match(source, /createNativeBrokerStatusProbe\(/);
  assert.match(probeBlock, /enqueueCommand/);
  assert.match(readyBlock, /const nativeBrokerReadyWakeDecision = decideNativeBrokerReadyWake\(/);
  assert.match(readyBlock, /allowWake:\s*nativeBrokerReadyWakeDecision\.allowWake/);
  assert.doesNotMatch(
    readyBlock,
    /probeNativeBrowserBrokerStatus\(\{\s*allowWake:\s*true/,
    'ready/status nao deve tentar ensure-native-broker sem pedido explicito ou canal confiavel',
  );
});

test('reload de abas existentes pode atualizar extensao sem abrir navegador', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const cliSource = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'), 'utf-8');
  const cliReloadRequestSource = readFileSync(
    resolve(ROOT, 'src', 'cli', 'existing-tabs-reload-request.ts'),
    'utf-8',
  );
  const browserReadyPolicySource = readFileSync(
    resolve(ROOT, 'src', 'cli', 'browser-ready-policy.ts'),
    'utf-8',
  );
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0];
  const cliReloadRequestBlock = cliSource.match(
    /const requestExistingTabsReloadFromCli = async[\s\S]*?\n\};\n\nconst reloadExistingTabsFromCli/,
  )?.[0];
  const cliReloadBlock = cliSource.match(
    /const reloadExistingTabsFromCli = async[\s\S]*?\n\};\n\nconst readyWithCliWake/,
  )?.[0];

  assert.ok(reloadBlock, 'reloadGeminiTabs deve existir');
  assert.ok(cliReloadRequestBlock, 'requestExistingTabsReloadFromCli deve existir');
  assert.ok(cliReloadBlock, 'reloadExistingTabsFromCli deve existir');
  assert.match(reloadBlock, /reloadExtensionForExistingTabs/);
  assert.doesNotMatch(reloadBlock, /launchChromeForGemini/);
  assert.match(runtimeSource, /allowLaunchChrome:\s*false/);
  assert.match(runtimeSource, /allowReload:\s*args\.allowReload === true/);
  assert.match(cliReloadRequestBlock, /buildExistingTabsReloadRequestParams\(flags, ready\)/);
  assert.match(cliReloadRequestSource, /action:\s*'reload'/);
  assert.match(cliReloadRequestSource, /openIfMissing:\s*false/);
  assert.match(cliReloadRequestSource, /allowReload:\s*true/);
  assert.match(cliReloadRequestSource, /allowHttpBrowserFallback:\s*true/);
  assert.match(cliSource, /shouldWakeBrowserForReady/);
  assert.doesNotMatch(cliSource, /const shouldWakeBrowserForReady =/);
  assert.match(browserReadyPolicySource, /export const shouldWakeBrowserForReady/);
  assert.match(browserReadyPolicySource, /readyHasKnownOnlyNonGeminiClients/);
  assert.match(browserReadyPolicySource, /no_selectable_gemini_tab/);
});

test('reload de abas usa native broker antes de depender de clientes vivos', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0];
  const nativeReloadBlock =
    nativeGateSource.match(/export const attachContentScriptSelfHealToNativeReload[\s\S]*?\nexport const noConnectedClientsForReloadResult/)?.[0] ||
    '';
  const runtimeReloadBlock =
    runtimeSource.match(/export const runExistingTabsNativeReloadRecovery[\s\S]*?\n\};\n\n/)?.[0] ||
    '';

  assert.ok(reloadBlock, 'reloadGeminiTabs deve existir');
  assert.match(reloadBlock, /runExistingTabsNativeReloadRecovery/);
  assert.match(runtimeSource, /tryNativeBrowserBrokerTabsAction\('reload', args\)/);
  assert.match(runtimeSource, /attachContentScriptSelfHealToNativeReload/);
  assert.match(nativeReloadBlock, /reloadedTabIds/);
  assert.match(nativeReloadBlock, /tabIds:\s*reloadedTabIds\.length > 0 \? reloadedTabIds : args\.tabIds/);
  assert.match(nativeReloadBlock, /runTabsAction\('selfHealContentScripts'/);
  assert.ok(
    runtimeReloadBlock.indexOf("tryNativeBrowserBrokerTabsAction('reload', args)") <
      runtimeReloadBlock.lastIndexOf('attachContentScriptSelfHealToNativeReload'),
    'self-heal nativo deve rodar depois do reload nativo',
  );
  assert.ok(
    reloadBlock.indexOf('runExistingTabsNativeReloadRecovery') <
      reloadBlock.indexOf('const liveClients = getLiveClients()'),
    'native broker precisa rodar antes de getLiveClients',
  );
  assert.match(nativeGateSource, /nativeBrowserBroker\.reload/);
  assert.match(nativeGateSource, /nativeBrowserBroker\.selfHealContentScripts/);
});

test('reload de abas recupera content scripts depois de timeout recuperavel do native broker', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'), 'utf-8');
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0] || '';

  assert.match(runtimeSource, /evaluateExistingTabsPostReloadRecoveryFsm/);
  assert.match(runtimeSource, /recoverExistingTabsContentScriptsAfterNativeReload/);
  assert.match(reloadBlock, /runExistingTabsNativeReloadRecovery/);
  assert.match(reloadBlock, /postNativeReloadRecovery/);
  assert.match(reloadBlock, /mode:\s*'native-broker-post-reload-self-heal'/);
  assert.ok(
    reloadBlock.indexOf('runExistingTabsNativeReloadRecovery') <
      reloadBlock.indexOf('shouldReturnNativeBrokerReloadResult'),
    'self-heal pos-timeout deve rodar antes do retorno terminal do native broker',
  );
});

test('reload de abas atualiza runtime da extensao pelo native broker antes de reinjetar tabs', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const runtimeSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'existing-tabs-reload.ts'), 'utf-8');
  const nativeGateSource = readFileSync(resolve(ROOT, 'src', 'mcp', 'native-release-gate.ts'), 'utf-8');
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0] || '';

  assert.match(runtimeSource, /evaluateExistingTabsRuntimeRefreshFsm/);
  assert.match(runtimeSource, /refreshExistingTabsExtensionRuntimeBeforeReload/);
  assert.match(nativeGateSource, /reloadExtensionSelf/);
  assert.match(reloadBlock, /runExistingTabsNativeReloadRecovery/);
  assert.match(reloadBlock, /nativeExtensionRuntimeRefresh/);
  assert.ok(
    runtimeSource.indexOf('refreshExistingTabsExtensionRuntimeBeforeReload') <
      runtimeSource.indexOf("tryNativeBrowserBrokerTabsAction('reload', args)"),
    'runtime da extensao deve ser atualizado antes do reload de abas',
  );
});

test('self-reload trata Extension context invalidated como reload em andamento', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reloadClientBlock = source.match(
    /const reloadChromeExtensionForClient = async[\s\S]*?\n\};\n\nconst reloadChromeExtension = async/,
  )?.[0];

  assert.ok(reloadClientBlock, 'reloadChromeExtensionForClient deve existir');
  assert.match(source, /extensionReloadAssumedResultForError/);
  assert.match(reloadClientBlock, /extensionReloadAssumedResultForError\(result\)/);
  assert.match(reloadClientBlock, /extensionReloadAssumedResultForError\(err\)/);
  assert.match(reloadClientBlock, /return assumedReload/);
});

test('MCP expõe diagnóstico e cleanup controlado de processos sem guard de browser', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const privateInventorySource = readFileSync(
    resolve(ROOT, 'src', 'mcp', 'private-inventory-runtime.ts'),
    'utf-8',
  );
  const guardedBlock = source.match(
    /const LEGACY_BROWSER_DEPENDENT_TOOL_NAMES = new Set\(\[[\s\S]*?\]\);/,
  )?.[0];
  const localProxyBlock = privateInventorySource.match(
    /export const localProxySupportActions = \[[\s\S]*?\] as const;/,
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
