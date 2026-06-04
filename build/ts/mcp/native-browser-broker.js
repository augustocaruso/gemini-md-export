import { defaultBrokerIpcPath, requestBrokerIpc } from '../native/local-ipc.js';
import { makeNativeRequest, } from '../native/protocol.js';
const DEFAULT_EXTENSION_SELF_HEAL_TIMEOUT_MS = 30_000;
const numberPayload = (payload, key, fallback) => {
    if (!payload || typeof payload !== 'object')
        return fallback;
    const value = Number(payload[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
const nativeRequestTimeoutMs = (request) => numberPayload(request.payload, 'timeoutMs', 5000);
export const nativeBrowserBrokerIpcTimeoutMs = (request) => nativeRequestTimeoutMs(request) + 1500;
export const shouldUseNativeBrowserBroker = ({ disabled = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER === 'disabled', } = {}) => disabled !== true;
export const nativeBrowserBrokerFailureCode = (response) => {
    const value = response;
    const nestedCode = value?.error && typeof value.error === 'object' ? String(value.error.code || '') : '';
    return nestedCode || String(value?.code || '');
};
export const canFallbackFromNativeBrowserBrokerFailure = (response, { strict = false } = {}) => {
    if (strict)
        return false;
    const value = response;
    if (value?.allowFallback === true)
        return true;
    const code = nativeBrowserBrokerFailureCode(response);
    if (code === 'native_broker_unavailable' ||
        code === 'extension_unavailable' ||
        code === 'extension_request_timeout' ||
        code === 'native_broker_probe_timeout') {
        return true;
    }
    const message = typeof value?.error === 'string'
        ? value.error
        : value?.error && typeof value.error === 'object'
            ? String(value.error.message || '')
            : String(value?.error || '');
    return /ECONNREFUSED|ENOENT|EPIPE|socket|timeout/i.test(message);
};
export const createNativeBrowserBrokerClient = ({ path = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(), request = (nativeRequest) => requestBrokerIpc(path, nativeRequest, {
    timeoutMs: nativeBrowserBrokerIpcTimeoutMs(nativeRequest),
}), } = {}) => {
    const call = async (command, payload = {}, options = {}) => {
        try {
            return await request(makeNativeRequest(command, payload));
        }
        catch (err) {
            return {
                ok: false,
                code: 'native_broker_unavailable',
                error: err instanceof Error ? err.message : String(err),
                allowFallback: options.allowFallback === true,
            };
        }
    };
    return {
        listTabs: (options = {}) => call('tabs.list', {}, options),
        status: (options = {}) => call('tabs.status', {}, options),
        claim: (payload = {}, options = {}) => call('tabs.claim', payload, options),
        release: (payload = {}, options = {}) => call('tabs.release', payload, options),
        activate: (payload = {}, options = {}) => call('tabs.activate', payload, options),
        reload: (payload = {}, options = {}) => call('tabs.reload', payload, options),
        keepAlive: (payload = {}, options = {}) => call('extension.keepAlive', payload, options),
        extensionStatus: (options = {}) => call('extension.status', {}, options),
        selfHealContentScripts: (payload = {}, options = {}) => call('extension.selfHealContentScripts', { timeoutMs: DEFAULT_EXTENSION_SELF_HEAL_TIMEOUT_MS, ...payload }, options),
        reloadManagedTabs: (payload = {}, options = {}) => call('extension.reloadManagedTabs', payload, options),
        reloadExtensionSelf: (payload = {}, options = {}) => call('extension.reloadSelf', payload, options),
        privateApiSessionStatus: (payload = {}, options = {}) => call('privateApi.sessionStatus', payload, options),
        privateApiListChats: (payload = {}, options = {}) => call('privateApi.listChats', payload, options),
        privateApiReadChat: (payload = {}, options = {}) => call('privateApi.readChat', payload, options),
    };
};
