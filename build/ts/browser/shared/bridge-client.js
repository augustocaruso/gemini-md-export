export const RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY = 'gemini-md-export.pendingBridgeCommand.v1';
const RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS = 5 * 60_000;
const RESUMABLE_BRIDGE_COMMAND_TYPES = new Set(['get-chat-by-id']);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 30000;
const COMMAND_CACHE_TTL_MS = 5 * 60_000;
const defaultRandomId = () => {
    try {
        return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    }
    catch {
        return Math.random().toString(36).slice(2);
    }
};
export const getOrCreateBridgeClientId = ({ storage, storageKey, prefix, randomId = defaultRandomId, }) => {
    try {
        const existing = storage?.getItem(storageKey);
        if (existing)
            return existing;
        const created = `${prefix}-${randomId()}`;
        storage?.setItem(storageKey, created);
        return created;
    }
    catch {
        return `${prefix}-${randomId()}`;
    }
};
export const isResumableBridgeCommand = (command) => !!command?.id && RESUMABLE_BRIDGE_COMMAND_TYPES.has(String(command.type || ''));
export const savePendingBridgeCommand = (storage, command, { now = Date.now() } = {}) => {
    if (!storage || !isResumableBridgeCommand(command))
        return false;
    storage.setItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt: now,
        command,
    }));
    return true;
};
export const clearPendingBridgeCommand = (storage, commandId) => {
    if (!storage)
        return false;
    if (commandId) {
        const pending = readPendingBridgeCommand(storage);
        if (pending?.id && pending.id !== commandId)
            return false;
    }
    storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
    return true;
};
export const readPendingBridgeCommand = (storage, { now = Date.now(), maxAgeMs = RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS, } = {}) => {
    if (!storage)
        return null;
    let parsed = null;
    try {
        const raw = storage.getItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
        parsed = raw ? JSON.parse(raw) : null;
    }
    catch {
        storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
        return null;
    }
    const command = parsed?.command || null;
    const savedAt = Number(parsed?.savedAt || 0);
    if (parsed?.version !== 1 ||
        !isResumableBridgeCommand(command) ||
        !Number.isFinite(savedAt) ||
        now - savedAt > maxAgeMs) {
        storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
        return null;
    }
    return command;
};
const defaultBridgeRequest = (bridgeBaseUrl) => async (path, options = {}) => {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${bridgeBaseUrl}${path}`, {
            method: options.method || 'GET',
            headers: options.payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
            body: options.payload ? JSON.stringify(options.payload) : undefined,
            mode: 'cors',
            cache: 'no-store',
            signal: controller.signal,
        });
        if (response.status === 204)
            return null;
        const text = await response.text();
        if (!response.ok)
            throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
        return text ? JSON.parse(text) : null;
    }
    finally {
        clearTimeout(timer);
    }
};
const defaultEventSourceFactory = (url) => new EventSource(url);
const parseEventPayload = (event) => {
    try {
        return event.data ? JSON.parse(event.data) : {};
    }
    catch {
        return null;
    }
};
export const createBrowserBridgeClient = (options) => {
    const bridgeRequest = options.bridgeRequest || defaultBridgeRequest(options.bridgeBaseUrl);
    const eventSourceFactory = options.eventSourceFactory || defaultEventSourceFactory;
    const setIntervalRef = options.setIntervalRef || setInterval;
    const clearIntervalRef = options.clearIntervalRef || clearInterval;
    const heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 10000;
    const pollTimeoutMs = options.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;
    const state = {
        kind: options.kind,
        clientId: options.clientId,
        started: false,
        heartbeatInFlight: false,
        heartbeatTimer: 0,
        polling: false,
        eventsConnected: false,
        eventSource: null,
        commandResultCache: new Map(),
        tabId: null,
        windowId: null,
        isActiveTab: null,
        tabClaim: null,
        lastError: null,
    };
    const rememberCommandResult = (commandId, result) => {
        const now = Date.now();
        const existing = state.commandResultCache.get(commandId);
        state.commandResultCache.set(commandId, {
            result,
            at: now,
            deliveredAt: existing?.deliveredAt || 0,
            attempts: existing?.attempts || 0,
            lastAttemptAt: existing?.lastAttemptAt || 0,
            lastError: existing?.lastError || null,
        });
        for (const [key, cached] of state.commandResultCache.entries()) {
            if (now - cached.at > COMMAND_CACHE_TTL_MS)
                state.commandResultCache.delete(key);
        }
    };
    const postCommandResult = async (command, result) => {
        if (options.postCommandResult)
            return options.postCommandResult(command, result);
        return bridgeRequest('/bridge/command-result', {
            method: 'POST',
            payload: {
                clientId: state.clientId,
                commandId: command.id,
                result: result,
            },
            timeoutMs: 10000,
        });
    };
    const closeEventSource = () => {
        if (state.eventSource) {
            try {
                state.eventSource.close();
            }
            catch {
                // ignore stale event source
            }
            state.eventSource = null;
        }
        state.eventsConnected = false;
    };
    const deliverCommandResult = async (command, cached) => {
        const now = Date.now();
        cached.at = now;
        cached.attempts = (cached.attempts || 0) + 1;
        cached.lastAttemptAt = now;
        try {
            await postCommandResult(command, cached.result);
            cached.deliveredAt = Date.now();
            cached.lastError = null;
            state.lastError = null;
            return true;
        }
        catch (err) {
            cached.deliveredAt = 0;
            cached.lastError = err instanceof Error ? err.message : String(err);
            state.lastError = cached.lastError;
            options.onError?.(err);
            return false;
        }
    };
    const flushPendingCommandResults = async () => {
        for (const [commandId, cached] of state.commandResultCache.entries()) {
            if (cached.deliveredAt)
                continue;
            await deliverCommandResult({ id: commandId }, cached);
        }
    };
    const handleCommand = async (command) => {
        if (!command?.id)
            return;
        options.onCommandReceived?.(command);
        const cached = state.commandResultCache.get(command.id);
        if (cached) {
            await deliverCommandResult(command, cached);
            return;
        }
        let result;
        try {
            result = await options.executeCommand(command);
        }
        catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        rememberCommandResult(command.id, result);
        const stored = state.commandResultCache.get(command.id);
        if (stored)
            await deliverCommandResult(command, stored);
    };
    const sendHeartbeat = async () => {
        if (!state.started || state.heartbeatInFlight)
            return;
        state.heartbeatInFlight = true;
        try {
            await options.beforeHeartbeat?.();
            const payload = (await options.buildHeartbeatPayload?.()) || {
                clientId: state.clientId,
                kind: options.kind,
                capabilities: options.capabilities,
                page: options.getPageSnapshot(),
            };
            const response = await bridgeRequest('/bridge/heartbeat', {
                method: 'POST',
                payload,
                timeoutMs: heartbeatTimeoutMs,
            });
            state.lastError = null;
            if (response?.clientId && typeof response.clientId === 'string')
                state.clientId = response.clientId;
            if (response?.jobProgress && typeof response.jobProgress === 'object') {
                options.onJobProgress?.(response.jobProgress);
            }
            else {
                options.onJobProgress?.(null);
            }
            await options.onHeartbeatResponse?.(response);
            await flushPendingCommandResults();
            if (response?.command && typeof response.command === 'object') {
                await handleCommand(response.command);
            }
            if (response?.commandPollRequired) {
                void pollCommands(true, { force: true });
            }
            return response;
        }
        catch (err) {
            state.lastError = err instanceof Error ? err.message : String(err);
            options.onError?.(err);
            return undefined;
        }
        finally {
            state.heartbeatInFlight = false;
        }
    };
    const pollCommands = async (enabled = true, { force = false } = {}) => {
        if (!enabled || !state.started || state.polling || (state.eventsConnected && !force))
            return;
        state.polling = true;
        try {
            const response = await bridgeRequest(`/bridge/command?clientId=${encodeURIComponent(state.clientId)}`, { timeoutMs: pollTimeoutMs });
            if (response?.command && typeof response.command === 'object') {
                await handleCommand(response.command);
            }
        }
        catch (err) {
            state.lastError = err instanceof Error ? err.message : String(err);
            options.onError?.(err);
        }
        finally {
            state.polling = false;
        }
    };
    const connectEvents = () => {
        if (!state.started || state.eventsConnected || state.eventSource)
            return;
        const url = `${options.bridgeBaseUrl}/bridge/events?clientId=${encodeURIComponent(state.clientId)}`;
        let events;
        try {
            events = eventSourceFactory(url);
        }
        catch (err) {
            state.eventSource = null;
            state.eventsConnected = false;
            state.lastError = err instanceof Error ? err.message : String(err);
            options.onError?.(err);
            return;
        }
        state.eventSource = events;
        events.addEventListener('open', () => {
            state.eventsConnected = true;
            state.lastError = null;
        });
        events.addEventListener('command', (event) => {
            const payload = parseEventPayload(event);
            if (payload?.command && typeof payload.command === 'object') {
                handleCommand(payload.command).catch((err) => {
                    state.lastError = err instanceof Error ? err.message : String(err);
                    options.onError?.(err);
                });
            }
        });
        events.addEventListener('jobProgress', (event) => {
            options.onJobProgress?.(parseEventPayload(event));
        });
        events.addEventListener('error', () => {
            if (state.eventSource === events)
                closeEventSource();
        });
    };
    const stop = () => {
        state.started = false;
        state.heartbeatInFlight = false;
        if (state.heartbeatTimer) {
            clearIntervalRef(state.heartbeatTimer);
            state.heartbeatTimer = 0;
        }
        closeEventSource();
        state.polling = false;
    };
    const start = async ({ connectEvents: shouldConnectEvents = true, startHeartbeatTimer = true, } = {}) => {
        if (state.started)
            return;
        state.started = true;
        if (shouldConnectEvents)
            connectEvents();
        if (startHeartbeatTimer) {
            state.heartbeatTimer = setIntervalRef(sendHeartbeat, heartbeatIntervalMs);
            state.heartbeatTimer?.unref?.();
        }
    };
    return {
        start,
        stop,
        sendHeartbeat,
        pollCommands,
        handleCommand,
        connectEvents,
        state,
    };
};
