type AnyRecord = Record<string, any>;

export const buildActiveExportJobReloadErrorInfo = (
  activeJobs: AnyRecord[] = [],
  kind = 'browser-reload',
) => {
  if (!activeJobs.length) return null;
  return {
    message:
      'Não vou recarregar extensão/abas enquanto existe export ativo; isso interrompe a conversa atual e gera falhas em cascata. Aguarde o job terminar ou cancele explicitamente.',
    code: 'extension_reload_deferred_active_export_job',
    data: {
      kind,
      activeJobCount: activeJobs.length,
      activeJobIds: activeJobs.map((job) => job.jobId).filter(Boolean),
    },
  };
};

export const buildActiveExportJobReloadResult = (
  activeJobs: AnyRecord[] = [],
  kind = 'browser-reload',
) => {
  const info = buildActiveExportJobReloadErrorInfo(activeJobs, kind);
  if (!info) return null;
  return {
    ok: false,
    action: 'reload',
    code: 'browser_reload_deferred_active_export_job',
    error: info.message,
    ...info.data,
  };
};

export const clientRuntimeSignalAt = (candidate: AnyRecord): number =>
  Math.max(
    Number(candidate?.lastSeenAt || 0),
    Number(candidate?.lastHeartbeatAt || 0),
    Number(candidate?.lastSnapshotAt || 0),
  );

export const runtimeSignalMatchesMin = (
  candidate: AnyRecord,
  minRuntimeSignalAt: unknown,
): boolean => {
  const min = Number(minRuntimeSignalAt || 0);
  return !Number.isFinite(min) || min <= 0 || clientRuntimeSignalAt(candidate) >= min;
};

export const summarizeClientLifecycle = (lifecycle: AnyRecord = {}) => ({
  ok: lifecycle.ok === true,
  state: lifecycle.state,
  code: lifecycle.code,
  message: lifecycle.message,
  nextAction: lifecycle.nextAction,
  retryable: lifecycle.retryable,
  manualReloadRecommended: lifecycle.manualReloadRecommended,
});

export const validateRecoveredBrowserClientLifecycle = (
  client: AnyRecord,
  deps: {
    getGeminiClientLifecycle(client: AnyRecord, options: AnyRecord): AnyRecord;
    hydrateClientLifecycleFields(client: AnyRecord): AnyRecord;
    activeClaimableGeminiClientOptions(): AnyRecord;
  },
) =>
  summarizeClientLifecycle(
    deps.getGeminiClientLifecycle(
      deps.hydrateClientLifecycleFields(client),
      deps.activeClaimableGeminiClientOptions(),
    ),
  );

export const activityClientMatchesSelector = (
  client: AnyRecord,
  selector: AnyRecord = {},
  deps: { normalizeTabId(value: unknown): number | null },
): boolean => {
  const selectorTabId = deps.normalizeTabId(selector.tabId);
  if (selector.clientId && client.clientId !== selector.clientId) return false;
  if (selectorTabId !== null && deps.normalizeTabId(client.tabId) !== selectorTabId) return false;
  return runtimeSignalMatchesMin(client, selector.minRuntimeSignalAt);
};

export const recoverActivityClientAfterVersionMismatch = async (
  input: { err: AnyRecord; args: AnyRecord; selector: AnyRecord },
  deps: {
    normalizeTabId(value: unknown): number | null;
    tryNativeBrowserBrokerTabsAction(action: string, args?: AnyRecord): Promise<AnyRecord | null>;
    waitForActivityClient(selector: AnyRecord, timeoutMs?: unknown): Promise<AnyRecord | null>;
  },
) => {
  const selectorTabId = deps.normalizeTabId(input.selector.tabId);
  if (
    input.err?.code !== 'activity_client_version_mismatch' ||
    input.args.openIfMissing === false ||
    selectorTabId === null
  ) {
    return { handled: false };
  }
  const reload = await deps.tryNativeBrowserBrokerTabsAction('reload', {
    tabIds: [selectorTabId],
    reason: 'reload-activity-client-version-mismatch',
    focusWindow: false,
  });
  const client = await deps.waitForActivityClient(input.selector, input.args.waitMs);
  return {
    handled: true,
    client,
    browserWake: client
      ? {
          attempted: false,
          reason: 'activity-client-reloaded-after-version-mismatch',
          reload,
        }
      : null,
  };
};

export const waitForContinuationClientWithRecovery = async (
  input: { client: AnyRecord; args?: AnyRecord; waitMs: number },
  deps: {
    clientsGet(clientId: string): AnyRecord | null | undefined;
    resolveContinuationClient(client: AnyRecord, args?: AnyRecord): AnyRecord | null | undefined;
    isLiveClient(client: AnyRecord): boolean;
    clientMatchesExpectedBrowserExtension(client: AnyRecord): boolean;
    validateRecoveredClient(client: AnyRecord): AnyRecord;
    sleep(ms: number): Promise<void>;
  },
) => {
  const args = input.args || {};
  const continuationClientReady = (candidate: AnyRecord) => {
    if (!candidate?.clientId) return false;
    const liveCandidate = deps.clientsGet(candidate.clientId) || candidate;
    if (!deps.isLiveClient(liveCandidate)) return false;
    if (!runtimeSignalMatchesMin(liveCandidate, args.minRuntimeSignalAt)) return false;
    if (
      args.requireExpectedBrowserExtension === true &&
      !deps.clientMatchesExpectedBrowserExtension(liveCandidate)
    ) {
      return false;
    }
    if (args.requireCommandReady === true && deps.validateRecoveredClient(liveCandidate).ok !== true) {
      return false;
    }
    return true;
  };

  const startedAt = Date.now();
  let recovered = deps.resolveContinuationClient(input.client, args);
  if (recovered?.clientId && continuationClientReady(recovered)) {
    return deps.clientsGet(recovered.clientId) || recovered;
  }
  while (Date.now() - startedAt < input.waitMs) {
    await deps.sleep(500);
    recovered = deps.resolveContinuationClient(input.client, args);
    if (recovered?.clientId && continuationClientReady(recovered)) {
      return deps.clientsGet(recovered.clientId) || recovered;
    }
  }
  return recovered;
};

export const tryNativeTabClaimVisual = async (
  input: {
    readyClient: AnyRecord;
    claimId: string;
    label: string;
    color: string;
    args?: AnyRecord;
  },
  deps: {
    normalizeTabId(value: unknown): number | null;
    tryNativeBrowserBrokerTabsAction(action: string, args?: AnyRecord): Promise<AnyRecord | null>;
    isTabClaimReceipt(receipt: AnyRecord): boolean;
  },
) => {
  const readyTabId = deps.normalizeTabId(input.readyClient?.tabId);
  if (readyTabId === null) return null;
  const args = input.args || {};
  const nativeClaim = await deps.tryNativeBrowserBrokerTabsAction('claim', {
    tabId: readyTabId,
    claimId: input.claimId,
    label: input.label,
    color: input.color,
    visualGroupTabId: deps.normalizeTabId(args.visualGroupTabId ?? args.groupWithTabId),
    groupWithTabId: deps.normalizeTabId(args.groupWithTabId),
    relatedTabIds: Array.isArray(args.relatedTabIds) ? args.relatedTabIds : undefined,
    tabIds: Array.isArray(args.tabIds) ? args.tabIds : undefined,
  });
  if (nativeClaim?.ok === false) return null;
  const nativeReceipt = { ok: true, visual: nativeClaim?.visual };
  if (!deps.isTabClaimReceipt(nativeReceipt)) return null;
  return {
    ...nativeReceipt,
    source: 'native-browser-broker',
    nativeBroker: nativeClaim?.nativeBroker || null,
  };
};

export const cleanupOrphanNativeClaimVisualsOnStartup = async (
  input: { bridgeRole: string; shouldUseNativeBrowserBroker: boolean },
  deps: {
    tryNativeBrowserBrokerTabsAction(action: string, args?: AnyRecord): Promise<AnyRecord | null>;
    recordFlightEvent(event: string, payload?: AnyRecord): void;
  },
) => {
  if (input.bridgeRole !== 'primary' || !input.shouldUseNativeBrowserBroker) return;
  try {
    const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
      reason: 'bridge-startup-orphan-claim-cleanup',
    });
    if (nativeVisual) deps.recordFlightEvent('orphan_native_claim_visual_cleanup', { nativeVisual });
  } catch (err: any) {
    deps.recordFlightEvent('orphan_native_claim_visual_cleanup_failed', {
      error: err?.message || String(err),
      code: err?.code || null,
    });
  }
};

export const abortPendingCommandsAfterEventStreamReconnect = (
  input: {
    client: AnyRecord;
    clientEventStreamUsable: boolean;
    hasDispatchedPendingCommand: boolean;
  },
  deps: {
    shouldAbortDispatchedCommandsOnEventStreamReconnect(input: AnyRecord): boolean;
    abortPendingCommandsForClient(clientId: string, reason: AnyRecord): void;
  },
) => {
  if (
    !deps.shouldAbortDispatchedCommandsOnEventStreamReconnect({
      existingEventStreamUsable: input.clientEventStreamUsable,
      hasDispatchedPendingCommand: input.hasDispatchedPendingCommand,
    })
  ) {
    return false;
  }
  deps.abortPendingCommandsForClient(input.client.clientId, {
    code: 'client_reconnected_during_command',
    reason: 'event-stream-reconnected-same-client',
    replacementClientId: input.client.clientId,
  });
  return true;
};
