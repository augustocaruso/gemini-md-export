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
  | { type: 'tabBusy'; nowMs: number; tabId: number | null; reason: string }
  | { type: 'tabReleased'; nowMs: number; tabId: number | null; claimId?: string }
  | { type: 'tabQuarantined'; nowMs: number; tabId: number | null; reason: string };

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
      tab: ManagedTab;
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'ambiguous';
      candidates: ManagedTab[];
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'needs_create';
      effects: TabOrchestratorEffect[];
    }
  | {
      status: 'unavailable';
      reason: 'no_ready_tab_for_purpose';
      candidates: ManagedTab[];
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

const matchesObservedIdentity = (tab: ManagedTab, evidence: RuntimeEpochEvidence): boolean => {
  if (evidence.tabId !== null) return tab.tabId === evidence.tabId;
  if (evidence.clientId !== null) return tab.clientId === evidence.clientId;
  return tab.tabId === null && tab.clientId === null;
};

const updateByTabId = (
  state: TabPoolState,
  tabId: number | null,
  update: (tab: ManagedTab) => ManagedTab,
): ManagedTab[] => state.tabs.map((tab) => (tab.tabId === tabId ? update(tab) : tab));

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
    const existingIndex = state.tabs.findIndex((tab) =>
      matchesObservedIdentity(tab, event.evidence),
    );
    const tabs =
      existingIndex === -1
        ? [...state.tabs, observedTab]
        : state.tabs.map((tab, index) => (index === existingIndex ? observedTab : tab));

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
        tabs: updateByTabId(state, event.tabId, (tab) => ({
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
        tabs: updateByTabId(state, event.tabId, (tab) => {
          const { leaseClaimId: _leaseClaimId, ...releasedTab } = tab;
          return {
            ...releasedTab,
            status: 'ready',
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
      tabs: updateByTabId(state, event.tabId, (tab) => ({
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
  if (request.requireStrongRuntime && !hasDesiredStrongRuntime(tab.evidence, desiredEpochId)) {
    return false;
  }
  return true;
};

export const allocateTabForPurpose = (
  state: TabPoolState,
  request: TabAllocationRequest,
): TabAllocationResult => {
  const candidates = state.tabs.filter((tab) => canAllocate(tab, request, state.desiredEpochId));

  if (candidates.length === 1) {
    const tab = candidates[0];
    return {
      status: 'allocated',
      tab,
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
