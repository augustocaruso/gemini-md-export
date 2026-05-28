import {
  buildMcpTabOrchestratorPlan,
  type ClientToObservedTabClientDeps,
  summarizeTabOrchestratorPlan,
} from './tab-orchestrator/mcp-integration.js';
import type { ExpectedExtensionRuntime } from './tab-orchestrator/types.js';

type UnknownRecord = Record<string, unknown>;

export type ManagedTabSelector = Readonly<{
  clientId?: string | null;
  tabId?: number | string | null;
  claimId?: string | null;
  sessionId?: string | null;
}>;

export type ManagedTabClaim = Readonly<{
  claimId?: string | null;
  clientId?: string | null;
  tabId?: number | string | null;
  sessionId?: string | null;
}>;

export type ManagedChatClientSelectionInput = Readonly<{
  selector?: ManagedTabSelector;
  purpose: string;
  processSessionId: string;
  expected: ExpectedExtensionRuntime;
  clients: readonly unknown[];
  candidateMode?: 'chat-command' | 'recent-chats';
  recentConversationCountForClient?: (client: unknown) => number;
  explicitClaim?: ManagedTabClaim | null;
  explicitClaimClient?: unknown | null;
  sessionClaim?: ManagedTabClaim | null;
  sessionClaimClient?: unknown | null;
  clientDeps: ClientToObservedTabClientDeps;
  nowMs?: number;
}>;

export type ManagedChatClientSelectorDeps = Readonly<{
  cleanupStaleClients: () => void;
  cleanupExpiredTabClaims: () => void;
  normalizeClientSelector: (selector: unknown) => ManagedTabSelector;
  getLiveClients: () => readonly unknown[];
  hydrateClientLifecycleFields: (client: unknown) => unknown;
  claimStore: Readonly<{ get: (claimId: string) => ManagedTabClaim | undefined }>;
  claimForSession: (sessionId?: string | null) => ManagedTabClaim | null | undefined;
  liveClientForClaim: (claim?: ManagedTabClaim | null) => unknown | null;
  processSessionId: string;
  expected: ExpectedExtensionRuntime;
  clientDeps: ClientToObservedTabClientDeps;
  recentConversationCountForClient?: (client: unknown) => number;
}>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeTabId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const clientId = (client: unknown): string | null =>
  isRecord(client) ? stringOrNull(client.clientId) : null;

const clientTabId = (client: unknown): number | null =>
  isRecord(client) ? normalizeTabId(client.tabId) : null;

const clientHasChatId = (client: unknown): boolean => {
  if (!isRecord(client)) return false;
  const page = isRecord(client.page) ? client.page : null;
  return Boolean(stringOrNull(page?.chatId));
};

const recentConversationCount = (
  client: unknown,
  countForClient?: (client: unknown) => number,
): number => {
  if (!countForClient) return 0;
  const count = Number(countForClient(client));
  return Number.isFinite(count) && count > 0 ? count : 0;
};

const selectorClaimId = (
  selector: ManagedTabSelector,
  sessionClaim?: ManagedTabClaim | null,
): string | null => stringOrNull(selector.claimId) || stringOrNull(sessionClaim?.claimId) || null;

const generatedClaimId = (purpose: string, processSessionId: string): string =>
  `managed-${purpose}-${processSessionId}`;

const clientMatchesSelector = (client: unknown, selector: ManagedTabSelector): boolean => {
  const requestedClientId = stringOrNull(selector.clientId);
  if (requestedClientId) return clientId(client) === requestedClientId;

  const requestedTabId = normalizeTabId(selector.tabId);
  if (requestedTabId !== null) return clientTabId(client) === requestedTabId;

  return false;
};

const candidateClientsForSelection = ({
  selector = {},
  clients,
  candidateMode = 'chat-command',
  recentConversationCountForClient,
  explicitClaimClient,
  sessionClaimClient,
}: Pick<
  ManagedChatClientSelectionInput,
  | 'selector'
  | 'clients'
  | 'candidateMode'
  | 'recentConversationCountForClient'
  | 'explicitClaimClient'
  | 'sessionClaimClient'
>): readonly unknown[] => {
  if (selector.claimId) return explicitClaimClient ? [explicitClaimClient] : [];
  if (selector.clientId || (selector.tabId !== null && selector.tabId !== undefined)) {
    return clients.filter((client) => clientMatchesSelector(client, selector));
  }
  if (sessionClaimClient) return [sessionClaimClient];
  if (candidateMode !== 'recent-chats') return clients;

  const usefulRecentClients = clients.filter(
    (client) =>
      recentConversationCount(client, recentConversationCountForClient) > 0 ||
      clientHasChatId(client),
  );
  return usefulRecentClients.length > 0 ? usefulRecentClients : clients;
};

const findSelectedClient = (
  selection: {
    selected?: { clientId: string | null; tabId: number | null };
  },
  candidates: readonly unknown[],
): unknown | null => {
  const selected = selection.selected;
  if (!selected) return null;
  if (selected.clientId) {
    const byClientId = candidates.find((client) => clientId(client) === selected.clientId);
    if (byClientId) return byClientId;
  }
  if (selected.tabId !== null && selected.tabId !== undefined) {
    return candidates.find((client) => clientTabId(client) === selected.tabId) || null;
  }
  return null;
};

export const buildManagedChatClientSelection = ({
  selector = {},
  purpose,
  processSessionId,
  expected,
  clients,
  candidateMode = 'chat-command',
  recentConversationCountForClient,
  explicitClaimClient = null,
  sessionClaim = null,
  sessionClaimClient = null,
  clientDeps,
  nowMs = Date.now(),
}: ManagedChatClientSelectionInput) => {
  const candidates = candidateClientsForSelection({
    selector,
    clients,
    candidateMode,
    recentConversationCountForClient,
    explicitClaimClient,
    sessionClaimClient,
  });
  const claimId =
    selectorClaimId(selector, sessionClaim) || generatedClaimId(purpose, processSessionId);
  const plan = buildMcpTabOrchestratorPlan({
    mode: 'job_safe',
    expected,
    desiredPageKind: 'chat',
    purpose,
    claimId,
    clients: candidates,
    clientDeps,
    allowCreate: false,
    nowMs,
  });
  const summary = summarizeTabOrchestratorPlan(plan);
  if (!plan.ready) {
    return {
      ok: false as const,
      code: plan.blocker?.code || 'managed_tab_unavailable',
      message:
        plan.blocker?.message ||
        'Nao ha aba Gemini pronta para esta operacao. Escolha uma aba, aguarde o carregamento ou recarregue a extensao.',
      tabOrchestrator: summary,
    };
  }

  const client = findSelectedClient(plan, candidates);
  if (!client) {
    return {
      ok: false as const,
      code: 'managed_tab_selected_client_missing',
      message: 'A selecao de aba retornou um alvo que nao esta mais conectado.',
      tabOrchestrator: summary,
    };
  }

  return {
    ok: true as const,
    client,
    claimId,
    tabOrchestrator: summary,
  };
};

export const createManagedChatClientSelector =
  (
    cleanupStaleClients: ManagedChatClientSelectorDeps['cleanupStaleClients'],
    cleanupExpiredTabClaims: ManagedChatClientSelectorDeps['cleanupExpiredTabClaims'],
    normalizeClientSelector: ManagedChatClientSelectorDeps['normalizeClientSelector'],
    getLiveClients: ManagedChatClientSelectorDeps['getLiveClients'],
    hydrateClientLifecycleFields: ManagedChatClientSelectorDeps['hydrateClientLifecycleFields'],
    claimStore: ManagedChatClientSelectorDeps['claimStore'],
    claimForSession: ManagedChatClientSelectorDeps['claimForSession'],
    liveClientForClaim: ManagedChatClientSelectorDeps['liveClientForClaim'],
    processSessionId: string,
    expected: ExpectedExtensionRuntime,
    clientDeps: ClientToObservedTabClientDeps,
    recentConversationCountForClient?: ManagedChatClientSelectorDeps['recentConversationCountForClient'],
  ) =>
  (
    selector: unknown = {},
    purpose = 'browser-command',
    options: Readonly<{ candidateMode?: ManagedChatClientSelectionInput['candidateMode'] }> = {},
  ): unknown => {
    cleanupStaleClients();
    cleanupExpiredTabClaims();
    const normalized = normalizeClientSelector(selector);
    const explicitClaim = normalized.claimId ? claimStore.get(normalized.claimId) : null;
    const sessionClaim = claimForSession(normalized.sessionId) || null;
    const result = buildManagedChatClientSelection({
      selector: normalized,
      purpose,
      processSessionId,
      expected,
      clients: getLiveClients().map(hydrateClientLifecycleFields),
      candidateMode: options.candidateMode,
      recentConversationCountForClient,
      explicitClaim,
      explicitClaimClient: liveClientForClaim(explicitClaim),
      sessionClaim,
      sessionClaimClient: liveClientForClaim(sessionClaim),
      clientDeps,
    });
    if (result.ok) return result.client;

    throw Object.assign(new Error(result.message), {
      code: result.code,
      data: {
        selector: normalized,
        tabOrchestrator: result.tabOrchestrator,
      },
    });
  };
