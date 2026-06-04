import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeNativeFrameBuffer, encodeNativeFrame } from './frame.js';
import { createBrokerIpcServer, defaultBrokerIpcPath } from './local-ipc.js';
import { nativeBrokerError, nativeBrokerOk, } from './protocol.js';
const DEFAULT_BRIDGE_URL = process.env.GEMINI_MD_EXPORT_BRIDGE_URL || 'http://127.0.0.1:47283';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const NATIVE_PROTOCOL_VERSION = 1;
let bridgeProcess = null;
const runtimeRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readPackageVersion = (root) => {
    try {
        return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')).version || '0.0.0';
    }
    catch {
        return '0.0.0';
    }
};
const makeError = (code, message, data = {}) => ({
    ok: false,
    code,
    error: message,
    ...data,
});
const toBrokerResponse = (request, result) => {
    if (result.ok === false) {
        const message = result.error || result.code || 'native_broker_error';
        return {
            id: request.id,
            ok: false,
            error: {
                code: result.code || 'native_broker_error',
                message,
                retryable: false,
                nextAction: message,
                data: result,
            },
        };
    }
    return {
        id: request.id,
        ok: true,
        result,
    };
};
const withTimeout = async (promise, timeoutMs, message = 'Timeout falando com native host.') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await promise(controller.signal);
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(message);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
};
const bridgeFetch = async ({ bridgeUrl = DEFAULT_BRIDGE_URL, path = '/healthz', method = 'GET', payload = undefined, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, } = {}) => {
    if (!String(path || '').startsWith('/')) {
        return makeError('invalid_path', 'Caminho da bridge precisa começar com /.');
    }
    const url = new URL(path, bridgeUrl);
    try {
        return await withTimeout(async (signal) => {
            const response = await fetch(url, {
                method,
                headers: payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
                body: payload === undefined ? undefined : JSON.stringify(payload),
                signal,
            });
            const text = await response.text();
            const data = text ? JSON.parse(text) : null;
            return {
                ok: response.ok,
                status: response.status,
                data,
                text: response.ok ? undefined : text,
            };
        }, Math.max(100, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS), `Timeout falando com a bridge em ${timeoutMs}ms.`);
    }
    catch (err) {
        return makeError('bridge_fetch_failed', err instanceof Error ? err.message : String(err), {
            bridgeUrl,
            path,
        });
    }
};
const startBridge = (root, { host = '127.0.0.1', port = 47283, keepAliveMs = 900_000, exitWhenIdle = true, } = {}) => {
    if (bridgeProcess && !bridgeProcess.killed && bridgeProcess.exitCode === null) {
        return {
            ok: true,
            alreadyRunning: true,
            pid: bridgeProcess.pid,
        };
    }
    const args = [
        resolve(root, 'src', 'bridge-server.js'),
        '--bridge-only',
        '--host',
        String(host),
        '--port',
        String(port),
        '--keep-alive-ms',
        String(keepAliveMs),
    ];
    if (exitWhenIdle)
        args.push('--exit-when-idle');
    bridgeProcess = spawn(process.execPath, args, {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
    });
    bridgeProcess.unref();
    return {
        ok: true,
        started: true,
        pid: bridgeProcess.pid,
        host,
        port,
    };
};
const stringPayload = (payload, key, fallback) => {
    const value = payload[key];
    return typeof value === 'string' && value ? value : fallback;
};
const numberPayload = (payload, key, fallback) => {
    const value = Number(payload[key]);
    return Number.isFinite(value) ? value : fallback;
};
const boolPayload = (payload, key, fallback = false) => {
    const value = payload[key];
    return typeof value === 'boolean' ? value : fallback;
};
const brokerRequestTimeoutMs = (request, fallback = 5000) => {
    const payload = request.payload && typeof request.payload === 'object'
        ? request.payload
        : {};
    return numberPayload(payload, 'timeoutMs', fallback);
};
const isExtensionBrokerCommand = (command) => {
    const value = String(command || '');
    return (value.startsWith('tabs.') || value.startsWith('extension.') || value.startsWith('privateApi.'));
};
const handleCommand = async (message, { root, bridgeUrl }) => {
    if (message?.ok === false && message.code)
        return message;
    const command = String(message.command || message.type || '').trim();
    const payload = message.payload && typeof message.payload === 'object'
        ? message.payload
        : {};
    if (command === 'ping') {
        return {
            ok: true,
            transport: 'nativeMessaging',
            nativeProtocolVersion: NATIVE_PROTOCOL_VERSION,
            version: readPackageVersion(root),
            pid: process.pid,
            node: process.version,
        };
    }
    if (command === 'healthz') {
        return bridgeFetch({
            bridgeUrl: stringPayload(payload, 'bridgeUrl', bridgeUrl),
            path: '/healthz',
            timeoutMs: numberPayload(payload, 'timeoutMs', 2500),
        });
    }
    if (command === 'ready') {
        const params = new URLSearchParams({
            detail: stringPayload(payload, 'detail', 'compact'),
            wakeBrowser: boolPayload(payload, 'wakeBrowser') ? 'true' : 'false',
            selfHeal: boolPayload(payload, 'selfHeal') ? 'true' : 'false',
        });
        return bridgeFetch({
            bridgeUrl: stringPayload(payload, 'bridgeUrl', bridgeUrl),
            path: `/agent/ready?${params.toString()}`,
            timeoutMs: numberPayload(payload, 'timeoutMs', 5000),
        });
    }
    if (command === 'startBridge') {
        return startBridge(root, {
            host: stringPayload(payload, 'host', '127.0.0.1'),
            port: numberPayload(payload, 'port', 47283),
            keepAliveMs: numberPayload(payload, 'keepAliveMs', 900_000),
            exitWhenIdle: boolPayload(payload, 'exitWhenIdle', true),
        });
    }
    if (command === 'proxyHttp') {
        return bridgeFetch({
            bridgeUrl: stringPayload(payload, 'bridgeUrl', bridgeUrl),
            path: stringPayload(payload, 'path', '/'),
            method: stringPayload(payload, 'method', 'GET'),
            payload: payload.payload,
            timeoutMs: numberPayload(payload, 'timeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
        });
    }
    return makeError('unknown_command', `Comando native desconhecido: ${command || '(vazio)'}`);
};
export const startNativeHostRuntime = (options = {}) => {
    const stdin = (options.stdin || process.stdin);
    const stdout = options.stdout || process.stdout;
    const root = options.root || runtimeRoot();
    const bridgeUrl = options.bridgeUrl || DEFAULT_BRIDGE_URL;
    let inputBuffer = Buffer.alloc(0);
    const writeNativeMessage = (message) => {
        stdout.write(encodeNativeFrame(message));
    };
    const pendingExtensionRequests = new Map();
    let extensionConnected = false;
    let brokerIpcStartPromise = null;
    const sendToExtension = (request, timeoutMs = 5000) => new Promise((resolve, reject) => {
        if (!extensionConnected) {
            reject(new Error('extension_unavailable'));
            return;
        }
        const timer = setTimeout(() => {
            pendingExtensionRequests.delete(request.id);
            reject(new Error('extension_request_timeout'));
        }, timeoutMs);
        pendingExtensionRequests.set(request.id, { resolve, reject, timer });
        writeNativeMessage(request);
    });
    const handleMessageFromExtension = async (message) => {
        if (message && typeof message === 'object' && 'ok' in message) {
            const response = message;
            const pending = pendingExtensionRequests.get(response.id);
            if (pending) {
                pendingExtensionRequests.delete(response.id);
                clearTimeout(pending.timer);
                pending.resolve(response);
            }
            return null;
        }
        if (message &&
            typeof message === 'object' &&
            'command' in message &&
            message.command === 'extension.hello') {
            extensionConnected = true;
            const brokerIpc = await ensureBrokerIpcServer();
            return nativeBrokerOk(message, {
                connected: true,
                brokerIpc: brokerIpc ? { path: brokerIpc.path } : { disabled: true },
            });
        }
        return handleCommand(message, { root, bridgeUrl });
    };
    const handleBrokerIpcRequest = async (request) => {
        if (isExtensionBrokerCommand(request.command)) {
            try {
                return await sendToExtension(request, brokerRequestTimeoutMs(request));
            }
            catch (err) {
                const code = err instanceof Error && err.message === 'extension_request_timeout'
                    ? 'extension_request_timeout'
                    : 'extension_unavailable';
                const message = code === 'extension_request_timeout'
                    ? 'A extensao nao respondeu ao comando a tempo.'
                    : 'A extensao ainda nao abriu a porta nativa do broker.';
                return nativeBrokerError(request, code, message, {
                    retryable: true,
                    nextAction: code === 'extension_request_timeout'
                        ? 'Tente novamente depois que a aba do Gemini terminar de carregar.'
                        : 'Abra ou recarregue uma aba Gemini com a extensao instalada.',
                    data: { error: err instanceof Error ? err.message : String(err) },
                });
            }
        }
        const result = await handleCommand(request, { root, bridgeUrl });
        return toBrokerResponse(request, result);
    };
    const ensureBrokerIpcServer = async () => {
        if (process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC === 'disabled') {
            return null;
        }
        brokerIpcStartPromise ||= createBrokerIpcServer({
            path: process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(),
            handleRequest: handleBrokerIpcRequest,
        }).catch((err) => {
            brokerIpcStartPromise = null;
            throw err;
        });
        return brokerIpcStartPromise;
    };
    const handleNativeMessage = async (message) => {
        const command = message;
        const id = command?.id ?? null;
        try {
            const result = await handleMessageFromExtension(command);
            if (result === null)
                return;
            writeNativeMessage({ id, ...result });
        }
        catch (err) {
            writeNativeMessage({
                id,
                ...makeError('native_host_error', err instanceof Error ? err.message : String(err)),
            });
        }
    };
    stdin.on('data', (chunk) => {
        try {
            inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
            const decoded = decodeNativeFrameBuffer(inputBuffer);
            inputBuffer = decoded.remaining;
            for (const message of decoded.messages) {
                handleNativeMessage(message);
            }
        }
        catch (err) {
            inputBuffer = Buffer.alloc(0);
            writeNativeMessage(makeError('invalid_native_frame', err instanceof Error ? err.message : String(err)));
        }
    });
    stdin.on('end', () => {
        process.exit(0);
    });
};
