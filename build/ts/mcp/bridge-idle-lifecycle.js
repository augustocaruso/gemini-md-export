const IDLE_NEUTRAL_GET_PATHS = new Set([
    '/healthz',
    '/agent/clients',
    '/agent/ready',
    '/agent/diagnostics',
]);
export const buildBridgeRequestRecord = (method, url) => {
    const parsed = new URL(url || '/', 'http://127.0.0.1');
    return {
        method: method || null,
        pathname: parsed.pathname,
        clientId: parsed.searchParams.get('clientId'),
    };
};
export const isIdleNeutralBridgeRequest = (record) => record.method === 'GET' && IDLE_NEUTRAL_GET_PATHS.has(record.pathname);
export const bridgeRequestBlocksIdle = (record, hasLiveRuntimeEvidence) => {
    if (isIdleNeutralBridgeRequest(record))
        return false;
    if (record.pathname === '/bridge/events' || record.pathname === '/bridge/command') {
        return hasLiveRuntimeEvidence;
    }
    return true;
};
export const buildBridgeIdleLifecycleSnapshot = (input) => {
    const idleForMs = Math.max(0, input.now - input.lastActivityAt);
    const heartbeatAgeMs = input.lastChromeHeartbeatAt
        ? input.now - input.lastChromeHeartbeatAt
        : null;
    const blockedBy = [];
    if (input.activeRequestBlockerCount > 0)
        blockedBy.push('active_request');
    if (input.activeJobCount > 0)
        blockedBy.push('active_job');
    if (input.liveClientCount > 0)
        blockedBy.push('recent_extension_heartbeat');
    return {
        enabled: input.exitWhenIdle,
        keepAliveMs: input.keepAliveMs,
        idleForMs,
        activeRequestCount: input.activeRequestCount,
        activeRequestBlockerCount: input.activeRequestBlockerCount,
        activeJobCount: input.activeJobCount,
        liveClientCount: input.liveClientCount,
        lastActivityAt: new Date(input.lastActivityAt).toISOString(),
        lastChromeHeartbeatAt: input.lastChromeHeartbeatAt
            ? new Date(input.lastChromeHeartbeatAt).toISOString()
            : null,
        heartbeatAgeMs,
        blockedBy,
        exitsWhenIdle: input.exitWhenIdle && blockedBy.length === 0,
        remainingMs: input.exitWhenIdle && blockedBy.length === 0
            ? Math.max(0, input.keepAliveMs - idleForMs)
            : null,
    };
};
export const transitionBridgeIdleLifecycle = (input) => {
    const snapshot = buildBridgeIdleLifecycleSnapshot(input);
    if (!input.exitWhenIdle) {
        return { state: 'disabled', snapshot, delayMs: null, effects: [] };
    }
    if (snapshot.blockedBy.length > 0) {
        return {
            state: 'blocked',
            snapshot,
            delayMs: Math.min(30_000, Math.max(1000, input.keepAliveMs)),
            effects: ['schedule_check'],
        };
    }
    if (snapshot.idleForMs >= input.keepAliveMs) {
        return { state: 'ready_to_shutdown', snapshot, delayMs: null, effects: ['shutdown'] };
    }
    return {
        state: 'counting_down',
        snapshot,
        delayMs: Math.max(1000, Math.min(30_000, snapshot.remainingMs || 0)),
        effects: ['schedule_check'],
    };
};
