export type TabOrchestratorMode = 'observe' | 'prepare' | 'command';

export type RuntimeEvidenceStrength = 'rejected' | 'weak' | 'strong';

export type ExpectedExtensionRuntime = Readonly<{
  extensionVersion?: string | null;
  buildStamp?: string | null;
  protocolVersion?: number | string | null;
}>;

export type ObservedTabClient = Readonly<{
  clientId?: string | null;
  extensionVersion?: string | null;
  buildStamp?: string | null;
  protocolVersion?: number | string | null;
  lastSeenAt?: number | string | null;
  eventStreamConnected?: boolean | null;
  commandPollPending?: boolean | null;
  pendingCommandPoll?: boolean | null;
  commandChannelStatus?: string | null;
  source?: string | null;
  page?: Readonly<Record<string, unknown>> | null;
}>;

export type RuntimeEvidenceRejectReason = 'runtime_epoch_mismatch' | 'client_stale';

export type RuntimeEpochEvidence = Readonly<{
  clientId: string | null;
  epochId: string;
  expectedEpochId: string;
  strength: RuntimeEvidenceStrength;
  hasCommandChannel: boolean;
  ageMs: number | null;
  rejectReason?: RuntimeEvidenceRejectReason;
}>;

export type DesiredRuntimeEvidence = Readonly<{
  requiredEpochId?: string | null;
  minStrength?: Exclude<RuntimeEvidenceStrength, 'rejected'>;
  requireCommandChannel?: boolean;
}>;

export type TabOrchestratorEffect =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'reload_extension'; reason: string }>
  | Readonly<{ type: 'reload_tab'; clientId: string | null; reason: string }>
  | Readonly<{ type: 'wait_for_runtime'; reason: string; timeoutMs?: number }>;

export type FsmTransition<TState = unknown> = Readonly<{
  state: TState;
  effects: readonly TabOrchestratorEffect[];
}>;
