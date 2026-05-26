export type NativeBrokerStatus = Readonly<{
  configured: boolean;
  available: boolean;
  code: string | null;
  message: string;
  response?: unknown;
}>;

type NativeBrokerResponse = Readonly<{
  ok?: boolean;
  code?: string | null;
  error?: string | Readonly<{ code?: string | null; message?: string | null }> | null;
}>;

type NativeExportArgs = Readonly<Record<string, unknown>>;
type NativeExportClaim = Readonly<Record<string, unknown>> | null | undefined;
type ErrorWithData = Error & { code?: string; data?: unknown };
type MutableRecord = Record<string, unknown>;

export const nativeBrokerStatusFromProbe = ({
  enabled,
  response,
}: Readonly<{
  enabled: boolean;
  response?: NativeBrokerResponse | null;
}>): NativeBrokerStatus => {
  if (!enabled) {
    return {
      configured: false,
      available: false,
      code: 'native_broker_disabled',
      message: 'Native broker desativado por configuracao.',
    };
  }

  if (response?.ok === true) {
    return {
      configured: true,
      available: true,
      code: null,
      message: 'Native broker conectado.',
      response,
    };
  }

  const error = response?.error;
  const code =
    (typeof error === 'object' && error ? error.code : null) ||
    response?.code ||
    'native_broker_unavailable';
  const message =
    (typeof error === 'object' && error ? error.message : null) ||
    (typeof error === 'string' ? error : null) ||
    'Não consegui falar com o broker nativo.';
  return {
    configured: true,
    available: false,
    code,
    message,
    response,
  };
};

export const nativeBrokerAvailabilityFromStatus = (status: NativeBrokerStatus): boolean | null => {
  if (status.available === true) return true;
  if (status.configured === false || status.code === 'native_broker_unavailable') return false;
  return null;
};

export const withNativeBrokerSoftTimeout = <TValue>(
  promise: Promise<TValue>,
  timeoutMs: number,
  fallback: TValue,
): Promise<TValue> =>
  Promise.race([
    promise,
    new Promise<TValue>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);

const NATIVE_BROKER_WAKEABLE_CODES = new Set([
  'native_broker_unavailable',
  'native_broker_probe_timeout',
  'native_broker_disconnected',
  'extension_unavailable',
  'extension_request_timeout',
]);

export const shouldAttemptNativeBrokerWake = ({
  nativeBrokerStatus,
  liveClientCount,
}: Readonly<{
  nativeBrokerStatus: NativeBrokerStatus;
  liveClientCount: number;
}>): boolean =>
  nativeBrokerStatus.configured === true &&
  nativeBrokerStatus.available !== true &&
  liveClientCount > 0 &&
  NATIVE_BROKER_WAKEABLE_CODES.has(String(nativeBrokerStatus.code || ''));

export const NATIVE_BROKER_WAKE_CAPABILITY = 'native-broker-wake-v1';

type NativeBrokerWakeClient = Readonly<{
  clientId?: string | null;
  capabilities?: readonly unknown[] | null;
}>;

type NativeBrokerWakeResult = Readonly<{
  attempted: boolean;
  ok: boolean;
  clientId?: string | null;
  reason?: string;
  code?: string | null;
  error?: string;
  result?: unknown;
}>;

type NativeBrokerWakeStatus = NativeBrokerStatus & Readonly<{ wake?: NativeBrokerWakeResult }>;
type NativeBrokerEnqueueCommand = (
  clientId: string,
  type: string,
  args?: Readonly<Record<string, unknown>>,
  options?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export const clientSupportsNativeBrokerWakeCommand = (
  client: NativeBrokerWakeClient | null | undefined,
): boolean =>
  Array.isArray(client?.capabilities) &&
  client.capabilities.some((capability) => capability === NATIVE_BROKER_WAKE_CAPABILITY);

export const selectNativeBrokerWakeClient = <TClient extends NativeBrokerWakeClient>({
  clients,
  clientMatchesExpectedBrowserExtension,
  commandChannelReadyForClient,
}: Readonly<{
  clients: readonly TClient[];
  clientMatchesExpectedBrowserExtension: (client: TClient) => boolean;
  commandChannelReadyForClient: (client: TClient) => boolean;
}>): TClient | null => {
  const wakeableClients = clients.filter(clientSupportsNativeBrokerWakeCommand);
  const commandReadyClient = wakeableClients.find(
    (client) =>
      clientMatchesExpectedBrowserExtension(client) && commandChannelReadyForClient(client),
  );
  return (
    commandReadyClient ||
    wakeableClients.find(clientMatchesExpectedBrowserExtension) ||
    wakeableClients[0] ||
    null
  );
};

export const createNativeBrokerWakeController = <TClient extends NativeBrokerWakeClient>({
  probeNativeBrokerStatusOnce,
  getLiveClients,
  clientMatchesExpectedBrowserExtension,
  commandChannelReadyForClient,
  enqueueNativeBrokerWakeCommand,
  sleep,
  now = () => Date.now(),
  settleMs = 2500,
  pollMs = 150,
}: Readonly<{
  probeNativeBrokerStatusOnce: () => Promise<NativeBrokerStatus>;
  getLiveClients: () => readonly TClient[];
  clientMatchesExpectedBrowserExtension: (client: TClient) => boolean;
  commandChannelReadyForClient: (client: TClient) => boolean;
  enqueueNativeBrokerWakeCommand: (
    client: TClient,
    nativeBrokerStatus: NativeBrokerStatus,
  ) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  settleMs?: number;
  pollMs?: number;
}>) => {
  let nativeBrokerWakeInFlight: Promise<NativeBrokerWakeResult> | null = null;

  const wakeNativeBrowserBrokerViaExtension = async (
    nativeBrokerStatus: NativeBrokerStatus,
  ): Promise<NativeBrokerWakeResult> => {
    if (nativeBrokerWakeInFlight) return nativeBrokerWakeInFlight;
    nativeBrokerWakeInFlight = (async () => {
      const client = selectNativeBrokerWakeClient({
        clients: getLiveClients(),
        clientMatchesExpectedBrowserExtension,
        commandChannelReadyForClient,
      });
      if (!client) {
        return {
          attempted: false,
          ok: false,
          reason: 'no-native-broker-wake-capable-client',
        };
      }
      if (!client.clientId) {
        return {
          attempted: false,
          ok: false,
          reason: 'native-broker-wake-client-id-missing',
        };
      }
      try {
        const result = await enqueueNativeBrokerWakeCommand(client, nativeBrokerStatus);
        return {
          attempted: true,
          ok: typeof result === 'object' && result !== null && 'ok' in result && result.ok === true,
          clientId: client.clientId || null,
          result,
        };
      } catch (err) {
        return {
          attempted: true,
          ok: false,
          clientId: client.clientId || null,
          code: err instanceof Error && 'code' in err ? String(err.code) : null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })().finally(() => {
      nativeBrokerWakeInFlight = null;
    });
    return nativeBrokerWakeInFlight;
  };

  const probeNativeBrowserBrokerStatus = async ({
    allowWake = false,
  }: Readonly<{ allowWake?: boolean }> = {}): Promise<NativeBrokerWakeStatus> => {
    const nativeBrokerStatus = await probeNativeBrokerStatusOnce();
    if (!allowWake) return nativeBrokerStatus;

    const liveClients = getLiveClients();
    const wakeableClientCount = liveClients.filter(clientSupportsNativeBrokerWakeCommand).length;
    if (
      !shouldAttemptNativeBrokerWake({
        nativeBrokerStatus,
        liveClientCount: wakeableClientCount,
      })
    ) {
      return nativeBrokerStatus;
    }

    const wake = nativeBrokerWakeInFlight
      ? await nativeBrokerWakeInFlight
      : await wakeNativeBrowserBrokerViaExtension(nativeBrokerStatus);
    const deadline = now() + settleMs;
    let retryStatus = nativeBrokerStatus;
    do {
      await sleep(pollMs);
      retryStatus = await probeNativeBrokerStatusOnce();
      if (retryStatus.available === true) {
        return {
          ...retryStatus,
          wake,
        };
      }
    } while (now() < deadline);

    return {
      ...retryStatus,
      wake,
    };
  };

  return {
    probeNativeBrowserBrokerStatus,
    wakeNativeBrowserBrokerViaExtension,
    getNativeBrokerWakeInFlight: () => nativeBrokerWakeInFlight,
  };
};

export const enqueueNativeBrokerWakeCommand = <TClient extends NativeBrokerWakeClient>(
  enqueueCommand: NativeBrokerEnqueueCommand,
  client: TClient,
  nativeBrokerStatus: NativeBrokerStatus,
) =>
  enqueueCommand(
    client.clientId || '',
    'ensure-native-broker',
    {
      reason: 'mcp-native-broker-wake',
      previousCode: nativeBrokerStatus.code || null,
      timeoutMs: 5000,
    },
    {
      timeoutMs: 8000,
      dispatchTimeoutMs: 2000,
    },
  );

export const createNativeBrokerStatusProbe = <TClient extends NativeBrokerWakeClient>(
  probeNativeBrokerStatusOnce: () => Promise<NativeBrokerStatus>,
  getLiveClients: () => readonly TClient[],
  clientMatchesExpectedBrowserExtension: (client: TClient) => boolean,
  commandChannelReadyForClient: (client: TClient) => boolean,
  enqueueCommand: NativeBrokerEnqueueCommand,
  sleep: (ms: number) => Promise<void>,
) =>
  createNativeBrokerWakeController({
    probeNativeBrokerStatusOnce,
    getLiveClients,
    clientMatchesExpectedBrowserExtension,
    commandChannelReadyForClient,
    enqueueNativeBrokerWakeCommand: (client, nativeBrokerStatus) =>
      enqueueNativeBrokerWakeCommand(enqueueCommand, client, nativeBrokerStatus),
    sleep,
  }).probeNativeBrowserBrokerStatus;

export const nativeBrokerBlockingIssueForReady = ({
  readinessBlockingIssue,
  ready,
  cdpBlockerCode,
  nativeBrokerStatus,
  claimableClientCount,
}: Readonly<{
  readinessBlockingIssue?: string | null;
  ready?: boolean;
  cdpBlockerCode?: string | null;
  nativeBrokerStatus: NativeBrokerStatus;
  claimableClientCount: number;
}>): string | null => {
  const fallback = readinessBlockingIssue || (!ready ? cdpBlockerCode || null : null);
  if (
    nativeBrokerStatus.configured === true &&
    nativeBrokerStatus.available !== true &&
    claimableClientCount === 0
  ) {
    return nativeBrokerStatus.code || fallback;
  }
  return fallback;
};

export const nativeExportLeaseArgsForClaim = (
  args: NativeExportArgs = {},
  claim: NativeExportClaim = null,
  fallbackTabId: unknown = undefined,
) => ({
  ...args,
  claimId: claim?.claimId || args.claimId,
  tabId: claim?.tabId ?? fallbackTabId ?? args.tabId,
});

export const isNativeExportLeaseStrict = (args: NativeExportArgs = {}) =>
  args.requireNativeExportLease === true || args.allowHttpBrowserFallback !== true;

export const withNativeExportLease = (args: NativeExportArgs = {}, nativeLease: unknown) => ({
  ...args,
  _nativeExportLease: nativeLease,
});

export const assignExportDateImportVisualGroupTabId = (
  args: Record<string, unknown>,
  tabId: number | null,
) => {
  if (tabId !== null && args._exportDateImportVisualGroupTabId === undefined) {
    args._exportDateImportVisualGroupTabId = tabId;
  }
  return args;
};

export const attachNativeLeaseVisualToClaim = <TClaim extends MutableRecord | null | undefined>(
  claim: TClaim,
  nativeLease: unknown,
  claimsById?: { get(claimId: string): MutableRecord | undefined },
): TClaim => {
  if (!claim) return claim;
  const claimId = typeof claim?.claimId === 'string' ? claim.claimId : '';
  const visual =
    typeof nativeLease === 'object' && nativeLease
      ? (nativeLease as Readonly<{ visual?: unknown }>).visual
      : null;
  if (!claimId || !visual) return claim;
  const rawClaim = claimsById?.get(claimId);
  if (rawClaim) rawClaim.visual = visual;
  claim.visual = visual;
  return claim;
};

export const nativeBrokerReloadPayload = (args: NativeExportArgs = {}) => ({
  tabId: args.tabId ?? null,
  claimId: args.claimId || null,
  tabIds: Array.isArray(args.tabIds) ? args.tabIds : undefined,
  relatedTabIds: Array.isArray(args.relatedTabIds) ? args.relatedTabIds : undefined,
  reloadAll: args.reloadAll === true,
  visualGroupTabId: args.visualGroupTabId ?? args.groupWithTabId ?? undefined,
  label: args.label || undefined,
  color: args.color || undefined,
  focusWindow: args.focusWindow === true,
  reason: args.reason || undefined,
});

const nativeBrokerSelfHealPayload = (args: NativeExportArgs = {}) => {
  const payload: Record<string, unknown> = {
    reason: args.reason || 'mcp-native-broker-self-heal',
    force: args.force !== false,
  };
  if (Array.isArray(args.tabIds)) {
    payload.tabIds = args.tabIds;
  } else if (args.tabId !== undefined && args.tabId !== null) {
    payload.tabIds = [args.tabId];
  }
  if (args.maxTabs !== undefined) payload.maxTabs = args.maxTabs;
  return payload;
};

export const shouldReturnNativeBrokerReloadResult = (
  result: Readonly<Record<string, unknown>> | null | undefined,
  args: NativeExportArgs = {},
) => !!result && (result.ok !== false || args.allowHttpBrowserFallback !== true);

export const attachContentScriptSelfHealToNativeReload = async (
  nativeReload: MutableRecord | null | undefined,
  args: NativeExportArgs = {},
  runTabsAction: (action: string, args?: NativeExportArgs) => Promise<unknown>,
) => {
  if (nativeReload?.ok !== true) return nativeReload;
  const reloadedTabIds = Array.isArray(nativeReload.reloadedTabIds)
    ? nativeReload.reloadedTabIds
    : [];
  nativeReload.contentScriptSelfHeal = await runTabsAction('selfHealContentScripts', {
    ...args,
    reason: args.reason || 'native-reload-post-self-heal',
    force: true,
    tabIds: reloadedTabIds.length > 0 ? reloadedTabIds : args.tabIds,
  });
  return nativeReload;
};

export const noConnectedClientsForReloadResult = () => ({
  ok: false,
  code: 'no_connected_clients_for_reload',
  reloaded: 0,
  error: 'Nenhuma aba viva do Gemini conectada à extensão.',
  nextAction:
    'Sem aba conectada, a CLI nao consegue recarregar abas existentes por comando. Use um cliente conectado, CDP ou native broker antes do reload.',
});

export const createTargetTabClientMissingAfterActivationError = ({
  tabId,
  broker,
  result,
}: Readonly<{
  tabId: number;
  broker: unknown;
  result: unknown;
}>): ErrorWithData => {
  const error = new Error(
    'A aba do navegador foi ativada, mas o cliente alvo do Gemini ainda não reconectou.',
  ) as ErrorWithData;
  error.code = 'target_tab_client_missing_after_activation';
  error.data = { tabId, broker, result };
  return error;
};

const okResult = (result: unknown): result is MutableRecord =>
  typeof result === 'object' && result !== null && (result as MutableRecord).ok === true;

const reloadStaleContentClaimAfterNativeRelease = async (
  deps: {
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: MutableRecord,
    ): Promise<MutableRecord | null>;
  },
  input: Readonly<{
    extensionVisual: MutableRecord | null;
    nativeVisual: MutableRecord | null;
    tabId: unknown;
    tabIds: unknown;
    reason: string;
  }>,
) => {
  if (okResult(input.extensionVisual) || !okResult(input.nativeVisual)) return null;
  return deps.tryNativeBrowserBrokerTabsAction('reload', {
    tabId: input.tabId,
    tabIds: input.tabIds || null,
    reason: `${input.reason}-stale-content-reload`,
    focusWindow: false,
  });
};

export const createTabClaimRelease =
  (deps: {
    cleanupExpiredTabClaims(): void;
    normalizeSessionId(sessionId: unknown): string;
    sessionClaims: { get(sessionId: string): string | undefined; delete(sessionId: string): void };
    tabClaims: { get(claimId: string): MutableRecord | undefined };
    clients: { get(clientId: string): MutableRecord | undefined };
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: MutableRecord,
    ): Promise<MutableRecord | null>;
    releaseTabClaimVisualByTabId(args: MutableRecord): Promise<MutableRecord | null>;
    summarizeTabClaims(): unknown;
    liveClientForClaim(claim: MutableRecord): MutableRecord | null;
    liveClientCarryingClaimId?(claimId: string): MutableRecord | null;
    waitForContinuationClient(
      client: MutableRecord,
      selector: MutableRecord,
    ): Promise<MutableRecord | null>;
    isLiveClient(client: MutableRecord | undefined | null): boolean;
    enqueueCommand(
      clientId: string,
      type: string,
      args?: MutableRecord,
      options?: MutableRecord,
    ): Promise<MutableRecord | null>;
    removeTabClaim(claimId: string): MutableRecord | null | undefined;
    summarizeTabClaim(claim: MutableRecord | null | undefined): unknown;
    summarizeClient(client: MutableRecord): unknown;
  }) =>
  async (args: MutableRecord = {}) => {
    deps.cleanupExpiredTabClaims();
    const sessionId = deps.normalizeSessionId(args.sessionId || args._proxySessionId);
    const claimId = String(args.claimId || deps.sessionClaims.get(sessionId) || '');
    if (!claimId) {
      const visual = await deps.releaseTabClaimVisualByTabId({
        tabId: args.tabId,
        reason: String(args.reason || 'mcp-release-without-server-claim'),
      });
      const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
        tabId: args.tabId,
        claimId: args.claimId || null,
        tabIds: args.tabIds || null,
        reason: `${args.reason || 'mcp-release-without-server-claim'}-native-visual`,
      });
      const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
        extensionVisual: visual,
        nativeVisual,
        tabId: args.tabId,
        tabIds: args.tabIds || null,
        reason: String(args.reason || 'mcp-release-without-server-claim'),
      });
      if (okResult(visual) || okResult(nativeVisual)) {
        return { ok: true, released: null, visual, nativeVisual, staleContentReload, client: null };
      }
      return {
        ok: false,
        reason: 'no-claim-for-session',
        sessionId,
        visual,
        nativeVisual,
        claims: deps.summarizeTabClaims(),
      };
    }

    const claim = deps.tabClaims.get(claimId);
    if (!claim) {
      deps.sessionClaims.delete(sessionId);
      const orphanClient = deps.liveClientCarryingClaimId?.(claimId) || null;
      const orphanClientRecord = orphanClient as MutableRecord | null;
      const orphanClientClaim = (orphanClientRecord?.tabClaim ||
        (orphanClientRecord?.summary as MutableRecord | undefined)?.tabClaim ||
        null) as
        | MutableRecord
        | null;
      const releaseTabId = args.tabId ?? orphanClientRecord?.tabId;
      const releaseTabIds =
        args.tabIds || (orphanClientClaim?.visual as MutableRecord | undefined)?.tabIds || null;
      const visual = await deps.releaseTabClaimVisualByTabId({
        tabId: releaseTabId,
        claimId,
        reason: String(args.reason || 'mcp-release-missing-server-claim'),
      });
      const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
        tabId: releaseTabId,
        claimId,
        tabIds: releaseTabIds,
        reason: `${args.reason || 'mcp-release-missing-server-claim'}-native-visual`,
      });
      const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
        extensionVisual: visual,
        nativeVisual,
        tabId: releaseTabId,
        tabIds: releaseTabIds,
        reason: String(args.reason || 'mcp-release-missing-server-claim'),
      });
      if (okResult(visual) || okResult(nativeVisual)) {
        return {
          ok: true,
          released: null,
          claimId,
          sessionId,
          visual,
          nativeVisual,
          staleContentReload,
          client: null,
        };
      }
      return {
        ok: false,
        reason: 'claim-not-found',
        claimId,
        sessionId,
        visual,
        nativeVisual,
        claims: deps.summarizeTabClaims(),
      };
    }

    let visual: MutableRecord | null = null;
    let client = deps.liveClientForClaim(claim);
    if (!client) {
      const recoveredClient = await deps.waitForContinuationClient(
        { clientId: claim.clientId, tabId: claim.tabId, sessionId: claim.sessionId },
        { claimId, tabId: claim.tabId, sessionId: claim.sessionId },
      );
      const recoveredLiveClient =
        typeof recoveredClient?.clientId === 'string'
          ? deps.clients.get(recoveredClient.clientId)
          : null;
      client = deps.isLiveClient(recoveredLiveClient) ? recoveredLiveClient || null : null;
    }
    if (client && typeof client.clientId === 'string') {
      try {
        visual = await deps.enqueueCommand(
          client.clientId,
          'release-tab-claim',
          { claimId, reason: args.reason || 'mcp-release' },
          { timeoutMs: 8000, dispatchTimeoutMs: 4000, browserSideEffectExplicit: true },
        );
      } catch (err) {
        visual = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof Error && 'code' in err ? String(err.code) : null,
        };
      }
    }

    const releaseVisualTabId = claim.tabId ?? args.tabId;
    const releaseVisualTabIds = (claim.visual as MutableRecord | undefined)?.tabIds || null;
    const releaseReason = String(args.reason || 'mcp-release');
    const releaseNativeClaimVisual = async () => {
      if (!Array.isArray(releaseVisualTabIds) || releaseVisualTabIds.length === 0) return null;
      return deps.tryNativeBrowserBrokerTabsAction('release', {
        tabId: releaseVisualTabId,
        claimId,
        tabIds: releaseVisualTabIds,
        reason: `${releaseReason}-native-visual`,
      });
    };

    const releaseSucceeded = () => {
      if (!okResult(visual)) return null;
      const removed = deps.removeTabClaim(claimId);
      return {
        ok: true,
        released: deps.summarizeTabClaim(removed),
        visual,
        client: client ? deps.summarizeClient(client) : null,
      };
    };
    const browserRelease = releaseSucceeded();
    if (browserRelease) {
      const nativeVisual = await releaseNativeClaimVisual();
      return nativeVisual ? { ...browserRelease, nativeVisual } : browserRelease;
    }

    if (releaseVisualTabId !== null && releaseVisualTabId !== undefined) {
      visual = await deps.releaseTabClaimVisualByTabId({
        tabId: releaseVisualTabId,
        claimId,
        reason: args.reason || 'mcp-release-by-tab-id',
      });
    }
    const extensionRelease = releaseSucceeded();
    if (extensionRelease) {
      const nativeVisual = await releaseNativeClaimVisual();
      return nativeVisual ? { ...extensionRelease, nativeVisual } : extensionRelease;
    }

    const extensionVisual = visual;
    const nativeVisual = await deps.tryNativeBrowserBrokerTabsAction('release', {
      tabId: releaseVisualTabId,
      claimId,
      tabIds: releaseVisualTabIds,
      reason: String(args.reason || 'mcp-native-release'),
    });
    const staleContentReload = await reloadStaleContentClaimAfterNativeRelease(deps, {
      extensionVisual,
      nativeVisual,
      tabId: releaseVisualTabId,
      tabIds: releaseVisualTabIds,
      reason: String(args.reason || 'mcp-native-release'),
    });
    visual = nativeVisual;
    const nativeRelease = releaseSucceeded();
    if (nativeRelease) return { ...nativeRelease, staleContentReload };

    const removed = deps.removeTabClaim(claimId);
    return {
      ok: true,
      released: deps.summarizeTabClaim(removed),
      visual,
      client: client ? deps.summarizeClient(client) : null,
    };
  };

export const createAutoTabClaimReleaseForJob =
  (deps: {
    clients: { get(clientId: string): MutableRecord | undefined };
    clientTabClaim(client: MutableRecord | null): MutableRecord | null;
    releaseTabClaim(args: MutableRecord): Promise<MutableRecord | null>;
    shouldUseNativeBrowserBroker(): boolean;
    tryNativeBrowserBrokerTabsAction(
      action: string,
      args?: MutableRecord,
    ): Promise<MutableRecord | null>;
  }) =>
  async (job: MutableRecord, reason: string) => {
    if (!job?.autoReleaseTabClaim || !job.tabClaimId || job.tabClaimRelease) {
      return job?.tabClaimRelease || null;
    }
    try {
      const client =
        typeof job.clientId === 'string' ? deps.clients.get(job.clientId) || null : null;
      const tabClaim = deps.clientTabClaim(client);
      const releaseTabId =
        (job.tabSession as MutableRecord | undefined)?.tabId ?? client?.tabId ?? tabClaim?.tabId;
      const releaseTabIds =
        (tabClaim?.visual as MutableRecord | undefined)?.tabIds ||
        ((job.nativeExportLease as MutableRecord | undefined)?.visual as MutableRecord | undefined)
          ?.tabIds ||
        ((job.tabSession as MutableRecord | undefined)?.visual as MutableRecord | undefined)
          ?.tabIds ||
        null;
      job.tabClaimRelease = await deps.releaseTabClaim({
        claimId: job.tabClaimId,
        tabId: releaseTabId,
        tabIds: releaseTabIds,
        reason,
      });
      if (deps.shouldUseNativeBrowserBroker()) {
        const releasedVisual = ((job.tabClaimRelease as MutableRecord | undefined)?.released as
          | MutableRecord
          | undefined)?.visual as MutableRecord | undefined;
        const nativeReleaseTabIds = releaseTabIds || releasedVisual?.tabIds || null;
        job.nativeTabClaimRelease = await deps.tryNativeBrowserBrokerTabsAction('release', {
          tabId: releaseTabId,
          claimId: job.tabClaimId,
          tabIds: nativeReleaseTabIds,
          reason: `${reason}-native-visual`,
        });
        if (job.tabClaimRelease && typeof job.tabClaimRelease === 'object') {
          (job.tabClaimRelease as MutableRecord).nativeVisual = job.nativeTabClaimRelease;
        }
      }
    } catch (err) {
      job.tabClaimRelease = {
        ok: false,
        claimId: job.tabClaimId,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error && 'code' in err ? String(err.code) : null,
      };
    }
    return job.tabClaimRelease;
  };

export const createNativeExportLeaseTools = ({
  ensureTabClaimForJob,
  validateNativeExportTabLeaseForJob,
}: Readonly<{
  ensureTabClaimForJob: (client: unknown, args: unknown, label: unknown) => Promise<unknown>;
  validateNativeExportTabLeaseForJob: (
    client: unknown,
    args: unknown,
    claim: unknown,
  ) => Promise<unknown>;
}>) => {
  const validateNativeExportLeaseForClaim = (client: unknown, args: unknown, claim: unknown) =>
    validateNativeExportTabLeaseForJob(
      nativeExportLeaseArgsForClaim(args as NativeExportArgs, claim as NativeExportClaim),
      claim,
      client,
    );
  return {
    validateNativeExportLeaseForClaim,
    claimNativeExportLeaseForJob: async (client: unknown, args: unknown, label: unknown) => {
      const claim = await ensureTabClaimForJob(client, args, label);
      return validateNativeExportLeaseForClaim(client, args, claim);
    },
  };
};

const parseOptionalBooleanValue = (value: string | null): boolean | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  return undefined;
};

export const clientSelectorFromUrlSearchParams = (searchParams: URLSearchParams) => ({
  clientId: searchParams.get('clientId') || undefined,
  tabId: searchParams.get('tabId') || undefined,
  claimId: searchParams.get('claimId') || undefined,
  sessionId: searchParams.get('sessionId') || undefined,
  cdpUrl: searchParams.get('cdpUrl') || undefined,
  controlPlane: searchParams.get('controlPlane') || undefined,
  wakeBrowser: parseOptionalBooleanValue(searchParams.get('wakeBrowser')),
  openIfMissing: parseOptionalBooleanValue(searchParams.get('openIfMissing')),
  activateTab: parseOptionalBooleanValue(searchParams.get('activateTab')),
  focusWindow: parseOptionalBooleanValue(searchParams.get('focusWindow')),
  allowHttpBrowserFallback: parseOptionalBooleanValue(searchParams.get('allowHttpBrowserFallback')),
  preferActive: parseOptionalBooleanValue(searchParams.get('preferActive')),
  preferRecent: parseOptionalBooleanValue(searchParams.get('preferRecent')),
});

export const createNativeBrokerTabsActionRunner =
  ({
    shouldUseNativeBrowserBroker,
    nativeBrowserBroker,
    nativeBrowserBrokerToolResult,
  }: Readonly<{
    shouldUseNativeBrowserBroker: () => boolean;
    nativeBrowserBroker: Record<string, (...args: unknown[]) => Promise<unknown>>;
    nativeBrowserBrokerToolResult: (response: unknown, action: string) => unknown;
  }>) =>
  async (action: string, args: NativeExportArgs = {}) => {
    if (!shouldUseNativeBrowserBroker()) return null;
    if (action === 'list') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.listTabs({ allowFallback: true }),
        action,
      );
    }
    if (action === 'status') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.status({ allowFallback: true }),
        action,
      );
    }
    if (action === 'claim') {
      if (args.clientId || args.index || args.chatId) return null;
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.claim(nativeBrokerReloadPayload(args), { allowFallback: true }),
        action,
      );
    }
    if (action === 'release') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.release(nativeBrokerReloadPayload(args), { allowFallback: true }),
        action,
      );
    }
    if (action === 'activate') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.activate(nativeBrokerReloadPayload(args), {
          allowFallback: args.allowHttpBrowserFallback === true,
        }),
        action,
      );
    }
    if (action === 'reload') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.reload(nativeBrokerReloadPayload(args), {
          allowFallback: args.allowHttpBrowserFallback === true,
        }),
        action,
      );
    }
    if (action === 'selfHealContentScripts') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.selfHealContentScripts(nativeBrokerSelfHealPayload(args), {
          allowFallback: args.allowHttpBrowserFallback === true,
        }),
        action,
      );
    }
    if (action === 'extensionStatus') {
      return nativeBrowserBrokerToolResult(
        await nativeBrowserBroker.extensionStatus({ allowFallback: true }),
        action,
      );
    }
    return null;
  };
