import type { FsmTransition, RuntimeEpochEvidence, TabOrchestratorEffect } from './types.js';
import { runtimeEvidenceSatisfiesDesired } from './runtime-epoch-fsm.js';

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
  lastReason?: string;
};

export type RuntimeRecoveryEvent =
  | { type: 'reloadRequested'; nowMs: number; reason: string }
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
});

const waitForEpochEffect = (state: RuntimeRecoveryState, reason: string): TabOrchestratorEffect => ({
  type: 'runtime.waitForEpoch',
  reason,
  epochId: state.desiredEpochId,
  timeoutMs: RUNTIME_EPOCH_TIMEOUT_MS,
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

const runtimeEvidenceIsReady = (state: RuntimeRecoveryState, evidence: RuntimeEpochEvidence): boolean =>
  runtimeEvidenceSatisfiesDesired(evidence, {
    requiredEpochId: state.desiredEpochId,
    minStrength: 'strong',
    requireCommandChannel: true,
  });

export const reduceRuntimeRecovery = (
  state: RuntimeRecoveryState,
  event: RuntimeRecoveryEvent,
): RuntimeRecoveryTransition => {
  if (event.type === 'reloadRequested') {
    const nextState: RuntimeRecoveryState = {
      ...state,
      status: 'reload_requested',
      updatedAtMs: event.nowMs,
      attempts: state.attempts + 1,
      lastReason: event.reason,
    };
    return {
      state: nextState,
      effects: [
        { type: 'extension.reloadSelf', reason: event.reason },
        waitForEpochEffect(nextState, event.reason),
      ],
    };
  }

  if (event.type === 'extensionContextInvalidated') {
    const reason = 'extension_context_invalidated';
    const nextState: RuntimeRecoveryState = {
      ...state,
      status: 'awaiting_runtime_epoch',
      updatedAtMs: event.nowMs,
      lastReason: reason,
    };
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

    if (state.attempts >= MAX_RECOVERY_ATTEMPTS || state.rejectedEvidenceCount >= MAX_REJECTED_EVIDENCE) {
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

    const nextState: RuntimeRecoveryState = {
      ...state,
      status: 'awaiting_runtime_epoch',
      updatedAtMs: event.nowMs,
      attempts: state.attempts + 1,
      lastReason: reason,
    };
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
