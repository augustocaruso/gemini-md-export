import { claimDebuggableGeminiTab, classifyBrowserTabs, getDebuggableGeminiTabs, } from './browser-session-broker.js';
import { inspectTabWithDebugger } from './chrome-debugger-controller.js';
import { looksLikeManagedClaimGroupTitle } from './tab-claim-managed-group.js';
import { trackedTabIdsForClaimRelease } from './tab-claim-release.js';
const managedTabQueryUrls = [
    'https://gemini.google.com/*',
    'https://myactivity.google.com/*',
    'https://accounts.google.com/*',
    'https://www.google.com/sorry/*',
];
const globalChrome = () => globalThis.chrome;
const queryManagedTabs = (chromeApi) => new Promise((resolve) => {
    chromeApi.tabs?.query?.({ url: managedTabQueryUrls }, (items = []) => {
        resolve(Array.isArray(items) ? items : []);
    });
});
const inspectWith = (chromeApi) => (tabId) => inspectTabWithDebugger(tabId, { chromeApi });
const chromeReloadTab = (chromeApi, tabId) => new Promise((resolve) => {
    if (!chromeApi.tabs?.reload) {
        resolve({ ok: false, error: 'chrome_tabs_reload_unavailable' });
        return;
    }
    chromeApi.tabs.reload(tabId, { bypassCache: false }, () => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message) {
            resolve({ ok: false, error: message });
            return;
        }
        resolve({ ok: true });
    });
});
const chromeGroupTabs = (chromeApi, tabIds) => new Promise((resolve) => {
    if (!chromeApi.tabs || !chromeApi.tabs.group || tabIds.length === 0) {
        resolve({ ok: false, reason: 'chrome_tabs_group_unavailable' });
        return;
    }
    chromeApi.tabs.group({ tabIds }, (groupId) => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message || !Number.isInteger(groupId)) {
            resolve({ ok: false, reason: message || 'chrome_tabs_group_invalid_group_id' });
            return;
        }
        resolve({ ok: true, groupId: Number(groupId) });
    });
});
const chromeUpdateTabGroup = (chromeApi, groupId, updateProperties) => new Promise((resolve) => {
    if (!chromeApi.tabGroups?.update || !Number.isInteger(groupId)) {
        resolve({ ok: false, reason: 'chrome_tabGroups_update_unavailable' });
        return;
    }
    chromeApi.tabGroups.update(groupId, updateProperties, () => {
        const message = chromeApi.runtime?.lastError?.message;
        resolve(message ? { ok: false, reason: message } : { ok: true });
    });
});
const chromeGetTabGroup = (chromeApi, groupId) => new Promise((resolve) => {
    if (!chromeApi.tabGroups?.get || !Number.isInteger(groupId) || groupId < 0) {
        resolve(null);
        return;
    }
    chromeApi.tabGroups.get(groupId, (group) => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message || !group) {
            resolve(null);
            return;
        }
        resolve(group);
    });
});
const tabGroupId = (tab) => {
    const groupId = Number(tab.groupId);
    return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
};
const existingManagedClaimGroupIdForTabs = async (chromeApi, tabs, tabIds) => {
    const targetTabs = tabIds
        .map((tabId) => tabs.find((tab) => Number(tab.id) === tabId) || null)
        .filter((tab) => tab !== null);
    if (targetTabs.length !== tabIds.length || targetTabs.length === 0)
        return null;
    const groupIds = Array.from(new Set(targetTabs.map(tabGroupId).filter((groupId) => groupId !== null)));
    if (groupIds.length !== 1)
        return null;
    const groupId = groupIds[0];
    const group = await chromeGetTabGroup(chromeApi, groupId);
    return looksLikeManagedClaimGroupTitle(group?.title) ? groupId : null;
};
const chromeUngroupTabs = (chromeApi, tabIds) => new Promise((resolve) => {
    if (!chromeApi.tabs?.ungroup) {
        resolve({ ok: false, error: 'chrome_tabs_ungroup_unavailable' });
        return;
    }
    const clean = Array.from(new Set(tabIds)).filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    if (clean.length === 0) {
        resolve({ ok: true });
        return;
    }
    chromeApi.tabs.ungroup(clean, () => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message) {
            resolve({ ok: false, error: message });
            return;
        }
        resolve({ ok: true });
    });
});
const chromeUpdateTabActive = (chromeApi, tabId) => new Promise((resolve) => {
    if (!chromeApi.tabs?.update) {
        resolve({ ok: false, error: 'chrome_tabs_update_unavailable' });
        return;
    }
    chromeApi.tabs.update(tabId, { active: true }, (tab) => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message) {
            resolve({ ok: false, error: message });
            return;
        }
        resolve({ ok: true, tab: tab || null });
    });
});
const chromeFocusWindow = (chromeApi, windowId) => new Promise((resolve) => {
    if (!chromeApi.windows?.update || !Number.isInteger(windowId) || windowId <= 0) {
        resolve({ ok: true });
        return;
    }
    chromeApi.windows.update(windowId, { focused: true }, () => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message) {
            resolve({ ok: false, error: message });
            return;
        }
        resolve({ ok: true });
    });
});
const nonEmptyIntegerArray = (values, fallback) => {
    const clean = Array.from(new Set(values)).filter(Number.isInteger);
    if (clean.length === 0)
        return [fallback];
    return clean;
};
const integerArray = (values) => Array.isArray(values)
    ? values.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    : [];
const relatedTabIdsFromClaimPayload = (tabId, payload = {}) => {
    const visualGroupTabId = Number(payload?.visualGroupTabId ?? payload?.groupWithTabId);
    return Array.from(new Set([
        ...integerArray(payload?.relatedTabIds),
        ...integerArray(payload?.tabIds).filter((candidateTabId) => candidateTabId !== tabId),
        ...(Number.isInteger(visualGroupTabId) && visualGroupTabId > 0 ? [visualGroupTabId] : []),
    ]));
};
const applyNativeClaimVisual = async (chromeApi, tabs, tabId, relatedTabIds, payload = {}) => {
    const tabIds = Array.from(new Set([tabId, ...relatedTabIds])).filter(Number.isInteger);
    if (!chromeApi.tabs || !chromeApi.tabs.group || !chromeApi.tabGroups?.update) {
        return { mode: 'action-badge', tabId, reason: 'tab-groups-api-unavailable' };
    }
    const label = payload.label || 'Gemini Export';
    const color = payload.color || 'blue';
    const existingGroupId = await existingManagedClaimGroupIdForTabs(chromeApi, tabs, tabIds);
    if (existingGroupId !== null) {
        const updated = await chromeUpdateTabGroup(chromeApi, existingGroupId, { title: label, color });
        if (!updated.ok) {
            return {
                mode: 'action-badge',
                tabId,
                groupId: existingGroupId,
                reason: 'tab-group-update-failed',
                detail: updated.reason,
            };
        }
        return {
            mode: 'tab-group',
            tabId,
            tabIds: nonEmptyIntegerArray(tabIds, tabId),
            groupId: existingGroupId,
            label,
            color,
            reason: 'reused-existing-managed-claim-group',
        };
    }
    const grouped = await chromeGroupTabs(chromeApi, tabIds);
    if (!grouped.ok) {
        return {
            mode: 'action-badge',
            tabId,
            reason: 'tab-group-create-failed',
            detail: grouped.reason,
        };
    }
    const groupId = grouped.groupId;
    const updated = await chromeUpdateTabGroup(chromeApi, groupId, { title: label, color });
    if (!updated.ok) {
        return {
            mode: 'action-badge',
            tabId,
            groupId,
            reason: 'tab-group-update-failed',
            detail: updated.reason,
        };
    }
    return {
        mode: 'tab-group',
        tabId,
        tabIds: nonEmptyIntegerArray(tabIds, tabId),
        groupId,
        label,
        color,
    };
};
const releaseNativeClaimVisual = async (chromeApi, tabs, payload = {}) => {
    const primaryTabId = Number(payload?.tabId || 0);
    const explicitTabIds = trackedTabIdsForClaimRelease(primaryTabId, {
        tabIds: payload?.tabIds,
    });
    const candidateGroupIds = Array.from(new Set(tabs
        .filter((tab) => explicitTabIds.length > 0 ? explicitTabIds.includes(Number(tab.id)) : true)
        .map((tab) => Number(tab.groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId >= 0)));
    const managedGroupIds = [];
    for (const groupId of candidateGroupIds) {
        const group = await chromeGetTabGroup(chromeApi, groupId);
        if (looksLikeManagedClaimGroupTitle(group?.title))
            managedGroupIds.push(groupId);
    }
    const tabIdsToUngroup = tabs
        .filter((tab) => managedGroupIds.includes(Number(tab.groupId)))
        .map((tab) => Number(tab.id))
        .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    const ungrouped = await chromeUngroupTabs(chromeApi, tabIdsToUngroup);
    return {
        ok: ungrouped.ok,
        released: ungrouped.ok,
        claimId: payload?.claimId || null,
        ungrouped: ungrouped.ok ? tabIdsToUngroup.length : 0,
        ungroupedTabIds: ungrouped.ok ? Array.from(new Set(tabIdsToUngroup)) : [],
        groupIds: managedGroupIds,
        error: ungrouped.ok ? null : ungrouped.error,
        code: ungrouped.ok ? null : 'native_tab_claim_release_failed',
    };
};
const activateNativeBrowserTab = async (chromeApi, tabs, payload = {}) => {
    const tabId = Number(payload?.tabId || 0);
    if (!Number.isInteger(tabId) || tabId <= 0) {
        return { ok: false, code: 'tab_id_required', error: 'tabId required' };
    }
    const tab = tabs.find((item) => Number(item.id) === tabId) || null;
    if (!tab) {
        return { ok: false, code: 'tab_not_found', error: 'Tab not found', tabId };
    }
    const activated = await chromeUpdateTabActive(chromeApi, tabId);
    if (!activated.ok) {
        return {
            ok: false,
            code: 'native_tab_activation_failed',
            error: activated.error,
            tabId,
        };
    }
    const shouldFocusWindow = payload?.focusWindow === true;
    const focus = shouldFocusWindow ? await chromeFocusWindow(chromeApi, Number(tab.windowId)) : null;
    return {
        ok: true,
        activated: true,
        tabId,
        windowId: Number(tab.windowId) || null,
        isActiveTab: true,
        focusWindow: shouldFocusWindow,
        focusOk: focus ? focus.ok : null,
        focusError: focus && !focus.ok ? focus.error : null,
        tab: activated.tab || tab,
    };
};
export const handleNativeBrowserBrokerCommand = async (request, chromeApi = globalChrome() || {}, runtimeActions = {}) => {
    if (request.command === 'extension.keepAlive') {
        if (!runtimeActions.keepAlive) {
            return {
                ok: false,
                code: 'extension_keepalive_unavailable',
            };
        }
        return runtimeActions.keepAlive(request.payload || {});
    }
    if (request.command === 'extension.status') {
        return (runtimeActions.extensionStatus?.() ?? {
            ok: false,
            code: 'extension_status_unavailable',
        });
    }
    if (request.command === 'extension.selfHealContentScripts') {
        if (!runtimeActions.selfHealContentScripts) {
            return {
                ok: false,
                code: 'extension_self_heal_unavailable',
            };
        }
        return runtimeActions.selfHealContentScripts(request.payload || {});
    }
    if (request.command === 'extension.reloadManagedTabs') {
        if (!runtimeActions.reloadManagedTabs) {
            return {
                ok: false,
                code: 'extension_reload_managed_tabs_unavailable',
            };
        }
        return runtimeActions.reloadManagedTabs(request.payload || {});
    }
    if (request.command === 'extension.reloadSelf') {
        if (!runtimeActions.reloadSelf) {
            return {
                ok: false,
                code: 'extension_reload_unavailable',
            };
        }
        return runtimeActions.reloadSelf(request.payload || {});
    }
    if (request.command === 'privateApi.sessionStatus') {
        if (!runtimeActions.privateApiSessionStatus) {
            return {
                ok: false,
                code: 'private_api_session_status_unavailable',
            };
        }
        return runtimeActions.privateApiSessionStatus(request.payload || {});
    }
    if (request.command === 'privateApi.listChats') {
        if (!runtimeActions.privateApiListChats) {
            return {
                ok: false,
                code: 'private_api_list_chats_unavailable',
            };
        }
        return runtimeActions.privateApiListChats(request.payload || {});
    }
    if (request.command === 'privateApi.readChat') {
        if (!runtimeActions.privateApiReadChat) {
            return {
                ok: false,
                code: 'private_api_read_chat_unavailable',
            };
        }
        return runtimeActions.privateApiReadChat(request.payload || {});
    }
    const tabs = await queryManagedTabs(chromeApi);
    const inspectTab = inspectWith(chromeApi);
    if (request.command === 'tabs.list' || request.command === 'tabs.status') {
        return { ok: true, tabs: await classifyBrowserTabs(tabs, { inspectTab }) };
    }
    if (request.command === 'tabs.claim') {
        const explicitRelatedTabIds = relatedTabIdsFromClaimPayload(0, request.payload);
        const claim = await claimDebuggableGeminiTab(tabs, {
            requestedTabId: Number(request.payload?.tabId || 0) || null,
            claimId: request.payload?.claimId || null,
            inspectTab,
            relatedTabIds: explicitRelatedTabIds,
        });
        if (claim.ok !== true)
            return claim;
        const relatedTabIds = Array.from(new Set([
            ...claim.visualCompanionTabIds,
            ...relatedTabIdsFromClaimPayload(claim.tab.tabId, request.payload),
        ]));
        return {
            ...claim,
            visual: await applyNativeClaimVisual(chromeApi, tabs, claim.tab.tabId, relatedTabIds, request.payload),
        };
    }
    if (request.command === 'tabs.release') {
        return releaseNativeClaimVisual(chromeApi, tabs, request.payload || {});
    }
    if (request.command === 'tabs.activate') {
        return activateNativeBrowserTab(chromeApi, tabs, request.payload || {});
    }
    if (request.command === 'tabs.reload') {
        const listed = await getDebuggableGeminiTabs(tabs, { inspectTab });
        const requestedTabId = Number(request.payload?.tabId || 0);
        const explicitTabIds = trackedTabIdsForClaimRelease(requestedTabId, {
            tabIds: request.payload?.tabIds,
        });
        const reloadAll = request.payload?.reloadAll === true;
        const explicitTargets = explicitTabIds.length > 0
            ? tabs
                .filter((tab) => explicitTabIds.includes(Number(tab.id)))
                .map((tab) => ({ ...tab, tabId: Number(tab.id) }))
            : [];
        const targets = explicitTabIds.length > 0
            ? explicitTargets
            : reloadAll
                ? listed.tabs
                : listed.tabs.filter((tab) => tab.active === true);
        if (targets.length === 0) {
            return {
                ok: false,
                code: explicitTabIds.length > 0
                    ? 'no_requested_tabs'
                    : listed.tabs.length === 0
                        ? 'no_existing_gemini_tabs'
                        : 'no_active_gemini_tab',
                reloaded: 0,
                tabs: listed.tabs,
                classified: listed.classified,
            };
        }
        if (explicitTabIds.length === 0 && !requestedTabId && !reloadAll && targets.length > 1) {
            return {
                ok: false,
                code: 'ambiguous_active_gemini_tabs',
                reloaded: 0,
                tabs: targets,
                classified: listed.classified,
            };
        }
        const results = await Promise.all(targets.map(async (tab) => ({
            tab,
            reload: await chromeReloadTab(chromeApi, tab.tabId),
        })));
        const successes = results.filter((item) => item.reload.ok);
        const failures = results.filter((item) => !item.reload.ok);
        return {
            ok: failures.length === 0,
            code: failures.length === 0 ? null : 'native_tab_reload_failed',
            requested: targets.length,
            reloaded: successes.length,
            reloadedTabIds: successes.map((item) => item.tab.tabId),
            failures: failures.map((item) => ({
                tabId: item.tab.tabId,
                error: item.reload.ok ? null : item.reload.error,
            })),
            tabs: listed.tabs,
            classified: listed.classified,
        };
    }
    return { ok: true, released: true, claimId: request.payload?.claimId || null };
};
const isBrokerResponse = (message) => !!message && typeof message === 'object' && 'ok' in message;
const isBrowserBrokerCommand = (command) => command === 'tabs.list' ||
    command === 'tabs.status' ||
    command === 'tabs.claim' ||
    command === 'tabs.release' ||
    command === 'tabs.activate' ||
    command === 'tabs.reload' ||
    command === 'extension.keepAlive' ||
    command === 'extension.status' ||
    command === 'extension.selfHealContentScripts' ||
    command === 'extension.reloadManagedTabs' ||
    command === 'extension.reloadSelf' ||
    command === 'privateApi.sessionStatus' ||
    command === 'privateApi.listChats' ||
    command === 'privateApi.readChat';
const unsupportedCommandResponse = (request) => ({
    id: request.id,
    ok: false,
    error: {
        code: 'unsupported_native_browser_command',
        message: 'Unsupported native browser broker command.',
        retryable: false,
        nextAction: 'Send a tabs.* command to the browser broker.',
    },
});
export const createNativeBrokerPort = ({ chromeApi = globalChrome() || {}, hostName, onStatus, runtimeActions = {}, }) => {
    let port = null;
    let readyPromise = null;
    let settleReady = null;
    const connect = () => {
        if (!chromeApi.runtime?.connectNative) {
            throw new Error('native_messaging_unavailable');
        }
        const helloId = `extension-${Date.now()}`;
        readyPromise = new Promise((resolve) => {
            settleReady = resolve;
        });
        port = chromeApi.runtime.connectNative(hostName);
        port.onMessage.addListener((message) => {
            if (isBrokerResponse(message)) {
                onStatus?.({ ok: message.ok, response: message });
                if (message.id === helloId) {
                    settleReady?.({ ok: message.ok, response: message });
                    settleReady = null;
                }
                return;
            }
            const request = message;
            if (!isBrowserBrokerCommand(request.command)) {
                port?.postMessage(unsupportedCommandResponse(request));
                return;
            }
            handleNativeBrowserBrokerCommand({
                id: request.id,
                command: request.command,
                payload: request.payload,
            }, chromeApi, runtimeActions).then((result) => {
                const response = { id: request.id, ok: true, result };
                port?.postMessage(response);
            }, (err) => {
                const response = {
                    id: request.id,
                    ok: false,
                    error: {
                        code: 'native_browser_broker_failed',
                        message: err instanceof Error ? err.message : String(err),
                        retryable: true,
                        nextAction: 'Retry the tab command after the browser settles.',
                    },
                };
                port?.postMessage(response);
            });
        });
        port.onDisconnect.addListener(() => {
            onStatus?.({
                ok: false,
                code: 'native_broker_disconnected',
                error: chromeApi.runtime?.lastError?.message || null,
            });
            settleReady?.({
                ok: false,
                code: 'native_broker_disconnected',
                error: chromeApi.runtime?.lastError?.message || null,
            });
            settleReady = null;
            readyPromise = null;
            port = null;
        });
        port.postMessage({
            id: helloId,
            protocolVersion: 1,
            command: 'extension.hello',
            payload: { source: 'extension-background' },
        });
        onStatus?.({ ok: true, connected: true });
        return port;
    };
    return {
        ensureConnected: () => port || connect(),
        ensureReady: ({ timeoutMs = 2500 } = {}) => {
            const connectedPort = port || connect();
            void connectedPort;
            const timeout = new Promise((resolve) => {
                setTimeout(() => resolve({
                    ok: false,
                    code: 'native_broker_ready_timeout',
                    timeoutMs,
                }), timeoutMs);
            });
            return Promise.race([readyPromise || Promise.resolve({ ok: true }), timeout]);
        },
        disconnect: () => {
            port?.disconnect?.();
            settleReady = null;
            readyPromise = null;
            port = null;
        },
    };
};
