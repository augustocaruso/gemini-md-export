export const initialTabPoolState = ({ desiredEpochId, nowMs, }) => ({
    desiredEpochId,
    tabs: [],
    updatedAtMs: nowMs,
});
const hasDesiredStrongRuntime = (evidence, desiredEpochId) => evidence.epochId === desiredEpochId &&
    evidence.strength === 'strong' &&
    evidence.hasCommandChannel === true;
const statusForObservedEvidence = (evidence, desiredEpochId) => (hasDesiredStrongRuntime(evidence, desiredEpochId) ? 'ready' : 'observed');
const statusForObservedUpdate = (tab, evidence, desiredEpochId) => {
    if (tab.status === 'observed' || tab.status === 'ready') {
        return statusForObservedEvidence(evidence, desiredEpochId);
    }
    return tab.status;
};
const observedIdentityRank = (tab, evidence) => {
    if (evidence.tabId !== null && tab.tabId === evidence.tabId)
        return 2;
    if (evidence.clientId !== null && tab.clientId === evidence.clientId && tab.tabId === null) {
        return 1;
    }
    if (evidence.tabId === null && evidence.clientId !== null && tab.clientId === evidence.clientId) {
        return 1;
    }
    if (evidence.tabId === null &&
        evidence.clientId === null &&
        tab.tabId === null &&
        tab.clientId === null) {
        return 0;
    }
    return -1;
};
const findObservedIndex = (tabs, evidence) => {
    let matchedIndex = -1;
    let matchedRank = -1;
    for (const [index, tab] of tabs.entries()) {
        const rank = observedIdentityRank(tab, evidence);
        if (rank > matchedRank) {
            matchedIndex = index;
            matchedRank = rank;
        }
    }
    return matchedIndex;
};
const matchesLifecycleIdentity = (tab, identity) => {
    if (identity.tabId !== null)
        return tab.tabId === identity.tabId;
    if (identity.clientId !== null && identity.clientId !== undefined) {
        return tab.clientId === identity.clientId;
    }
    return false;
};
const updateByLifecycleIdentity = (state, identity, update) => state.tabs.map((tab) => (matchesLifecycleIdentity(tab, identity) ? update(tab) : tab));
export const reduceTabLifecycle = (state, event) => {
    if (event.type === 'tabObserved') {
        const observedTab = {
            tabId: event.evidence.tabId,
            clientId: event.evidence.clientId,
            pageKind: event.evidence.pageKind,
            status: statusForObservedEvidence(event.evidence, state.desiredEpochId),
            evidence: event.evidence,
            updatedAtMs: event.nowMs,
        };
        const existingIndex = findObservedIndex(state.tabs, event.evidence);
        const tabs = existingIndex === -1
            ? [...state.tabs, observedTab]
            : state.tabs.map((tab, index) => index === existingIndex
                ? {
                    ...tab,
                    tabId: event.evidence.tabId,
                    clientId: event.evidence.clientId,
                    pageKind: event.evidence.pageKind,
                    status: statusForObservedUpdate(tab, event.evidence, state.desiredEpochId),
                    evidence: event.evidence,
                    updatedAtMs: event.nowMs,
                }
                : tab);
        return {
            state: {
                ...state,
                tabs,
                updatedAtMs: event.nowMs,
            },
            effects: [],
        };
    }
    if (event.type === 'tabBusy') {
        return {
            state: {
                ...state,
                tabs: updateByLifecycleIdentity(state, event, (tab) => ({
                    ...tab,
                    status: 'busy',
                    updatedAtMs: event.nowMs,
                })),
                updatedAtMs: event.nowMs,
            },
            effects: [],
        };
    }
    if (event.type === 'tabReleased') {
        return {
            state: {
                ...state,
                tabs: updateByLifecycleIdentity(state, event, (tab) => {
                    if (tab.leaseClaimId && event.claimId !== tab.leaseClaimId)
                        return tab;
                    const { leaseClaimId: _leaseClaimId, ...releasedTab } = tab;
                    return {
                        ...releasedTab,
                        status: tab.status === 'quarantined' ? 'quarantined' : 'ready',
                        updatedAtMs: event.nowMs,
                    };
                }),
                updatedAtMs: event.nowMs,
            },
            effects: [],
        };
    }
    return {
        state: {
            ...state,
            tabs: updateByLifecycleIdentity(state, event, (tab) => ({
                ...tab,
                status: 'quarantined',
                quarantineReason: event.reason,
                updatedAtMs: event.nowMs,
            })),
            updatedAtMs: event.nowMs,
        },
        effects: [],
    };
};
const canAllocate = (tab, request, desiredEpochId) => {
    if (tab.pageKind !== request.pageKind)
        return false;
    if (tab.status !== 'ready')
        return false;
    if (tab.leaseClaimId && tab.leaseClaimId !== request.claimId)
        return false;
    if (request.requireStrongRuntime && !hasDesiredStrongRuntime(tab.evidence, desiredEpochId)) {
        return false;
    }
    return true;
};
const reserveTabLease = (state, tab, claimId) => ({
    ...state,
    tabs: state.tabs.map((candidate) => candidate === tab ? { ...candidate, leaseClaimId: claimId } : candidate),
});
export const allocateTabForPurpose = (state, request) => {
    const candidates = state.tabs.filter((tab) => canAllocate(tab, request, state.desiredEpochId));
    if (candidates.length === 1) {
        const tab = candidates[0];
        const tabIndex = state.tabs.indexOf(tab);
        const nextState = reserveTabLease(state, tab, request.claimId);
        const reservedTab = nextState.tabs[tabIndex] ?? {
            ...tab,
            leaseClaimId: request.claimId,
        };
        return {
            status: 'allocated',
            tabId: tab.tabId,
            clientId: tab.clientId,
            tab: reservedTab,
            state: nextState,
            effects: [
                {
                    type: 'tab.claim',
                    reason: request.purpose,
                    tabId: tab.tabId,
                    claimId: request.claimId,
                },
            ],
        };
    }
    if (candidates.length > 1) {
        return {
            status: 'ambiguous',
            candidates,
            state,
            effects: [
                {
                    type: 'diagnostic.record',
                    reason: request.purpose,
                    code: 'ambiguous_tab_allocation',
                    severity: 'warning',
                },
            ],
        };
    }
    if (request.allowCreate && request.createUrl) {
        return {
            status: 'needs_create',
            state,
            effects: [
                {
                    type: 'browser.open',
                    reason: request.purpose,
                    url: request.createUrl,
                    pageKind: request.pageKind,
                },
            ],
        };
    }
    return {
        status: 'unavailable',
        reason: 'no_ready_tab_for_purpose',
        candidates: [],
        state,
        effects: [
            {
                type: 'diagnostic.record',
                reason: request.purpose,
                code: 'no_ready_tab_for_purpose',
                severity: 'warning',
            },
        ],
    };
};
