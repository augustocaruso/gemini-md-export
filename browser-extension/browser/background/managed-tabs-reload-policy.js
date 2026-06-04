const text = (value) => value === null || value === undefined ? '' : String(value);
export const managedTabsReloadRuntimeKey = (runtime = {}) => [
    text(runtime.extensionVersion || runtime.version),
    text(runtime.protocolVersion),
    text(runtime.buildStamp),
].join('|');
const reloadId = (runtimeKey, nowMs) => `${runtimeKey || 'unknown-runtime'}:${nowMs.toString(36)}`;
export const decideManagedTabsReload = ({ previous = null, runtimeKey, reason = 'manual', nowMs = Date.now(), cooldownMs, force = false, }) => {
    const previousRecord = previous;
    const previousReloadedAtMs = Number(previousRecord?.reloadedAtMs || 0);
    if (!force && previousReloadedAtMs > 0 && nowMs - previousReloadedAtMs < cooldownMs) {
        return {
            ok: false,
            status: 'cooldown',
            reason,
            previous,
            cooldownMs: cooldownMs - (nowMs - previousReloadedAtMs),
            runtimeKey,
        };
    }
    if (!force && previousRecord?.runtimeKey && previousRecord.runtimeKey === runtimeKey) {
        return {
            ok: false,
            status: 'already-reloaded-current-runtime',
            reason,
            previous,
            runtimeKey,
        };
    }
    return {
        ok: true,
        status: 'allowed',
        previous,
        current: {
            reloadId: reloadId(runtimeKey, nowMs),
            reason,
            runtimeKey,
            reloadedAtMs: nowMs,
            reloadedAt: new Date(nowMs).toISOString(),
            forced: force,
        },
    };
};
