const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const normalizeId = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    return String(value);
};
const normalizeNumber = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};
const freshTimestamp = (value, now, maxAgeMs) => {
    const timestamp = normalizeNumber(value);
    return timestamp !== null && now - timestamp >= 0 && now - timestamp <= maxAgeMs;
};
const expectedRuntimeMatches = (client, options) => {
    if (options.expectedExtensionVersion &&
        String(client.extensionVersion || '') !== String(options.expectedExtensionVersion)) {
        return false;
    }
    if (options.expectedProtocolVersion !== null &&
        options.expectedProtocolVersion !== undefined &&
        Number(client.protocolVersion) !== Number(options.expectedProtocolVersion)) {
        return false;
    }
    const expectedBuildStamp = options.expectedBuildStamp;
    const clientBuildStamp = client.buildStamp || client.page?.buildStamp || null;
    if (expectedBuildStamp && String(clientBuildStamp || '') !== String(expectedBuildStamp)) {
        return false;
    }
    return true;
};
const clientHasPageEvidence = (client) => Boolean(normalizeId(client.page?.url) ||
    normalizeId(client.page?.pathname) ||
    normalizeId(client.page?.path) ||
    normalizeId(client.page?.chatId) ||
    normalizeId(client.page?.notebookId));
const clientTargetsBrowserTab = (client, targetTabId) => {
    const target = normalizeNumber(targetTabId);
    const tabId = normalizeNumber(client?.tabId);
    return target !== null && tabId !== null && tabId === target;
};
export const resolveActivatedTargetClient = ({ targetTabId = null, activeClient = null, liveClient = null, preferredClient = null, }) => {
    for (const client of [activeClient, liveClient, preferredClient]) {
        if (clientTargetsBrowserTab(client, targetTabId))
            return client;
    }
    return null;
};
export const activateBrowserTabWithNativeBroker = async ({ tabId, args = {}, preferredClient = null, tryNativeBrowserBrokerTabsAction, waitForActivatedBrowserTabById, liveClientForBrowserTabId, }) => {
    const nativeActivation = await tryNativeBrowserBrokerTabsAction('activate', {
        tabId,
        reason: args.activateTabReason || 'export',
        focusWindow: args.focusWindow === true,
        allowHttpBrowserFallback: true,
    });
    if (!nativeActivation?.ok)
        return null;
    const confirmedClient = resolveActivatedTargetClient({
        targetTabId: tabId,
        activeClient: await waitForActivatedBrowserTabById(tabId, args),
        liveClient: liveClientForBrowserTabId(tabId),
        preferredClient,
    });
    if (confirmedClient) {
        confirmedClient.isActiveTab = true;
    }
    return {
        broker: null,
        client: confirmedClient || preferredClient,
        result: {
            ok: true,
            mode: 'native-browser-broker',
            tabId,
            windowId: confirmedClient?.windowId ??
                preferredClient?.windowId ??
                null,
            isActiveTab: true,
            native: nativeActivation,
        },
    };
};
export const clientHasLiveRuntimeEvidence = (client, options) => {
    const now = Number(options.now ?? Date.now());
    if (freshTimestamp(client.lastHeartbeatAt, now, options.staleAfterMs) ||
        freshTimestamp(client.lastSnapshotAt, now, options.staleAfterMs)) {
        return true;
    }
    const warmupGraceMs = Number(options.warmupGraceMs ?? 4000);
    if (!freshTimestamp(client.lastSeenAt, now, warmupGraceMs))
        return false;
    if (!expectedRuntimeMatches(client, options))
        return false;
    if (options.eventStreamConnected !== true && options.longPollConnected !== true)
        return false;
    return normalizeId(client.tabId) !== null || clientHasPageEvidence(client);
};
const sameConcreteTab = (left, right) => {
    const leftTabId = normalizeId(left.tabId);
    const rightTabId = normalizeId(right.tabId);
    return leftTabId !== null && leftTabId === rightTabId;
};
const sameClaim = (left, right) => {
    const leftClaimId = normalizeId(left.claimId);
    const rightClaimId = normalizeId(right.claimId);
    if (leftClaimId !== null && leftClaimId === rightClaimId)
        return true;
    if (leftClaimId !== null && rightClaimId !== null)
        return false;
    const leftSessionId = normalizeId(left.sessionId);
    const rightSessionId = normalizeId(right.sessionId);
    return (leftSessionId !== null &&
        leftSessionId === rightSessionId &&
        (sameConcreteTab(left, right) || leftClaimId !== null || rightClaimId !== null));
};
const sameDurableTab = (left, right) => sameConcreteTab(left, right) || sameClaim(left, right);
const cacheScore = (client) => Number(client.conversationCount || 0) * 1_000_000_000 + Number(client.lastSeenAt || 0);
export const selectReconnectSourcesForTab = ({ nextClient, candidates = [], }) => {
    const matches = candidates.filter((candidate) => candidate.clientId !== nextClient.clientId && sameDurableTab(candidate, nextClient));
    const cacheSource = [...matches].sort((a, b) => cacheScore(b) - cacheScore(a))[0] || null;
    return {
        abortClientIds: matches.map((candidate) => candidate.clientId),
        cacheSourceClientId: cacheSource?.clientId || null,
    };
};
export const shouldIncludeHeartbeatJobProgress = ({ hasJobProgress = false, status = null, terminalAgeMs = null, terminalTtlMs = null, }) => {
    if (!hasJobProgress)
        return false;
    if (!status || !TERMINAL_STATUSES.has(status))
        return true;
    if (terminalAgeMs === null || terminalTtlMs === null)
        return true;
    return terminalAgeMs <= terminalTtlMs;
};
