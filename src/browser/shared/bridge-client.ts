export type BridgeClientKind = 'chat' | 'activity' | 'blocker';

export type BridgeCommand = {
  id?: string;
  type?: string;
  args?: Record<string, unknown>;
};

export type BridgeRequestOptions = {
  method?: 'GET' | 'POST';
  payload?: Record<string, unknown>;
  timeoutMs?: number;
};

export type BridgeRequest = (
  path: string,
  options?: BridgeRequestOptions,
) => Promise<Record<string, unknown> | null | undefined>;

export type BridgeClientIdentityOptions = {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  storageKey: string;
  prefix: string;
  randomId?: () => string;
};

type BridgeEventSource = {
  addEventListener: (
    type: string,
    listener: (event: { data?: string }) => void | Promise<void>,
  ) => void;
  close: () => void;
};

export type BridgeClientOptions = {
  kind: BridgeClientKind;
  bridgeBaseUrl: string;
  capabilities: string[];
  clientId: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  pollTimeoutMs?: number;
  getPageSnapshot: () => Record<string, unknown>;
  buildHeartbeatPayload?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  beforeHeartbeat?: () => void | Promise<void>;
  executeCommand: (command: BridgeCommand) => Promise<unknown>;
  postCommandResult?: (command: BridgeCommand, result: unknown) => Promise<unknown>;
  bridgeRequest?: BridgeRequest;
  eventSourceFactory?: (url: string) => BridgeEventSource;
  setIntervalRef?: typeof setInterval;
  clearIntervalRef?: typeof clearInterval;
  onJobProgress?: (progress: Record<string, unknown> | null) => void;
  onCommandReceived?: (command: BridgeCommand) => void;
  onHeartbeatResponse?: (
    response: Record<string, unknown> | null | undefined,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

type CommandResultCacheEntry = {
  result: unknown;
  at: number;
  deliveredAt?: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string | null;
};

export const RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY = 'gemini-md-export.pendingBridgeCommand.v1';
const RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS = 5 * 60_000;
const RESUMABLE_BRIDGE_COMMAND_TYPES = new Set(['get-chat-by-id']);

export type BrowserBridgeClient = {
  start: (options?: { connectEvents?: boolean; startHeartbeatTimer?: boolean }) => Promise<void>;
  stop: () => void;
  sendHeartbeat: () => Promise<Record<string, unknown> | null | undefined>;
  pollCommands: (enabled?: boolean, options?: { force?: boolean }) => Promise<void>;
  handleCommand: (command: BridgeCommand) => Promise<void>;
  connectEvents: () => void;
  state: {
    kind: BridgeClientKind;
    clientId: string;
    started: boolean;
    heartbeatInFlight: boolean;
    heartbeatTimer: ReturnType<typeof setInterval> | 0;
    polling: boolean;
    eventsConnected: boolean;
    eventSource: BridgeEventSource | null;
    commandResultCache: Map<string, CommandResultCacheEntry>;
    tabId: number | null;
    windowId: number | null;
    isActiveTab: boolean | null;
    tabClaim: unknown | null;
    lastError: string | null;
  };
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 30000;
const COMMAND_CACHE_TTL_MS = 5 * 60_000;

const defaultRandomId = () => {
  try {
    return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  } catch {
    return Math.random().toString(36).slice(2);
  }
};

export const getOrCreateBridgeClientId = ({
  storage,
  storageKey,
  prefix,
  randomId = defaultRandomId,
}: BridgeClientIdentityOptions): string => {
  try {
    const existing = storage?.getItem(storageKey);
    if (existing) return existing;
    const created = `${prefix}-${randomId()}`;
    storage?.setItem(storageKey, created);
    return created;
  } catch {
    return `${prefix}-${randomId()}`;
  }
};

export const isResumableBridgeCommand = (command: BridgeCommand | null | undefined): boolean =>
  !!command?.id && RESUMABLE_BRIDGE_COMMAND_TYPES.has(String(command.type || ''));

export const savePendingBridgeCommand = (
  storage: Pick<Storage, 'setItem'> | null | undefined,
  command: BridgeCommand,
  { now = Date.now() }: { now?: number } = {},
): boolean => {
  if (!storage || !isResumableBridgeCommand(command)) return false;
  storage.setItem(
    RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      savedAt: now,
      command,
    }),
  );
  return true;
};

export const clearPendingBridgeCommand = (
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined,
  commandId?: string | null,
): boolean => {
  if (!storage) return false;
  if (commandId) {
    const pending = readPendingBridgeCommand(storage);
    if (pending?.id && pending.id !== commandId) return false;
  }
  storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
  return true;
};

export const readPendingBridgeCommand = (
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined,
  {
    now = Date.now(),
    maxAgeMs = RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS,
  }: { now?: number; maxAgeMs?: number } = {},
): BridgeCommand | null => {
  if (!storage) return null;
  let parsed: { version?: number; savedAt?: number; command?: BridgeCommand } | null = null;
  try {
    const raw = storage.getItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
    return null;
  }
  const command = parsed?.command || null;
  const savedAt = Number(parsed?.savedAt || 0);
  if (
    parsed?.version !== 1 ||
    !isResumableBridgeCommand(command) ||
    !Number.isFinite(savedAt) ||
    now - savedAt > maxAgeMs
  ) {
    storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
    return null;
  }
  return command;
};

const defaultBridgeRequest =
  (bridgeBaseUrl: string): BridgeRequest =>
  async (path, options = {}) => {
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
      if (response.status === 204) return null;
      const text = await response.text();
      if (!response.ok)
        throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };

const defaultEventSourceFactory = (url: string): BridgeEventSource => new EventSource(url);

const parseEventPayload = (event: { data?: string }): Record<string, unknown> | null => {
  try {
    return event.data ? JSON.parse(event.data) : {};
  } catch {
    return null;
  }
};

export const createBrowserBridgeClient = (options: BridgeClientOptions): BrowserBridgeClient => {
  const bridgeRequest = options.bridgeRequest || defaultBridgeRequest(options.bridgeBaseUrl);
  const eventSourceFactory = options.eventSourceFactory || defaultEventSourceFactory;
  const setIntervalRef = options.setIntervalRef || setInterval;
  const clearIntervalRef = options.clearIntervalRef || clearInterval;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 10000;
  const pollTimeoutMs = options.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;

  const state: BrowserBridgeClient['state'] = {
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

  const rememberCommandResult = (commandId: string, result: unknown) => {
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
      if (now - cached.at > COMMAND_CACHE_TTL_MS) state.commandResultCache.delete(key);
    }
  };

  const postCommandResult = async (command: BridgeCommand, result: unknown) => {
    if (options.postCommandResult) return options.postCommandResult(command, result);
    return bridgeRequest('/bridge/command-result', {
      method: 'POST',
      payload: {
        clientId: state.clientId,
        commandId: command.id,
        result: result as Record<string, unknown>,
      },
      timeoutMs: 10000,
    });
  };

  const closeEventSource = () => {
    if (state.eventSource) {
      try {
        state.eventSource.close();
      } catch {
        // ignore stale event source
      }
      state.eventSource = null;
    }
    state.eventsConnected = false;
  };

  const deliverCommandResult = async (command: BridgeCommand, cached: CommandResultCacheEntry) => {
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
    } catch (err) {
      cached.deliveredAt = 0;
      cached.lastError = err instanceof Error ? err.message : String(err);
      state.lastError = cached.lastError;
      options.onError?.(err);
      return false;
    }
  };

  const flushPendingCommandResults = async () => {
    for (const [commandId, cached] of state.commandResultCache.entries()) {
      if (cached.deliveredAt) continue;
      await deliverCommandResult({ id: commandId }, cached);
    }
  };

  const handleCommand = async (command: BridgeCommand) => {
    if (!command?.id) return;
    options.onCommandReceived?.(command);
    const cached = state.commandResultCache.get(command.id);
    if (cached) {
      await deliverCommandResult(command, cached);
      return;
    }
    let result: unknown;
    try {
      result = await options.executeCommand(command);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    rememberCommandResult(command.id, result);
    const stored = state.commandResultCache.get(command.id);
    if (stored) await deliverCommandResult(command, stored);
  };

  const sendHeartbeat = async () => {
    if (!state.started || state.heartbeatInFlight) return;
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
        options.onJobProgress?.(response.jobProgress as Record<string, unknown>);
      } else {
        options.onJobProgress?.(null);
      }
      await options.onHeartbeatResponse?.(response);
      await flushPendingCommandResults();
      if (response?.command && typeof response.command === 'object') {
        await handleCommand(response.command as BridgeCommand);
      }
      if (response?.commandPollRequired) {
        void pollCommands(true, { force: true });
      }
      return response;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      options.onError?.(err);
      return undefined;
    } finally {
      state.heartbeatInFlight = false;
    }
  };

  const pollCommands = async (enabled = true, { force = false } = {}) => {
    if (!enabled || !state.started || state.polling || (state.eventsConnected && !force)) return;
    state.polling = true;
    try {
      const response = await bridgeRequest(
        `/bridge/command?clientId=${encodeURIComponent(state.clientId)}`,
        { timeoutMs: pollTimeoutMs },
      );
      if (response?.command && typeof response.command === 'object') {
        await handleCommand(response.command as BridgeCommand);
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      options.onError?.(err);
    } finally {
      state.polling = false;
    }
  };

  const connectEvents = () => {
    if (!state.started || state.eventsConnected || state.eventSource) return;
    const url = `${options.bridgeBaseUrl}/bridge/events?clientId=${encodeURIComponent(state.clientId)}`;
    let events: BridgeEventSource;
    try {
      events = eventSourceFactory(url);
    } catch (err) {
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
        handleCommand(payload.command as BridgeCommand).catch((err) => {
          state.lastError = err instanceof Error ? err.message : String(err);
          options.onError?.(err);
        });
      }
    });
    events.addEventListener('jobProgress', (event) => {
      options.onJobProgress?.(parseEventPayload(event));
    });
    events.addEventListener('error', () => {
      if (state.eventSource === events) closeEventSource();
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

  const start = async ({
    connectEvents: shouldConnectEvents = true,
    startHeartbeatTimer = true,
  } = {}) => {
    if (state.started) return;
    state.started = true;
    if (shouldConnectEvents) connectEvents();
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
