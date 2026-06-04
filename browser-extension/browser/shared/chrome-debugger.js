const lastChromeErrorMessage = (chromeApi) => {
    const message = chromeApi.runtime?.lastError?.message;
    return typeof message === 'string' && message ? message : null;
};
const callbackResult = (chromeApi, invoke, errorReason) => new Promise((resolve) => {
    try {
        invoke((result) => {
            const error = lastChromeErrorMessage(chromeApi);
            if (error) {
                resolve({ __chromeDebuggerError: { reason: errorReason, error } });
                return;
            }
            resolve(result);
        });
    }
    catch (err) {
        resolve({
            __chromeDebuggerError: {
                reason: errorReason,
                error: err instanceof Error ? err.message : String(err),
            },
        });
    }
});
const debuggerErrorFromResult = (result) => {
    const marker = result
        ?.__chromeDebuggerError;
    if (!marker?.error)
        return null;
    return {
        reason: marker.reason || 'debugger-command-failed',
        error: marker.error,
    };
};
export const shouldUseDebuggerForTabControl = (chromeApi, options = {}) => options.disableDebugger !== true &&
    typeof chromeApi?.debugger?.attach === 'function' &&
    typeof chromeApi.debugger.sendCommand === 'function' &&
    typeof chromeApi.debugger.detach === 'function';
export const activateTabWithDebugger = async (tabId, options = {}) => {
    const chromeApi = options.chromeApi || globalThis.chrome;
    const protocolVersion = options.protocolVersion || '1.3';
    if (!Number.isInteger(tabId) || tabId <= 0) {
        return {
            ok: false,
            mode: 'chrome-debugger-cdp',
            reason: 'tab-id-unavailable',
            tabId: null,
        };
    }
    if (!chromeApi || !shouldUseDebuggerForTabControl(chromeApi, options) || !chromeApi.debugger) {
        return {
            ok: false,
            mode: 'chrome-debugger-cdp',
            reason: 'debugger-api-unavailable',
            tabId,
        };
    }
    const debuggerApi = chromeApi.debugger;
    const target = { tabId };
    const attached = await callbackResult(chromeApi, (callback) => debuggerApi.attach(target, protocolVersion, callback), 'debugger-attach-failed');
    const attachError = debuggerErrorFromResult(attached);
    if (attachError) {
        return {
            ok: false,
            mode: 'chrome-debugger-cdp',
            reason: attachError.reason,
            error: attachError.error,
            tabId,
            protocolVersion,
        };
    }
    try {
        const result = await callbackResult(chromeApi, (callback) => debuggerApi.sendCommand(target, 'Page.bringToFront', {}, callback), 'debugger-command-failed');
        const commandError = debuggerErrorFromResult(result);
        if (commandError) {
            return {
                ok: false,
                mode: 'chrome-debugger-cdp',
                reason: commandError.reason,
                error: commandError.error,
                tabId,
                protocolVersion,
            };
        }
        return {
            ok: true,
            mode: 'chrome-debugger-cdp',
            reason: options.reason || 'activate-tab',
            tabId,
            protocolVersion,
            result,
        };
    }
    finally {
        await new Promise((resolve) => {
            try {
                debuggerApi.detach(target, () => resolve());
            }
            catch {
                resolve();
            }
        });
    }
};
