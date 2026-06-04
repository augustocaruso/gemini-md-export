export const CONTENT_RUNTIME_BOOT_GRACE_MS = 15_000;
export const CONTENT_RUNTIME_HEARTBEAT_STALE_MS = 45_000;
const numericTimestamp = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const withinAge = (nowMs, timestamp, maxAgeMs) => timestamp !== null && nowMs - timestamp >= 0 && nowMs - timestamp <= maxAgeMs;
export const classifyContentRuntimeHealth = ({ status, installedAt, nowMs = Date.now(), bootGraceMs = CONTENT_RUNTIME_BOOT_GRACE_MS, staleHeartbeatMs = CONTENT_RUNTIME_HEARTBEAT_STALE_MS, }) => {
    const runtimeInstalledAt = numericTimestamp(status?.installedAt) ?? numericTimestamp(installedAt);
    const withinBootGrace = withinAge(nowMs, runtimeInstalledAt, bootGraceMs);
    const bridge = status?.bridge || null;
    if (!bridge)
        return withinBootGrace ? 'booting' : 'stale';
    if (bridge.started !== true)
        return withinBootGrace ? 'booting' : 'stale';
    const lastHeartbeatAt = numericTimestamp(bridge.lastHeartbeatAt);
    if (withinAge(nowMs, lastHeartbeatAt, staleHeartbeatMs)) {
        return bridge.heartbeatTimerActive === false ? 'stale' : 'healthy';
    }
    const lastHeartbeatStartedAt = numericTimestamp(bridge.lastHeartbeatStartedAt);
    if (bridge.heartbeatInFlight === true &&
        withinAge(nowMs, lastHeartbeatStartedAt, staleHeartbeatMs)) {
        return 'healthy';
    }
    return withinBootGrace ? 'booting' : 'stale';
};
export const transitionContentRuntimeGuard = (_state, event) => {
    if (event.type !== 'evaluate-runtime' || !event.hasRuntime) {
        return {
            state: { tag: 'absent' },
            effects: ['continue-bootstrap'],
        };
    }
    if (!event.sameBuild || !event.sameProtocol) {
        return {
            state: { tag: 'signature-mismatch' },
            effects: ['quiesce-existing', 'continue-bootstrap'],
        };
    }
    const health = classifyContentRuntimeHealth({
        status: event.status,
        installedAt: event.installedAt,
        nowMs: event.nowMs,
        bootGraceMs: event.bootGraceMs,
        staleHeartbeatMs: event.staleHeartbeatMs,
    });
    if (health === 'healthy') {
        return {
            state: { tag: 'same-signature-healthy' },
            effects: ['return-existing'],
        };
    }
    if (health === 'booting') {
        return {
            state: { tag: 'same-signature-booting' },
            effects: ['return-existing'],
        };
    }
    return {
        state: { tag: 'same-signature-stale' },
        effects: ['quiesce-existing', 'continue-bootstrap'],
    };
};
