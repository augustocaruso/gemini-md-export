import { createCdpRuntimeSessionOwner, } from './runtime-session-owner.js';
import { activateExtensionClientWithCdp, buildCdpControlSnapshot, cdpUrlForRuntimeInput, } from './tab-session-broker.js';
export const CDP_ENV_KEYS = Object.freeze([
    'GEMINI_MD_EXPORT_CDP_URL',
    'GEMINI_MCP_CDP_URL',
    'GME_CDP_URL',
]);
export const CDP_DEVTOOLS_ACTIVE_PORT_FILE_ENV_KEYS = Object.freeze([
    'GEMINI_MD_EXPORT_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
    'GEMINI_MCP_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
    'GME_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
]);
export const defaultCdpUrlFromEnv = (env = process.env) => {
    for (const key of CDP_ENV_KEYS) {
        const value = String(env[key] || '').trim();
        if (value)
            return value;
    }
    return '';
};
export const defaultDevToolsActivePortFileFromEnv = (env = process.env) => {
    for (const key of CDP_DEVTOOLS_ACTIVE_PORT_FILE_ENV_KEYS) {
        const value = String(env[key] || '').trim();
        if (value)
            return value;
    }
    return '';
};
export const cdpRuntimeInputForArgs = (args = {}, options = {}) => {
    const defaultCdpUrl = options.defaultCdpUrl !== undefined ? options.defaultCdpUrl : defaultCdpUrlFromEnv(options.env);
    const defaultDevToolsActivePortFile = defaultDevToolsActivePortFileFromEnv(options.env);
    const input = {
        ...args,
        defaultCdpUrl,
        ...(defaultDevToolsActivePortFile ? { defaultDevToolsActivePortFile } : {}),
    };
    const devToolsActivePortFile = String(input.devToolsActivePortFile || input.defaultDevToolsActivePortFile || '').trim();
    return {
        ...input,
        cdpUrl: cdpUrlForRuntimeInput(input),
        ...(devToolsActivePortFile ? { devToolsActivePortFile } : {}),
    };
};
export const buildRuntimeCdpControlSnapshot = (args = {}, options = {}, deps = {}) => buildCdpControlSnapshot(cdpRuntimeInputForArgs(args, options), deps);
export const activateRuntimeExtensionClientWithCdp = (client, args = {}, options = {}, deps = {}) => activateExtensionClientWithCdp(client, cdpRuntimeInputForArgs(args, options), deps);
const ownedCdpRuntimeSessionOwner = createCdpRuntimeSessionOwner();
export const buildOwnedRuntimeCdpControlSnapshot = (args = {}, options = {}) => buildRuntimeCdpControlSnapshot(args, options, ownedCdpRuntimeSessionOwner);
export const activateOwnedRuntimeExtensionClientWithCdp = (client, args = {}, options = {}) => activateRuntimeExtensionClientWithCdp(client, args, options, ownedCdpRuntimeSessionOwner);
export const reloadExtensionFromOwnedDevToolsActivePort = (args) => ownedCdpRuntimeSessionOwner.reloadExtensionFromDevToolsActivePort(args);
export const closeOwnedCdpRuntimeSessionOwner = () => ownedCdpRuntimeSessionOwner.closeAll();
export const createOwnedCdpRuntimePorts = (options = {}) => ({
    buildSnapshot: (args = {}) => buildOwnedRuntimeCdpControlSnapshot(args, options),
    activateClient: (client, args = {}) => activateOwnedRuntimeExtensionClientWithCdp(client, args, options),
    close: closeOwnedCdpRuntimeSessionOwner,
});
export const cdpRuntime = createOwnedCdpRuntimePorts();
export const browserControlParamsFromFlags = (flags = {}) => {
    const cdpUrl = String(flags.cdpUrl || '').trim();
    const params = {
        activateTab: flags.activateTab === true,
        focusWindow: flags.focusWindow === true,
        ...(flags.allowHttpBrowserFallback === true ? { allowHttpBrowserFallback: true } : {}),
    };
    return cdpUrl ? { ...params, cdpUrl, controlPlane: 'cdp' } : params;
};
