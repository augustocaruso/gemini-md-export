import { reloadExtensionFromOwnedDevToolsActivePort } from '../cdp/runtime-options.js';
import { runLocalExtensionCdpReload, } from '../cli/local-extension-cdp-reload.js';
const errorMessage = (err) => {
    if (err instanceof Error)
        return err.message;
    if (err && typeof err === 'object') {
        const record = err;
        for (const key of ['message', 'error', 'detail']) {
            if (typeof record[key] === 'string' && record[key])
                return record[key];
        }
    }
    return String(err || '');
};
export const isExtensionContextInvalidatedError = (err) => /Extension context invalidated/i.test(errorMessage(err));
export const extensionReloadAssumedResultForError = (err) => {
    if (!isExtensionContextInvalidatedError(err))
        return null;
    return {
        ok: true,
        reloading: true,
        assumed: true,
        reason: 'extension-context-invalidated',
        detail: errorMessage(err),
    };
};
const normalizeExtensionReloadBody = (body) => body && typeof body === 'object' ? body : {};
const errorCode = (err) => err && typeof err === 'object' && 'code' in err
    ? String(err.code || 'cdp_extension_reload_failed')
    : 'cdp_extension_reload_failed';
export const runBridgeCdpExtensionReloadHttpRequest = async (body, assertBrowserSideEffect) => {
    try {
        const reloadBody = normalizeExtensionReloadBody(await body);
        assertBrowserSideEffect('extension-reload', {
            explicit: reloadBody.allowReload === true || reloadBody.explicit === true,
        });
        return {
            status: 200,
            body: await runLocalExtensionCdpReload(reloadBody, {
                reloadExtensionFromDevToolsActivePort: reloadExtensionFromOwnedDevToolsActivePort,
            }),
        };
    }
    catch (err) {
        return {
            status: 503,
            body: {
                ok: false,
                mode: 'cdp-browser-websocket',
                attempted: true,
                code: errorCode(err),
                error: errorMessage(err),
            },
        };
    }
};
