import type { FsmTransition, RuntimeEpochEvidence, TabOrchestratorEffect } from './types.js';

export type TabLifecycleStatus = 'observed' | 'ready' | 'busy' | 'reloading' | 'quarantined';

export type ManagedTab = {
  tabId: number | null;
  clientId: string | null;
  pageKind: string | null;
  status: TabLifecycleStatus;
  evidence: RuntimeEpochEvidence;
  leaseClaimId?: string;
  quarantineReason?: string;
  updatedAtMs: number;
};

export type TabPoolState = {
  desiredEpochId: string;
  tabs: ManagedTab[];
  updatedAtMs: number;
};

export type TabLifecycleEvent =
  | { type: 'tabObserved'; nowMs: number; evidence: RuntimeEpochEvidence }
  | {
      type: 'tabBusy';
      nowMs: number;
      tabId: number | null;
      clientId?: string | null;
      reason: string;
    }
  | {
      type: 'tabReleased';
      nowMs: number;
      tabId: number | null;
      clientId?: string | null;
      claimId?: string;
    }
  | {
      type: 'tabQuarantined';
      nowMs: number;
      tabId: number | null;
      clientId?: string | null;
      reason: string;
    };

export type TabAllocationRequest = {
  purpose: string;
  pageKind: string;
  requireStrongRuntime: boolean;
  allowCreate: boolean;
  createUrl?: string;
  claimId: string;
};

export type TabAllocationResult =
  | {
      status: 'allocated';
      tabId: number | null;
      clientId: string | null;
      tab: ManagedTab;
      state: TabPoolState;
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'ambiguous';
      candidates: ManagedTab[];
      state: TabPoolState;
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'needs_create';
      state: TabPoolState;
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'unavailable';
      reason: 'no_ready_tab_for_purpose';
      candidates: ManagedTab[];
      state: TabPoolState;
      effects: TabOrchestratorEffect[];
    };

export const initialTabPoolState = ({
  desiredEpochId,
  nowMs,
}: {
  desiredEpochId: string;
  nowMs: number;
}): TabPoolState => ({
  desiredEpochId,
  tabs: [],
  updatedAtMs: nowMs,
});

const hasDesiredStrongRuntime = (
  evidence: RuntimeEpochEvidence,
  desiredEpochId: string,
): boolean =>
  evidence.epochId === desiredEpochId &&
  evidence.strength === 'strong' &&
  evidence.hasCommandChannel === true;

const statusForObservedEvidence = (
  evidence: RuntimeEpochEvidence,
  desiredEpochId: string,
): TabLifecycleStatus => (hasDesiredStrongRuntime(evidence, desiredEpochId) ? 'ready' : 'observed');

const statusForObservedUpdate = (
  tab: ManagedTab,
  evidence: RuntimeEpochEvidence,
  desiredEpochId: string,
): TabLifecycleStatus => {
  if (tab.status === 'observed' || tab.status === 'ready') {
    return statusForObservedEvidence(evidence, desiredEpochId);
  }
  return tab.status;
};

const observedIdentityRank = (tab: ManagedTab, evidence: RuntimeEpochEvidence): number => {
  if (evidence.tabId !== null && tab.tabId === evidence.tabId) return 2;
  if (evidence.clientId !== null && tab.clientId === evidence.clientId && tab.tabId === null) {
    return 1;
  }
  if (evidence.tabId === null && evidence.clientId !== null && tab.clientId === evidence.clientId) {
    return 1;
  }
  if (
    evidence.tabId === null &&
    evidence.clientId === null &&
    tab.tabId === null &&
    tab.clientId === null
  ) {
    return 0;
  }
  return -1;
};

const findObservedIndex = (tabs: ManagedTab[], evidence: RuntimeEpochEvidence): number => {
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

const matchesLifecycleIdentity = (
  tab: ManagedTab,
  identity: { tabId: number | null; clientId?: string | null },
): boolean => {
  if (identity.tabId !== null) return tab.tabId === identity.tabId;
  if (identity.clientId !== null && identity.clientId !== undefined) {
    return tab.clientId === identity.clientId;
  }
  return false;
};

const updateByLifecycleIdentity = (
  state: TabPoolState,
  identity: { tabId: number | null; clientId?: string | null },
  update: (tab: ManagedTab) => ManagedTab,
): ManagedTab[] =>
  state.tabs.map((tab) => (matchesLifecycleIdentity(tab, identity) ? update(tab) : tab));

export const reduceTabLifecycle = (
  state: TabPoolState,
  event: TabLifecycleEvent,
): FsmTransition<TabPoolState, TabLifecycleEvent> => {
  if (event.type === 'tabObserved') {
    const observedTab: ManagedTab = {
      tabId: event.evidence.tabId,
      clientId: event.evidence.clientId,
      pageKind: event.evidence.pageKind,
      status: statusForObservedEvidence(event.evidence, state.desiredEpochId),
      evidence: event.evidence,
      updatedAtMs: event.nowMs,
    };
    const existingIndex = findObservedIndex(state.tabs, event.evidence);
    const tabs =
      existingIndex === -1
        ? [...state.tabs, observedTab]
        : state.tabs.map((tab, index) =>
            index === existingIndex
              ? {
                  ...tab,
                  tabId: event.evidence.tabId,
                  clientId: event.evidence.clientId,
                  pageKind: event.evidence.pageKind,
                  status: statusForObservedUpdate(tab, event.evidence, state.desiredEpochId),
                  evidence: event.evidence,
                  updatedAtMs: event.nowMs,
                }
              : tab,
          );

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
          if (tab.leaseClaimId && event.claimId !== tab.leaseClaimId) return tab;
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

const canAllocate = (
  tab: ManagedTab,
  request: TabAllocationRequest,
  desiredEpochId: string,
): boolean => {
  if (tab.pageKind !== request.pageKind) return false;
  if (tab.status !== 'ready') return false;
  if (tab.leaseClaimId) return false;
  if (request.requireStrongRuntime && !hasDesiredStrongRuntime(tab.evidence, desiredEpochId)) {
    return false;
  }
  return true;
};

const reserveTabLease = (
  state: TabPoolState,
  tab: ManagedTab,
  claimId: string,
): TabPoolState => ({
  ...state,
  tabs: state.tabs.map((candidate) =>
    candidate === tab ? { ...candidate, leaseClaimId: claimId } : candidate,
  ),
});

export const allocateTabForPurpose = (
  state: TabPoolState,
  request: TabAllocationRequest,
): TabAllocationResult => {
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
