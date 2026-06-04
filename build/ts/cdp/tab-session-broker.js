import { activateCdpTarget, buildCdpBrowserSnapshot, selectCdpTarget, } from './browser-control.js';
export const cdpUrlForRuntimeInput = (input = {}) => {
    if (input.controlPlane === 'bridge')
        return null;
    const value = String(input.cdpUrl || input.defaultCdpUrl || '').trim();
    return value || null;
};
export const buildCdpControlSnapshot = async (input = {}, deps = {}) => {
    const endpoint = cdpUrlForRuntimeInput(input);
    if (!endpoint) {
        return {
            attempted: false,
            ok: false,
            reason: 'cdp-url-not-configured',
        };
    }
    try {
        const buildSnapshot = deps.buildSnapshot || buildCdpBrowserSnapshot;
        return {
            attempted: true,
            ...(await buildSnapshot({
                endpoint,
                allowHttpBrowserFallback: input.allowHttpBrowserFallback === true,
                devToolsActivePortContents: input.devToolsActivePortContents || null,
                devToolsActivePortFile: input.devToolsActivePortFile || input.defaultDevToolsActivePortFile || null,
            })),
        };
    }
    catch (err) {
        return {
            attempted: true,
            ok: false,
            endpoint,
            error: err instanceof Error ? err.message : String(err),
            code: typeof err === 'object' && err !== null && 'code' in err
                ? String(err.code)
                : 'cdp_unavailable',
        };
    }
};
const snapshotTargets = (snapshot) => Array.isArray(snapshot.targets)
    ? snapshot.targets
    : [];
export const activateExtensionClientWithCdp = async (client, input = {}, deps = {}) => {
    const endpoint = cdpUrlForRuntimeInput(input);
    if (!endpoint || !client)
        return null;
    const snapshot = await buildCdpControlSnapshot(input, deps);
    if (snapshot.ok === false) {
        return {
            ok: false,
            mode: 'cdp',
            skipped: true,
            snapshot,
        };
    }
    const target = selectCdpTarget(snapshotTargets(snapshot), {
        chatId: client.page?.chatId || client.chatId || input.chatId || null,
        url: client.page?.url || client.url || null,
    });
    if (!target) {
        return {
            ok: false,
            mode: 'cdp',
            skipped: true,
            reason: 'cdp-target-not-found',
            snapshot,
        };
    }
    const activateTarget = deps.activateTarget || activateCdpTarget;
    const activated = await activateTarget(target, { endpoint });
    return {
        ok: activated.ok !== false,
        mode: 'cdp',
        targetId: String(activated.targetId || target.id),
        target,
        snapshot,
        tabId: client.tabId ?? null,
        windowId: client.windowId ?? null,
        isActiveTab: true,
        result: { ...activated },
    };
};
