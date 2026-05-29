import { runtimeEvidenceSatisfiesDesired } from './runtime-epoch-fsm.js';
import type { FsmTransition, RuntimeEpochEvidence, TabOrchestratorEffect } from './types.js';

const RUNTIME_EPOCH_TIMEOUT_MS = 8_000;
const MAX_RECOVERY_ATTEMPTS = 2;
const MAX_REJECTED_EVIDENCE = 3;
const EXTENSION_RUNTIME_TARGET = 'extension-runtime';

export type RuntimeRecoveryStatus =
  | 'idle'
  | 'reload_requested'
  | 'awaiting_runtime_epoch'
  | 'ready'
  | 'quarantined'
  | 'failed';

export type RuntimeRecoveryState = {
  status: RuntimeRecoveryStatus;
  desiredEpochId: string;
  startedAtMs: number;
  updatedAtMs: number;
  attempts: number;
  rejectedEvidenceCount: number;
  backoffMs: number;
  deadlineAtMs?: number;
  lastReason?: string;
};

export type RuntimeRecoveryEvent =
  | { type: 'reloadRequested'; nowMs: number; reason: string; clientId?: string | null }
  | { type: 'extensionContextInvalidated'; nowMs: number; message: string }
  | { type: 'runtimeEvidenceObserved'; nowMs: number; evidence: RuntimeEpochEvidence }
  | { type: 'timeout'; nowMs: number }
  | { type: 'manualAbort'; nowMs: number; reason: string };

export type RuntimeRecoveryInitialArgs = Readonly<{
  desiredEpochId: string;
  nowMs: number;
}>;

export type RuntimeRecoveryTransition = FsmTransition<
  RuntimeRecoveryState,
  RuntimeRecoveryEvent,
  TabOrchestratorEffect
>;

export const initialRecoveryState = ({
  desiredEpochId,
  nowMs,
}: RuntimeRecoveryInitialArgs): RuntimeRecoveryState => ({
  status: 'idle',
  desiredEpochId,
  startedAtMs: nowMs,
  updatedAtMs: nowMs,
  attempts: 0,
  rejectedEvidenceCount: 0,
  backoffMs: RUNTIME_EPOCH_TIMEOUT_MS,
});

const waitForEpochEffect = (
  state: RuntimeRecoveryState,
  reason: string,
): TabOrchestratorEffect => ({
  type: 'runtime.waitForEpoch',
  reason,
  epochId: state.desiredEpochId,
  timeoutMs: state.backoffMs,
});

const selfHealEffect = (reason: string): TabOrchestratorEffect => ({
  type: 'serviceWorker.selfHeal',
  reason,
  target: EXTENSION_RUNTIME_TARGET,
});

const diagnosticEffect = (
  reason: string,
  code: string,
  severity: 'info' | 'warning' | 'error',
): TabOrchestratorEffect => ({
  type: 'diagnostic.record',
  reason,
  code,
  severity,
});

const runtimeEvidenceIsReady = (
  state: RuntimeRecoveryState,
  evidence: RuntimeEpochEvidence,
): boolean =>
  runtimeEvidenceSatisfiesDesired(evidence, {
    requiredEpochId: state.desiredEpochId,
    minStrength: 'strong',
    requireCommandChannel: true,
  });

const terminalStatuses: ReadonlySet<RuntimeRecoveryStatus> = new Set([
  'ready',
  'quarantined',
  'failed',
]);

const isTerminalState = (state: RuntimeRecoveryState): boolean =>
  terminalStatuses.has(state.status);

const withWaitDeadline = (state: RuntimeRecoveryState, nowMs: number): RuntimeRecoveryState => ({
  ...state,
  deadlineAtMs: nowMs + state.backoffMs,
});

export const reduceRuntimeRecovery = (
  state: RuntimeRecoveryState,
  event: RuntimeRecoveryEvent,
): RuntimeRecoveryTransition => {
  if (isTerminalState(state)) {
    return { state, effects: [] };
  }

  if (event.type === 'reloadRequested') {
    const nextState = withWaitDeadline(
      {
        ...state,
        status: 'reload_requested',
        updatedAtMs: event.nowMs,
        attempts: state.attempts + 1,
        lastReason: event.reason,
      },
      event.nowMs,
    );
    const reloadEffect: TabOrchestratorEffect = event.clientId
      ? { type: 'extension.reloadSelf', reason: event.reason, clientId: event.clientId }
      : { type: 'extension.reloadSelf', reason: event.reason };
    return {
      state: nextState,
      effects: [reloadEffect, waitForEpochEffect(nextState, event.reason)],
    };
  }

  if (event.type === 'extensionContextInvalidated') {
    const reason = 'extension_context_invalidated';
    const nextState = withWaitDeadline(
      {
        ...state,
        status: 'awaiting_runtime_epoch',
        updatedAtMs: event.nowMs,
        lastReason: reason,
      },
      event.nowMs,
    );
    return {
      state: nextState,
      effects: [waitForEpochEffect(nextState, reason), selfHealEffect(reason)],
    };
  }

  if (event.type === 'runtimeEvidenceObserved') {
    if (runtimeEvidenceIsReady(state, event.evidence)) {
      return {
        state: {
          ...state,
          status: 'ready',
          updatedAtMs: event.nowMs,
        },
        effects: [],
      };
    }

    if (state.status === 'idle') {
      return { state, effects: [] };
    }

    const reason = event.evidence.rejectReason ?? 'insufficient_runtime_evidence';
    const nextState: RuntimeRecoveryState = {
      ...state,
      status: 'awaiting_runtime_epoch',
      updatedAtMs: event.nowMs,
      rejectedEvidenceCount: state.rejectedEvidenceCount + 1,
      lastReason: reason,
    };
    return {
      state: nextState,
      effects: [diagnosticEffect(reason, 'stale_runtime_ignored', 'warning')],
    };
  }

  if (event.type === 'timeout') {
    const reason = 'runtime_epoch_timeout';

    if (
      state.status === 'idle' ||
      state.deadlineAtMs === undefined ||
      event.nowMs < state.deadlineAtMs
    ) {
      return { state, effects: [] };
    }

    if (
      state.attempts >= MAX_RECOVERY_ATTEMPTS ||
      state.rejectedEvidenceCount >= MAX_REJECTED_EVIDENCE
    ) {
      return {
        state: {
          ...state,
          status: 'quarantined',
          updatedAtMs: event.nowMs,
          lastReason: reason,
        },
        effects: [diagnosticEffect(reason, 'runtime_epoch_timeout', 'error')],
      };
    }

    const nextState = withWaitDeadline(
      {
        ...state,
        status: 'awaiting_runtime_epoch',
        updatedAtMs: event.nowMs,
        attempts: state.attempts + 1,
        lastReason: reason,
      },
      event.nowMs,
    );
    return {
      state: nextState,
      effects: [selfHealEffect(reason), waitForEpochEffect(nextState, reason)],
    };
  }

  return {
    state: {
      ...state,
      status: 'failed',
      updatedAtMs: event.nowMs,
      lastReason: event.reason,
    },
    effects: [diagnosticEffect(event.reason, 'runtime_recovery_aborted', 'error')],
  };
};
