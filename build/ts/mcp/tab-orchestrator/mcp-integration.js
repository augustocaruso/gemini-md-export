import { planTabOrchestration } from './orchestrator.js';
import { initialRecoveryState, reduceRuntimeRecovery, } from './recovery-fsm.js';
import { classifyRuntimeEvidence, runtimeEpochId } from './runtime-epoch-fsm.js';
const isRecord = (value) => value !== null && typeof value === 'object';
const stringOrNull = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const recordOrNull = (value) => (isRecord(value) ? value : null);
export const clientToObservedTabClient = (client, deps) => {
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
        protocolVersion: typeof record.protocolVersion === 'string' || typeof record.protocolVersion === 'number'
            ? record.protocolVersion
            : null,
        lastSeenAt: typeof record.lastSeenAt === 'string' || typeof record.lastSeenAt === 'number'
            ? record.lastSeenAt
            : null,
        eventStreamConnected: deps.clientCommandEventStreamUsable(client),
        commandPollPending: commandPoll?.polling === true,
        pendingCommandPoll: record.pendingPoll === true,
        commandChannelStatus: deps.commandChannelReadyForClient(client) ? 'ready' : null,
        tabClaim: recordOrNull(record.tabClaim),
    };
};
export const buildMcpTabOrchestratorPlan = ({ mode, expected, desiredPageKind, purpose, claimId, clients, clientDeps, allowCreate, createUrl, nowMs = Date.now(), }) => planTabOrchestration({
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
export const summarizeTabOrchestratorPlan = (plan, extras = {}) => {
    const summary = {
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
    if (extras.recovery)
        summary.recovery = extras.recovery;
    if (extras.effectExecution)
        summary.effectExecution = extras.effectExecution;
    return summary;
};
export const tabOrchestratorBlockingIssueForReady = (plan, _legacyBlockingIssue) => {
    const blocker = plan.blocker;
    if (!blocker || blocker.severity !== 'error')
        return null;
    return {
        code: blocker.code,
        message: blocker.message,
        severity: blocker.severity,
        source: 'tab-orchestrator',
    };
};
export const buildTabOrchestratorReloadRecovery = ({ expected, clients = [], clientDeps, nowMs = Date.now(), message = 'Extension context invalidated after reload', }) => {
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
export const createMcpTabOrchestratorEffectAdapter = (deps) => ({
    async reloadExtensionSelf(effect) {
        const client = effect.clientId
            ? deps.getLiveClients().find((item) => isRecord(item) && item.clientId === effect.clientId)
            : null;
        if (!client)
            return { skipped: true, reason: 'no_client_for_extension_reload' };
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
        if (!client)
            return { skipped: true, reason: 'no_client_for_tab_claim' };
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
        const matchingStrongClientCount = plan.evidence.filter((item) => item.epochId === effect.epochId && item.strength === 'strong').length;
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
