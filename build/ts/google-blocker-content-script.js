// @ts-nocheck
(function () {
    'use strict';
    /* __INLINE_BRIDGE_CLIENT__ */
    /* __INLINE_PAGE_BLOCKER__ */
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const BRIDGE_BASE_URL = pageWindow.__GEMINI_MCP_BRIDGE_URL || 'http://127.0.0.1:47283';
    const CLIENT_ID_STORAGE_KEY = 'gemini-md-export.blockerClientId.v1';
    const HEARTBEAT_INTERVAL_MS = 3000;
    const CONTENT_SCRIPT_PING_TYPE = 'gemini-md-export/content-ping';
    const extensionSendMessage = (message, { timeoutMs = 3500 } = {}) => new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
            resolve({ ok: false, reason: 'runtime-message-unavailable' });
            return;
        }
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish({ ok: false, reason: 'runtime-message-timeout' }), timeoutMs);
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    finish({ ok: false, reason: lastError.message || String(lastError) });
                    return;
                }
                finish(response || { ok: false, reason: 'empty-runtime-response' });
            });
        }
        catch (err) {
            finish({ ok: false, reason: err?.message || String(err) });
        }
    });
    const bridgeRequest = async (path, { method = 'GET', payload, timeoutMs = 10000 } = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
                method,
                headers: payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
                body: payload ? JSON.stringify(payload) : undefined,
                mode: 'cors',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (response.status === 204)
                return null;
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
            }
            return text ? JSON.parse(text) : null;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const clientId = getOrCreateBridgeClientId({
        storage: pageWindow.sessionStorage,
        storageKey: CLIENT_ID_STORAGE_KEY,
        prefix: 'blocker',
    });
    const pageSnapshot = () => ({
        url: location.href,
        pathname: location.pathname,
        title: document.title || '',
        kind: 'blocker',
        blocker: detectGooglePageBlocker({
            url: location.href,
            title: document.title || '',
            bodyText: document.body?.innerText || '',
        }) || {
            code: 'google_page_blocked',
            kind: 'unknown_google_blocker',
            terminal: true,
            message: 'O navegador esta em uma pagina do Google que nao e o Gemini.',
            nextAction: 'Volte ao Gemini quando a pagina estiver liberada.',
            url: location.href,
            title: document.title || null,
        },
    });
    let extensionInfo = {};
    const refreshExtensionInfo = async () => {
        const response = await extensionSendMessage({ type: 'GET_EXTENSION_INFO' });
        if (response?.ok)
            extensionInfo = response;
    };
    const client = createBrowserBridgeClient({
        kind: 'blocker',
        bridgeBaseUrl: BRIDGE_BASE_URL,
        capabilities: ['page-blocker-v1'],
        clientId,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: 3500,
        pollTimeoutMs: 5000,
        getPageSnapshot: pageSnapshot,
        beforeHeartbeat: refreshExtensionInfo,
        buildHeartbeatPayload: () => ({
            clientId: client.state.clientId,
            kind: 'blocker',
            tabId: extensionInfo.tabId ?? null,
            windowId: extensionInfo.windowId ?? null,
            isActiveTab: extensionInfo.isActiveTab ?? null,
            extensionVersion: extensionInfo.extensionVersion || extensionInfo.version || '__VERSION__',
            protocolVersion: extensionInfo.protocolVersion ?? Number('__EXTENSION_PROTOCOL_VERSION__'),
            buildStamp: extensionInfo.buildStamp || '__BUILD_STAMP__',
            capabilities: ['page-blocker-v1'],
            observedAt: new Date().toISOString(),
            page: pageSnapshot(),
        }),
        executeCommand: async () => ({
            ok: false,
            code: 'google_page_blocked',
            error: 'A pagina atual do Google nao aceita comandos do exporter.',
            page: pageSnapshot(),
        }),
        bridgeRequest,
    });
    let contentScriptMessageListenerInstalled = false;
    const contentScriptRuntimeStatus = () => ({
        ok: true,
        kind: 'blocker',
        contentScript: true,
        extensionVersion: extensionInfo.extensionVersion || extensionInfo.version || '__VERSION__',
        version: extensionInfo.extensionVersion || extensionInfo.version || '__VERSION__',
        protocolVersion: extensionInfo.protocolVersion ?? Number('__EXTENSION_PROTOCOL_VERSION__'),
        buildStamp: extensionInfo.buildStamp || '__BUILD_STAMP__',
        tabId: extensionInfo.tabId ?? null,
        windowId: extensionInfo.windowId ?? null,
        isActiveTab: extensionInfo.isActiveTab ?? null,
        clientId: client.state.clientId || null,
        page: pageSnapshot(),
    });
    const installContentScriptMessageListener = () => {
        if (contentScriptMessageListenerInstalled ||
            typeof chrome === 'undefined' ||
            !chrome.runtime?.onMessage?.addListener) {
            return;
        }
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type !== CONTENT_SCRIPT_PING_TYPE)
                return false;
            sendResponse(contentScriptRuntimeStatus());
            return false;
        });
        contentScriptMessageListenerInstalled = true;
    };
    const start = async () => {
        await refreshExtensionInfo();
        await client.start({ connectEvents: false, startHeartbeatTimer: true });
        await client.sendHeartbeat();
    };
    installContentScriptMessageListener();
    start().catch(() => {
        // A pagina bloqueada nao deve ficar ruidosa para o usuario.
    });
})();
export {};
