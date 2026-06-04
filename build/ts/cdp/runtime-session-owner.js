import { activateCdpTarget, buildCdpBrowserSnapshot, normalizeCdpEndpoint, } from './browser-control.js';
import { createBrowserWebSocketSession, findExtensionManagementTarget, parseDevToolsActivePort, readDevToolsActivePort, } from './browser-websocket.js';
const fetchVersion = async (endpoint, fetchImpl) => {
    const response = await fetchImpl(`${normalizeCdpEndpoint(endpoint)}/json/version`, {
        method: 'GET',
    });
    if (!response.ok)
        return null;
    return (await response.json());
};
const browserWebSocketUrlFromVersion = (version) => {
    const value = version?.webSocketDebuggerUrl;
    return typeof value === 'string' ? value.trim() : '';
};
export const createCdpRuntimeSessionOwner = ({ fetchImpl = fetch, WebSocketImpl, timeoutMs, } = {}) => {
    const sessions = new Map();
    const endpointBrowserUrls = new Map();
    const sessionForUrl = (browserWebSocketUrl) => {
        const cached = sessions.get(browserWebSocketUrl);
        if (cached)
            return cached;
        const session = createBrowserWebSocketSession({
            browserWebSocketUrl,
            WebSocketImpl,
            timeoutMs,
        });
        sessions.set(browserWebSocketUrl, session);
        return session;
    };
    const resolveBrowserWebSocketUrl = async (options) => {
        const explicit = String(options.browserWebSocketUrl || '').trim();
        if (explicit)
            return explicit;
        const endpoint = normalizeCdpEndpoint(options.endpoint);
        const cached = endpointBrowserUrls.get(endpoint);
        if (cached)
            return cached;
        const version = await fetchVersion(endpoint, options.fetchImpl || fetchImpl).catch(() => null);
        const browserWebSocketUrl = browserWebSocketUrlFromVersion(version) ||
            (typeof options.devToolsActivePortContents === 'string'
                ? parseDevToolsActivePort(options.devToolsActivePortContents).webSocketDebuggerUrl
                : options.devToolsActivePortFile
                    ? readDevToolsActivePort(String(options.devToolsActivePortFile)).webSocketDebuggerUrl
                    : '');
        if (browserWebSocketUrl)
            endpointBrowserUrls.set(endpoint, browserWebSocketUrl);
        return browserWebSocketUrl;
    };
    const withOwnedSession = async (options) => {
        const browserWebSocketUrl = await resolveBrowserWebSocketUrl(options);
        if (!browserWebSocketUrl)
            return { ...options, fetchImpl: options.fetchImpl || fetchImpl };
        return {
            ...options,
            browserWebSocketUrl,
            browserWebSocketSession: sessionForUrl(browserWebSocketUrl),
            fetchImpl: options.fetchImpl || fetchImpl,
            WebSocketImpl: options.WebSocketImpl || WebSocketImpl,
            timeoutMs: options.timeoutMs || timeoutMs,
        };
    };
    return {
        async buildSnapshot(options) {
            return buildCdpBrowserSnapshot(await withOwnedSession(options));
        },
        async activateTarget(target, options) {
            return activateCdpTarget(target, await withOwnedSession(options));
        },
        async reloadExtensionFromDevToolsActivePort({ extensionId, devToolsActivePortContents, devToolsActivePortFile, }) {
            const activePort = typeof devToolsActivePortContents === 'string'
                ? parseDevToolsActivePort(devToolsActivePortContents)
                : readDevToolsActivePort(String(devToolsActivePortFile || ''));
            const session = sessionForUrl(activePort.webSocketDebuggerUrl);
            const targets = await session.listTargets();
            const target = findExtensionManagementTarget(targets, extensionId);
            if (!target) {
                return {
                    ok: false,
                    mode: 'cdp-browser-websocket',
                    extensionId,
                    targetId: '',
                    targetUrl: '',
                    code: 'extension_management_target_not_found',
                    error: 'Nao encontrei uma aba chrome://extensions da extensao carregada.',
                };
            }
            return session.reloadExtensionFromManagementTarget({ extensionId, target });
        },
        closeAll() {
            for (const session of sessions.values())
                session.close();
            sessions.clear();
            endpointBrowserUrls.clear();
        },
    };
};
