const CLAIMABLE_GEMINI_TAB: unique symbol = Symbol('ClaimableGeminiTab');
const CLAIMED_READY_GEMINI_TAB: unique symbol = Symbol('ClaimedReadyGeminiTab');

export type GeminiClientLifecycleState =
  | 'disconnected'
  | 'transport_connected'
  | 'extension_mismatch'
  | 'warming_up'
  | 'page_unready'
  | 'command_unready'
  | 'blocked'
  | 'busy'
  | 'claimable'
  | 'claimed_ready'
  | 'dead';

export type GeminiClientLifecycleCode =
  | 'no_connected_client'
  | 'warming_up'
  | 'extension_version_mismatch'
  | 'extension_protocol_mismatch'
  | 'extension_build_mismatch'
  | 'activity_client_not_claimable'
  | 'missing_tab_id'
  | 'inactive_tab'
  | 'page_not_gemini'
  | 'page_not_hydrated'
  | 'current_chat_required'
  | 'google_verification_required'
  | 'google_login_required'
  | 'google_page_blocked'
  | 'command_channel_unready'
  | 'tab_operation_in_progress'
  | 'claim_missing'
  | 'claim_conflict'
  | 'client_dead';

export type GeminiPageSnapshot = Readonly<{
  url?: string | null;
  pathname?: string | null;
  path?: string | null;
  chatId?: string | null;
  notebookId?: string | null;
  kind?: string | null;
  buildStamp?: string | null;
  turnCount?: number | null;
  sidebarOpen?: boolean | null;
  listedConversationCount?: number | null;
  bridgeConversationCount?: number | null;
  sidebarConversationCount?: number | null;
  notebookCacheCount?: number | null;
  isActiveTab?: boolean | null;
  blocker?: {
    code?: string | null;
    kind?: string | null;
    message?: string | null;
    nextAction?: string | null;
    terminal?: boolean | null;
  } | null;
}>;

export type GeminiClientSnapshot = Readonly<{
  clientId: string;
  kind?: string | null;
  tabId?: number | string | null;
  windowId?: number | string | null;
  isActiveTab?: boolean | null;
  lastHeartbeatAt?: number | null;
  lastSnapshotAt?: number | null;
  lastSeenAt?: number | null;
  extensionVersion?: string | null;
  protocolVersion?: number | string | null;
  buildStamp?: string | null;
  commandReady?: boolean | null;
  recentCommandFailure?: boolean | null;
  tabOperationInProgress?: boolean | null;
  page?: GeminiPageSnapshot | null;
  metrics?: {
    tabOperation?: {
      active?: unknown;
    } | null;
  } | null;
  summary?: {
    metrics?: {
      tabOperation?: {
        active?: unknown;
      } | null;
    } | null;
  } | null;
}>;

export type GeminiTabClaimSnapshot = Readonly<{
  claimId: string;
  clientId?: string | null;
  tabId?: number | string | null;
  sessionId?: string | null;
  expiresAtMs?: number | null;
}>;

export type GeminiClientLifecycleOptions = Readonly<{
  now?: number;
  staleAfterMs: number;
  hydrationGraceMs?: number;
  expectedExtensionVersion?: string | null;
  expectedProtocolVersion?: number | string | null;
  expectedBuildStamp?: string | null;
  requireCommandReady?: boolean;
  requireClaimed?: boolean;
  capability?: 'current-chat' | 'recent-export';
  sessionId?: string | null;
  claimId?: string | null;
  claims?: readonly GeminiTabClaimSnapshot[];
}>;

export type ClaimableGeminiTab = GeminiClientSnapshot &
  Readonly<{
    readonly [CLAIMABLE_GEMINI_TAB]: true;
    readonly tabId: number;
    readonly isActiveTab: true;
    readonly lastRuntimeSignalAt: number;
    readonly page: GeminiPageSnapshot & Readonly<{ url: string }>;
  }>;

export type ClaimedReadyGeminiTab = ClaimableGeminiTab &
  Readonly<{
    readonly [CLAIMED_READY_GEMINI_TAB]: true;
    readonly commandReady: true;
    readonly claim: GeminiTabClaimSnapshot;
  }>;

export type GeminiClientLifecycle = Readonly<{
  ok: boolean;
  state: GeminiClientLifecycleState;
  code: GeminiClientLifecycleCode | null;
  message: string;
  nextAction: string;
  retryable: boolean;
  manualReloadRecommended: boolean;
  client?: GeminiClientSnapshot;
  claim?: GeminiTabClaimSnapshot | null;
}>;

export type GeminiClientLifecycleDiagnostic = Readonly<{
  ok: false;
  code: GeminiClientLifecycleCode;
  message: string;
  state: GeminiClientLifecycleState;
  nextAction: string;
  retryable: boolean;
  manualReloadRecommended: boolean;
}>;

const LIFECYCLE_MESSAGES: Record<GeminiClientLifecycleCode, string> = {
  no_connected_client: 'Nenhuma aba do Gemini conectada a extensao.',
  warming_up: 'A aba Gemini ainda esta inicializando.',
  extension_version_mismatch: 'A extensao conectada nao esta na versao esperada.',
  extension_protocol_mismatch: 'A extensao conectada nao fala o protocolo esperado.',
  extension_build_mismatch: 'A extensao conectada nao esta no build esperado.',
  activity_client_not_claimable:
    'Cliente My Activity nao pode ser usado para exportar chats do Gemini.',
  missing_tab_id: 'A aba conectada nao informou o ID real da aba do navegador.',
  inactive_tab: 'Aba Gemini inativa nao pode ser reivindicada para exportacao.',
  page_not_gemini: 'A aba ativa nao aponta para o Gemini Web.',
  page_not_hydrated: 'A pagina do Gemini ainda nao hidratou uma conversa exportavel.',
  current_chat_required: 'Abra uma conversa específica para exportar o chat atual.',
  google_verification_required: 'O Google abriu uma tela de verificacao antes do Gemini.',
  google_login_required: 'O navegador esta no login do Google.',
  google_page_blocked: 'O Google bloqueou a pagina antes de liberar o Gemini.',
  command_channel_unready: 'A aba ativa ainda nao abriu o canal de comandos.',
  tab_operation_in_progress: 'A aba ja esta executando uma operacao pesada.',
  claim_missing: 'Esta sessao ainda nao reivindicou uma aba Gemini valida.',
  claim_conflict: 'A aba Gemini esta reivindicada por outra sessao.',
  client_dead: 'O cliente da aba parou de enviar sinais recentes.',
};

const NEXT_ACTIONS: Record<GeminiClientLifecycleCode, string> = {
  no_connected_client: 'Abra uma aba do Gemini e aguarde a extensao conectar.',
  warming_up: 'Aguarde a aba terminar de carregar e tente novamente.',
  extension_version_mismatch: 'Recarregue a extensao do navegador e a aba Gemini.',
  extension_protocol_mismatch: 'Recarregue a extensao do navegador e a aba Gemini.',
  extension_build_mismatch: 'Recarregue a extensao do navegador e a aba Gemini.',
  activity_client_not_claimable: 'Escolha uma aba do Gemini Web, nao uma aba My Activity.',
  missing_tab_id: 'Recarregue a aba Gemini para a extensao obter o identificador real.',
  inactive_tab: 'Ative a aba Gemini desejada antes de reivindicar ou exportar.',
  page_not_gemini: 'Abra https://gemini.google.com/app na aba ativa.',
  page_not_hydrated: 'Aguarde o Gemini renderizar a conversa ou a lista lateral.',
  current_chat_required: 'Abra uma conversa específica para exportar o chat atual.',
  google_verification_required: 'Resolva a verificacao no navegador e tente novamente.',
  google_login_required: 'Conclua o login no navegador e tente novamente.',
  google_page_blocked: 'Resolva o bloqueio no navegador e tente novamente.',
  command_channel_unready: 'Aguarde o canal de comandos reconectar ou recarregue a aba.',
  tab_operation_in_progress: 'Aguarde a operacao atual da aba terminar.',
  claim_missing: 'Reivindique explicitamente uma aba Gemini para esta sessao.',
  claim_conflict: 'Libere a claim existente, escolha outra aba ou use force quando apropriado.',
  client_dead: 'Recarregue a aba Gemini ou abra uma nova aba.',
};

const RETRYABLE_CODES = new Set<GeminiClientLifecycleCode>([
  'warming_up',
  'page_not_hydrated',
  'command_channel_unready',
  'tab_operation_in_progress',
]);

const MANUAL_RELOAD_CODES = new Set<GeminiClientLifecycleCode>([
  'extension_version_mismatch',
  'extension_protocol_mismatch',
  'extension_build_mismatch',
  'client_dead',
]);

const normalizeNumber = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const normalizeString = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text ? text : null;
};

const pageUrl = (client: GeminiClientSnapshot): string | null => {
  const url = client.page?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
};

const pageOrigin = (client: GeminiClientSnapshot): string | null => {
  const url = pageUrl(client);
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const clientBuildStamp = (client: GeminiClientSnapshot): string | null =>
  client.page?.buildStamp || client.buildStamp || null;

const result = (
  state: GeminiClientLifecycleState,
  code: GeminiClientLifecycleCode | null,
  client?: GeminiClientSnapshot | null,
  claim?: GeminiTabClaimSnapshot | null,
): GeminiClientLifecycle => ({
  ok: code === null,
  state,
  code,
  message: code ? LIFECYCLE_MESSAGES[code] : 'Aba Gemini pronta.',
  nextAction: code ? NEXT_ACTIONS[code] : 'Pode executar a operacao solicitada.',
  retryable: code ? RETRYABLE_CODES.has(code) : false,
  manualReloadRecommended: code ? MANUAL_RELOAD_CODES.has(code) : false,
  ...(client ? { client } : {}),
  ...(claim ? { claim } : {}),
});

const tabIdsMatch = (
  left: number | string | null | undefined,
  right: number | string | null | undefined,
) => {
  const normalizedLeft = normalizeNumber(left);
  const normalizedRight = normalizeNumber(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
};

const hasExpired = (claim: GeminiTabClaimSnapshot, now: number) =>
  typeof claim.expiresAtMs === 'number' && claim.expiresAtMs <= now;

const claimTargetsClient = (claim: GeminiTabClaimSnapshot, client: GeminiClientSnapshot) => {
  if (claim.clientId && claim.clientId === client.clientId) return true;
  return tabIdsMatch(claim.tabId, client.tabId);
};

const findClaimForClient = (
  client: GeminiClientSnapshot,
  options: GeminiClientLifecycleOptions,
): GeminiTabClaimSnapshot | null => {
  const now = Number(options.now ?? Date.now());
  const claims = options.claims || [];
  const claimId = normalizeString(options.claimId);
  const sessionId = normalizeString(options.sessionId);
  return (
    claims.find((claim) => {
      if (hasExpired(claim, now)) return false;
      if (claimId && claim.claimId !== claimId) return false;
      if (!claimTargetsClient(claim, client)) return false;
      if (sessionId && claim.sessionId && claim.sessionId !== sessionId) return false;
      return true;
    }) || null
  );
};

const hasConflictingClaim = (
  client: GeminiClientSnapshot,
  options: GeminiClientLifecycleOptions,
) => {
  const now = Number(options.now ?? Date.now());
  const sessionId = normalizeString(options.sessionId);
  const claimId = normalizeString(options.claimId);
  return (options.claims || []).some((claim) => {
    if (hasExpired(claim, now)) return false;
    if (!claimTargetsClient(claim, client)) return false;
    if (claimId && claim.claimId !== claimId) return true;
    if (sessionId && claim.sessionId && claim.sessionId !== sessionId) return true;
    return false;
  });
};

const pagePathname = (page: GeminiPageSnapshot): string => {
  if (typeof page.pathname === 'string') return page.pathname;
  if (typeof page.path === 'string') return page.path;
  if (typeof page.url === 'string') {
    try {
      return new URL(page.url).pathname;
    } catch {
      return '';
    }
  }
  return '';
};

const pageHasHydratedGeminiContext = (page: GeminiPageSnapshot) => {
  const pathname = pagePathname(page);
  if (normalizeString(page.chatId)) return true;
  if (normalizeString(page.notebookId)) return true;
  if (/^\/app\/[a-f0-9]{12,}/i.test(pathname)) return true;
  if (pathname.startsWith('/notebook/')) return true;
  if (Number(page.turnCount || 0) > 0) return true;
  if (Number(page.listedConversationCount || 0) > 0) return true;
  if (Number(page.bridgeConversationCount || 0) > 0) return true;
  if (Number(page.sidebarConversationCount || 0) > 0) return true;
  if (Number(page.notebookCacheCount || 0) > 0) return true;
  if (page.sidebarOpen === true) return true;
  return false;
};

const pageIsGeminiAppHome = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  return pathname === '/app' || pathname === '/app/';
};

const pageIsGeminiAppRoute = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  return pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/');
};

const pageHasRecentExportContext = (page: GeminiPageSnapshot): boolean => {
  if (!pageIsGeminiAppRoute(page)) return false;
  if (pageHasHydratedGeminiContext(page)) return true;
  if (pageIsGeminiAppHome(page)) return true;
  return false;
};

const pageHasCurrentChatContext = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  if (normalizeString(page.chatId)) return true;
  if (/^\/app\/[a-f0-9]{12,}/i.test(pathname)) return true;
  return false;
};

const pageBlockerCode = (
  page: GeminiPageSnapshot | null | undefined,
): GeminiClientLifecycleCode | null => {
  const code = normalizeString(page?.blocker?.code);
  if (code === 'google_verification_required') return 'google_verification_required';
  if (code === 'google_login_required') return 'google_login_required';
  if (code === 'google_page_blocked') return 'google_page_blocked';

  const kind = normalizeString(page?.blocker?.kind);
  if (kind === 'google_sorry' || kind === 'google_verification_text') {
    return 'google_verification_required';
  }
  if (kind === 'google_login') return 'google_login_required';
  if (page?.blocker?.terminal === true) return 'google_page_blocked';
  return null;
};

const activeTabOperation = (client: GeminiClientSnapshot) =>
  client.tabOperationInProgress === true ||
  Boolean(client.metrics?.tabOperation?.active) ||
  Boolean(client.summary?.metrics?.tabOperation?.active);

const effectiveIsActiveTab = (client: GeminiClientSnapshot): boolean =>
  client.isActiveTab === true || client.page?.isActiveTab === true;

const runtimeSignalAt = (client: GeminiClientSnapshot): number | null => {
  const lastHeartbeatAt = normalizeNumber(client.lastHeartbeatAt);
  const lastSnapshotAt = normalizeNumber(client.lastSnapshotAt);
  const lastSeenAt = normalizeNumber(client.lastSeenAt);
  const signalAt = Math.max(lastHeartbeatAt || 0, lastSnapshotAt || 0, lastSeenAt || 0);
  return signalAt > 0 ? signalAt : null;
};

export const getGeminiClientLifecycle = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): GeminiClientLifecycle => {
  if (!client?.clientId) {
    return result('disconnected', 'no_connected_client');
  }

  const now = Number(options.now ?? Date.now());
  const lastRuntimeSignalAt = runtimeSignalAt(client);
  if (lastRuntimeSignalAt !== null && now - lastRuntimeSignalAt > options.staleAfterMs) {
    return result('dead', 'client_dead', client);
  }

  const blockerCode = pageBlockerCode(client.page);
  if (blockerCode) {
    return result('blocked', blockerCode, client);
  }

  if (lastRuntimeSignalAt === null && client.page) {
    return result('dead', 'client_dead', client);
  }

  if (
    options.expectedExtensionVersion &&
    String(client.extensionVersion || '') !== String(options.expectedExtensionVersion)
  ) {
    return result('extension_mismatch', 'extension_version_mismatch', client);
  }

  if (
    options.expectedProtocolVersion !== null &&
    options.expectedProtocolVersion !== undefined &&
    Number(client.protocolVersion) !== Number(options.expectedProtocolVersion)
  ) {
    return result('extension_mismatch', 'extension_protocol_mismatch', client);
  }

  if (
    options.expectedBuildStamp &&
    String(clientBuildStamp(client) || '') !== String(options.expectedBuildStamp)
  ) {
    return result('extension_mismatch', 'extension_build_mismatch', client);
  }

  const origin = pageOrigin(client);
  if (
    client.kind === 'activity' ||
    client.page?.kind === 'activity' ||
    origin === 'https://myactivity.google.com'
  ) {
    return result('page_unready', 'activity_client_not_claimable', client);
  }

  const tabId = normalizeNumber(client.tabId);
  if (tabId === null) return result('page_unready', 'missing_tab_id', client);

  if (!effectiveIsActiveTab(client)) return result('page_unready', 'inactive_tab', client);

  const hydrationGraceMs = Number(options.hydrationGraceMs ?? 4000);
  if (!client.page) {
    if (lastRuntimeSignalAt !== null && now - lastRuntimeSignalAt <= hydrationGraceMs) {
      return result('warming_up', 'warming_up', client);
    }
    return result('transport_connected', 'page_not_hydrated', client);
  }

  if (origin !== 'https://gemini.google.com') {
    return result('page_unready', 'page_not_gemini', client);
  }

  const capability = options.capability || null;
  if (capability === 'current-chat') {
    if (!pageHasCurrentChatContext(client.page)) {
      return result('page_unready', 'current_chat_required', client);
    }
  } else if (capability === 'recent-export') {
    if (!pageHasRecentExportContext(client.page)) {
      return result('page_unready', 'page_not_hydrated', client);
    }
  } else if (!pageHasHydratedGeminiContext(client.page)) {
    return result('page_unready', 'page_not_hydrated', client);
  }

  if (options.requireCommandReady === true && client.commandReady !== true) {
    return result('command_unready', 'command_channel_unready', client);
  }

  if (activeTabOperation(client)) {
    return result('busy', 'tab_operation_in_progress', client);
  }

  if (options.requireClaimed === true) {
    const claim = findClaimForClient(client, options);
    if (!claim) {
      if (hasConflictingClaim(client, options)) {
        return result('claimable', 'claim_conflict', client);
      }
      return result('claimable', 'claim_missing', client);
    }
    return result('claimed_ready', null, client, claim);
  }

  return result('claimable', null, client);
};

export const toClaimableGeminiTab = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): ClaimableGeminiTab | null => {
  const lifecycle = getGeminiClientLifecycle(client, options);
  if (lifecycle.state !== 'claimable' || !client?.page?.url) return null;
  return {
    ...client,
    tabId: normalizeNumber(client.tabId) ?? 0,
    isActiveTab: true,
    lastRuntimeSignalAt: runtimeSignalAt(client) ?? 0,
    page: {
      ...client.page,
      url: client.page.url,
    },
    [CLAIMABLE_GEMINI_TAB]: true,
  };
};

export const toClaimedReadyGeminiTab = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): ClaimedReadyGeminiTab | null => {
  const lifecycle = getGeminiClientLifecycle(client, {
    ...options,
    requireClaimed: true,
    requireCommandReady: true,
  });
  if (lifecycle.state !== 'claimed_ready' || !client?.page?.url || !lifecycle.claim) return null;
  return {
    ...client,
    tabId: normalizeNumber(client.tabId) ?? 0,
    isActiveTab: true,
    commandReady: true,
    lastRuntimeSignalAt: runtimeSignalAt(client) ?? 0,
    page: {
      ...client.page,
      url: client.page.url,
    },
    claim: lifecycle.claim,
    [CLAIMABLE_GEMINI_TAB]: true,
    [CLAIMED_READY_GEMINI_TAB]: true,
  };
};

export const assertClaimableGeminiTab = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): ClaimableGeminiTab => {
  const claimable = toClaimableGeminiTab(client, options);
  if (claimable) return claimable;
  const lifecycle = getGeminiClientLifecycle(client, options);
  const error = new Error(`${lifecycle.code}: ${lifecycle.message}`);
  Object.assign(error, { code: lifecycle.code, data: { lifecycle } });
  throw error;
};

export const assertClaimedReadyGeminiTab = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): ClaimedReadyGeminiTab => {
  const claimed = toClaimedReadyGeminiTab(client, {
    ...options,
    requireClaimed: true,
    requireCommandReady: true,
  });
  if (claimed) return claimed;
  const lifecycle = getGeminiClientLifecycle(client, {
    ...options,
    requireClaimed: true,
    requireCommandReady: true,
  });
  const error = new Error(`${lifecycle.code}: ${lifecycle.message}`);
  Object.assign(error, { code: lifecycle.code, data: { lifecycle } });
  throw error;
};

export const getClaimableGeminiTabs = (
  clients: readonly GeminiClientSnapshot[] = [],
  options: GeminiClientLifecycleOptions,
): ClaimableGeminiTab[] =>
  clients.flatMap((client) => {
    const claimable = toClaimableGeminiTab(client, options);
    return claimable ? [claimable] : [];
  });

export const classifyGeminiClientLifecycle = (
  clients: readonly GeminiClientSnapshot[] = [],
  options: GeminiClientLifecycleOptions,
) =>
  clients.map((client) => ({
    client,
    lifecycle: getGeminiClientLifecycle(client, options),
  }));

export const explainGeminiClientLifecycleRejection = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): GeminiClientLifecycleDiagnostic | null => {
  const lifecycle = getGeminiClientLifecycle(client, options);
  if (lifecycle.ok) return null;
  return {
    ok: false,
    code: lifecycle.code || 'no_connected_client',
    message: lifecycle.message,
    state: lifecycle.state,
    nextAction: lifecycle.nextAction,
    retryable: lifecycle.retryable,
    manualReloadRecommended: lifecycle.manualReloadRecommended,
  };
};
