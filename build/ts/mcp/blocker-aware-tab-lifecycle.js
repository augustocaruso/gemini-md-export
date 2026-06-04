const DEFAULT_STATE = (nowMs) => ({
    status: 'idle',
    activeLaunchId: null,
    blocker: null,
    managedTabs: [],
    launchAttemptCount: 0,
    updatedAtMs: nowMs,
});
const MANAGED_TAB_WITHOUT_ID_TTL_MS = 120_000;
const MANAGED_TAB_MAX_RECORDS = 12;
const recordOrNull = (value) => value !== null && typeof value === 'object' ? value : null;
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
};
const safeUrlForDiagnostics = (value) => {
    const text = stringOrNull(value);
    if (!text)
        return null;
    try {
        const parsed = new URL(text);
        if (parsed.hostname.endsWith('google.com') &&
            parsed.pathname.toLowerCase().startsWith('/sorry')) {
            return `${parsed.origin}${parsed.pathname}`;
        }
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return text.slice(0, 300);
    }
};
const normalizeManagedTab = (value, nowMs) => {
    const record = recordOrNull(value);
    if (!record)
        return null;
    const createdAtMs = Number(record.createdAtMs || record.updatedAtMs || nowMs);
    const updatedAtMs = Number(record.updatedAtMs || createdAtMs || nowMs);
    const source = stringOrNull(record.source) || 'unknown';
    return {
        managed: true,
        tabId: numberOrNull(record.tabId),
        launchId: stringOrNull(record.launchId),
        source: source === 'cli' || source === 'mcp' || source === 'native-broker' ? source : 'unknown',
        targetUrl: safeUrlForDiagnostics(record.targetUrl),
        observedUrl: safeUrlForDiagnostics(record.observedUrl),
        blockerCode: record.blockerCode === 'google_verification_required' ||
            record.blockerCode === 'google_login_required' ||
            record.blockerCode === 'google_page_blocked' ||
            record.blockerCode === 'browser_not_on_gemini'
            ? record.blockerCode
            : null,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : nowMs,
    };
};
const pruneManagedTabs = (managedTabs, nowMs) => {
    const freshTabs = managedTabs.filter((tab) => {
        if (tab.tabId !== null && tab.tabId !== undefined)
            return true;
        const ageMs = nowMs - tab.updatedAtMs;
        if (!Number.isFinite(ageMs) || ageMs < 0)
            return true;
        return ageMs < MANAGED_TAB_WITHOUT_ID_TTL_MS;
    });
    return freshTabs.length > MANAGED_TAB_MAX_RECORDS
        ? freshTabs.slice(freshTabs.length - MANAGED_TAB_MAX_RECORDS)
        : freshTabs;
};
const normalizeBlocker = (value, nowMs) => {
    const record = recordOrNull(value);
    if (!record)
        return null;
    const code = record.code;
    if (code !== 'google_verification_required' &&
        code !== 'google_login_required' &&
        code !== 'google_page_blocked' &&
        code !== 'browser_not_on_gemini') {
        return null;
    }
    return {
        code,
        kind: stringOrNull(record.kind) || code,
        terminal: true,
        message: stringOrNull(record.message) || blockerMessage(code),
        nextAction: stringOrNull(record.nextAction) || blockerNextAction(code),
        url: safeUrlForDiagnostics(record.url),
        scope: record.scope === 'tab' ? 'tab' : 'profile',
        observedAtMs: Number(record.observedAtMs || nowMs) || nowMs,
    };
};
export const browserTabLifecycleStateFromLaunchState = (value, nowMs = Date.now()) => {
    const record = recordOrNull(value);
    const nested = recordOrNull(record?.tabLifecycle) || recordOrNull(record?.browserTabLifecycle);
    const source = nested || record;
    if (!source)
        return DEFAULT_STATE(nowMs);
    const status = stringOrNull(source.status);
    const managedTabs = Array.isArray(source.managedTabs)
        ? source.managedTabs
            .map((item) => normalizeManagedTab(item, nowMs))
            .filter((item) => item !== null)
        : [];
    return {
        status: status === 'launching' || status === 'ready' || status === 'blocked' || status === 'idle'
            ? status
            : normalizeBlocker(source.blocker, nowMs)
                ? 'blocked'
                : 'idle',
        activeLaunchId: stringOrNull(source.activeLaunchId),
        blocker: normalizeBlocker(source.blocker, nowMs),
        managedTabs: pruneManagedTabs(managedTabs, nowMs),
        launchAttemptCount: Math.max(0, Math.floor(Number(source.launchAttemptCount || 0) || 0)),
        updatedAtMs: Number(source.updatedAtMs || nowMs) || nowMs,
    };
};
const blockerMessage = (code) => {
    if (code === 'google_verification_required') {
        return 'O Google abriu uma tela de verificacao antes do Gemini.';
    }
    if (code === 'google_login_required')
        return 'O navegador esta no login do Google.';
    if (code === 'browser_not_on_gemini')
        return 'O navegador abriu, mas nao chegou ao Gemini Web.';
    return 'O Google bloqueou a pagina antes de liberar o Gemini.';
};
const blockerNextAction = (code) => {
    if (code === 'google_login_required')
        return 'Conclua o login no navegador e tente novamente.';
    if (code === 'browser_not_on_gemini') {
        return 'Abra o Gemini Web na aba correta e tente novamente.';
    }
    return 'Resolva a verificacao no navegador e tente novamente.';
};
export const blockerFromBrowserDiagnosis = (diagnosis, nowMs = Date.now()) => {
    const kind = stringOrNull(diagnosis?.kind);
    if (!kind)
        return null;
    const code = kind === 'google_sorry'
        ? 'google_verification_required'
        : kind === 'google_login'
            ? 'google_login_required'
            : null;
    if (!code)
        return null;
    return {
        code,
        kind,
        scope: 'profile',
        terminal: true,
        message: blockerMessage(code),
        nextAction: blockerNextAction(code),
        url: safeUrlForDiagnostics(diagnosis?.url || diagnosis?.activeUrl),
        observedAtMs: nowMs,
    };
};
const trackManagedTab = (state, tab) => {
    const existingIndex = state.managedTabs.findIndex((item) => {
        if (tab.tabId !== null && tab.tabId !== undefined && item.tabId === tab.tabId)
            return true;
        if (tab.launchId && item.launchId === tab.launchId && item.targetUrl === tab.targetUrl)
            return true;
        return false;
    });
    const managedTabs = existingIndex === -1
        ? [...state.managedTabs, tab]
        : state.managedTabs.map((item, index) => index === existingIndex
            ? {
                ...item,
                ...tab,
                createdAtMs: item.createdAtMs,
                updatedAtMs: tab.updatedAtMs,
            }
            : item);
    return { ...state, managedTabs };
};
const openedNewTab = (result) => result.result.openedNewTab === true && result.result.reusedExistingTab !== true;
export const transitionBrowserTabLifecycle = (state, event) => {
    if (event.type === 'readyObserved') {
        return {
            state: {
                ...state,
                status: event.ready ? 'ready' : state.status === 'ready' ? 'idle' : state.status,
                updatedAtMs: event.nowMs,
            },
            effects: [],
        };
    }
    if (event.type === 'browserInventoryObserved') {
        const blocker = blockerFromBrowserDiagnosis(event.diagnosis, event.nowMs);
        if (!blocker) {
            if (state.status === 'blocked' &&
                state.blocker?.scope !== 'profile' &&
                event.diagnosis?.kind === 'gemini') {
                return {
                    state: {
                        ...state,
                        status: 'idle',
                        blocker: null,
                        updatedAtMs: event.nowMs,
                    },
                    effects: [
                        {
                            type: 'diagnostic.record',
                            code: 'browser_blocker_resolved',
                            severity: 'info',
                            message: 'O navegador voltou ao Gemini Web; launch automatico liberado.',
                        },
                    ],
                };
            }
            return { state: { ...state, updatedAtMs: event.nowMs }, effects: [] };
        }
        let nextState = {
            ...state,
            status: 'blocked',
            blocker,
            updatedAtMs: event.nowMs,
        };
        const effects = [
            {
                type: 'browser.launch.suppress',
                reason: blocker.code,
                blocker,
            },
            {
                type: 'diagnostic.record',
                code: blocker.code,
                severity: 'error',
                message: blocker.message,
            },
        ];
        if (event.manageObservedTab || state.status === 'launching' || event.launchId) {
            const tab = {
                managed: true,
                launchId: event.launchId || state.activeLaunchId || null,
                source: event.source,
                targetUrl: null,
                observedUrl: safeUrlForDiagnostics(event.diagnosis?.url || event.diagnosis?.activeUrl),
                blockerCode: blocker.code,
                createdAtMs: event.nowMs,
                updatedAtMs: event.nowMs,
            };
            nextState = trackManagedTab(nextState, tab);
            effects.push({
                type: 'managedTab.track',
                reason: 'terminal_blocker_after_launch',
                tab,
            });
        }
        return { state: nextState, effects };
    }
    if (event.type === 'launchRequested') {
        if (state.status === 'blocked' && state.blocker?.terminal === true) {
            return {
                state: { ...state, updatedAtMs: event.nowMs },
                effects: [
                    {
                        type: 'browser.launch.suppress',
                        reason: state.blocker.code,
                        blocker: state.blocker,
                    },
                ],
            };
        }
        return {
            state: {
                ...state,
                status: 'launching',
                activeLaunchId: event.launchId,
                launchAttemptCount: state.launchAttemptCount + 1,
                updatedAtMs: event.nowMs,
            },
            effects: [],
        };
    }
    const tab = {
        managed: true,
        tabId: numberOrNull(event.result.tabId),
        launchId: event.launchId,
        source: event.source,
        targetUrl: safeUrlForDiagnostics(event.result.targetUrl || event.targetUrl),
        observedUrl: null,
        blockerCode: null,
        createdAtMs: event.nowMs,
        updatedAtMs: event.nowMs,
    };
    const shouldTrack = openedNewTab(event);
    const nextState = shouldTrack ? trackManagedTab(state, tab) : state;
    return {
        state: {
            ...nextState,
            status: nextState.status === 'launching' ? 'idle' : nextState.status,
            activeLaunchId: nextState.activeLaunchId === event.launchId ? null : nextState.activeLaunchId || null,
            updatedAtMs: event.nowMs,
        },
        effects: shouldTrack
            ? [
                {
                    type: 'managedTab.track',
                    reason: 'launch_opened_tab',
                    tab,
                },
            ]
            : [],
    };
};
export const evaluateBrowserLaunchGate = ({ launchState, diagnosis = null, nowMs, launchId, source, targetUrl, }) => {
    let state = browserTabLifecycleStateFromLaunchState(launchState, nowMs);
    const effects = [];
    if (diagnosis) {
        const observed = transitionBrowserTabLifecycle(state, {
            type: 'browserInventoryObserved',
            nowMs,
            diagnosis,
            source,
            launchId: state.activeLaunchId || null,
        });
        state = observed.state;
        effects.push(...observed.effects);
    }
    const requested = transitionBrowserTabLifecycle(state, {
        type: 'launchRequested',
        nowMs,
        launchId,
        source,
        targetUrl,
    });
    state = requested.state;
    effects.push(...requested.effects);
    const suppress = effects.find((effect) => effect.type === 'browser.launch.suppress');
    return {
        canLaunch: !suppress,
        state,
        blocker: suppress?.blocker || state.blocker || null,
        effects,
    };
};
export const observeBrowserLaunchResult = ({ state, nowMs = Date.now(), launchId, source, targetUrl, result, }) => transitionBrowserTabLifecycle(state, {
    type: 'launchResultObserved',
    nowMs,
    launchId,
    source,
    targetUrl,
    result,
});
