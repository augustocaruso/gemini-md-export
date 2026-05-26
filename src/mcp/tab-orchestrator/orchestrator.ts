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
): TabPoolState => {
  let state = initialTabPoolState({ desiredEpochId, nowMs });
  for (const item of evidence) {
    state = reduceTabLifecycle(state, {
      type: 'tabObserved',
      nowMs,
      evidence: item,
    }).state;
  }
  return state;
};

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
  const state = observeEvidence(desiredEpochId, request.nowMs, evidence);
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
    allocationStatus: allocation.status,
    mode: request.mode,
    purpose: request.purpose,
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

  const rejectedEvidence =
    matchingPageEvidence.find((item) => item.strength === 'rejected') ||
    evidence.find((item) => item.strength === 'rejected');
  if (rejectedEvidence) {
    const recovery = recoveryForEvidence(desiredEpochId, request.nowMs, rejectedEvidence);
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
