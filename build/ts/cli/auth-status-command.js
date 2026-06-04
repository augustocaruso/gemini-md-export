import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';
const recordValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const textContentFromToolResult = (result) => {
    const content = result.content;
    if (!Array.isArray(content))
        return null;
    const item = content.find((candidate) => recordValue(candidate).type === 'text' && typeof recordValue(candidate).text === 'string');
    return stringValue(item?.text);
};
export const buildAuthStatusToolCall = (flags = {}) => ({
    name: 'gemini_support',
    arguments: {
        action: 'session_status',
        waitMs: flags.waitMs,
        cookiesJson: flags.cookiesJson,
        pythonFallback: Boolean(flags.cookiesJson || flags.python),
        python: flags.python,
        clientId: flags.clientId,
        tabId: flags.tabId,
        claimId: flags.claimId,
        sessionId: flags.sessionId,
    },
});
export const buildAuthHelp = ({ commonOptions = [], outputModes = [], } = {}) => [
    'gemini-md-export auth status',
    '',
    'Uso:',
    '  gemini-md-export auth status [opcoes]',
    '',
    'Verifica a sessao usada pela API privada. Primeiro tenta a extensao/navegador logado; se',
    'necessario, diagnostica o sidecar Python e o arquivo de cookies informado.',
    '',
    'Opcoes:',
    '  --cookies-json <path>   storage_state.json/JSON de cookies para o fallback Python.',
    '  --python <path>         Python explicito para o sidecar.',
    '  --wake                  Acorda/abre Gemini antes de verificar a sessao. Default do auth.',
    '  --no-wake               Nao abre navegador; usa apenas aba/extensao ja conectada.',
    '  --allow-reload          Pode recarregar extensao/abas existentes antes da verificacao.',
    '  --wait-ms <ms>          Timeout da verificacao.',
    '',
    ...commonOptions,
    '',
    ...outputModes,
].join('\n');
export const extractAuthStatusResult = (payload) => {
    const payloadRecord = recordValue(payload);
    const result = recordValue(payloadRecord.result ?? payload);
    const structuredContent = recordValue(result.structuredContent);
    if (Object.keys(structuredContent).length > 0)
        return structuredContent;
    const text = textContentFromToolResult(result);
    if (text) {
        try {
            return recordValue(JSON.parse(text));
        }
        catch {
            return { ok: false, error: text };
        }
    }
    return result;
};
export const authStatusIsOk = (result) => result.ok === true;
export const formatAuthStatusLabel = (result) => {
    if (authStatusIsOk(result)) {
        return `Auth: ok via ${stringValue(result.selectedAdapter) || 'nenhum adapter'}`;
    }
    const nextAction = recordValue(result.nextAction);
    const message = stringValue(nextAction.message) ||
        stringValue(result.message) ||
        stringValue(result.error) ||
        'Sessao nao pronta.';
    return `Auth: requer acao - ${message}`;
};
const usageError = (message) => {
    const error = new Error(message);
    error.code = 'usage';
    return error;
};
const bridgePostTimeoutMs = (waitMs) => Math.max(5000, Number(waitMs || 45_000)) + 15_000;
const shouldWakeBrowserForAuthStatus = (flags) => flags.wakeBrowser === true || flags.wakeBrowserExplicit !== true;
export const runAuthStatusCommand = async ({ subcommand = 'status', flags = {}, ui = {}, dependencies, exitCodes = { ok: 0, manualAction: 4 }, }) => {
    if (!['status', 'check'].includes(subcommand)) {
        throw usageError('Uso: gemini-md-export auth status.');
    }
    const effectiveFlags = applyPrivateApiSessionDefaults(flags);
    const bridgeUrl = stringValue(effectiveFlags.bridgeUrl) || '';
    await dependencies.ensureBridgeAvailable(effectiveFlags, ui);
    await dependencies.readyWithCliWake(bridgeUrl, {
        ...effectiveFlags,
        wakeBrowser: shouldWakeBrowserForAuthStatus(effectiveFlags),
    }, ui);
    const response = await dependencies.requestJson(bridgeUrl, '/agent/mcp-tool-call', {
        method: 'POST',
        timeoutMs: bridgePostTimeoutMs(effectiveFlags.waitMs),
        body: buildAuthStatusToolCall(effectiveFlags),
    });
    const result = extractAuthStatusResult(response);
    dependencies.writeStructuredResult(ui, result, { label: formatAuthStatusLabel(result) });
    return {
        exitCode: authStatusIsOk(result) ? exitCodes.ok : exitCodes.manualAction,
        result,
    };
};
