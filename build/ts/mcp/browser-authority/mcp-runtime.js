import { browserAuthorityLeaseToken, initialBrowserAuthorityState, transitionBrowserAuthority, } from './index.js';
const DEFAULT_BROWSER_AUTHORITY_BUDGET_MS = 120_000;
export const defaultBrowserAuthorityBudget = (nowMs = Date.now(), overrides = {}) => ({
    maxNewTabs: overrides.maxNewTabs ?? 0,
    maxReloads: overrides.maxReloads ?? 0,
    maxActivations: overrides.maxActivations ?? 0,
    maxNavigations: overrides.maxNavigations ?? 0,
    deadlineAtMs: overrides.deadlineAtMs ?? nowMs + DEFAULT_BROWSER_AUTHORITY_BUDGET_MS,
});
export const createBrowserAuthorityLeaseForMcp = ({ state = initialBrowserAuthorityState(), nowMs = Date.now(), leaseId, operationId, operationKind, policy, budget, }) => {
    const result = transitionBrowserAuthority(state, {
        type: 'leaseRequested',
        nowMs,
        leaseId,
        operationId,
        operationKind,
        owner: 'mcp',
        policy,
        budget,
    });
    const lease = result.state.leases.find((item) => item.leaseId === leaseId);
    if (!lease) {
        throw Object.assign(new Error(result.blocker?.message || 'Controle do navegador bloqueado.'), {
            code: result.blocker?.code || 'browser_authority_lease_blocked',
            data: { blocker: result.blocker || null },
        });
    }
    return { state: result.state, lease, token: browserAuthorityLeaseToken(lease) };
};
export const mutatingBrowserCommandTypes = new Set([
    'activate-browser-tab',
    'activate-tab',
    'claim-tab',
    'get-chat-by-id',
    'load-more-conversations',
    'open-chat',
    'release-tab-claim',
    'release-tab-claim-by-tab-id',
    'reload-extension-self',
    'reload-gemini-tabs',
    'reload-page',
]);
export const browserAuthorityBudgetForCommand = (commandType, nowMs = Date.now()) => {
    const reload = commandType === 'reload-page' || commandType === 'reload-gemini-tabs';
    const extensionReload = commandType === 'reload-extension-self';
    const activate = commandType === 'activate-browser-tab' || commandType === 'activate-tab';
    const navigate = commandType === 'open-chat' || commandType === 'get-chat-by-id';
    return defaultBrowserAuthorityBudget(nowMs, {
        maxReloads: reload || extensionReload ? 1 : 0,
        maxActivations: activate ? 1 : 0,
        maxNavigations: navigate ? 1 : 0,
    });
};
export const browserAuthorityOperationKindForCommand = (commandType) => {
    if (commandType === 'claim-tab' || commandType === 'release-tab-claim')
        return 'tab_management';
    if (commandType === 'release-tab-claim-by-tab-id')
        return 'tab_management';
    if (commandType === 'reload-gemini-tabs' || commandType === 'reload-page')
        return 'tab_management';
    if (commandType === 'reload-extension-self')
        return 'ready_check';
    if (commandType === 'open-chat' || commandType === 'get-chat-by-id')
        return 'selected_export';
    return 'diagnostic';
};
export const assertBrowserAuthorityCommandAllowed = ({ commandType, args, }) => {
    if (!mutatingBrowserCommandTypes.has(commandType))
        return;
    if (typeof args.browserAuthorityLeaseId === 'string' && args.browserAuthorityLeaseId.trim()) {
        return;
    }
    throw Object.assign(new Error('Comando de navegador bloqueado: faltou autorizacao da operacao.'), { code: 'browser_authority_lease_missing' });
};
export const attachBrowserAuthorityLeaseToCommand = ({ state, commandType, args, operationId, nowMs = Date.now(), }) => {
    if (!mutatingBrowserCommandTypes.has(commandType)) {
        return { state, args, lease: null };
    }
    if (typeof args.browserAuthorityLeaseId === 'string' && args.browserAuthorityLeaseId.trim()) {
        return {
            state,
            args,
            lease: state.leases.find((item) => item.leaseId === args.browserAuthorityLeaseId) || null,
        };
    }
    const leaseId = `mcp-${operationId}-${commandType}-${nowMs}`;
    const leased = createBrowserAuthorityLeaseForMcp({
        state,
        nowMs,
        leaseId,
        operationId,
        operationKind: browserAuthorityOperationKindForCommand(commandType),
        policy: 'interactive_explicit',
        budget: browserAuthorityBudgetForCommand(commandType, nowMs),
    });
    return {
        state: leased.state,
        lease: leased.lease,
        args: {
            ...args,
            browserAuthorityLeaseId: leased.lease.leaseId,
        },
    };
};
export const prepareMcpBrowserAuthorityCommand = ({ state, commandType, args, options = {}, operationIdFallback, nowMs = Date.now(), }) => {
    const browserSideEffectExplicit = options.browserSideEffectExplicit === true ||
        args.browserSideEffectExplicit === true ||
        args.explicitBrowserSideEffect === true;
    const markedArgs = browserSideEffectExplicit
        ? {
            ...args,
            explicit: true,
            explicitBrowserSideEffect: true,
        }
        : args;
    if (!mutatingBrowserCommandTypes.has(commandType) || !browserSideEffectExplicit) {
        return { state, args: markedArgs, browserSideEffectExplicit };
    }
    const authority = attachBrowserAuthorityLeaseToCommand({
        state,
        commandType,
        args: markedArgs,
        operationId: String(options.operationId ||
            args.jobId ||
            args.claimId ||
            args.sessionId ||
            operationIdFallback ||
            'mcp-command'),
        nowMs,
    });
    assertBrowserAuthorityCommandAllowed({ commandType, args: authority.args });
    return {
        state: authority.state,
        args: authority.args,
        browserSideEffectExplicit,
    };
};
