import { createBrowserWebSocketSession, listBrowserTargetsViaWebSocket, } from './browser-websocket.js';
const GEMINI_CHAT_ID_RE = /^\/app\/([a-f0-9]{12,})(?:[/?#]|$)/i;
const trimTrailingSlash = (value) => value.replace(/\/+$/, '');
export const normalizeCdpEndpoint = (endpoint) => {
    const raw = String(endpoint || '').trim();
    if (!raw)
        return 'http://127.0.0.1:9222';
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const parsed = new URL(withProtocol);
    parsed.pathname = trimTrailingSlash(parsed.pathname);
    parsed.search = '';
    parsed.hash = '';
    return trimTrailingSlash(parsed.toString());
};
const fetchJson = async (endpoint, path, { fetchImpl = fetch, method = 'GET' } = {}) => {
    const response = await fetchImpl(`${normalizeCdpEndpoint(endpoint)}${path}`, { method });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`CDP HTTP ${response.status} ${response.statusText || ''}${body ? `: ${body}` : ''}`.trim());
        Object.assign(error, { code: 'cdp_http_error', statusCode: response.status });
        throw error;
    }
    return (await response.json());
};
const cdpError = (message, code) => Object.assign(new Error(message), { code });
const browserVersionString = (version, key) => typeof version?.[key] === 'string' ? String(version[key]).trim() : '';
const assertUserBrowserCdpEndpoint = (version) => {
    if (!version)
        return;
    const browser = browserVersionString(version, 'Browser');
    const userAgent = browserVersionString(version, 'User-Agent');
    if (/LenovoVantage/i.test(userAgent)) {
        throw cdpError('A porta CDP pertence a um WebView de aplicativo, nao ao navegador do usuario.', 'cdp_unrelated_endpoint');
    }
    if (browser &&
        !/^(Chrome|Chromium|HeadlessChrome|Edg|Microsoft Edge|Brave|Dia)\//i.test(browser)) {
        throw cdpError(`A porta CDP anunciou um navegador inesperado: ${browser}.`, 'cdp_unrelated_endpoint');
    }
};
const chatIdFromGeminiUrl = (url) => {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'gemini.google.com')
            return null;
        return parsed.pathname.match(GEMINI_CHAT_ID_RE)?.[1] || null;
    }
    catch {
        return null;
    }
};
export const classifyCdpTargetUrl = (value) => {
    const url = String(value || '').trim();
    if (!url)
        return { kind: 'unknown', terminal: false, url: null };
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const continueUrl = (parsed.searchParams.get('continue') || '').toLowerCase();
        if (hostname.endsWith('google.com') &&
            pathname.startsWith('/sorry') &&
            continueUrl.includes('gemini.google.com')) {
            return {
                kind: 'google_sorry',
                terminal: true,
                url,
                code: 'google_verification_required',
                hostname,
            };
        }
        if (hostname === 'accounts.google.com') {
            return {
                kind: 'google_login',
                terminal: true,
                url,
                code: 'google_login_required',
                hostname,
            };
        }
        if (hostname === 'gemini.google.com') {
            if (GEMINI_CHAT_ID_RE.test(parsed.pathname)) {
                return { kind: 'gemini_chat', terminal: false, url, hostname };
            }
            if (pathname.startsWith('/notebook/')) {
                return { kind: 'gemini_notebook', terminal: false, url, hostname };
            }
            if (pathname === '/app' || pathname === '/app/') {
                return { kind: 'gemini_home', terminal: false, url, hostname };
            }
            return { kind: 'gemini', terminal: false, url, hostname };
        }
        if (/^(about:blank|chrome:\/\/newtab|edge:\/\/newtab|brave:\/\/newtab|dia:\/\/)/i.test(url)) {
            return { kind: 'loading', terminal: false, url };
        }
        return { kind: 'other', terminal: true, url, hostname };
    }
    catch {
        return { kind: 'unknown', terminal: false, url };
    }
};
const normalizeTarget = (target) => {
    const id = String(target.id || '').trim();
    const type = String(target.type || '').trim();
    const url = String(target.url || '').trim();
    if (!id || type !== 'page')
        return null;
    const classification = classifyCdpTargetUrl(url);
    return {
        id,
        type,
        title: typeof target.title === 'string' ? target.title : undefined,
        url,
        webSocketDebuggerUrl: typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : undefined,
        chatId: chatIdFromGeminiUrl(url),
        classification,
    };
};
const normalizeBrowserWebSocketTarget = (target, browserWebSocketUrl) => {
    const id = String(target.targetId || '').trim();
    const type = String(target.type || '').trim();
    const url = String(target.url || '').trim();
    if (!id || type !== 'page')
        return null;
    const classification = classifyCdpTargetUrl(url);
    return {
        id,
        type,
        title: typeof target.title === 'string' ? target.title : undefined,
        url,
        browserWebSocketUrl,
        chatId: chatIdFromGeminiUrl(url),
        classification,
    };
};
export const listCdpTargets = async ({ endpoint, fetchImpl, }) => {
    const rawTargets = await fetchJson(endpoint, '/json/list', {
        fetchImpl,
    });
    return rawTargets.flatMap((target) => {
        const normalized = normalizeTarget(target);
        return normalized ? [normalized] : [];
    });
};
const listCdpTargetsFromBrowserWebSocket = async ({ browserWebSocketUrl, browserWebSocketSession, WebSocketImpl, timeoutMs, }) => {
    const rawTargets = browserWebSocketSession
        ? await browserWebSocketSession.listTargets()
        : await listBrowserTargetsViaWebSocket({
            browserWebSocketUrl,
            WebSocketImpl,
            timeoutMs,
        });
    return rawTargets.flatMap((target) => {
        const normalized = normalizeBrowserWebSocketTarget(target, browserWebSocketUrl);
        return normalized ? [normalized] : [];
    });
};
export const selectCdpTarget = (targets, selector = {}) => {
    const targetId = String(selector.targetId || '').trim();
    if (targetId)
        return targets.find((target) => target.id === targetId) || null;
    const chatId = String(selector.chatId || '')
        .trim()
        .toLowerCase();
    if (chatId) {
        return targets.find((target) => String(target.chatId || '').toLowerCase() === chatId) || null;
    }
    const url = String(selector.url || '').trim();
    if (url)
        return targets.find((target) => target.url === url) || null;
    const usable = targets.filter((target) => !target.classification.terminal);
    return (usable.find((target) => target.classification.kind === 'gemini_chat') ||
        usable.find((target) => target.classification.kind === 'gemini_notebook') ||
        usable.find((target) => target.classification.kind === 'gemini_home') ||
        usable.find((target) => target.classification.kind === 'gemini') ||
        null);
};
const blockerFromTarget = (target) => {
    if (target.classification.kind === 'google_sorry') {
        return {
            code: 'google_verification_required',
            kind: target.classification.kind,
            url: target.url,
            message: 'O Google abriu uma tela de verificacao antes do Gemini.',
            nextAction: 'Resolva a verificacao no navegador e tente novamente.',
        };
    }
    if (target.classification.kind === 'google_login') {
        return {
            code: 'google_login_required',
            kind: target.classification.kind,
            url: target.url,
            message: 'O navegador esta no login do Google.',
            nextAction: 'Conclua o login no navegador e tente novamente.',
        };
    }
    return null;
};
export const buildCdpBrowserSnapshot = async ({ endpoint, allowHttpBrowserFallback = false, browserWebSocketUrl: explicitBrowserWebSocketUrl, browserWebSocketSession, fetchImpl, WebSocketImpl, timeoutMs, }) => {
    const version = await fetchJson(endpoint, '/json/version', {
        fetchImpl,
    }).catch(() => null);
    assertUserBrowserCdpEndpoint(version);
    const browserWebSocketUrl = String(explicitBrowserWebSocketUrl || '').trim() ||
        (typeof version?.webSocketDebuggerUrl === 'string' ? String(version.webSocketDebuggerUrl) : '');
    let targets;
    if (browserWebSocketUrl) {
        try {
            targets = await listCdpTargetsFromBrowserWebSocket({
                browserWebSocketUrl,
                browserWebSocketSession,
                WebSocketImpl,
                timeoutMs,
            });
        }
        catch (err) {
            if (!allowHttpBrowserFallback)
                throw err;
            targets = await listCdpTargets({ endpoint, fetchImpl });
        }
    }
    else if (!allowHttpBrowserFallback) {
        throw cdpError('CDP sem Browser WebSocket nao e aceito para controle de abas.', 'cdp_browser_websocket_required');
    }
    else {
        targets = await listCdpTargets({ endpoint, fetchImpl });
    }
    const geminiTargets = targets.filter((target) => target.classification.kind.startsWith('gemini'));
    const blocker = targets.map(blockerFromTarget).find(Boolean) || null;
    return {
        ok: true,
        controlPlane: 'cdp',
        endpoint: normalizeCdpEndpoint(endpoint),
        version,
        targets,
        geminiTargets,
        blocker,
    };
};
export const activateCdpTarget = async (target, { endpoint, browserWebSocketSession, fetchImpl, WebSocketImpl, timeoutMs }) => {
    const browserWebSocketUrl = target
        .browserWebSocketUrl;
    if (browserWebSocketUrl) {
        if (browserWebSocketSession)
            return await browserWebSocketSession.activateTarget(target.id);
        const session = createBrowserWebSocketSession({
            browserWebSocketUrl,
            WebSocketImpl,
            timeoutMs,
        });
        try {
            return await session.activateTarget(target.id);
        }
        finally {
            session.close();
        }
    }
    const body = await fetchJson(endpoint, `/json/activate/${encodeURIComponent(target.id)}`, { fetchImpl });
    return {
        ok: true,
        targetId: target.id,
        result: body,
    };
};
const defaultWebSocketConstructor = () => {
    const ctor = globalThis.WebSocket;
    if (!ctor) {
        const error = new Error('WebSocket nativo indisponivel para CDP.');
        Object.assign(error, { code: 'cdp_websocket_unavailable' });
        throw error;
    }
    return ctor;
};
export const sendCdpCommand = async (webSocketDebuggerUrl, method, params = {}, { WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = 10_000 } = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const timer = setTimeout(() => {
        finish(reject, Object.assign(new Error(`Timeout CDP em ${timeoutMs}ms (${method}).`), {
            code: 'cdp_timeout',
        }));
    }, timeoutMs);
    const finish = (callback, value) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        try {
            socket.close();
        }
        catch {
            // ignore close races
        }
        callback(value);
    };
    socket.onopen = () => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve: (value) => finish(resolve, value), reject });
        socket.send(JSON.stringify({ id, method, params }));
    };
    socket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(String(event.data || '{}'));
        }
        catch (err) {
            finish(reject, err instanceof Error ? err : new Error(String(err)));
            return;
        }
        if (!message.id || !pending.has(message.id))
            return;
        pending.delete(message.id);
        if (message.error) {
            const error = new Error(message.error.message || `CDP command failed: ${method}`);
            Object.assign(error, { code: 'cdp_command_failed', data: message.error });
            finish(reject, error);
            return;
        }
        finish(resolve, message.result || {});
    };
    socket.onerror = () => {
        const error = new Error(`Falha no WebSocket CDP (${method}).`);
        Object.assign(error, { code: 'cdp_websocket_error' });
        finish(reject, error);
    };
    socket.onclose = () => {
        if (!settled) {
            const error = new Error(`Conexao CDP fechou antes da resposta (${method}).`);
            Object.assign(error, { code: 'cdp_connection_closed' });
            finish(reject, error);
        }
    };
});
export const navigateCdpTarget = async (target, url, options = {}) => {
    if (!target.webSocketDebuggerUrl) {
        const error = new Error('Target CDP nao informou webSocketDebuggerUrl.');
        Object.assign(error, { code: 'cdp_target_missing_websocket' });
        throw error;
    }
    const result = await sendCdpCommand(target.webSocketDebuggerUrl, 'Page.navigate', { url }, options);
    return {
        ok: true,
        targetId: target.id,
        result,
    };
};
