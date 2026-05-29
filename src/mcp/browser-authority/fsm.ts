import type {
  BrowserAuthorityBlocker,
  BrowserAuthorityBudget,
  BrowserAuthorityEffect,
  BrowserAuthorityOperationKind,
  BrowserAuthorityOwner,
  BrowserAuthorityPolicy,
  BrowserAuthorityState,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from './types.js';

export type BrowserAuthorityEvent =
  | Readonly<{
      type: 'leaseRequested';
      nowMs: number;
      leaseId: string;
      operationId: string;
      operationKind: BrowserAuthorityOperationKind;
      owner: BrowserAuthorityOwner;
      policy: BrowserAuthorityPolicy;
      budget: BrowserAuthorityBudget;
      expectedEpochId?: string | null;
    }>
  | Readonly<{
      type: 'effectRequested';
      nowMs: number;
      leaseId: string;
      effect: BrowserAuthorityEffect;
    }>
  | Readonly<{
      type: 'profileBlockerObserved';
      nowMs: number;
      blocker: BrowserAuthorityBlocker;
    }>
  | Readonly<{
      type: 'profileBlockerCleared';
      nowMs: number;
      reason: string;
    }>
  | Readonly<{
      type: 'leaseReleased';
      nowMs: number;
      leaseId: string;
      reason: string;
    }>;

export type BrowserAuthorityTransition = Readonly<{
  state: BrowserAuthorityState;
  effects: readonly LeasedBrowserAuthorityEffect[];
  blocker?: BrowserAuthorityBlocker | null;
}>;

export const initialBrowserAuthorityState = ({
  nowMs = Date.now(),
}: Readonly<{ nowMs?: number }> = {}): BrowserAuthorityState => ({
  leases: [],
  profileBlocker: null,
  updatedAtMs: nowMs,
});

const makeBlocker = (
  code: BrowserAuthorityBlocker['code'],
  nowMs: number,
  message: string,
  nextAction: string,
): BrowserAuthorityBlocker => ({
  code,
  scope: 'operation',
  terminal: true,
  message,
  nextAction,
  observedAtMs: nowMs,
});

const activeLease = (state: BrowserAuthorityState, leaseId: string): BrowserLease | null =>
  state.leases.find((lease) => lease.leaseId === leaseId) || null;

const leaseIsExpired = (lease: BrowserLease, nowMs: number): boolean =>
  !!lease.releasedAtMs || lease.budget.deadlineAtMs <= nowMs;

const effectCost = (effect: BrowserAuthorityEffect): keyof BrowserAuthorityBudget | null => {
  if (effect.type === 'browser.launch') return 'maxNewTabs';
  if (effect.type === 'tab.reload' || effect.type === 'extension.reload') return 'maxReloads';
  if (effect.type === 'tab.activate') return 'maxActivations';
  if (effect.type === 'tab.navigate') return 'maxNavigations';
  return null;
};

const budgetAllowsEffect = (lease: BrowserLease, effect: BrowserAuthorityEffect): boolean => {
  const key = effectCost(effect);
  if (!key) return true;
  return Number(lease.budget[key]) > 0;
};

const spendBudget = (
  lease: BrowserLease,
  effect: BrowserAuthorityEffect,
  nowMs: number,
): BrowserLease => {
  const key = effectCost(effect);
  if (!key) return { ...lease, updatedAtMs: nowMs };
  return {
    ...lease,
    budget: {
      ...lease.budget,
      [key]: Math.max(0, Number(lease.budget[key]) - 1),
    },
    updatedAtMs: nowMs,
  };
};

const upsertLease = (
  leases: readonly BrowserLease[],
  next: BrowserLease,
): readonly BrowserLease[] => [...leases.filter((lease) => lease.leaseId !== next.leaseId), next];

export const transitionBrowserAuthority = (
  state: BrowserAuthorityState,
  event: BrowserAuthorityEvent,
): BrowserAuthorityTransition => {
  if (event.type === 'profileBlockerObserved') {
    return {
      state: {
        ...state,
        profileBlocker: event.blocker,
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: event.blocker,
    };
  }

  if (event.type === 'profileBlockerCleared') {
    return {
      state: {
        ...state,
        profileBlocker: null,
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: null,
    };
  }

  if (event.type === 'leaseRequested') {
    if (state.profileBlocker?.terminal) {
      return {
        state: { ...state, updatedAtMs: event.nowMs },
        effects: [],
        blocker: state.profileBlocker,
      };
    }

    const lease: BrowserLease = {
      leaseId: event.leaseId,
      operationId: event.operationId,
      operationKind: event.operationKind,
      owner: event.owner,
      policy: event.policy,
      budget: event.budget,
      managedTabIds: [],
      expectedEpochId: event.expectedEpochId || null,
      createdAtMs: event.nowMs,
      updatedAtMs: event.nowMs,
      blocker: null,
      releasedAtMs: null,
    };

    return {
      state: {
        ...state,
        leases: upsertLease(state.leases, lease),
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: null,
    };
  }

  if (event.type === 'leaseReleased') {
    return {
      state: {
        ...state,
        leases: state.leases.map((lease) =>
          lease.leaseId === event.leaseId
            ? { ...lease, releasedAtMs: event.nowMs, updatedAtMs: event.nowMs }
            : lease,
        ),
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: null,
    };
  }

  const lease = activeLease(state, event.leaseId);
  if (!lease) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: makeBlocker(
        'lease_missing',
        event.nowMs,
        'A operacao nao tem uma autorizacao de navegador valida.',
        'Reinicie a operacao pelo fluxo principal.',
      ),
    };
  }

  if (leaseIsExpired(lease, event.nowMs)) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: makeBlocker(
        'lease_expired',
        event.nowMs,
        'A autorizacao de navegador desta operacao expirou.',
        'Reinicie a operacao se ainda precisar controlar o navegador.',
      ),
    };
  }

  if (!budgetAllowsEffect(lease, event.effect)) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: makeBlocker(
        'operation_budget_exhausted',
        event.nowMs,
        'A operacao atingiu o limite seguro de controle do navegador.',
        'Pare e revise o diagnostico antes de tentar de novo.',
      ),
    };
  }

  const spentLease = spendBudget(lease, event.effect, event.nowMs);
  const leasedEffect: LeasedBrowserAuthorityEffect = {
    ...event.effect,
    leaseId: event.leaseId,
  };

  return {
    state: {
      ...state,
      leases: upsertLease(state.leases, spentLease),
      updatedAtMs: event.nowMs,
    },
    effects: [leasedEffect],
    blocker: null,
  };
};
