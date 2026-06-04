const numberOrNull = (value) => {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
};
const commandArgs = (command) => command.args || {};
const sharedTabCommandSideEffectCommands = new Set([
    'activate-browser-tab',
    'activate-tab',
    'claim-tab',
    'release-tab-claim',
    'release-tab-claim-by-tab-id',
    'reload-extension-self',
]);
const hasExplicitBrowserIntent = (args) => args.explicit === true ||
    args.explicitBrowserSideEffect === true ||
    args.browserSideEffectExplicit === true;
const hasBrowserAuthorityLease = (args) => typeof args.browserAuthorityLeaseId === 'string' &&
    args.browserAuthorityLeaseId.trim().length > 0;
const sharedTabCommandExplicitIntentRequired = (command) => ({
    ok: false,
    code: 'explicit_browser_intent_required',
    status: 'explicit-browser-intent-required',
    reason: command.args?.reason || 'bridge-command',
    skipped: true,
});
const sharedTabCommandAuthorityLeaseRequired = (command) => ({
    ok: false,
    code: 'browser_authority_lease_missing',
    status: 'browser-authority-lease-missing',
    reason: command.args?.reason || 'bridge-command',
    skipped: true,
});
export const createSharedTabCommandHandlers = (options) => {
    const getTabId = () => options.getTabId?.() ?? options.state?.tabId ?? null;
    const getWindowId = () => options.getWindowId?.() ?? options.state?.windowId ?? null;
    const getTabClaim = () => options.getTabClaim?.() ?? options.state?.tabClaim ?? null;
    const setTabClaim = (claim) => {
        if (options.setTabClaim)
            options.setTabClaim(claim);
        else if (options.state)
            options.state.tabClaim = claim;
    };
    const clearTabClaim = () => {
        if (options.clearTabClaim)
            options.clearTabClaim();
        else
            setTabClaim(null);
    };
    const execute = async (command) => {
        const args = commandArgs(command);
        if (command.type === 'get-extension-info') {
            if (options.getExtensionInfo)
                return options.getExtensionInfo(command);
            const response = await options.extensionSendMessage({ type: 'GET_EXTENSION_INFO' }, { timeoutMs: 3500 });
            if (response?.ok && options.state) {
                options.state.extensionVersion =
                    String(response.extensionVersion || response.version || '') || null;
                options.state.protocolVersion =
                    typeof response.protocolVersion === 'number' ? response.protocolVersion : null;
                options.state.buildStamp = String(response.buildStamp || '') || null;
                options.state.tabId = numberOrNull(response.tabId);
                options.state.windowId = numberOrNull(response.windowId);
                options.state.isActiveTab =
                    typeof response.isActiveTab === 'boolean' ? response.isActiveTab : null;
            }
            return {
                ...(response || { ok: false, reason: 'empty-extension-info-response' }),
                contentScript: true,
                serviceWorker: response?.ok === true,
            };
        }
        if (sharedTabCommandSideEffectCommands.has(String(command.type || '')) &&
            !hasExplicitBrowserIntent(args)) {
            return sharedTabCommandExplicitIntentRequired(command);
        }
        if (sharedTabCommandSideEffectCommands.has(String(command.type || '')) &&
            !hasBrowserAuthorityLease(args)) {
            return sharedTabCommandAuthorityLeaseRequired(command);
        }
        if (command.type === 'reload-extension-self') {
            const response = await options.extensionSendMessage({
                type: 'RELOAD_SELF',
                reason: args.reason || options.defaultReason,
                expectedExtensionVersion: args.expectedExtensionVersion || null,
                expectedProtocolVersion: args.expectedProtocolVersion || null,
                expectedBuildStamp: args.expectedBuildStamp || null,
            }, { timeoutMs: 3500 });
            return response || { ok: false, reason: 'empty-reload-response' };
        }
        if (command.type === 'activate-tab' || command.type === 'activate-browser-tab') {
            const requestedTabId = numberOrNull(args.tabId ?? args.targetTabId);
            const response = await options.extensionSendMessage({
                type: 'gemini-md-export/activate-tab',
                tabId: requestedTabId ?? undefined,
                reason: args.reason || options.defaultReason,
                focusWindow: args.focusWindow === true,
            }, { timeoutMs: 5000 });
            const localTabId = numberOrNull(getTabId());
            if (typeof response?.isActiveTab === 'boolean' &&
                (requestedTabId === null || requestedTabId === localTabId)) {
                if (options.setIsActiveTab)
                    options.setIsActiveTab(response.isActiveTab);
                else if (options.state)
                    options.state.isActiveTab = response.isActiveTab;
            }
            return response || { ok: false, reason: 'empty-activate-tab-response' };
        }
        if (command.type === 'claim-tab') {
            const claimId = String(args.claimId || '').trim();
            if (!claimId)
                return { ok: false, reason: 'claim-id-required' };
            const claim = {
                claimId,
                sessionId: args.sessionId || null,
                label: args.label || options.defaultClaimLabel,
                color: args.color || options.defaultClaimColor,
                expiresAt: args.expiresAt || null,
                visualGroupTabId: numberOrNull(args.visualGroupTabId ?? args.groupWithTabId),
            };
            const response = await options.extensionSendMessage({
                type: 'gemini-md-export/claim-tab',
                ...claim,
            }, { timeoutMs: 5000 });
            if (response?.ok) {
                if (options.rememberTabClaim)
                    options.rememberTabClaim(claim, response);
                else {
                    setTabClaim({
                        ...claim,
                        tabId: response.tabId ??
                            response.visual?.tabId ??
                            getTabId(),
                        windowId: response.windowId ?? getWindowId(),
                        visual: response.visual || response,
                    });
                }
            }
            return response || { ok: false, reason: 'empty-claim-response' };
        }
        if (command.type === 'release-tab-claim') {
            if (options.releaseCurrentTabClaim) {
                const response = await options.releaseCurrentTabClaim({
                    claimId: args.claimId || null,
                    reason: String(args.reason || options.defaultReason),
                });
                return response || { ok: false, reason: 'empty-release-response' };
            }
            const response = await options.extensionSendMessage({
                type: 'gemini-md-export/release-tab-claim',
                tabId: args.tabId ?? getTabId(),
                claimId: args.claimId || getTabClaim()?.claimId || null,
                reason: args.reason || options.defaultReason,
            }, { timeoutMs: 5000 });
            if (response?.ok)
                clearTabClaim();
            return response || { ok: false, reason: 'empty-release-response' };
        }
        if (command.type === 'release-tab-claim-by-tab-id') {
            const requestedTabId = numberOrNull(args.tabId);
            const response = await options.extensionSendMessage({
                type: 'gemini-md-export/release-tab-claim',
                tabId: requestedTabId ?? getTabId(),
                claimId: args.claimId || getTabClaim()?.claimId || null,
                reason: args.reason || `${options.defaultReason}-tab-id-release`,
            }, { timeoutMs: 5000 });
            const localTabId = numberOrNull(getTabId());
            const localClaim = getTabClaim();
            const targetsThisTab = requestedTabId !== null && localTabId !== null && requestedTabId === localTabId;
            const claimMatches = !args.claimId || !localClaim?.claimId || localClaim.claimId === args.claimId;
            if (response?.ok && targetsThisTab && claimMatches)
                clearTabClaim();
            await options.afterReleaseByTabId?.({
                command,
                response,
                requestedTabId: requestedTabId ?? -1,
            });
            return response || { ok: false, reason: 'empty-release-response' };
        }
        return undefined;
    };
    return { execute };
};
