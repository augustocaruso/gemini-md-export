export type ExistingTabsExtensionReloadResult = Readonly<{
  ok: boolean;
  reloadAttempts?: number;
  client?: unknown;
  info?: unknown;
  timings?: unknown;
  error?: string;
  code?: string | null;
  data?: unknown;
}>;

type ExistingTabsNativeReloadResult = Readonly<Record<string, unknown>> | null | undefined;
type ExistingTabsReloadClientPredicate = (client: unknown) => boolean;

export type ExistingTabsRuntimeRefreshFsmInput = Readonly<{
  allowReload?: boolean;
  expected?: Readonly<{
    extensionVersion?: unknown;
    protocolVersion?: unknown;
    buildStamp?: unknown;
  }> | null;
  extensionStatus?: Readonly<Record<string, unknown>> | null;
}>;

export type ExistingTabsRuntimeRefreshFsmDecision = Readonly<{
  state: 'ready' | 'reload_extension_self' | 'blocked';
  reason: string;
  force?: true;
}>;

export type ExistingTabsPostReloadRecoveryFsmInput = Readonly<{
  allowReload?: boolean;
  connectedClientCount?: number;
  nativeReload?: ExistingTabsNativeReloadResult;
}>;

export type ExistingTabsPostReloadRecoveryFsmDecision = Readonly<{
  state: 'ready' | 'self_heal_content_scripts' | 'wait_for_clients' | 'blocked';
  reason: string;
  force?: true;
  tabIds?: readonly number[];
  waitForClients?: boolean;
}>;

export type BrowserReadyInactiveTabActivationCandidate = Readonly<{
  clientId?: unknown;
  tabId?: unknown;
  isActiveTab?: unknown;
  commandReady?: unknown;
  lastHeartbeatAt?: unknown;
  lastSnapshotAt?: unknown;
  lastSeenAt?: unknown;
  page?: Readonly<Record<string, unknown>> | null;
}>;

export type BrowserReadyInactiveTabActivationFsmInput = Readonly<{
  allowActivation?: boolean;
  ready?: boolean;
  claimableClientCount?: number;
  selectableClients?: readonly BrowserReadyInactiveTabActivationCandidate[];
}>;

export type BrowserReadyInactiveTabActivationFsmDecision = Readonly<{
  state: 'ready' | 'activate_existing_tab' | 'blocked';
  reason: string;
  tabId?: number;
  clientId?: string;
}>;

const RECOVERABLE_NATIVE_RELOAD_CODES = new Set([
  'extension_context_invalidated',
  'extension_request_timeout',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const numberOrStringValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
};

const extensionStatusValue = (
  status: Readonly<Record<string, unknown>> | null | undefined,
  key: 'extensionVersion' | 'protocolVersion' | 'buildStamp',
): string | null => {
  if (!isRecord(status)) return null;
  if (key === 'extensionVersion') {
    return numberOrStringValue(status.extensionVersion) || numberOrStringValue(status.version);
  }
  return numberOrStringValue(status[key]);
};

const expectedValue = (
  expected: ExistingTabsRuntimeRefreshFsmInput['expected'],
  key: 'extensionVersion' | 'protocolVersion' | 'buildStamp',
): string | null => (isRecord(expected) ? numberOrStringValue(expected[key]) : null);

export const evaluateExistingTabsRuntimeRefreshFsm = ({
  allowReload = false,
  expected = null,
  extensionStatus = null,
}: ExistingTabsRuntimeRefreshFsmInput = {}): ExistingTabsRuntimeRefreshFsmDecision => {
  if (!isRecord(extensionStatus) || extensionStatus.ok === false) {
    return { state: 'blocked', reason: 'extension_status_unavailable' };
  }

  const checks: ReadonlyArray<['extensionVersion' | 'protocolVersion' | 'buildStamp', string]> = [
    ['extensionVersion', 'extension_version_mismatch'],
    ['protocolVersion', 'extension_protocol_mismatch'],
    ['buildStamp', 'extension_build_mismatch'],
  ];
  for (const [key, reason] of checks) {
    const wanted = expectedValue(expected, key);
    const actual = extensionStatusValue(extensionStatus, key);
    if (wanted && actual && wanted !== actual) {
      return allowReload === true
        ? { state: 'reload_extension_self', reason, force: true }
        : { state: 'blocked', reason };
    }
  }

  return { state: 'ready', reason: 'extension_runtime_current' };
};

const nativeReloadCode = (result: ExistingTabsNativeReloadResult): string | null => {
  if (!isRecord(result)) return null;
  return (
    stringValue(result.code) ||
    (isRecord(result.error) ? stringValue(result.error.code) : null) ||
    (isRecord(result.result) ? stringValue(result.result.code) : null)
  );
};

const nativeReloadTabIds = (result: ExistingTabsNativeReloadResult): readonly number[] => {
  if (!isRecord(result) || !Array.isArray(result.reloadedTabIds)) return [];
  return result.reloadedTabIds
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
};

const positiveIntegerValue = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const candidatePage = (
  candidate: BrowserReadyInactiveTabActivationCandidate,
): Readonly<Record<string, unknown>> => (isRecord(candidate.page) ? candidate.page : {});

const candidateIsActive = (candidate: BrowserReadyInactiveTabActivationCandidate): boolean =>
  candidate.isActiveTab === true || candidatePage(candidate).isActiveTab === true;

const candidateClientId = (
  candidate: BrowserReadyInactiveTabActivationCandidate,
): string | undefined => stringValue(candidate.clientId) || undefined;

const candidateUrl = (candidate: BrowserReadyInactiveTabActivationCandidate): string | null =>
  stringValue(candidatePage(candidate).url);

const candidateKind = (candidate: BrowserReadyInactiveTabActivationCandidate): string | null =>
  stringValue(candidatePage(candidate).kind);

const candidateLooksLikeGeminiApp = (
  candidate: BrowserReadyInactiveTabActivationCandidate,
): boolean => {
  const kind = candidateKind(candidate);
  if (kind === 'activity') return false;
  const url = candidateUrl(candidate);
  if (!url) return kind === 'chat' || kind === 'gemini';
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://gemini.google.com';
  } catch {
    return false;
  }
};

const candidateHasBlockingPage = (
  candidate: BrowserReadyInactiveTabActivationCandidate,
): boolean => {
  const blocker = candidatePage(candidate).blocker;
  if (!isRecord(blocker)) return false;
  const code = stringValue(blocker.code);
  const kind = stringValue(blocker.kind);
  return (
    blocker.terminal === true ||
    code === 'google_verification_required' ||
    code === 'google_login_required' ||
    code === 'google_page_blocked' ||
    kind === 'google_sorry' ||
    kind === 'google_login' ||
    kind === 'google_verification_text'
  );
};

const candidateContextScore = (candidate: BrowserReadyInactiveTabActivationCandidate): number => {
  const page = candidatePage(candidate);
  let score = 0;
  if (candidate.commandReady === true) score += 100;
  if (stringValue(page.chatId)) score += 30;
  if (stringValue(page.notebookId)) score += 20;
  if (Number(page.turnCount || 0) > 0) score += 12;
  if (Number(page.listedConversationCount || 0) > 0) score += 10;
  if (Number(page.bridgeConversationCount || 0) > 0) score += 10;
  if (Number(page.sidebarConversationCount || 0) > 0) score += 10;
  if (page.sidebarOpen === true) score += 4;
  return score;
};

const candidateLastSignal = (candidate: BrowserReadyInactiveTabActivationCandidate): number =>
  Math.max(
    Number(candidate.lastHeartbeatAt || 0),
    Number(candidate.lastSnapshotAt || 0),
    Number(candidate.lastSeenAt || 0),
  );

export const evaluateBrowserReadyInactiveTabActivationFsm = ({
  allowActivation = false,
  ready = false,
  claimableClientCount = 0,
  selectableClients = [],
}: BrowserReadyInactiveTabActivationFsmInput = {}): BrowserReadyInactiveTabActivationFsmDecision => {
  if (ready === true || Number(claimableClientCount || 0) > 0) {
    return { state: 'ready', reason: 'active_claimable_tab_available' };
  }

  if (allowActivation !== true) {
    return { state: 'blocked', reason: 'activation_not_allowed' };
  }

  const candidates = selectableClients
    .map((candidate) => ({ candidate, tabId: positiveIntegerValue(candidate.tabId) }))
    .filter(
      (item): item is { candidate: BrowserReadyInactiveTabActivationCandidate; tabId: number } =>
        item.tabId !== null &&
        !candidateIsActive(item.candidate) &&
        candidateLooksLikeGeminiApp(item.candidate) &&
        !candidateHasBlockingPage(item.candidate),
    )
    .sort(
      (left, right) =>
        candidateContextScore(right.candidate) - candidateContextScore(left.candidate) ||
        candidateLastSignal(right.candidate) - candidateLastSignal(left.candidate) ||
        right.tabId - left.tabId,
    );

  const selected = candidates[0];
  if (!selected) {
    return { state: 'blocked', reason: 'no_inactive_ready_gemini_tab' };
  }

  return {
    state: 'activate_existing_tab',
    reason: 'inactive_ready_gemini_tab',
    tabId: selected.tabId,
    clientId: candidateClientId(selected.candidate),
  };
};

export const maybeActivateBrowserReadyInactiveTab = async (
  input: BrowserReadyInactiveTabActivationFsmInput & {
    args?: Record<string, unknown>;
  } = {},
  deps: {
    activateBrowserTabById(
      tabId: number,
      args?: Record<string, unknown>,
      candidate?: unknown,
    ): Promise<Record<string, any> | null>;
    summarizeClient(client: unknown): unknown;
  },
) => {
  const args = input.args || {};
  const decision = evaluateBrowserReadyInactiveTabActivationFsm({
    ...input,
    allowActivation:
      input.allowActivation ??
      (args.wakeBrowser === true ||
        args.activateTab === true ||
        args.activateTabBeforeClaim === true),
  });
  if (decision.state !== 'activate_existing_tab' || !decision.tabId) {
    return { attempted: false, decision };
  }

  const activationCandidate =
    (input.selectableClients || []).find(
      (client) => positiveIntegerValue(client.tabId) === decision.tabId,
    ) || null;
  try {
    const activation = await deps.activateBrowserTabById(
      decision.tabId,
      {
        ...args,
        activateTabReason: args.activateTabReason || 'browser-ready-activate-existing-tab',
      },
      activationCandidate,
    );
    const activatedClient = activation?.client || activationCandidate;
    return {
      attempted: true,
      ok: true,
      shouldRefreshClientSets: true,
      decision,
      result: activation?.result || null,
      broker: activation?.broker ? deps.summarizeClient(activation.broker) : null,
      client: activatedClient ? deps.summarizeClient(activatedClient) : null,
    };
  } catch (err) {
    const error = err as Error & { code?: string | null; data?: unknown };
    return {
      attempted: true,
      ok: false,
      shouldRefreshClientSets: false,
      decision,
      error: error.message,
      code: error.code || null,
      data: error.data || null,
    };
  }
};

const attachedContentScriptSelfHealFailed = (result: ExistingTabsNativeReloadResult): boolean =>
  isRecord(result) &&
  isRecord(result.contentScriptSelfHeal) &&
  result.contentScriptSelfHeal.ok === false;

const attachedContentScriptSelfHealCompleted = (result: ExistingTabsNativeReloadResult): boolean =>
  isRecord(result) &&
  isRecord(result.contentScriptSelfHeal) &&
  result.contentScriptSelfHeal.ok === true;

const reloadReadyClients = (
  clients: readonly unknown[],
  predicate?: ExistingTabsReloadClientPredicate,
): unknown[] => {
  const items = [...clients];
  return predicate ? items.filter(predicate) : items;
};

export const evaluateExistingTabsPostReloadRecoveryFsm = ({
  allowReload = false,
  connectedClientCount = 0,
  nativeReload = null,
}: ExistingTabsPostReloadRecoveryFsmInput = {}): ExistingTabsPostReloadRecoveryFsmDecision => {
  if (attachedContentScriptSelfHealFailed(nativeReload)) {
    if (allowReload !== true) {
      return connectedClientCount > 0
        ? { state: 'ready', reason: 'content_client_connected' }
        : { state: 'blocked', reason: 'reload_not_allowed' };
    }
    return {
      state: 'self_heal_content_scripts',
      reason: 'native_reload_post_self_heal_failed',
      force: true,
      waitForClients: true,
    };
  }

  if (connectedClientCount > 0) {
    return { state: 'ready', reason: 'content_client_connected' };
  }

  if (allowReload !== true) {
    return { state: 'blocked', reason: 'reload_not_allowed' };
  }

  if (!isRecord(nativeReload)) {
    return { state: 'blocked', reason: 'native_reload_result_missing' };
  }

  const code = nativeReloadCode(nativeReload);
  if (attachedContentScriptSelfHealCompleted(nativeReload)) {
    return { state: 'blocked', reason: 'native_reload_post_self_heal_completed_without_client' };
  }
  if (nativeReload.ok === true && nativeReload.reloadMode === 'managed-tabs') {
    return {
      state: 'wait_for_clients',
      reason: 'managed_tabs_reloaded_wait_for_clients',
      waitForClients: true,
    };
  }

  const shouldSelfHeal =
    nativeReload.ok === true || (code !== null && RECOVERABLE_NATIVE_RELOAD_CODES.has(code));

  if (!shouldSelfHeal) {
    return {
      state: 'blocked',
      reason: code ? `native_reload_${code}` : 'native_reload_not_recoverable',
    };
  }

  const tabIds = nativeReloadTabIds(nativeReload);
  return {
    state: 'self_heal_content_scripts',
    reason: code ? `native_reload_${code}` : 'native_reload_completed_no_content_clients',
    force: true,
    tabIds: tabIds.length > 0 ? tabIds : undefined,
    waitForClients: true,
  };
};

export const reloadSideEffectExplicitlyAllowed = (args: Record<string, unknown> = {}): boolean =>
  args.allowReload === true ||
  args.explicit === true ||
  args.intent === 'tab_management' ||
  args.diagnostic === true;

export const refreshExistingTabsExtensionRuntimeBeforeReload = async (
  args: Record<string, unknown> = {},
  deps: {
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
    expected: ExistingTabsRuntimeRefreshFsmInput['expected'];
    sleep(ms: number): Promise<unknown>;
    pollIntervalMs: number;
  },
) => {
  const extensionStatus = await deps.tryNativeBrowserBrokerTabsAction('extensionStatus', args);
  const decision = evaluateExistingTabsRuntimeRefreshFsm({
    allowReload: reloadSideEffectExplicitlyAllowed(args),
    expected: deps.expected,
    extensionStatus,
  });
  if (decision.state !== 'reload_extension_self') {
    return {
      decision,
      attempted: false,
      ok: decision.state === 'ready',
      extensionStatus,
    };
  }

  const reloadSelf = await deps.tryNativeBrowserBrokerTabsAction('reloadExtensionSelf', {
    ...args,
    reason: decision.reason,
    force: true,
  });
  await deps.sleep(deps.pollIntervalMs);
  return {
    decision,
    attempted: true,
    ok: reloadSelf?.ok !== false,
    extensionStatus,
    reloadSelf,
  };
};

export const recoverExistingTabsContentScriptsAfterNativeReload = async (
  nativeReload: ExistingTabsNativeReloadResult,
  args: Record<string, unknown> = {},
  deps: {
    getLiveClients(): unknown[];
    waitForLiveClients(
      timeoutMs: number,
      pollIntervalMs?: number,
      predicate?: ExistingTabsReloadClientPredicate,
    ): Promise<unknown[]>;
    normalizeReloadWaitMs(value: unknown, fallback: number): number;
    summarizeClient(client: unknown): unknown;
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
    defaultWaitMs: number;
    pollIntervalMs: number;
    clientReadyAfterReload?: ExistingTabsReloadClientPredicate;
  },
) => {
  const readyClients = () => reloadReadyClients(deps.getLiveClients(), deps.clientReadyAfterReload);
  const connectedClientCount = readyClients().length;
  const decision = evaluateExistingTabsPostReloadRecoveryFsm({
    allowReload: reloadSideEffectExplicitlyAllowed(args),
    connectedClientCount,
    nativeReload,
  });
  const recovery = {
    decision,
    attempted: false,
    ok: decision.state === 'ready',
    connectedClientCount,
    totalConnectedClientCount: deps.getLiveClients().length,
  };
  if (decision.state === 'wait_for_clients') {
    const waitMs = deps.normalizeReloadWaitMs(args.reloadWaitMs ?? args.waitMs, deps.defaultWaitMs);
    const waitStartedAt = Date.now();
    const liveClients = decision.waitForClients
      ? await deps.waitForLiveClients(waitMs, deps.pollIntervalMs, deps.clientReadyAfterReload)
      : readyClients();
    return {
      decision,
      attempted: true,
      ok: liveClients.length > 0,
      waitMs,
      waitedMs: Math.max(0, Date.now() - waitStartedAt),
      connectedClientCount: liveClients.length,
      totalConnectedClientCount: deps.getLiveClients().length,
      clients: liveClients.map(deps.summarizeClient),
    };
  }
  if (decision.state !== 'self_heal_content_scripts') return recovery;

  const selfHealArgs: Record<string, unknown> = {
    ...args,
    reason: decision.reason,
    force: true,
  };
  if (Array.isArray(decision.tabIds) && decision.tabIds.length > 0) {
    selfHealArgs.tabIds = [...decision.tabIds];
  }

  const waitMs = deps.normalizeReloadWaitMs(args.reloadWaitMs ?? args.waitMs, deps.defaultWaitMs);
  const waitStartedAt = Date.now();
  const selfHeal = await deps.tryNativeBrowserBrokerTabsAction(
    'selfHealContentScripts',
    selfHealArgs,
  );
  const liveClients = decision.waitForClients
    ? await deps.waitForLiveClients(waitMs, deps.pollIntervalMs, deps.clientReadyAfterReload)
    : readyClients();
  return {
    decision,
    attempted: true,
    ok: liveClients.length > 0,
    waitMs,
    waitedMs: Math.max(0, Date.now() - waitStartedAt),
    connectedClientCount: liveClients.length,
    totalConnectedClientCount: deps.getLiveClients().length,
    clients: liveClients.map(deps.summarizeClient),
    selfHeal,
  };
};

export const runExistingTabsNativeReloadRecovery = async (
  args: Record<string, unknown> = {},
  deps: {
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
    attachContentScriptSelfHealToNativeReload(
      nativeReload: ExistingTabsNativeReloadResult,
      args: Record<string, unknown>,
      action: (
        action: string,
        args?: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null>,
    ): Promise<unknown>;
    expected: ExistingTabsRuntimeRefreshFsmInput['expected'];
    sleep(ms: number): Promise<unknown>;
    getLiveClients(): unknown[];
    waitForLiveClients(
      timeoutMs: number,
      pollIntervalMs?: number,
      predicate?: ExistingTabsReloadClientPredicate,
    ): Promise<unknown[]>;
    normalizeReloadWaitMs(value: unknown, fallback: number): number;
    summarizeClient(client: unknown): unknown;
    defaultWaitMs: number;
    pollIntervalMs: number;
    clientReadyAfterReload?: ExistingTabsReloadClientPredicate;
  },
) => {
  const nativeExtensionRuntimeRefresh = await refreshExistingTabsExtensionRuntimeBeforeReload(
    args,
    deps,
  );
  const managedReload = await deps.tryNativeBrowserBrokerTabsAction('reloadManagedTabs', args);
  const nativeReload =
    managedReload?.ok === true
      ? managedReload
      : await deps.tryNativeBrowserBrokerTabsAction('reload', args);
  if (nativeReload?.reloadMode !== 'managed-tabs') {
    await deps.attachContentScriptSelfHealToNativeReload(
      nativeReload,
      args,
      deps.tryNativeBrowserBrokerTabsAction,
    );
  }
  const postNativeReloadRecovery = nativeReload
    ? await recoverExistingTabsContentScriptsAfterNativeReload(nativeReload, args, deps)
    : null;
  return { nativeExtensionRuntimeRefresh, nativeReload, postNativeReloadRecovery };
};

type EnsureBrowserExtensionReady = (
  args: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<{
  reloadAttempts?: number | null;
  client?: unknown;
  info?: unknown;
  timings?: unknown;
}>;

export const reloadExtensionForExistingTabs = async (
  args: Record<string, unknown> = {},
  ensureBrowserExtensionReady: EnsureBrowserExtensionReady,
  summarizeClient: (client: unknown) => unknown,
  reloadTimeoutMs: number,
  normalizeReloadWaitMs: (value: unknown, fallback: number) => number,
  cleanupStaleClients?: () => void,
): Promise<ExistingTabsExtensionReloadResult | null> => {
  if (args.allowReload !== true) return null;
  try {
    const ready = await ensureBrowserExtensionReady(args, {
      allowLaunchChrome: false,
      allowReload: args.allowReload === true,
      config: {
        initialConnectTimeoutMs: 0,
        reloadTimeoutMs: normalizeReloadWaitMs(args.reloadWaitMs, reloadTimeoutMs),
      },
    });
    return {
      ok: true,
      reloadAttempts: Number(ready.reloadAttempts || 0),
      client: summarizeClient(ready.client),
      info: ready.info || null,
      timings: ready.timings || null,
    };
  } catch (err) {
    const error = err as Error & { code?: string | null; data?: unknown };
    return {
      ok: false,
      error: error.message,
      code: error.code || null,
      data: error.data || null,
    };
  } finally {
    cleanupStaleClients?.();
  }
};

export type ActivityClaimAffinityInput = Readonly<{
  baseSessionId: string;
  activityClientId: string;
  existingGeminiSessionClaim?: {
    claimId?: string | null;
    clientId?: string | null;
    tabId?: number | null;
  } | null;
  requestedVisualGroupTabId?: number | null;
}>;

export const buildActivityClaimAffinity = (
  baseSessionId: string,
  activityClientId: string,
  existingGeminiSessionClaim: ActivityClaimAffinityInput['existingGeminiSessionClaim'] = null,
  requestedVisualGroupTabId: number | null = null,
): {
  sessionId: string;
  visualGroupTabId: number | null;
  joinsExistingGeminiClaim: boolean;
} => {
  const joinsExistingGeminiClaim =
    !!existingGeminiSessionClaim?.clientId &&
    existingGeminiSessionClaim.clientId !== activityClientId;
  return {
    sessionId:
      existingGeminiSessionClaim?.claimId && joinsExistingGeminiClaim
        ? `${baseSessionId}:activity:${existingGeminiSessionClaim.claimId}`
        : baseSessionId,
    visualGroupTabId:
      existingGeminiSessionClaim?.tabId && joinsExistingGeminiClaim
        ? existingGeminiSessionClaim.tabId
        : requestedVisualGroupTabId,
    joinsExistingGeminiClaim,
  };
};

export const normalizePositiveIntegerOrNull = (
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safeValue = Math.floor(parsed);
  if (safeValue < 1) return null;
  return Math.min(safeValue, max);
};

export const previousWebConversationCountForResumeReport = (
  report:
    | {
        webConversationCount?: unknown;
        resume?: { previousCounters?: { webConversationCount?: unknown } | null } | null;
      }
    | null
    | undefined,
  max: number,
): number | null =>
  normalizePositiveIntegerOrNull(report?.resume?.previousCounters?.webConversationCount, max) ??
  normalizePositiveIntegerOrNull(report?.webConversationCount, max);

export const recentChatsResumeCounters = (
  report: {
    webConversationCount?: unknown;
    existingVaultCount?: unknown;
    missingCount?: unknown;
    reachedEnd?: unknown;
    truncated?: unknown;
    job?: { fullHistoryVerified?: unknown } | null;
    resume?: { previousCounters?: { webConversationCount?: unknown } | null } | null;
  },
  max: number,
) => ({
  webConversationCount: previousWebConversationCountForResumeReport(report, max),
  existingVaultCount: report.existingVaultCount ?? 0,
  missingCount: report.missingCount ?? null,
  reachedEnd: report.reachedEnd ?? null,
  truncated: report.truncated ?? null,
  fullHistoryVerified: report.job?.fullHistoryVerified ?? null,
});

export const recentExportResumeScope = (
  args: { maxChats?: unknown; limit?: unknown } = {},
  resume: { previousCounters?: { webConversationCount?: unknown } | null } | null | undefined,
  exportMissingOnly: boolean,
  syncMode: boolean,
  maxChatsLoadTarget: number,
): {
  hasExplicitMaxChats: boolean;
  resumeMaxChats: number | null;
  effectiveHasMaxChats: boolean;
} => {
  const hasExplicitMaxChats = args.maxChats !== undefined || args.limit !== undefined;
  const resumeMaxChats =
    !exportMissingOnly && !syncMode
      ? normalizePositiveIntegerOrNull(
          resume?.previousCounters?.webConversationCount,
          maxChatsLoadTarget,
        )
      : null;
  return {
    hasExplicitMaxChats,
    resumeMaxChats,
    effectiveHasMaxChats: hasExplicitMaxChats || resumeMaxChats !== null,
  };
};
