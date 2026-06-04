const COMMAND_CLIENT_LEASE = Symbol('CommandClientLease');
const isLive = (client) => !!client?.clientId && client.live !== false;
const sameClient = (left, right) => !!left?.clientId && left.clientId === right?.clientId;
const normalizeTabId = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : String(value);
};
const tabIdsMatch = (left, right) => {
    const normalizedLeft = normalizeTabId(left);
    const normalizedRight = normalizeTabId(right);
    return normalizedLeft !== null && normalizedLeft === normalizedRight;
};
const issueCommandClientLease = (client, reason) => ({
    [COMMAND_CLIENT_LEASE]: true,
    clientId: client.clientId,
    tabId: normalizeTabId(client.tabId),
    claimId: client.claimId || null,
    sessionId: client.sessionId || null,
    reason,
    issuedAt: Date.now(),
});
const commandClientUnavailableError = () => {
    const error = new Error('Nenhum cliente de comando do Gemini está disponível.');
    error.code = 'no_command_client_available';
    error.recoverable = true;
    return error;
};
const commandClientPreferenceScore = (client) => Number(client.commandReady === true) * 100 +
    Number(client.recentCommandFailure !== true) * 50 +
    Number(client.lastSeenAt || 0) / 1_000_000_000_000;
const preferredClient = (clients = []) => clients
    .filter(isLive)
    .sort((a, b) => commandClientPreferenceScore(b) - commandClientPreferenceScore(a))[0] || null;
const shouldPreferReplacementOverCurrent = (current, candidate) => {
    if (!isLive(candidate) || sameClient(current, candidate))
        return false;
    if (!isLive(current))
        return true;
    if (current.recentCommandFailure === true)
        return true;
    if (current.commandReady !== true && candidate.commandReady === true)
        return true;
    return Number(candidate.lastSeenAt || 0) > Number(current.lastSeenAt || 0);
};
const selectorPinsDifferentClient = (selector, client) => !!selector?.clientId && !!client?.clientId && selector.clientId !== client.clientId;
const selectorAllowsClient = (selector, client) => {
    if (!isLive(client))
        return false;
    if (selector?.clientId && selector.clientId !== client.clientId)
        return false;
    if (selector?.claimId && client.claimId && selector.claimId !== client.claimId)
        return false;
    if (selector?.tabId !== undefined &&
        selector.tabId !== null &&
        !tabIdsMatch(selector.tabId, client.tabId)) {
        return false;
    }
    return true;
};
export const selectCommandClientLease = ({ selector = {}, pool = {}, }) => {
    const current = isLive(pool.current) ? pool.current : null;
    const explicitCurrent = !!selector.clientId && current?.clientId === selector.clientId;
    if (selectorAllowsClient(selector, pool.replacement)) {
        return issueCommandClientLease(pool.replacement, 'replacement');
    }
    if (!explicitCurrent && selectorAllowsClient(selector, pool.claim)) {
        if (shouldPreferReplacementOverCurrent(current, pool.claim)) {
            return issueCommandClientLease(pool.claim, 'claim');
        }
    }
    const sameTab = preferredClient((pool.sameTab || []).filter((client) => !selectorPinsDifferentClient(selector, client)));
    if (!explicitCurrent && sameTab && shouldPreferReplacementOverCurrent(current, sameTab)) {
        return issueCommandClientLease(sameTab, 'same-tab');
    }
    if (!explicitCurrent && selectorAllowsClient(selector, pool.sessionClaim)) {
        if (shouldPreferReplacementOverCurrent(current, pool.sessionClaim)) {
            return issueCommandClientLease(pool.sessionClaim, 'session-claim');
        }
    }
    if (selectorAllowsClient(selector, current)) {
        return issueCommandClientLease(current, 'current');
    }
    if (selectorAllowsClient(selector, pool.claim)) {
        return issueCommandClientLease(pool.claim, 'claim');
    }
    if (selectorAllowsClient(selector, sameTab)) {
        return issueCommandClientLease(sameTab, 'same-tab');
    }
    if (selectorAllowsClient(selector, pool.sessionClaim)) {
        return issueCommandClientLease(pool.sessionClaim, 'session-claim');
    }
    if (selectorAllowsClient(selector, pool.fallback)) {
        return issueCommandClientLease(pool.fallback, 'fallback');
    }
    return null;
};
export const selectRecoveryCommandClientLease = ({ selector = {}, pool = {}, error = {}, }) => {
    if (error.replacementClientId && pool.replacement?.clientId === error.replacementClientId) {
        return isLive(pool.replacement)
            ? issueCommandClientLease(pool.replacement, 'replacement')
            : null;
    }
    return selectCommandClientLease({ selector, pool });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const waitForRecoveryCommandClientLease = async ({ selector = {}, error = {}, getPool, waitMs = 10_000, pollMs = 500, }) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= waitMs) {
        const lease = selectRecoveryCommandClientLease({
            selector,
            error,
            pool: await getPool(),
        });
        if (lease)
            return lease;
        await sleep(pollMs);
    }
    return null;
};
export const runBrowserCommandWithClientRecovery = async ({ initialClient = null, selector = {}, request, getPool, dispatch, isRecoverableError, describeError, waitMs, pollMs, }) => {
    const initialLease = selectCommandClientLease({
        selector,
        pool: await getPool({ activeLease: null, error: null }),
    });
    const lease = initialLease ||
        (isLive(initialClient) ? issueCommandClientLease(initialClient, 'fallback') : null);
    if (!lease) {
        throw commandClientUnavailableError();
    }
    try {
        const result = await dispatch(lease, request);
        return {
            lease,
            result,
            recovered: lease.clientId !== initialClient?.clientId,
        };
    }
    catch (error) {
        if (!isRecoverableError(error))
            throw error;
        const errorInfo = describeError(error);
        const recoveredLease = await waitForRecoveryCommandClientLease({
            selector,
            error: errorInfo,
            waitMs,
            pollMs,
            getPool: () => getPool({ activeLease: lease, error: errorInfo }),
        });
        if (!recoveredLease)
            throw error;
        const result = await dispatch(recoveredLease, request);
        return {
            lease: recoveredLease,
            result,
            recovered: true,
        };
    }
};
export const enqueueBrowserCommandWithLease = async (lease, request, dispatch) => ({
    lease,
    result: await dispatch(lease, request),
    recovered: false,
});
