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

export const nativeBrokerAvailabilityFromStatus = (
  status: NativeBrokerStatus,
): boolean | null => {
  if (status.available === true) return true;
  if (status.configured === false || status.code === 'native_broker_unavailable') return false;
  return null;
};

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

export const withNativeExportLease = (
  args: NativeExportArgs = {},
  nativeLease: unknown,
) => ({
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

export const nativeBrokerReloadPayload = (args: NativeExportArgs = {}) => ({
  tabId: args.tabId ?? null,
  claimId: args.claimId || null,
});

export const shouldReturnNativeBrokerReloadResult = (
  result: Readonly<Record<string, unknown>> | null | undefined,
  args: NativeExportArgs = {},
) => !!result && (result.ok !== false || args.allowHttpBrowserFallback !== true);

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
  const validateNativeExportLeaseForClaim = (
    client: unknown,
    args: unknown,
    claim: unknown,
  ) =>
    validateNativeExportTabLeaseForJob(
      nativeExportLeaseArgsForClaim(args as NativeExportArgs, claim as NativeExportClaim),
      claim,
      client,
    );
  return {
    validateNativeExportLeaseForClaim,
    claimNativeExportLeaseForJob: async (
    client: unknown,
    args: unknown,
    label: unknown,
  ) => {
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
  allowHttpBrowserFallback: parseOptionalBooleanValue(
    searchParams.get('allowHttpBrowserFallback'),
  ),
  preferActive: parseOptionalBooleanValue(searchParams.get('preferActive')),
  preferRecent: parseOptionalBooleanValue(searchParams.get('preferRecent')),
});

export const createNativeBrokerTabsActionRunner = ({
  shouldUseNativeBrowserBroker,
  nativeBrowserBroker,
  nativeBrowserBrokerToolResult,
}: Readonly<{
  shouldUseNativeBrowserBroker: () => boolean;
  nativeBrowserBroker: Record<string, (...args: unknown[]) => Promise<unknown>>;
  nativeBrowserBrokerToolResult: (response: unknown, action: string) => unknown;
}>) => async (action: string, args: NativeExportArgs = {}) => {
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
  if (action === 'reload') {
    return nativeBrowserBrokerToolResult(
      await nativeBrowserBroker.reload(nativeBrokerReloadPayload(args), {
        allowFallback: args.allowHttpBrowserFallback === true,
      }),
      action,
    );
  }
  return null;
};
