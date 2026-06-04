export const nativeBrokerStatusFromProbe = ({ enabled, response, }) => {
    if (!enabled) {
        return {
            configured: false,
            available: false,
            code: 'native_broker_disabled',
            message: 'Native broker desativado por configuracao.',
        };
    }
    if (response?.ok === true) {
        return {
            configured: true,
            available: true,
            code: null,
            message: 'Native broker conectado.',
            response,
        };
    }
    const error = response?.error;
    const code = (typeof error === 'object' && error ? error.code : null) ||
        response?.code ||
        'native_broker_unavailable';
    const message = (typeof error === 'object' && error ? error.message : null) ||
        (typeof error === 'string' ? error : null) ||
        'Não consegui falar com o broker nativo.';
    return {
        configured: true,
        available: false,
        code,
        message,
        response,
    };
};
export const nativeBrokerAvailabilityFromStatus = (status) => {
    if (status.available === true)
        return true;
    if (status.configured === false || status.code === 'native_broker_unavailable')
        return false;
    return null;
};
export const withNativeBrokerSoftTimeout = (promise, timeoutMs, fallback) => Promise.race([
    promise,
    new Promise((resolve) => {
        setTimeout(() => resolve(fallback), timeoutMs);
    }),
]);
const NATIVE_BROKER_WAKEABLE_CODES = new Set([
    'native_broker_unavailable',
    'native_broker_probe_timeout',
    'native_broker_disconnected',
    'extension_unavailable',
    'extension_request_timeout',
]);
export const shouldAttemptNativeBrokerWake = ({ nativeBrokerStatus, liveClientCount, }) => nativeBrokerStatus.configured === true &&
    nativeBrokerStatus.available !== true &&
    liveClientCount > 0 &&
    NATIVE_BROKER_WAKEABLE_CODES.has(String(nativeBrokerStatus.code || ''));
const positiveCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
export const decideNativeBrokerReadyWake = ({ explicit = false, matchingClientCount = 0, commandReadyClientCount = 0, }) => {
    if (explicit === true) {
        return { allowWake: true, reason: 'explicit' };
    }
    if (positiveCount(matchingClientCount) === 0) {
        return { allowWake: false, reason: 'no_matching_client' };
    }
    if (positiveCount(commandReadyClientCount) > 0) {
        return { allowWake: true, reason: 'command_channel_ready' };
    }
    return { allowWake: false, reason: 'command_channel_not_ready' };
};
export const NATIVE_BROKER_WAKE_CAPABILITY = 'native-broker-wake-v1';
export const clientSupportsNativeBrokerWakeCommand = (client) => Array.isArray(client?.capabilities) &&
    client.capabilities.some((capability) => capability === NATIVE_BROKER_WAKE_CAPABILITY);
export const selectNativeBrokerWakeClient = ({ clients, clientMatchesExpectedBrowserExtension, commandChannelReadyForClient, }) => {
    const wakeableClients = clients.filter(clientSupportsNativeBrokerWakeCommand);
    const commandReadyClient = wakeableClients.find((client) => clientMatchesExpectedBrowserExtension(client) && commandChannelReadyForClient(client));
    return (commandReadyClient ||
        wakeableClients.find(clientMatchesExpectedBrowserExtension) ||
        wakeableClients[0] ||
        null);
};
export const createNativeBrokerWakeController = ({ probeNativeBrokerStatusOnce, getLiveClients, clientMatchesExpectedBrowserExtension, commandChannelReadyForClient, enqueueNativeBrokerWakeCommand, sleep, now = () => Date.now(), settleMs = 2500, pollMs = 150, }) => {
    let nativeBrokerWakeInFlight = null;
    const wakeNativeBrowserBrokerViaExtension = async (nativeBrokerStatus) => {
        if (nativeBrokerWakeInFlight)
            return nativeBrokerWakeInFlight;
        nativeBrokerWakeInFlight = (async () => {
            const client = selectNativeBrokerWakeClient({
                clients: getLiveClients(),
                clientMatchesExpectedBrowserExtension,
                commandChannelReadyForClient,
            });
            if (!client) {
                return {
                    attempted: false,
                    ok: false,
                    reason: 'no-native-broker-wake-capable-client',
                };
            }
            if (!client.clientId) {
                return {
                    attempted: false,
                    ok: false,
                    reason: 'native-broker-wake-client-id-missing',
                };
            }
            try {
                const result = await enqueueNativeBrokerWakeCommand(client, nativeBrokerStatus);
                return {
                    attempted: true,
                    ok: typeof result === 'object' && result !== null && 'ok' in result && result.ok === true,
                    clientId: client.clientId || null,
                    result,
                };
            }
            catch (err) {
                return {
                    attempted: true,
                    ok: false,
                    clientId: client.clientId || null,
                    code: err instanceof Error && 'code' in err ? String(err.code) : null,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        })().finally(() => {
            nativeBrokerWakeInFlight = null;
        });
        return nativeBrokerWakeInFlight;
    };
    const probeNativeBrowserBrokerStatus = async ({ allowWake = false, } = {}) => {
        const nativeBrokerStatus = await probeNativeBrokerStatusOnce();
        if (!allowWake)
            return nativeBrokerStatus;
        const liveClients = getLiveClients();
        const wakeableClientCount = liveClients.filter(clientSupportsNativeBrokerWakeCommand).length;
        if (!shouldAttemptNativeBrokerWake({
            nativeBrokerStatus,
            liveClientCount: wakeableClientCount,
        })) {
            return nativeBrokerStatus;
        }
        const wake = nativeBrokerWakeInFlight
            ? await nativeBrokerWakeInFlight
            : await wakeNativeBrowserBrokerViaExtension(nativeBrokerStatus);
        const deadline = now() + settleMs;
        let retryStatus = nativeBrokerStatus;
        do {
            await sleep(pollMs);
            retryStatus = await probeNativeBrokerStatusOnce();
            if (retryStatus.available === true) {
                return {
                    ...retryStatus,
                    wake,
                };
            }
        } while (now() < deadline);
        return {
            ...retryStatus,
            wake,
        };
    };
    return {
        probeNativeBrowserBrokerStatus,
        wakeNativeBrowserBrokerViaExtension,
        getNativeBrokerWakeInFlight: () => nativeBrokerWakeInFlight,
    };
};
export const enqueueNativeBrokerWakeCommand = (enqueueCommand, client, nativeBrokerStatus) => enqueueCommand(client.clientId || '', 'ensure-native-broker', {
    reason: 'mcp-native-broker-wake',
    previousCode: nativeBrokerStatus.code || null,
    timeoutMs: 5000,
}, {
    timeoutMs: 8000,
    dispatchTimeoutMs: 2000,
});
export const createNativeBrokerStatusProbe = (probeNativeBrokerStatusOnce, getLiveClients, clientMatchesExpectedBrowserExtension, commandChannelReadyForClient, enqueueCommand, sleep) => createNativeBrokerWakeController({
    probeNativeBrokerStatusOnce,
    getLiveClients,
    clientMatchesExpectedBrowserExtension,
    commandChannelReadyForClient,
    enqueueNativeBrokerWakeCommand: (client, nativeBrokerStatus) => enqueueNativeBrokerWakeCommand(enqueueCommand, client, nativeBrokerStatus),
    sleep,
}).probeNativeBrowserBrokerStatus;
export const nativeBrokerBlockingIssueForReady = ({ readinessBlockingIssue, ready, cdpBlockerCode, nativeBrokerStatus, claimableClientCount, }) => {
    const fallback = readinessBlockingIssue || (!ready ? cdpBlockerCode || null : null);
    if (nativeBrokerStatus.configured === true &&
        nativeBrokerStatus.available !== true &&
        claimableClientCount === 0) {
        return nativeBrokerStatus.code || fallback;
    }
    return fallback;
};
export const nativeExportLeaseArgsForClaim = (args = {}, claim = null, fallbackTabId = undefined) => ({
    ...args,
    claimId: claim?.claimId || args.claimId,
    tabId: claim?.tabId ?? fallbackTabId ?? args.tabId,
});
export const isNativeExportLeaseStrict = (args = {}) => args.requireNativeExportLease === true || args.allowHttpBrowserFallback !== true;
export const withNativeExportLease = (args = {}, nativeLease) => ({
    ...args,
    _nativeExportLease: nativeLease,
});
export const assignExportDateImportVisualGroupTabId = (args, tabId) => {
    if (tabId !== null && args._exportDateImportVisualGroupTabId === undefined) {
        args._exportDateImportVisualGroupTabId = tabId;
    }
    return args;
};
export const attachNativeLeaseVisualToClaim = (claim, nativeLease, claimsById) => {
    if (!claim)
        return claim;
    const claimId = typeof claim?.claimId === 'string' ? claim.claimId : '';
    const visual = typeof nativeLease === 'object' && nativeLease
        ? nativeLease.visual
        : null;
    if (!claimId || !visual)
        return claim;
    const rawClaim = claimsById?.get(claimId);
    if (rawClaim)
        rawClaim.visual = visual;
    claim.visual = visual;
    return claim;
};
export const nativeBrokerReloadPayload = (args = {}) => ({
    tabId: args.tabId ?? null,
    claimId: args.claimId || null,
    tabIds: Array.isArray(args.tabIds) ? args.tabIds : undefined,
    relatedTabIds: Array.isArray(args.relatedTabIds) ? args.relatedTabIds : undefined,
    reloadAll: args.reloadAll === true,
    visualGroupTabId: args.visualGroupTabId ?? args.groupWithTabId ?? undefined,
    label: args.label || undefined,
    color: args.color || undefined,
    focusWindow: args.focusWindow === true,
    reason: args.reason || undefined,
});
const nativeBrokerSelfHealPayload = (args = {}) => {
    const payload = {
        reason: args.reason || 'mcp-native-broker-self-heal',
        force: args.force !== false,
    };
    if (Array.isArray(args.tabIds)) {
        payload.tabIds = args.tabIds;
    }
    else if (args.tabId !== undefined && args.tabId !== null) {
        payload.tabIds = [args.tabId];
    }
    if (args.maxTabs !== undefined)
        payload.maxTabs = args.maxTabs;
    return payload;
};
const nativeBrokerReloadSelfPayload = (args = {}) => ({
    reason: args.reason || 'mcp-native-broker-reload-self',
});
const nativeBrokerReloadManagedTabsPayload = (args = {}) => ({
    reason: args.reason || 'mcp-native-broker-managed-tabs-reload',
    force: args.force !== false,
    explicit: args.explicit !== false,
});
export const shouldReturnNativeBrokerReloadResult = (result, args = {}) => !!result && (result.ok !== false || args.allowHttpBrowserFallback !== true);
export const attachContentScriptSelfHealToNativeReload = async (nativeReload, args = {}, runTabsAction) => {
    if (nativeReload?.ok !== true)
        return nativeReload;
    const reloadedTabIds = Array.isArray(nativeReload.reloadedTabIds)
        ? nativeReload.reloadedTabIds
        : [];
    nativeReload.contentScriptSelfHeal = await runTabsAction('selfHealContentScripts', {
        ...args,
        reason: args.reason || 'native-reload-post-self-heal',
        force: true,
        tabIds: reloadedTabIds.length > 0 ? reloadedTabIds : args.tabIds,
    });
    return nativeReload;
};
export const noConnectedClientsForReloadResult = () => ({
    ok: false,
    code: 'no_connected_clients_for_reload',
    reloaded: 0,
    error: 'Nenhuma aba viva do Gemini conectada à extensão.',
    nextAction: 'Sem aba conectada, a CLI nao consegue recarregar abas existentes por comando. Use um cliente conectado, CDP ou native broker antes do reload.',
});
export const createTargetTabClientMissingAfterActivationError = ({ tabId, broker, result, }) => {
    const error = new Error('A aba do navegador foi ativada, mas o cliente alvo do Gemini ainda não reconectou.');
    error.code = 'target_tab_client_missing_after_activation';
    error.data = { tabId, broker, result };
    return error;
};
const okResult = (result) => typeof result === 'object' && result !== null && result.ok === true;
const reloadStaleContentClaimAfterNativeRelease = async (deps, input) => {
    if (okResult(input.extensionVisual) || !okResult(input.nativeVisual))
        return null;
    return deps.tryNativeBrowserBrokerTabsAction('reload', {
        tabId: input.tabId,
        tabIds: input.tabIds || null,
        reason: `${input.reason}-stale-content-reload`,
        focusWindow: false,
    });
};
export const createTabClaimRelease = (deps) => async (args = {}) => {
    deps.cleanupExpiredTabClaims();
    const sessionId = deps.normalizeSessionId(args.sessionId || args._proxySessionId);
    const claimId = String(args.claimId || deps.sessionClaims.get(sessionId) || '');
    if (!claimId) {
        const visual = await deps.releaseTabClaimVisualByTabId({
            tabId: args.tabId,
            reason: String(args.reason || 'mcp-release-without-server-claim'),
        });
        const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
            tabId: args.tabId,
            claimId: args.claimId || null,
            tabIds: args.tabIds || null,
            reason: `${args.reason || 'mcp-release-without-server-claim'}-native-visual`,
        });
        const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
            extensionVisual: visual,
            nativeVisual,
            tabId: args.tabId,
            tabIds: args.tabIds || null,
            reason: String(args.reason || 'mcp-release-without-server-claim'),
        });
        if (okResult(visual) || okResult(nativeVisual)) {
            return { ok: true, released: null, visual, nativeVisual, staleContentReload, client: null };
        }
        return {
            ok: false,
            reason: 'no-claim-for-session',
            sessionId,
            visual,
            nativeVisual,
            claims: deps.summarizeTabClaims(),
        };
    }
    const claim = deps.tabClaims.get(claimId);
    if (!claim) {
        deps.sessionClaims.delete(sessionId);
        const orphanClient = deps.liveClientCarryingClaimId?.(claimId) || null;
        const orphanClientRecord = orphanClient;
        const orphanClientClaim = (orphanClientRecord?.tabClaim ||
            orphanClientRecord?.summary?.tabClaim ||
            null);
        const releaseTabId = args.tabId ?? orphanClientRecord?.tabId;
        const releaseTabIds = args.tabIds || orphanClientClaim?.visual?.tabIds || null;
        const visual = await deps.releaseTabClaimVisualByTabId({
            tabId: releaseTabId,
            claimId,
            reason: String(args.reason || 'mcp-release-missing-server-claim'),
        });
        const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
            tabId: releaseTabId,
            claimId,
            tabIds: releaseTabIds,
            reason: `${args.reason || 'mcp-release-missing-server-claim'}-native-visual`,
        });
        const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
            extensionVisual: visual,
            nativeVisual,
            tabId: releaseTabId,
            tabIds: releaseTabIds,
            reason: String(args.reason || 'mcp-release-missing-server-claim'),
        });
        if (okResult(visual) || okResult(nativeVisual)) {
            return {
                ok: true,
                released: null,
                claimId,
                sessionId,
                visual,
                nativeVisual,
                staleContentReload,
                client: null,
            };
        }
        return {
            ok: false,
            reason: 'claim-not-found',
            claimId,
            sessionId,
            visual,
            nativeVisual,
            claims: deps.summarizeTabClaims(),
        };
    }
    let visual = null;
    let client = deps.liveClientForClaim(claim);
    if (!client) {
        const recoveredClient = await deps.waitForContinuationClient({ clientId: claim.clientId, tabId: claim.tabId, sessionId: claim.sessionId }, { claimId, tabId: claim.tabId, sessionId: claim.sessionId });
        const recoveredLiveClient = typeof recoveredClient?.clientId === 'string'
            ? deps.clients.get(recoveredClient.clientId)
            : null;
        client = deps.isLiveClient(recoveredLiveClient) ? recoveredLiveClient || null : null;
    }
    if (client && typeof client.clientId === 'string') {
        try {
            visual = await deps.enqueueCommand(client.clientId, 'release-tab-claim', { claimId, reason: args.reason || 'mcp-release' }, { timeoutMs: 8000, dispatchTimeoutMs: 4000, browserSideEffectExplicit: true });
        }
        catch (err) {
            visual = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: err instanceof Error && 'code' in err ? String(err.code) : null,
            };
        }
    }
    const releaseVisualTabId = claim.tabId ?? args.tabId;
    const releaseVisualTabIds = claim.visual?.tabIds || null;
    const releaseReason = String(args.reason || 'mcp-release');
    const releaseNativeClaimVisual = async () => {
        if (!Array.isArray(releaseVisualTabIds) || releaseVisualTabIds.length === 0)
            return null;
        return deps.tryNativeBrowserBrokerTabsAction('release', {
            tabId: releaseVisualTabId,
            claimId,
            tabIds: releaseVisualTabIds,
            reason: `${releaseReason}-native-visual`,
        });
    };
    const releaseSucceeded = () => {
        if (!okResult(visual))
            return null;
        const removed = deps.removeTabClaim(claimId);
        return {
            ok: true,
            released: deps.summarizeTabClaim(removed),
            visual,
            client: client ? deps.summarizeClient(client) : null,
        };
    };
    const browserRelease = releaseSucceeded();
    if (browserRelease) {
        const nativeVisual = await releaseNativeClaimVisual();
        return nativeVisual ? { ...browserRelease, nativeVisual } : browserRelease;
    }
    if (releaseVisualTabId !== null && releaseVisualTabId !== undefined) {
        visual = await deps.releaseTabClaimVisualByTabId({
            tabId: releaseVisualTabId,
            claimId,
            reason: args.reason || 'mcp-release-by-tab-id',
        });
    }
    const extensionRelease = releaseSucceeded();
    if (extensionRelease) {
        const nativeVisual = await releaseNativeClaimVisual();
        return nativeVisual ? { ...extensionRelease, nativeVisual } : extensionRelease;
    }
    const extensionVisual = visual;
    const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
        tabId: releaseVisualTabId,
        claimId,
        tabIds: releaseVisualTabIds,
        reason: String(args.reason || 'mcp-native-release'),
    });
    const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
        extensionVisual,
        nativeVisual,
        tabId: releaseVisualTabId,
        tabIds: releaseVisualTabIds,
        reason: String(args.reason || 'mcp-native-release'),
    });
    visual = nativeVisual;
    const nativeRelease = releaseSucceeded();
    if (nativeRelease)
        return { ...nativeRelease, staleContentReload };
    const removed = deps.removeTabClaim(claimId);
    return {
        ok: true,
        released: deps.summarizeTabClaim(removed),
        visual,
        client: client ? deps.summarizeClient(client) : null,
    };
};
export const createAutoTabClaimReleaseForJob = (deps) => async (job, reason) => {
    if (!job?.autoReleaseTabClaim || !job.tabClaimId || job.tabClaimRelease) {
        return job?.tabClaimRelease || null;
    }
    try {
        const client = typeof job.clientId === 'string' ? deps.clients.get(job.clientId) || null : null;
        const tabClaim = deps.clientTabClaim(client);
        const releaseTabId = job.tabSession?.tabId ?? client?.tabId ?? tabClaim?.tabId;
        const releaseTabIds = tabClaim?.visual?.tabIds ||
            job.nativeExportLease?.visual
                ?.tabIds ||
            job.tabSession?.visual
                ?.tabIds ||
            null;
        job.tabClaimRelease = await deps.releaseTabClaim({
            claimId: job.tabClaimId,
            tabId: releaseTabId,
            tabIds: releaseTabIds,
            reason,
        });
        if (deps.shouldUseNativeBrowserBroker()) {
            const releasedVisual = job.tabClaimRelease?.released?.visual;
            const nativeReleaseTabIds = releaseTabIds || releasedVisual?.tabIds || null;
            job.nativeTabClaimRelease = await deps.tryNativeBrowserBrokerTabsAction('release', {
                tabId: releaseTabId,
                claimId: job.tabClaimId,
                tabIds: nativeReleaseTabIds,
                reason: `${reason}-native-visual`,
            });
            if (job.tabClaimRelease && typeof job.tabClaimRelease === 'object') {
                job.tabClaimRelease.nativeVisual = job.nativeTabClaimRelease;
            }
        }
    }
    catch (err) {
        job.tabClaimRelease = {
            ok: false,
            claimId: job.tabClaimId,
            error: err instanceof Error ? err.message : String(err),
            code: err instanceof Error && 'code' in err ? String(err.code) : null,
        };
    }
    return job.tabClaimRelease;
};
export const createNativeExportLeaseTools = ({ ensureTabClaimForJob, validateNativeExportTabLeaseForJob, }) => {
    const validateNativeExportLeaseForClaim = (client, args, claim) => validateNativeExportTabLeaseForJob(nativeExportLeaseArgsForClaim(args, claim), claim, client);
    return {
        validateNativeExportLeaseForClaim,
        claimNativeExportLeaseForJob: async (client, args, label) => {
            const claim = await ensureTabClaimForJob(client, args, label);
            return validateNativeExportLeaseForClaim(client, args, claim);
        },
    };
};
const parseOptionalBooleanValue = (value) => {
    if (value === null || value === undefined || value === '')
        return undefined;
    if (/^(1|true|yes)$/i.test(value))
        return true;
    if (/^(0|false|no)$/i.test(value))
        return false;
    return undefined;
};
export const clientSelectorFromUrlSearchParams = (searchParams) => ({
    clientId: searchParams.get('clientId') || undefined,
    tabId: searchParams.get('tabId') || undefined,
    claimId: searchParams.get('claimId') || undefined,
    sessionId: searchParams.get('sessionId') || undefined,
    cdpUrl: searchParams.get('cdpUrl') || undefined,
    controlPlane: searchParams.get('controlPlane') || undefined,
    wakeBrowser: parseOptionalBooleanValue(searchParams.get('wakeBrowser')),
    openIfMissing: parseOptionalBooleanValue(searchParams.get('openIfMissing')),
    activateTab: parseOptionalBooleanValue(searchParams.get('activateTab')),
    focusWindow: parseOptionalBooleanValue(searchParams.get('focusWindow')),
    allowHttpBrowserFallback: parseOptionalBooleanValue(searchParams.get('allowHttpBrowserFallback')),
    preferActive: parseOptionalBooleanValue(searchParams.get('preferActive')),
    preferRecent: parseOptionalBooleanValue(searchParams.get('preferRecent')),
});
export const createNativeBrokerTabsActionRunner = ({ shouldUseNativeBrowserBroker, nativeBrowserBroker, nativeBrowserBrokerToolResult, }) => async (action, args = {}) => {
    if (!shouldUseNativeBrowserBroker())
        return null;
    if (action === 'list') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.listTabs({ allowFallback: true }), action);
    }
    if (action === 'status') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.status({ allowFallback: true }), action);
    }
    if (action === 'claim') {
        if (args.clientId || args.index || args.chatId)
            return null;
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.claim(nativeBrokerReloadPayload(args), { allowFallback: true }), action);
    }
    if (action === 'release') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.release(nativeBrokerReloadPayload(args), { allowFallback: true }), action);
    }
    if (action === 'activate') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.activate(nativeBrokerReloadPayload(args), {
            allowFallback: args.allowHttpBrowserFallback === true,
        }), action);
    }
    if (action === 'reload') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.reload(nativeBrokerReloadPayload(args), {
            allowFallback: args.allowHttpBrowserFallback === true,
        }), action);
    }
    if (action === 'selfHealContentScripts') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.selfHealContentScripts(nativeBrokerSelfHealPayload(args), {
            allowFallback: args.allowHttpBrowserFallback === true,
        }), action);
    }
    if (action === 'reloadManagedTabs') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.reloadManagedTabs(nativeBrokerReloadManagedTabsPayload(args), {
            allowFallback: args.allowHttpBrowserFallback === true,
        }), action);
    }
    if (action === 'extensionStatus') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.extensionStatus({ allowFallback: true }), action);
    }
    if (action === 'reloadExtensionSelf') {
        return nativeBrowserBrokerToolResult(await nativeBrowserBroker.reloadExtensionSelf(nativeBrokerReloadSelfPayload(args), {
            allowFallback: false,
        }), action);
    }
    return null;
};
