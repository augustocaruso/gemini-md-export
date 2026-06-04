const positiveTabId = (value) => {
    const tabId = Number(value);
    return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
};
const numberOrNull = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const tabFromListItem = (item) => {
    if (item && typeof item === 'object' && 'tab' in item && item.tab)
        return item.tab;
    return item;
};
const tabUrl = (tab) => String(tab.url || tab.pendingUrl || '');
const itemPageKind = (item) => String(item && typeof item === 'object' && 'inspection' in item ? item.inspection?.pageKind || '' : '');
const isActivityListItem = (item) => {
    const tab = tabFromListItem(item);
    return (itemPageKind(item) === 'my_activity' ||
        tabUrl(tab).startsWith('https://myactivity.google.com/product/gemini'));
};
export const activityCompanionTabIdsForNativeLease = (lease, exportTabId = undefined) => {
    const primaryTabId = positiveTabId(exportTabId ?? lease?.tabId);
    const tabIds = Array.isArray(lease?.visual?.tabIds) ? lease.visual.tabIds : [];
    const companions = tabIds
        .map(positiveTabId)
        .filter((tabId) => tabId !== null && tabId !== primaryTabId);
    return Array.from(new Set(companions));
};
export const activityCompanionTabIdsForNativeTabs = (list, exportTabId = undefined) => {
    const primaryTabId = positiveTabId(exportTabId);
    const entries = Array.isArray(list?.tabs) ? list.tabs : [];
    const exportTab = entries
        .map(tabFromListItem)
        .find((tab) => primaryTabId !== null && positiveTabId(tab.id ?? tab.tabId) === primaryTabId);
    const exportWindowId = numberOrNull(exportTab?.windowId);
    const exportIndex = numberOrNull(exportTab?.index);
    const candidates = entries
        .filter(isActivityListItem)
        .map(tabFromListItem)
        .map((tab) => ({
        tabId: positiveTabId(tab.id ?? tab.tabId),
        windowId: numberOrNull(tab.windowId),
        index: numberOrNull(tab.index),
    }))
        .filter((item) => item.tabId !== null && item.tabId !== primaryTabId)
        .filter((item) => exportWindowId === null || item.windowId === null || item.windowId === exportWindowId)
        .sort((left, right) => {
        const leftDistance = exportIndex === null || left.index === null
            ? Number.MAX_SAFE_INTEGER
            : Math.abs(left.index - exportIndex);
        const rightDistance = exportIndex === null || right.index === null
            ? Number.MAX_SAFE_INTEGER
            : Math.abs(right.index - exportIndex);
        return leftDistance - rightDistance || left.tabId - right.tabId;
    });
    const selected = candidates[0]?.tabId;
    return Number.isInteger(selected) ? [selected] : [];
};
export const shouldPrepareActivityCompanionForDateImport = (args = {}) => args.noMyActivity !== true && args.useMyActivity !== false;
const noWakeEffects = {
    activateCompanion: false,
    reloadCompanion: false,
    restoreExportTab: false,
};
export const transitionActivityCompanionWakeFsm = (state, event) => {
    if (state !== 'checking')
        return { state, effects: noWakeEffects };
    if (event.type === 'client_ready')
        return { state: 'already_ready', effects: noWakeEffects };
    if (!event.companionTabIdKnown)
        return { state: 'no_companion', effects: noWakeEffects };
    if (event.explicitActivation) {
        return {
            state: 'activate_then_reload',
            effects: {
                activateCompanion: true,
                reloadCompanion: true,
                restoreExportTab: event.exportTabIdKnown,
            },
        };
    }
    return {
        state: 'background_reload',
        effects: {
            activateCompanion: false,
            reloadCompanion: true,
            restoreExportTab: false,
        },
    };
};
const DEFAULT_ACTIVITY_COMPANION_WAKE_WAIT_MS = 30_000;
const activityCompanionWakeWaitMs = (args, normalizeWaitMs) => normalizeWaitMs(args.activityCompanionWakeWaitMs ??
    args.activityWaitMs ??
    args.myActivityWaitMs ??
    args.readyWaitMs, DEFAULT_ACTIVITY_COMPANION_WAKE_WAIT_MS, 120_000);
const summarizeActivityCompanionWakeError = (err) => ({
    ok: false,
    code: err?.code || null,
    error: err?.message || String(err),
});
const isRecord = (value) => typeof value === 'object' && value !== null;
const copyScalar = (target, source, key) => {
    const value = source[key];
    if (value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean') {
        target[key] = value;
    }
};
const tabIdArrayOrNull = (value) => {
    if (!Array.isArray(value))
        return null;
    const tabIds = value.map(positiveTabId).filter((tabId) => tabId !== null);
    return tabIds.length > 0 ? Array.from(new Set(tabIds)) : null;
};
const summarizeVisualResult = (visual) => {
    if (!isRecord(visual))
        return null;
    const summary = {};
    for (const key of ['mode', 'label', 'color', 'reason'])
        copyScalar(summary, visual, key);
    for (const key of ['tabId', 'groupId', 'originalGroupId']) {
        const value = numberOrNull(visual[key]);
        if (value !== null)
            summary[key] = value;
    }
    const tabIds = tabIdArrayOrNull(visual.tabIds);
    if (tabIds)
        summary.tabIds = tabIds;
    return Object.keys(summary).length > 0 ? summary : null;
};
const summarizeNativeActionResult = (result) => {
    if (!isRecord(result))
        return result === null || result === undefined ? null : { value: String(result) };
    const summary = {};
    for (const key of [
        'ok',
        'action',
        'source',
        'code',
        'error',
        'reason',
        'requested',
        'reloaded',
        'tabId',
        'windowId',
        'isActiveTab',
        'claimId',
        'releasedByTab',
    ]) {
        copyScalar(summary, result, key);
    }
    for (const key of ['tabIds', 'relatedTabIds', 'reloadedTabIds', 'released']) {
        const tabIds = tabIdArrayOrNull(result[key]);
        if (tabIds)
            summary[key] = tabIds;
    }
    const visual = summarizeVisualResult(result.visual);
    if (visual)
        summary.visual = visual;
    if (isRecord(result.nativeBroker)) {
        summary.nativeBroker = {};
        for (const key of ['ok', 'code', 'error', 'reason']) {
            copyScalar(summary.nativeBroker, result.nativeBroker, key);
        }
    }
    if (Array.isArray(result.tabs))
        summary.tabCount = result.tabs.length;
    if (Array.isArray(result.classified))
        summary.classifiedCount = result.classified.length;
    return summary;
};
const summarizeActivityCompanionClient = (client, summarizeClient) => {
    if (!isRecord(client))
        return null;
    let rawSummary;
    try {
        rawSummary = summarizeClient(client);
    }
    catch (err) {
        return summarizeActivityCompanionWakeError(err);
    }
    if (!isRecord(rawSummary))
        return null;
    const summary = {};
    for (const key of [
        'clientId',
        'kind',
        'tabId',
        'windowId',
        'isActiveTab',
        'extensionVersion',
        'protocolVersion',
        'buildStamp',
    ]) {
        copyScalar(summary, rawSummary, key);
    }
    if (isRecord(rawSummary.page)) {
        summary.page = {};
        for (const key of ['kind', 'url', 'title', 'chatId']) {
            copyScalar(summary.page, rawSummary.page, key);
        }
    }
    return summary;
};
const summarizeActivationResult = (result, summarizeClient) => {
    if (!isRecord(result))
        return summarizeNativeActionResult(result);
    const summary = {};
    for (const key of ['ok', 'code', 'error', 'reason', 'tabId', 'windowId']) {
        copyScalar(summary, result, key);
    }
    const broker = summarizeActivityCompanionClient(result.broker, summarizeClient);
    if (broker)
        summary.broker = broker;
    const client = summarizeActivityCompanionClient(result.client, summarizeClient);
    if (client)
        summary.client = client;
    const actionResult = 'result' in result ? result.result : result;
    const summarizedResult = summarizeNativeActionResult(actionResult);
    if (summarizedResult)
        summary.result = summarizedResult;
    return summary;
};
const claimIdFromLease = (lease, args) => {
    const claimId = args.claimId || lease?.claimId || lease?.tab?.claimId;
    const normalized = String(claimId || '').trim();
    return normalized || null;
};
export const createActivityCompanionPreparer = (deps) => async (client, args = {}, nativeLease = null) => {
    if (!shouldPrepareActivityCompanionForDateImport(args)) {
        return { attempted: false, reason: 'my-activity-disabled' };
    }
    const exportTabId = deps.normalizeTabId(nativeLease?.tabId ?? args.tabId ?? client?.tabId);
    let companionTabIds = activityCompanionTabIdsForNativeLease(nativeLease, exportTabId);
    let companionSource = 'claim-visual';
    let companionList = null;
    let visualRefresh = null;
    if (companionTabIds.length === 0) {
        try {
            const rawCompanionList = await deps.tryNativeBrowserBrokerTabsAction('list', {
                reason: 'find-activity-companion-before-export',
            });
            companionList = summarizeNativeActionResult(rawCompanionList);
            companionTabIds = activityCompanionTabIdsForNativeTabs(rawCompanionList, exportTabId);
            companionSource = 'native-tabs-list';
        }
        catch (err) {
            companionList = summarizeActivityCompanionWakeError(err);
        }
    }
    if (companionTabIds.length === 0) {
        return { attempted: false, reason: 'no-activity-companion-tab', companionList };
    }
    const companionTabId = companionTabIds[0];
    if (exportTabId !== null && companionSource !== 'claim-visual') {
        try {
            visualRefresh = summarizeNativeActionResult(await deps.tryNativeBrowserBrokerTabsAction('claim', {
                ...args,
                tabId: exportTabId,
                claimId: claimIdFromLease(nativeLease, args) || undefined,
                tabIds: [exportTabId, companionTabId],
                relatedTabIds: [companionTabId],
                reason: 'attach-activity-companion-before-export',
            }));
        }
        catch (err) {
            visualRefresh = summarizeActivityCompanionWakeError(err);
        }
    }
    const alreadyReady = await deps.waitForActivityClient({ tabId: companionTabId }, 1500);
    if (alreadyReady && deps.activityClientCommandReady(alreadyReady)) {
        return {
            attempted: false,
            reason: 'activity-companion-already-ready',
            wakePolicy: transitionActivityCompanionWakeFsm('checking', { type: 'client_ready' }),
            source: companionSource,
            tabId: companionTabId,
            client: summarizeActivityCompanionClient(alreadyReady, deps.summarizeClient),
            visualRefresh,
        };
    }
    const wakePolicy = transitionActivityCompanionWakeFsm('checking', {
        type: 'needs_wake',
        explicitActivation: args.activateActivityTabBeforeExport === true || args.activateActivityTab === true,
        companionTabIdKnown: companionTabId !== null,
        exportTabIdKnown: exportTabId !== null,
    });
    let activation = null;
    let reload = null;
    let restore = null;
    if (wakePolicy.effects.activateCompanion) {
        try {
            activation = summarizeActivationResult(await deps.activateBrowserTabById(companionTabId, {
                ...args,
                activateTabReason: 'wake-activity-companion-before-export',
                focusWindow: false,
                activateTabConfirmWaitMs: 5000,
            }, null), deps.summarizeClient);
        }
        catch (err) {
            activation = summarizeActivityCompanionWakeError(err);
        }
    }
    const reloadStartedAt = Date.now();
    if (wakePolicy.effects.reloadCompanion) {
        try {
            reload = summarizeNativeActionResult(await deps.tryNativeBrowserBrokerTabsAction('reload', {
                tabIds: [companionTabId],
                reason: 'reload-activity-companion-before-export',
                focusWindow: false,
            }));
        }
        catch (err) {
            reload = summarizeActivityCompanionWakeError(err);
        }
    }
    const activityClient = await deps.waitForActivityClient({ tabId: companionTabId, minRuntimeSignalAt: reloadStartedAt }, activityCompanionWakeWaitMs(args, deps.normalizeWaitMs));
    if (wakePolicy.effects.restoreExportTab && exportTabId !== null) {
        try {
            restore = summarizeActivationResult(await deps.activateBrowserTabById(exportTabId, {
                ...args,
                activateTabReason: 'restore-gemini-after-activity-companion',
                focusWindow: false,
                activateTabConfirmWaitMs: 8000,
            }, client), deps.summarizeClient);
        }
        catch (err) {
            restore = summarizeActivityCompanionWakeError(err);
        }
    }
    let fallback = null;
    if ((!activityClient || !deps.activityClientCommandReady(activityClient)) &&
        companionSource === 'claim-visual') {
        try {
            const rawFallbackList = await deps.tryNativeBrowserBrokerTabsAction('list', {
                reason: 'find-activity-companion-after-stale-claim-visual',
            });
            const fallbackCompanionList = summarizeNativeActionResult(rawFallbackList);
            const fallbackCompanionTabId = activityCompanionTabIdsForNativeTabs(rawFallbackList, exportTabId).find((tabId) => tabId !== companionTabId) || null;
            fallback = {
                attempted: true,
                source: 'native-tabs-list',
                companionList: fallbackCompanionList,
                tabId: fallbackCompanionTabId,
                visualRefresh: null,
                wakePolicy: null,
                activation: null,
                reload: null,
                restore: null,
                client: null,
            };
            if (fallbackCompanionTabId !== null) {
                if (exportTabId !== null) {
                    try {
                        fallback.visualRefresh = summarizeNativeActionResult(await deps.tryNativeBrowserBrokerTabsAction('claim', {
                            ...args,
                            tabId: exportTabId,
                            claimId: claimIdFromLease(nativeLease, args) || undefined,
                            tabIds: [exportTabId, fallbackCompanionTabId],
                            relatedTabIds: [fallbackCompanionTabId],
                            reason: 'reattach-activity-companion-after-stale-claim-visual',
                        }));
                    }
                    catch (err) {
                        fallback.visualRefresh = summarizeActivityCompanionWakeError(err);
                    }
                }
                const fallbackWakePolicy = transitionActivityCompanionWakeFsm('checking', {
                    type: 'needs_wake',
                    explicitActivation: args.activateActivityTabBeforeExport === true || args.activateActivityTab === true,
                    companionTabIdKnown: true,
                    exportTabIdKnown: exportTabId !== null,
                });
                fallback.wakePolicy = fallbackWakePolicy;
                if (fallbackWakePolicy.effects.activateCompanion) {
                    try {
                        fallback.activation = summarizeActivationResult(await deps.activateBrowserTabById(fallbackCompanionTabId, {
                            ...args,
                            activateTabReason: 'wake-activity-companion-fallback-before-export',
                            focusWindow: false,
                            activateTabConfirmWaitMs: 5000,
                        }, null), deps.summarizeClient);
                    }
                    catch (err) {
                        fallback.activation = summarizeActivityCompanionWakeError(err);
                    }
                }
                const fallbackReloadStartedAt = Date.now();
                if (fallbackWakePolicy.effects.reloadCompanion) {
                    try {
                        fallback.reload = summarizeNativeActionResult(await deps.tryNativeBrowserBrokerTabsAction('reload', {
                            tabIds: [fallbackCompanionTabId],
                            reason: 'reload-activity-companion-fallback-before-export',
                            focusWindow: false,
                        }));
                    }
                    catch (err) {
                        fallback.reload = summarizeActivityCompanionWakeError(err);
                    }
                }
                const fallbackActivityClient = await deps.waitForActivityClient({ tabId: fallbackCompanionTabId, minRuntimeSignalAt: fallbackReloadStartedAt }, activityCompanionWakeWaitMs(args, deps.normalizeWaitMs));
                if (fallbackWakePolicy.effects.restoreExportTab && exportTabId !== null) {
                    try {
                        fallback.restore = summarizeActivationResult(await deps.activateBrowserTabById(exportTabId, {
                            ...args,
                            activateTabReason: 'restore-gemini-after-activity-companion-fallback',
                            focusWindow: false,
                            activateTabConfirmWaitMs: 8000,
                        }, client), deps.summarizeClient);
                    }
                    catch (err) {
                        fallback.restore = summarizeActivityCompanionWakeError(err);
                    }
                }
                fallback.client = summarizeActivityCompanionClient(fallbackActivityClient, deps.summarizeClient);
                if (fallbackActivityClient && deps.activityClientCommandReady(fallbackActivityClient)) {
                    return {
                        attempted: true,
                        reason: 'activity-companion-ready-after-fallback',
                        source: 'native-tabs-list',
                        tabId: fallbackCompanionTabId,
                        client: fallback.client,
                        visualRefresh: fallback.visualRefresh,
                        wakePolicy: fallbackWakePolicy,
                        activation: fallback.activation,
                        reload: fallback.reload,
                        restore: fallback.restore,
                        fallbackFrom: {
                            source: companionSource,
                            tabId: companionTabId,
                            wakePolicy,
                            activation,
                            reload,
                            restore,
                            visualRefresh,
                            client: summarizeActivityCompanionClient(activityClient, deps.summarizeClient),
                        },
                    };
                }
            }
        }
        catch (err) {
            fallback = summarizeActivityCompanionWakeError(err);
        }
    }
    if (!activityClient || !deps.activityClientCommandReady(activityClient)) {
        const error = new Error('A aba My Activity da claim visual não ficou pronta para buscar datas.');
        error.code = 'activity_companion_not_ready';
        error.data = {
            companionTabId,
            exportTabId,
            wakePolicy,
            activation,
            reload,
            restore,
            visualRefresh,
            fallback,
            connectedActivityClients: deps.getActivityClients().map(deps.summarizeClient),
        };
        throw error;
    }
    return {
        attempted: true,
        reason: 'activity-companion-ready-after-wake',
        source: companionSource,
        tabId: companionTabId,
        client: summarizeActivityCompanionClient(activityClient, deps.summarizeClient),
        visualRefresh,
        wakePolicy,
        activation,
        reload,
        restore,
    };
};
