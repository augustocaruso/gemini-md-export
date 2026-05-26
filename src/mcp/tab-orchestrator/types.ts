export type TabOrchestratorMode = 'diagnostic' | 'interactive' | 'job_safe' | 'activity_scan';

export type RuntimeEvidenceStrength = 'rejected' | 'weak' | 'strong';

export type ExpectedExtensionRuntime = Readonly<{
  extensionVersion?: string | null;
  buildStamp?: string | null;
  protocolVersion?: number | string | null;
}>;

export type ObservedTabClient = Readonly<{
  clientId: string | null;
  tabId: number | string | null;
  windowId: number | string | null;
  url: string | null;
  source: string | null;
  page: Readonly<Record<string, unknown>> | null;
  extensionVersion: string | null;
  buildStamp: string | null;
  protocolVersion: number | string | null;
  lastSeenAt: number | string | null;
  eventStreamConnected: boolean | null;
  commandPollPending: boolean | null;
  pendingCommandPoll: boolean | null;
  commandChannelStatus: string | null;
  tabClaim: Readonly<Record<string, unknown>> | null;
}>;

export type RuntimeEvidenceRejectReason = 'runtime_epoch_mismatch' | 'client_stale';

export type RuntimeEpochEvidence = Readonly<{
  clientId: string | null;
  tabId: number | null;
  pageKind: string | null;
  epochId: string;
  expectedEpochId: string;
  strength: RuntimeEvidenceStrength;
  hasCommandChannel: boolean;
  observedAtMs: number;
  ageMs: number | null;
  rejectReason?: RuntimeEvidenceRejectReason;
  details: Readonly<{
    extensionVersion?: string | null;
    buildStamp?: string | null;
    protocolVersion?: number | string | null;
    lastSeenAt?: number | string | null;
    source?: string | null;
  }>;
}>;

export type DesiredRuntimeEvidence = Readonly<{
  requiredEpochId: string;
  minStrength: Exclude<RuntimeEvidenceStrength, 'rejected'>;
  requireCommandChannel: boolean;
}>;

export type TabOrchestratorEffect =
  | Readonly<{ type: 'extension.reloadSelf'; reason: string; clientId?: string | null }>
  | Readonly<{ type: 'serviceWorker.selfHeal'; reason: string; target?: string }>
  | Readonly<{ type: 'browser.open'; reason: string; url: string; pageKind?: string }>
  | Readonly<{ type: 'tab.reload'; reason: string; tabId?: number | null; url?: string | null }>
  | Readonly<{ type: 'tab.claim'; reason: string; tabId?: number | null; claimId: string }>
  | Readonly<{ type: 'runtime.waitForEpoch'; reason: string; epochId: string; timeoutMs: number }>
  | Readonly<{
      type: 'diagnostic.record';
      reason: string;
      code: string;
      severity: 'info' | 'warning' | 'error';
    }>;

export type FsmTransition<
  State = unknown,
  Event = unknown,
  Effect = TabOrchestratorEffect,
> = Readonly<{
  state: State;
  effects: Effect[];
}>;
