import {
  classifyRuntimeEvidence,
  runtimeEpochId,
} from './runtime-epoch-fsm.js';
import {
  allocateTabForPurpose,
  initialTabPoolState,
  reduceTabLifecycle,
  type TabPoolState,
} from './tab-lifecycle-fsm.js';
import {
  initialRecoveryState,
  reduceRuntimeRecovery,
} from './recovery-fsm.js';
import type {
  ExpectedExtensionRuntime,
  ObservedTabClient,
  RuntimeEpochEvidence,
  TabOrchestratorEffect,
  TabOrchestratorMode,
} from './types.js';

export type TabOrchestrationRequest = {
  mode: TabOrchestratorMode;
  expected: ExpectedExtensionRuntime;
  nowMs: number;
  desiredPageKind: string;
  purpose: string;
  claimId: string;
  clients: ObservedTabClient[];
  allowCreate: boolean;
  createUrl?: string;
};

export type TabOrchestrationBlocker = {
  code:
    | 'runtime_epoch_not_ready'
    | 'command_channel_not_ready'
    | 'no_ready_tab_for_purpose'
    | 'ambiguous_tabs';
  message: string;
  severity: 'info' | 'warning' | 'error';
};

export type TabOrchestrationResult = {
  ready: boolean;
  blocker: TabOrchestrationBlocker | null;
  effects: TabOrchestratorEffect[];
  evidence: RuntimeEpochEvidence[];
  selected?: { tabId: number | null; clientId: string | null };
  state: TabPoolState;
  diagnostics: Record<string, unknown>;
};

const blocker = (
  code: TabOrchestrationBlocker['code'],
  message: string,
  severity: TabOrchestrationBlocker['severity'] = 'warning',
): TabOrchestrationBlocker => ({ code, message, severity });

const observeEvidence = (
  desiredEpochId: string,
  nowMs: number,
  evidence: RuntimeEpochEvidence[],
  clients: ObservedTabClient[],
): TabPoolState => {
  let state = initialTabPoolState({ desiredEpochId, nowMs });
  for (const [index, item] of evidence.entries()) {
    state = reduceTabLifecycle(state, {
      type: 'tabObserved',
      nowMs,
      evidence: item,
    }).state;
    const leaseClaimId = observedClaimId(clients[index]);
    if (leaseClaimId) {
      state = hydrateObservedLease(state, item, leaseClaimId);
    }
  }
  return state;
};

const observedClaimId = (client?: ObservedTabClient): string | null => {
  const claim = client?.tabClaim;
  if (!claim || typeof claim !== 'object') return null;
  const value = claim.claimId;
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
};

const evidenceMatchesTab = (
  item: RuntimeEpochEvidence,
  tab: TabPoolState['tabs'][number],
): boolean => {
  if (item.tabId !== null) return tab.tabId === item.tabId;
  if (item.clientId !== null) return tab.clientId === item.clientId;
  return false;
};

const hydrateObservedLease = (
  state: TabPoolState,
  item: RuntimeEpochEvidence,
  leaseClaimId: string,
): TabPoolState => ({
  ...state,
  tabs: state.tabs.map((tab) =>
    evidenceMatchesTab(item, tab) ? { ...tab, leaseClaimId } : tab,
  ),
});

const summarizeEvidence = (item: RuntimeEpochEvidence) => ({
  clientId: item.clientId,
  tabId: item.tabId,
  pageKind: item.pageKind,
  epochId: item.epochId,
  strength: item.strength,
  rejectReason: item.rejectReason ?? null,
});

const evidenceCounts = (evidence: RuntimeEpochEvidence[]) => {
  const byStrength = { rejected: 0, weak: 0, strong: 0 };
  const byPageKind: Record<string, number> = {};
  for (const item of evidence) {
    byStrength[item.strength] += 1;
    const pageKind = item.pageKind ?? 'unknown';
    byPageKind[pageKind] = (byPageKind[pageKind] ?? 0) + 1;
  }
  return {
    total: evidence.length,
    byStrength,
    byPageKind,
  };
};

const modeAllowsRuntimeRecovery = (mode: TabOrchestratorMode): boolean =>
  mode === 'activity_scan' || mode === 'interactive';

const recoveryForEvidence = (
  desiredEpochId: string,
  nowMs: number,
  item: RuntimeEpochEvidence,
): { status: string; effects: TabOrchestratorEffect[] } => {
  const start = initialRecoveryState({ desiredEpochId, nowMs });
  const begin = reduceRuntimeRecovery(start, {
    type: 'reloadRequested',
    nowMs,
    reason: item.rejectReason ?? 'runtime_epoch_not_ready',
  });
  const observed = reduceRuntimeRecovery(begin.state, {
    type: 'runtimeEvidenceObserved',
    nowMs,
    evidence: item,
  });
  return {
    status: observed.state.status,
    effects: [...begin.effects, ...observed.effects],
  };
};

export const planTabOrchestration = (
  request: TabOrchestrationRequest,
): TabOrchestrationResult => {
  const desiredEpochId = runtimeEpochId(request.expected);
  const evidence = request.clients.map((client) =>
    classifyRuntimeEvidence({
      client,
      expected: request.expected,
      nowMs: request.nowMs,
    }),
  );
  const state = observeEvidence(desiredEpochId, request.nowMs, evidence, request.clients);
  const allowCreate = request.mode === 'job_safe' ? false : request.allowCreate;
  const allocation = allocateTabForPurpose(state, {
    purpose: request.purpose,
    pageKind: request.desiredPageKind,
    requireStrongRuntime: true,
    allowCreate,
    createUrl: request.createUrl,
    claimId: request.claimId,
  });
  const diagnostics: Record<string, unknown> = {
    desiredEpochId,
    requestedPageKind: request.desiredPageKind,
    allocationStatus: allocation.status,
    mode: request.mode,
    purpose: request.purpose,
    evidenceCounts: evidenceCounts(evidence),
  };

  if (allocation.status === 'allocated') {
    return {
      ready: true,
      blocker: null,
      effects: allocation.effects,
      evidence,
      selected: { tabId: allocation.tabId, clientId: allocation.clientId },
      state: allocation.state,
      diagnostics,
    };
  }

  if (allocation.status === 'ambiguous') {
    return {
      ready: false,
      blocker: blocker(
        'ambiguous_tabs',
        'Mais de uma aba atende ao pedido; selecione ou reivindique uma aba explicitamente.',
      ),
      effects: allocation.effects,
      evidence,
      state: allocation.state,
      diagnostics,
    };
  }

  const matchingPageEvidence = evidence.filter((item) => item.pageKind === request.desiredPageKind);
  const weakMatchingEvidence = matchingPageEvidence.find(
    (item) => item.epochId === desiredEpochId && item.strength === 'weak',
  );
  if (weakMatchingEvidence) {
    return {
      ready: false,
      blocker: blocker(
        'command_channel_not_ready',
        'A aba respondeu no runtime esperado, mas ainda nao tem canal de comando forte.',
      ),
      effects: [],
      evidence,
      state: allocation.state,
      diagnostics,
    };
  }

  const rejectedEvidence = matchingPageEvidence.find((item) => item.strength === 'rejected');
  if (rejectedEvidence) {
    const recoveryAllowed = modeAllowsRuntimeRecovery(request.mode);
    const recovery = recoveryAllowed
      ? recoveryForEvidence(desiredEpochId, request.nowMs, rejectedEvidence)
      : {
          status: 'suppressed',
          effects: [
            {
              type: 'diagnostic.record' as const,
              reason: rejectedEvidence.rejectReason ?? 'runtime_epoch_not_ready',
              code: 'runtime_recovery_suppressed',
              severity: 'warning' as const,
            },
          ],
        };
    return {
      ready: false,
      blocker: blocker(
        'runtime_epoch_not_ready',
        'A aba observada pertence a outro runtime da extensao ou esta stale.',
        'error',
      ),
      effects: recovery.effects,
      evidence,
      state: allocation.state,
      diagnostics: {
        ...diagnostics,
        recoveryStatus: recovery.status,
        recoverySuppressed: !recoveryAllowed,
        rejectedEvidence: summarizeEvidence(rejectedEvidence),
      },
    };
  }

  return {
    ready: false,
    blocker: blocker(
      'no_ready_tab_for_purpose',
      'Nao ha aba pronta para esta operacao.',
    ),
    effects: allocation.effects,
    evidence,
    state: allocation.state,
    diagnostics,
  };
};
