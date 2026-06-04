import { authStatusIsOk, buildAuthStatusToolCall, extractAuthStatusResult, } from './auth-status-command.js';
import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';
export const shouldSkipFixVaultBrowserPrivatePreflight = (flags, env = process.env) => Boolean(flags.python || flags.cookiesJson || env.GME_GEMINI_WEBAPI_RUNNER);
export const assertFixVaultBrowserPrivateSessionReady = async ({ flags, streams, makeUi, warnTuiFallback, ensureBridgeAvailable, readyWithCliWake, requestJson, }) => {
    flags = applyPrivateApiSessionDefaults(flags);
    if (shouldSkipFixVaultBrowserPrivatePreflight(flags))
        return;
    const ui = makeUi(flags, streams);
    warnTuiFallback(ui);
    await ensureBridgeAvailable(flags, ui);
    if (flags.wakeBrowser === true) {
        await readyWithCliWake(flags.bridgeUrl, flags, ui);
    }
    const response = await requestJson(flags.bridgeUrl, '/agent/mcp-tool-call', {
        method: 'POST',
        timeoutMs: Math.max(5000, Number(flags.waitMs || 45_000)) + 15_000,
        body: buildAuthStatusToolCall({
            ...flags,
            cookiesJson: undefined,
            python: undefined,
        }),
    });
    const status = extractAuthStatusResult(response);
    if (authStatusIsOk(status) && status.selectedAdapter === 'browserBackground')
        return;
    const nextAction = status.nextAction && typeof status.nextAction === 'object'
        ? status.nextAction
        : {};
    const err = new Error(String(nextAction.message ||
        status.message ||
        status.error ||
        'A sessao privada do navegador nao ficou pronta para reparar o vault.'));
    err.code = String(nextAction.code || status.code || 'browser_session_not_connected');
    err.nextAction = String(nextAction.message ||
        'Abra o Gemini no navegador logado, aguarde a extensao conectar e rode fix-vault novamente.');
    throw err;
};
export const createFixVaultBrowserPrivateSessionPreflight = (flags, streams, makeUi, warnTuiFallback, ensureBridgeAvailable, readyWithCliWake, requestJson) => () => assertFixVaultBrowserPrivateSessionReady({
    flags,
    streams,
    makeUi,
    warnTuiFallback,
    ensureBridgeAvailable,
    readyWithCliWake,
    requestJson,
});
