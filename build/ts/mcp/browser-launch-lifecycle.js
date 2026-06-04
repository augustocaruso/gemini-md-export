import { evaluateBrowserLaunchGate, observeBrowserLaunchResult, } from './blocker-aware-tab-lifecycle.js';
const recordOrEmpty = (value) => value !== null && typeof value === 'object' ? value : {};
const blockedBrowserDiagnostic = (browserTabs, blocker) => ({
    ok: browserTabs?.ok === true,
    source: browserTabs?.source || 'unknown',
    diagnosis: blocker
        ? {
            kind: blocker.kind,
            terminal: true,
            url: blocker.url || null,
        }
        : browserTabs?.diagnosis || null,
    error: browserTabs?.error || null,
});
export const evaluateMcpBrowserLaunchGate = ({ previousState, browserTabs, nowMs, launchId, targetUrl, }) => {
    const gate = evaluateBrowserLaunchGate({
        launchState: previousState,
        diagnosis: browserTabs?.diagnosis || null,
        nowMs,
        launchId,
        source: 'mcp',
        targetUrl,
    });
    if (gate.canLaunch) {
        return {
            canLaunch: true,
            state: gate.state,
            blockedLaunch: null,
            blockedLaunchState: null,
        };
    }
    const blockedLaunch = {
        attempted: false,
        supported: true,
        skipped: true,
        reason: 'terminal-browser-blocker',
        blocker: gate.blocker,
        browserDiagnostic: blockedBrowserDiagnostic(browserTabs, gate.blocker),
    };
    return {
        canLaunch: false,
        state: gate.state,
        blockedLaunch,
        blockedLaunchState: {
            ...recordOrEmpty(previousState),
            source: 'mcp',
            launchId,
            status: 'blocked',
            lastAttemptAt: nowMs,
            updatedAt: new Date(nowMs).toISOString(),
            targetUrl,
            blockingIssue: gate.blocker?.code || null,
            tabLifecycle: gate.state,
            launch: blockedLaunch,
        },
    };
};
export const observeMcpBrowserLaunchResultState = ({ state, nowMs = Date.now(), launchId, targetUrl, result, }) => observeBrowserLaunchResult({
    state,
    nowMs,
    launchId,
    source: 'mcp',
    targetUrl,
    result,
}).state;
