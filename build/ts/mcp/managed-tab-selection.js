import { buildMcpTabOrchestratorPlan, summarizeTabOrchestratorPlan, } from './tab-orchestrator/mcp-integration.js';
const isRecord = (value) => value !== null && typeof value === 'object';
const stringOrNull = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const normalizeTabId = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
};
const clientId = (client) => isRecord(client) ? stringOrNull(client.clientId) : null;
const clientTabId = (client) => isRecord(client) ? normalizeTabId(client.tabId) : null;
const clientHasChatId = (client) => {
    if (!isRecord(client))
        return false;
    const page = isRecord(client.page) ? client.page : null;
    return Boolean(stringOrNull(page?.chatId));
};
const recentConversationCount = (client, countForClient) => {
    if (!countForClient)
        return 0;
    const count = Number(countForClient(client));
    return Number.isFinite(count) && count > 0 ? count : 0;
};
const selectorClaimId = (selector, sessionClaim) => stringOrNull(selector.claimId) || stringOrNull(sessionClaim?.claimId) || null;
const generatedClaimId = (purpose, processSessionId) => `managed-${purpose}-${processSessionId}`;
const clientMatchesSelector = (client, selector) => {
    const requestedClientId = stringOrNull(selector.clientId);
    if (requestedClientId)
        return clientId(client) === requestedClientId;
    const requestedTabId = normalizeTabId(selector.tabId);
    if (requestedTabId !== null)
        return clientTabId(client) === requestedTabId;
    return false;
};
const candidateClientsForSelection = ({ selector = {}, clients, candidateMode = 'chat-command', recentConversationCountForClient, explicitClaimClient, sessionClaimClient, }) => {
    if (selector.claimId)
        return explicitClaimClient ? [explicitClaimClient] : [];
    if (selector.clientId || (selector.tabId !== null && selector.tabId !== undefined)) {
        return clients.filter((client) => clientMatchesSelector(client, selector));
    }
    if (sessionClaimClient)
        return [sessionClaimClient];
    if (candidateMode !== 'recent-chats')
        return clients;
    const usefulRecentClients = clients.filter((client) => recentConversationCount(client, recentConversationCountForClient) > 0 ||
        clientHasChatId(client));
    return usefulRecentClients.length > 0 ? usefulRecentClients : clients;
};
const findSelectedClient = (selection, candidates) => {
    const selected = selection.selected;
    if (!selected)
        return null;
    if (selected.clientId) {
        const byClientId = candidates.find((client) => clientId(client) === selected.clientId);
        if (byClientId)
            return byClientId;
    }
    if (selected.tabId !== null && selected.tabId !== undefined) {
        return candidates.find((client) => clientTabId(client) === selected.tabId) || null;
    }
    return null;
};
export const buildManagedChatClientSelection = ({ selector = {}, purpose, processSessionId, expected, clients, candidateMode = 'chat-command', recentConversationCountForClient, explicitClaimClient = null, sessionClaim = null, sessionClaimClient = null, clientDeps, nowMs = Date.now(), }) => {
    const candidates = candidateClientsForSelection({
        selector,
        clients,
        candidateMode,
        recentConversationCountForClient,
        explicitClaimClient,
        sessionClaimClient,
    });
    const claimId = selectorClaimId(selector, sessionClaim) || generatedClaimId(purpose, processSessionId);
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
            ok: false,
            code: plan.blocker?.code || 'managed_tab_unavailable',
            message: plan.blocker?.message ||
                'Nao ha aba Gemini pronta para esta operacao. Escolha uma aba, aguarde o carregamento ou recarregue a extensao.',
            tabOrchestrator: summary,
        };
    }
    const client = findSelectedClient(plan, candidates);
    if (!client) {
        return {
            ok: false,
            code: 'managed_tab_selected_client_missing',
            message: 'A selecao de aba retornou um alvo que nao esta mais conectado.',
            tabOrchestrator: summary,
        };
    }
    return {
        ok: true,
        client,
        claimId,
        tabOrchestrator: summary,
    };
};
export const createManagedChatClientSelector = (cleanupStaleClients, cleanupExpiredTabClaims, normalizeClientSelector, getLiveClients, hydrateClientLifecycleFields, claimStore, claimForSession, liveClientForClaim, processSessionId, expected, clientDeps, recentConversationCountForClient) => (selector = {}, purpose = 'browser-command', options = {}) => {
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
    if (result.ok)
        return result.client;
    throw Object.assign(new Error(result.message), {
        code: result.code,
        data: {
            selector: normalized,
            tabOrchestrator: result.tabOrchestrator,
        },
    });
};
