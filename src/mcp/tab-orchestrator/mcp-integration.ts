import type {
  TabOrchestratorEffectAdapter,
  TabOrchestratorEffectExecutionReport,
} from './executor.js';
import { planTabOrchestration, type TabOrchestrationResult } from './orchestrator.js';
import {
  initialRecoveryState,
  type RuntimeRecoveryState,
  reduceRuntimeRecovery,
} from './recovery-fsm.js';
import { classifyRuntimeEvidence, runtimeEpochId } from './runtime-epoch-fsm.js';
import type {
  ExpectedExtensionRuntime,
  ObservedTabClient,
  TabOrchestratorEffect,
  TabOrchestratorMode,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

export type ClientToObservedTabClientDeps = Readonly<{
  normalizeTabId: (value: unknown) => number | null;
  clientBuildStamp: (client: unknown) => string | null | undefined;
  clientCommandEventStreamUsable: (client: unknown) => boolean;
  commandChannelReadyForClient: (client: unknown) => boolean;
}>;

export type BuildMcpTabOrchestratorPlanArgs = Readonly<{
  mode: TabOrchestratorMode;
  expected: ExpectedExtensionRuntime;
  desiredPageKind: string;
  purpose: string;
  claimId: string;
  clients: readonly unknown[];
  clientDeps: ClientToObservedTabClientDeps;
  allowCreate: boolean;
  createUrl?: string;
  nowMs?: number;
}>;

export type TabOrchestratorReloadRecovery = Readonly<{
  desiredEpochId: string;
  state: RuntimeRecoveryState;
  effects: TabOrchestratorEffect[];
  status: RuntimeRecoveryState['status'];
}>;

export type TabOrchestratorPlanSummary = Readonly<{
  ready: boolean;
  blocker: TabOrchestrationResult['blocker'];
  selected: TabOrchestrationResult['selected'] | null;
  effects: readonly TabOrchestratorEffect[];
  diagnostics: Record<string, unknown>;
  evidence: ReadonlyArray<
    Readonly<{
      clientId: string | null;
      tabId: number | null;
      pageKind: string | null;
      strength: string;
      hasCommandChannel: boolean;
      rejectReason: string | null;
      epochId: string;
      expectedEpochId: string;
    }>
  >;
  recovery?: TabOrchestratorReloadRecovery;
  effectExecution?: TabOrchestratorEffectExecutionReport;
}>;

export type TabOrchestratorBlockingIssueSummary = Readonly<{
  code: string;
  message: string;
  severity: string;
  source: 'tab-orchestrator';
}>;

export type MpcTabOrchestratorEffectAdapterDeps = Readonly<{
  getLiveClients: () => readonly unknown[];
  normalizeTabId: (value: unknown) => number | null;
  reloadChromeExtensionForClient: (
    client: unknown,
    args: Readonly<{ reason: string; explicit: boolean }>,
  ) => unknown | Promise<unknown>;
  tryNativeBrowserBrokerTabsAction: (
    action: string,
    args: Readonly<Record<string, unknown>>,
  ) => unknown | Promise<unknown>;
  launchChromeForGemini: (
    args: Readonly<{
      profileDirectory?: unknown;
      targetUrl?: string;
      explicit: boolean;
    }>,
  ) => unknown | Promise<unknown>;
  claimTabForClient: (
    client: unknown,
    args: Readonly<{
      claimId: string;
      reason: string;
      force: boolean;
    }>,
  ) => unknown | Promise<unknown>;
  waitForLiveClients: (timeoutMs: number, pollIntervalMs: number) => Promise<readonly unknown[]>;
  buildTabOrchestratorPlan: (
    args: Readonly<{
      mode: TabOrchestratorMode;
      desiredPageKind: string;
      purpose: string;
      claimId: string;
      clients: readonly unknown[];
      allowCreate: boolean;
    }>,
  ) => Pick<TabOrchestrationResult, 'evidence'>;
  profileDirectory?: unknown;
  pollIntervalMs: number;
  processSessionId?: string;
}>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const recordOrNull = (value: unknown): UnknownRecord | null => (isRecord(value) ? value : null);

export const clientToObservedTabClient = (
  client: unknown,
  deps: ClientToObservedTabClientDeps,
): ObservedTabClient => {
  const record = recordOrNull(client) ?? {};
  const page = recordOrNull(record.page);
  const commandPoll = recordOrNull(record.commandPoll);
  return {
    clientId: stringOrNull(record.clientId),
    tabId: deps.normalizeTabId(record.tabId),
    windowId: deps.normalizeTabId(record.windowId),
    url: stringOrNull(page?.url) ?? stringOrNull(record.url),
    source: stringOrNull(record.source) ?? stringOrNull(record.kind),
    page,
    extensionVersion: stringOrNull(record.extensionVersion),
    buildStamp: deps.clientBuildStamp(client) ?? null,
    protocolVersion:
      typeof record.protocolVersion === 'string' || typeof record.protocolVersion === 'number'
        ? record.protocolVersion
        : null,
    lastSeenAt:
      typeof record.lastSeenAt === 'string' || typeof record.lastSeenAt === 'number'
        ? record.lastSeenAt
        : null,
    eventStreamConnected: deps.clientCommandEventStreamUsable(client),
    commandPollPending: commandPoll?.polling === true,
    pendingCommandPoll: record.pendingPoll === true,
    commandChannelStatus: deps.commandChannelReadyForClient(client) ? 'ready' : null,
    tabClaim: recordOrNull(record.tabClaim),
  };
};

export const buildMcpTabOrchestratorPlan = ({
  mode,
  expected,
  desiredPageKind,
  purpose,
  claimId,
  clients,
  clientDeps,
  allowCreate,
  createUrl,
  nowMs = Date.now(),
}: BuildMcpTabOrchestratorPlanArgs): TabOrchestrationResult =>
  planTabOrchestration({
    mode,
    expected,
    nowMs,
    desiredPageKind,
    purpose,
    claimId,
    clients: clients.map((client) => clientToObservedTabClient(client, clientDeps)),
    allowCreate,
    createUrl,
  });

export const summarizeTabOrchestratorPlan = (
  plan: TabOrchestrationResult,
  extras: Readonly<{
    recovery?: TabOrchestratorReloadRecovery | null;
    effectExecution?: TabOrchestratorEffectExecutionReport | null;
  }> = {},
): TabOrchestratorPlanSummary => {
  const summary: {
    ready: boolean;
    blocker: TabOrchestrationResult['blocker'];
    selected: TabOrchestrationResult['selected'] | null;
    effects: readonly TabOrchestratorEffect[];
    diagnostics: Record<string, unknown>;
    evidence: TabOrchestratorPlanSummary['evidence'];
    recovery?: TabOrchestratorReloadRecovery;
    effectExecution?: TabOrchestratorEffectExecutionReport;
  } = {
    ready: plan.ready,
    blocker: plan.blocker ?? null,
    selected: plan.selected ?? null,
    effects: plan.effects,
    diagnostics: plan.diagnostics,
    evidence: plan.evidence.map((item) => ({
      clientId: item.clientId,
      tabId: item.tabId,
      pageKind: item.pageKind,
      strength: item.strength,
      hasCommandChannel: item.hasCommandChannel,
      rejectReason: item.rejectReason ?? null,
      epochId: item.epochId,
      expectedEpochId: item.expectedEpochId,
    })),
  };
  if (extras.recovery) summary.recovery = extras.recovery;
  if (extras.effectExecution) summary.effectExecution = extras.effectExecution;
  return summary;
};

export const tabOrchestratorBlockingIssueForReady = (
  plan: Pick<TabOrchestrationResult, 'blocker'>,
  _legacyBlockingIssue: unknown,
): TabOrchestratorBlockingIssueSummary | null => {
  const blocker = plan.blocker;
  if (!blocker || blocker.severity !== 'error') return null;
  return {
    code: blocker.code,
    message: blocker.message,
    severity: blocker.severity,
    source: 'tab-orchestrator',
  };
};

export const buildTabOrchestratorReloadRecovery = ({
  expected,
  clients = [],
  clientDeps,
  nowMs = Date.now(),
  message = 'Extension context invalidated after reload',
}: Readonly<{
  expected: ExpectedExtensionRuntime;
  clients?: readonly unknown[];
  clientDeps?: ClientToObservedTabClientDeps;
  nowMs?: number;
  message?: string;
}>): TabOrchestratorReloadRecovery => {
  const desiredEpochId = runtimeEpochId(expected);
  const start = initialRecoveryState({ desiredEpochId, nowMs });
  const transition = reduceRuntimeRecovery(start, {
    type: 'extensionContextInvalidated',
    nowMs,
    message,
  });
  let state = transition.state;
  const effects = [...transition.effects];
  if (clientDeps) {
    for (const client of clients) {
      const observed = clientToObservedTabClient(client, clientDeps);
      const evidence = classifyRuntimeEvidence({ client: observed, expected, nowMs });
      const observedTransition = reduceRuntimeRecovery(state, {
        type: 'runtimeEvidenceObserved',
        nowMs,
        evidence,
      });
      state = observedTransition.state;
      effects.push(...observedTransition.effects);
    }
  }
  return {
    desiredEpochId,
    state,
    effects,
    status: state.status,
  };
};

export const createMcpTabOrchestratorEffectAdapter = (
  deps: MpcTabOrchestratorEffectAdapterDeps,
): TabOrchestratorEffectAdapter => ({
  async reloadExtensionSelf(effect) {
    const client = effect.clientId
      ? deps.getLiveClients().find((item) => isRecord(item) && item.clientId === effect.clientId)
      : null;
    if (!client) return { skipped: true, reason: 'no_client_for_extension_reload' };
    return deps.reloadChromeExtensionForClient(client, {
      reason: effect.reason,
      explicit: true,
    });
  },
  async serviceWorkerSelfHeal(effect) {
    return deps.tryNativeBrowserBrokerTabsAction('selfHealContentScripts', {
      reason: effect.reason,
      target: effect.target,
      force: true,
    });
  },
  async openBrowser(effect) {
    return deps.launchChromeForGemini({
      profileDirectory: deps.profileDirectory,
      targetUrl: effect.url,
      explicit: true,
    });
  },
  async reloadTab(effect) {
    return deps.tryNativeBrowserBrokerTabsAction('reload', {
      tabId: effect.tabId,
      url: effect.url,
      reason: effect.reason,
    });
  },
  async claimTab(effect) {
    const client = deps
      .getLiveClients()
      .find((item) => isRecord(item) && deps.normalizeTabId(item.tabId) === effect.tabId);
    if (!client) return { skipped: true, reason: 'no_client_for_tab_claim' };
    return deps.claimTabForClient(client, {
      claimId: effect.claimId,
      reason: effect.reason,
      force: true,
    });
  },
  async waitForRuntimeEpoch(effect) {
    const clients = await deps.waitForLiveClients(effect.timeoutMs, deps.pollIntervalMs);
    const plan = deps.buildTabOrchestratorPlan({
      mode: 'diagnostic',
      desiredPageKind: 'chat',
      purpose: 'wait_runtime_epoch',
      claimId: `wait-${deps.processSessionId ?? 'tab-orchestrator'}`,
      clients,
      allowCreate: false,
    });
    const matchingStrongClientCount = plan.evidence.filter(
      (item) => item.epochId === effect.epochId && item.strength === 'strong',
    ).length;
    return {
      ready: matchingStrongClientCount > 0,
      epochId: effect.epochId,
      matchingStrongClientCount,
      connectedClientCount: clients.length,
    };
  },
  async recordDiagnostic(effect) {
    return {
      recorded: true,
      reason: effect.reason,
      code: effect.code,
      severity: effect.severity,
    };
  },
});
