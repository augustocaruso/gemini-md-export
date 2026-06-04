import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const DEFAULT_TIMEOUT_MS = 10_000;
const defaultWebSocketConstructor = () => {
    const ctor = globalThis.WebSocket;
    if (!ctor) {
        const error = new Error('WebSocket nativo indisponivel para CDP.');
        Object.assign(error, { code: 'cdp_websocket_unavailable' });
        throw error;
    }
    return ctor;
};
const errorCode = (error) => typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'cdp_browser_websocket_error';
export const parseDevToolsActivePort = (contents, host = '127.0.0.1') => {
    const [rawPort, rawPath] = String(contents || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || !rawPath?.startsWith('/')) {
        const error = new Error('DevToolsActivePort invalido.');
        Object.assign(error, { code: 'invalid_devtools_active_port' });
        throw error;
    }
    return {
        port,
        browserPath: rawPath,
        webSocketDebuggerUrl: `ws://${host}:${port}${rawPath}`,
    };
};
export const readDevToolsActivePort = (filePath) => parseDevToolsActivePort(readFileSync(filePath, 'utf-8'));
export const devToolsActivePortPathForUserDataDir = (userDataDir) => resolve(userDataDir, 'DevToolsActivePort');
export const findExtensionManagementTarget = (targets, extensionId) => {
    const id = String(extensionId || '').trim();
    if (!id)
        return null;
    const exactUrl = `chrome://extensions/?id=${id}`;
    return (targets.find((target) => target.type === 'page' && target.url === exactUrl) ||
        targets.find((target) => target.type === 'page' &&
            target.url.startsWith('chrome://extensions') &&
            target.title?.includes('Gemini Chat -> Markdown Export')) ||
        targets.find((target) => target.type === 'page' && target.url.startsWith('chrome://extensions')) ||
        null);
};
const normalizeBrowserTargetInfo = (target) => {
    const targetId = String(target.targetId || '').trim();
    const type = String(target.type || '').trim();
    const url = String(target.url || '').trim();
    if (!targetId || !type)
        return null;
    return {
        targetId,
        type,
        url,
        title: typeof target.title === 'string' ? target.title : undefined,
        attached: typeof target.attached === 'boolean' ? target.attached : undefined,
        browserContextId: typeof target.browserContextId === 'string' ? target.browserContextId : undefined,
    };
};
export const buildExtensionReloadExpression = (extensionId) => {
    const id = String(extensionId || '').trim();
    return `(() => {
    try {
      if (!chrome?.developerPrivate?.reload) {
        return JSON.stringify({ ok: false, code: 'developer_private_unavailable' });
      }
      chrome.developerPrivate.reload(${JSON.stringify(id)});
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        code: 'developer_private_reload_failed',
        error: err && err.message ? err.message : String(err),
      });
    }
  })()`;
};
class BrowserWebSocketCdpClient {
    timeoutMs;
    socket;
    pending = new Map();
    nextId = 1;
    opened = false;
    openPromise;
    constructor(webSocketUrl, WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = timeoutMs;
        this.socket = new WebSocketImpl(webSocketUrl);
        this.openPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(Object.assign(new Error(`Timeout CDP em ${timeoutMs}ms (connect).`), {
                    code: 'cdp_browser_websocket_connect_timeout',
                }));
            }, timeoutMs);
            this.socket.onopen = () => {
                clearTimeout(timer);
                this.opened = true;
                resolve();
            };
            this.socket.onerror = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('Falha no WebSocket CDP do navegador.'), {
                    code: 'cdp_browser_websocket_error',
                }));
            };
        });
        this.socket.onmessage = (event) => this.handleMessage(event);
        this.socket.onclose = () => this.rejectAll('Conexao CDP do navegador fechou.');
    }
    async send(method, params = {}, sessionId) {
        if (!this.opened)
            await this.openPromise;
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(Object.assign(new Error(`Timeout CDP em ${this.timeoutMs}ms (${method}).`), {
                    code: 'cdp_browser_websocket_timeout',
                }));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
            }));
        });
    }
    close() {
        try {
            this.socket.close();
        }
        catch {
            // Ignore close races.
        }
    }
    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(String(event.data || '{}'));
        }
        catch (err) {
            this.rejectAll(err instanceof Error ? err.message : String(err));
            return;
        }
        if (!message.id || !this.pending.has(message.id))
            return;
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            pending.reject(Object.assign(new Error(message.error.message || 'CDP command failed.'), {
                code: 'cdp_browser_websocket_command_failed',
                data: message.error,
            }));
            return;
        }
        pending.resolve(message.result || {});
    }
    rejectAll(message) {
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(Object.assign(new Error(message), {
                code: 'cdp_browser_websocket_closed',
            }));
        }
    }
}
const parseReloadPayload = (result) => {
    const rawValue = typeof result.result?.value === 'string'
        ? String(result.result.value)
        : '';
    return rawValue ? JSON.parse(rawValue) : { ok: true };
};
class PersistentBrowserWebSocketSession {
    client;
    attachedSessions = new Map();
    constructor({ browserWebSocketUrl, WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = DEFAULT_TIMEOUT_MS, }) {
        this.client = new BrowserWebSocketCdpClient(browserWebSocketUrl, WebSocketImpl, timeoutMs);
    }
    async listTargets() {
        const result = await this.client.send('Target.getTargets');
        const targets = Array.isArray(result.targetInfos) ? result.targetInfos : [];
        return targets.flatMap((target) => {
            if (!target || typeof target !== 'object')
                return [];
            const normalized = normalizeBrowserTargetInfo(target);
            return normalized ? [normalized] : [];
        });
    }
    async activateTarget(targetId) {
        const id = String(targetId || '').trim();
        if (!id) {
            throw Object.assign(new Error('Target CDP invalido para ativacao.'), {
                code: 'cdp_missing_target_id',
            });
        }
        const result = await this.client.send('Target.activateTarget', { targetId: id });
        return {
            ok: true,
            targetId: id,
            result,
        };
    }
    async reloadExtensionFromManagementTarget({ extensionId, target, }) {
        try {
            const sessionId = await this.sessionIdForTarget(target);
            const result = await this.client.send('Runtime.evaluate', {
                expression: buildExtensionReloadExpression(extensionId),
                returnByValue: true,
            }, sessionId);
            const payload = parseReloadPayload(result);
            return {
                ok: payload.ok !== false,
                mode: 'cdp-browser-websocket',
                extensionId,
                targetId: target.targetId,
                targetUrl: target.url,
                result,
                ...(payload.ok === false
                    ? {
                        code: String(payload.code || 'developer_private_reload_failed'),
                        error: String(payload.error || payload.code || 'developerPrivate.reload falhou.'),
                    }
                    : {}),
            };
        }
        catch (err) {
            return {
                ok: false,
                mode: 'cdp-browser-websocket',
                extensionId,
                targetId: target.targetId,
                targetUrl: target.url,
                code: errorCode(err),
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    close() {
        this.client.close();
    }
    async sessionIdForTarget(target) {
        const cached = this.attachedSessions.get(target.targetId);
        if (cached)
            return cached;
        const attached = await this.client.send('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
        });
        const sessionId = typeof attached.sessionId === 'string' ? attached.sessionId : '';
        if (!sessionId) {
            throw Object.assign(new Error('CDP nao retornou sessionId ao anexar no chrome://extensions.'), {
                code: 'cdp_missing_session_id',
            });
        }
        this.attachedSessions.set(target.targetId, sessionId);
        return sessionId;
    }
}
export const createBrowserWebSocketSession = (args) => new PersistentBrowserWebSocketSession(args);
export const listBrowserTargetsViaWebSocket = async ({ browserWebSocketUrl, WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = DEFAULT_TIMEOUT_MS, }) => {
    const session = createBrowserWebSocketSession({ browserWebSocketUrl, WebSocketImpl, timeoutMs });
    try {
        return await session.listTargets();
    }
    finally {
        session.close();
    }
};
export const reloadExtensionFromManagementTarget = async ({ browserWebSocketUrl, extensionId, target, WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = DEFAULT_TIMEOUT_MS, }) => {
    const session = createBrowserWebSocketSession({ browserWebSocketUrl, WebSocketImpl, timeoutMs });
    try {
        return await session.reloadExtensionFromManagementTarget({ extensionId, target });
    }
    finally {
        session.close();
    }
};
export const reloadExtensionFromDevToolsActivePort = async ({ extensionId, devToolsActivePortContents, devToolsActivePortFile, WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = DEFAULT_TIMEOUT_MS, }) => {
    const activePort = typeof devToolsActivePortContents === 'string'
        ? parseDevToolsActivePort(devToolsActivePortContents)
        : readDevToolsActivePort(String(devToolsActivePortFile || ''));
    const session = createBrowserWebSocketSession({
        browserWebSocketUrl: activePort.webSocketDebuggerUrl,
        WebSocketImpl,
        timeoutMs,
    });
    try {
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
        return await session.reloadExtensionFromManagementTarget({ extensionId, target });
    }
    finally {
        session.close();
    }
};
