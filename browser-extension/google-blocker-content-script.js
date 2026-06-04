// @ts-nocheck
(function () {
    'use strict';
      // ============================================================
  // Inlined from src/browser/shared/bridge-client.ts (auto-generated — do not edit)
  // ============================================================
  const RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY = 'gemini-md-export.pendingBridgeCommand.v1';
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
  const getOrCreateBridgeClientId = ({ storage, storageKey, prefix, randomId = defaultRandomId, }) => {
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
  const isResumableBridgeCommand = (command) => !!command?.id && RESUMABLE_BRIDGE_COMMAND_TYPES.has(String(command.type || ''));
  const savePendingBridgeCommand = (storage, command, { now = Date.now() } = {}) => {
      if (!storage || !isResumableBridgeCommand(command))
          return false;
      storage.setItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY, JSON.stringify({
          version: 1,
          savedAt: now,
          command,
      }));
      return true;
  };
  const clearPendingBridgeCommand = (storage, commandId) => {
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
  const readPendingBridgeCommand = (storage, { now = Date.now(), maxAgeMs = RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS, } = {}) => {
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
  const createBrowserBridgeClient = (options) => {
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

      // ============================================================
  // Inlined from src/browser/shared/page-blocker.ts (auto-generated — do not edit)
  // ============================================================
  const normalizeText = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const detection = (code, kind, message, nextAction, input) => ({
      code,
      kind,
      terminal: true,
      message,
      nextAction,
      url: input.url || null,
      title: input.title || null,
  });
  const isGoogleHost = (hostname) => hostname === 'google.com' || hostname.endsWith('.google.com');
  const isNormalExporterSurface = (hostname) => hostname === 'gemini.google.com' || hostname === 'myactivity.google.com';
  const detectGooglePageBlocker = (input = {}) => {
      const url = String(input.url || '').trim();
      let hostname = '';
      let pathname = '';
      let continueUrl = '';
      try {
          const parsed = new URL(url);
          hostname = parsed.hostname.toLowerCase();
          pathname = parsed.pathname.toLowerCase();
          continueUrl = String(parsed.searchParams.get('continue') || '').toLowerCase();
      }
      catch {
          // URL ausente ou parcial: cai para heurística por texto visível.
      }
      if (hostname.endsWith('google.com') &&
          pathname.startsWith('/sorry') &&
          (!continueUrl || continueUrl.includes('gemini.google.com'))) {
          return detection('google_verification_required', 'google_sorry', 'O Google abriu uma tela de verificacao antes do Gemini.', 'Resolva a verificacao no navegador e tente novamente.', input);
      }
      if (hostname === 'accounts.google.com') {
          return detection('google_login_required', 'google_login', 'O navegador esta no login do Google.', 'Conclua o login no navegador e tente novamente.', input);
      }
      const shouldUseVisibleTextHeuristics = !hostname || (isGoogleHost(hostname) && !isNormalExporterSurface(hostname));
      const text = normalizeText(`${input.title || ''}\n${input.bodyText || ''}`);
      const looksLikeGoogleVerification = shouldUseVisibleTextHeuristics &&
          (/\bunusual traffic\b/.test(text) ||
              /\bdetected unusual\b/.test(text) ||
              /\batividade suspeita\b/.test(text) ||
              /\btrafego incomum\b/.test(text) ||
              /\bverifique se voce nao e um robo\b/.test(text) ||
              /\bnao e um robo\b/.test(text) ||
              /\bto continue, please type\b/.test(text) ||
              /\bgoogle sorry\b/.test(text));
      if (looksLikeGoogleVerification) {
          return detection('google_verification_required', 'google_verification_text', 'O Google pediu verificacao antes de liberar o Gemini.', 'Resolva a verificacao no navegador e tente novamente.', input);
      }
      const looksBlocked = shouldUseVisibleTextHeuristics &&
          (/\baccess blocked\b/.test(text) ||
              /\bacesso bloqueado\b/.test(text) ||
              /\bthis browser or app may not be secure\b/.test(text) ||
              /\beste navegador ou app talvez nao seja seguro\b/.test(text));
      if (looksBlocked) {
          return detection('google_page_blocked', 'google_blocked_text', 'O Google bloqueou a pagina antes de liberar o Gemini.', 'Resolva o bloqueio no navegador e tente novamente.', input);
      }
      return null;
  };

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
            extensionVersion: extensionInfo.extensionVersion || extensionInfo.version || '0.8.60',
            protocolVersion: extensionInfo.protocolVersion ?? Number('2'),
            buildStamp: extensionInfo.buildStamp || '20260604-0112',
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
        extensionVersion: extensionInfo.extensionVersion || extensionInfo.version || '0.8.60',
        version: extensionInfo.extensionVersion || extensionInfo.version || '0.8.60',
        protocolVersion: extensionInfo.protocolVersion ?? Number('2'),
        buildStamp: extensionInfo.buildStamp || '20260604-0112',
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
