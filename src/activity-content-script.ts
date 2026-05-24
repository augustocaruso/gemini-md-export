// @ts-nocheck

(function () {
  'use strict';

  /* __INLINE_PROGRESS_DOCK_UI__ */
  /* __INLINE_PROGRESS_PORT__ */
  /* __INLINE_TAB_COMMANDS__ */
  /* __INLINE_BRIDGE_CLIENT__ */

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const BRIDGE_BASE_URL =
    pageWindow.__GEMINI_MCP_BRIDGE_URL || 'http://127.0.0.1:47283';
  const CLIENT_ID_STORAGE_KEY = 'gemini-md-export.activityClientId.v1';
  const HEARTBEAT_INTERVAL_MS = 3000;
  const COMMAND_POLL_TIMEOUT_MS = 30000;
  const CONTENT_SCRIPT_PING_TYPE = 'gemini-md-export/content-ping';
  const SCROLL_SETTLE_MS = 500;
  const DEFAULT_MAX_CARDS = 1000;
  const DEFAULT_MAX_SCROLL_ROUNDS = 80;
  const MATCH_THRESHOLD = 0.58;
  const PROGRESS_DOCK_ID = 'gm-md-export-progress-dock';
  const TAB_CLAIM_DEFAULT_LABEL = '🔎 Conferindo';

  const state = {
    started: false,
    clientId: '',
    heartbeatTimer: 0,
    heartbeatInFlight: false,
    eventSource: null,
    commandResultCache: new Map(),
    extensionInfoLoadedAt: 0,
    extensionVersion: null,
    protocolVersion: null,
    buildStamp: null,
    tabId: null,
    windowId: null,
    isActiveTab: null,
    tabClaim: null,
    activityProgress: null,
    activityProgressHideTimer: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const portableIsoSeconds = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };

  const getOrCreateActivityClientId = () =>
    getOrCreateBridgeClientId({
      storage: pageWindow.sessionStorage,
      storageKey: CLIENT_ID_STORAGE_KEY,
      prefix: 'activity',
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
      if (response.status === 204) return null;
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };

  const extensionSendMessage = (message, { timeoutMs = 5000 } = {}) =>
    new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
        resolve({ ok: false, reason: 'runtime-message-unavailable' });
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, reason: 'runtime-message-timeout' });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({ ok: false, reason: lastError.message || String(lastError) });
            return;
          }
          finish(response || { ok: false, reason: 'empty-runtime-response' });
        });
      } catch (err) {
        finish({ ok: false, reason: err?.message || String(err) });
      }
    });

  const refreshExtensionInfo = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && state.extensionInfoLoadedAt && now - state.extensionInfoLoadedAt < 30_000) {
      return {
        ok: true,
        extensionVersion: state.extensionVersion,
        protocolVersion: state.protocolVersion,
        buildStamp: state.buildStamp,
        tabId: state.tabId,
        windowId: state.windowId,
        isActiveTab: state.isActiveTab,
      };
    }
    const response = await extensionSendMessage({ type: 'GET_EXTENSION_INFO' }, { timeoutMs: 3500 });
    if (response?.ok) {
      state.extensionVersion = response.extensionVersion || response.version || null;
      state.protocolVersion = response.protocolVersion ?? null;
      state.buildStamp = response.buildStamp || null;
      state.tabId = response.tabId ?? null;
      state.windowId = response.windowId ?? null;
      state.isActiveTab = response.isActiveTab ?? null;
      state.extensionInfoLoadedAt = now;
    }
    return response;
  };

  const sharedTabCommands = createSharedTabCommandHandlers({
    state,
    defaultReason: 'activity-bridge-command',
    defaultClaimLabel: TAB_CLAIM_DEFAULT_LABEL,
    defaultClaimColor: 'blue',
    extensionSendMessage,
    getExtensionInfo: async () => {
      const response = await refreshExtensionInfo({ force: true });
      return {
        ...(response || { ok: false, reason: 'empty-extension-info-response' }),
        contentScript: true,
        serviceWorker: response?.ok === true,
      };
    },
  });

  const normalizeText = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  const hashText = (value) => {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  };

  const tokenScore = (needle, haystack) => {
    const normalizedNeedle = normalizeText(needle);
    const normalizedHaystack = normalizeText(haystack);
    if (!normalizedNeedle || !normalizedHaystack) return 0;
    if (normalizedHaystack.includes(normalizedNeedle)) return 1;
    const needleTokens = new Set(normalizedNeedle.split(' ').filter((token) => token.length > 2));
    if (!needleTokens.size) return 0;
    const haystackTokens = new Set(normalizedHaystack.split(' ').filter((token) => token.length > 2));
    let overlap = 0;
    for (const token of needleTokens) {
      if (haystackTokens.has(token)) overlap += 1;
    }
    return overlap / needleTokens.size;
  };

  const candidateFields = (candidate = {}) => {
    const fields = [];
    if (candidate.firstPrompt) fields.push({ kind: 'created', text: candidate.firstPrompt });
    if (candidate.lastPrompt) fields.push({ kind: 'last_message', text: candidate.lastPrompt });
    for (const sample of candidate.assistantSamples || []) {
      if (sample) fields.push({ kind: 'last_message', text: sample });
    }
    if (!fields.length && candidate.title) fields.push({ kind: 'unknown', text: candidate.title });
    return fields;
  };

  const scoreCandidate = (candidate, text) => {
    let best = { score: 0, kind: 'unknown', sampleHash: null, sampleLength: 0 };
    for (const field of candidateFields(candidate)) {
      const score = tokenScore(field.text, text);
      if (score > best.score) {
        best = {
          score,
          kind: field.kind,
          sampleHash: hashText(field.text),
          sampleLength: String(field.text || '').length,
        };
      }
    }
    return best;
  };

  const scoreCandidateByKind = (candidate, text) => {
    const byKind = new Map();
    for (const field of candidateFields(candidate)) {
      const score = tokenScore(field.text, text);
      const current = byKind.get(field.kind);
      if (!current || score > current.score) {
        byKind.set(field.kind, {
          score,
          kind: field.kind,
          sampleHash: hashText(field.text),
          sampleLength: String(field.text || '').length,
        });
      }
    }
    if (byKind.size === 0) return [scoreCandidate(candidate, text)];
    return Array.from(byKind.values());
  };

  const parseNumericTimestamp = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const number = Number(raw.replace(/[^\d]/g, ''));
    if (!Number.isFinite(number) || number <= 0) return null;
    if (number > 10_000_000_000_000) return portableIsoSeconds(new Date(Math.floor(number / 1000)));
    if (number > 10_000_000_000) return portableIsoSeconds(new Date(number));
    return portableIsoSeconds(new Date(number * 1000));
  };

  const PT_MONTHS = {
    janeiro: 0,
    fevereiro: 1,
    marco: 2,
    março: 2,
    abril: 3,
    maio: 4,
    junho: 5,
    julho: 6,
    agosto: 7,
    setembro: 8,
    outubro: 9,
    novembro: 10,
    dezembro: 11,
  };

  const parseTimeParts = (text) => {
    const match = String(text || '').match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = String(match[3] || '').toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute, second: 0 };
  };

  const parsePortugueseDate = (dateText, timeText) => {
    const normalized = normalizeText(dateText);
    const match = normalized.match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/);
    const time = parseTimeParts(timeText);
    if (!match || !time) return null;
    const month = PT_MONTHS[match[2]];
    if (month === undefined) return null;
    return portableIsoSeconds(new Date(Number(match[3]), month, Number(match[1]), time.hour, time.minute, time.second));
  };

  const parseTextualTimestamp = (dateText, cardText) => {
    const time = parseTimeParts(cardText);
    if (!dateText || !time) return null;
    const pt = parsePortugueseDate(dateText, cardText);
    if (pt) return pt;
    const parsed = new Date(`${dateText} ${String(cardText).match(/\b\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\b/i)?.[0] || ''}`);
    if (Number.isNaN(parsed.getTime())) return null;
    return portableIsoSeconds(parsed);
  };

  const extractCardDate = (card) => {
    const timestampEl = card.closest('[data-timestamp]') || card.querySelector('[data-timestamp]');
    const numeric =
      parseNumericTimestamp(card.getAttribute('data-timestamp')) ||
      parseNumericTimestamp(timestampEl?.getAttribute('data-timestamp')) ||
      parseNumericTimestamp(card.getAttribute('data-time'));
    if (numeric) return numeric;
    const dateText =
      card.getAttribute('data-date') ||
      card.closest('[data-date]')?.getAttribute('data-date') ||
      card.querySelector('[data-date]')?.getAttribute('data-date') ||
      '';
    return parseTextualTimestamp(dateText, card.textContent || '');
  };

  const findActivityCards = () => {
    const selectors = [
      '[data-timestamp]',
      '[data-date]',
      '[data-gm-activity-card]',
      '.activity-card',
      'c-wiz',
    ];
    const seen = new Set();
    const cards = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!(el instanceof Element) || seen.has(el)) continue;
        const text = normalizeText(el.textContent || '');
        if (!text.includes('gemini') && !el.querySelector('[data-gm-activity-details]')) continue;
        seen.add(el);
        cards.push(el);
      }
    }
    return cards;
  };

  const detailsButtonFor = (card) =>
    Array.from(card.querySelectorAll('button,[role="button"],a')).find((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      return /item details|detalhes|detalhe|details/i.test(label);
    }) || null;

  const detailDialogs = () => Array.from(document.querySelectorAll('[role="dialog"]'));

  const closeButtonForDialog = (dialog) =>
    dialog
      ? Array.from(dialog.querySelectorAll('button,[role="button"]')).find((el) =>
          /close|fechar|dismiss/i.test(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`),
        )
      : null;

  const waitForDialogDismissal = async (dialog, beforeCount, timeoutMs = 900) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentCount = detailDialogs().length;
      if (!dialog?.isConnected || currentCount < beforeCount) return true;
      await sleep(30);
    }
    return !dialog?.isConnected || detailDialogs().length < beforeCount;
  };

  const closeOpenDetails = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const dialogs = detailDialogs();
      const dialog = dialogs.at(-1);
      if (!dialog) return;
      const closeButton = closeButtonForDialog(dialog);
      try {
        if (closeButton) closeButton.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch {
        // Sem efeito em alguns DOMs de teste.
      }
      const dismissed = await waitForDialogDismissal(dialog, dialogs.length);
      if (!dismissed) return;
    }
  };

  const openDetailsForCard = async (card) => {
    await closeOpenDetails();
    const before = document.querySelectorAll('[role="dialog"],[data-gm-activity-details]').length;
    const button = detailsButtonFor(card);
    if (button) {
      try {
        button.click();
        await sleep(80);
      } catch {
        // O texto do card ainda pode ser suficiente para scoring.
      }
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[data-gm-activity-details]'));
    if (dialogs.length > before) return dialogs.at(-1);
    return card.querySelector('[data-gm-activity-details]') || null;
  };

  const isDarkTheme = () => {
    try {
      return pageWindow.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
    } catch {
      return false;
    }
  };

  let activityProgressPort = null;

  const ensureActivityProgressPort = () => {
    if (!activityProgressPort) {
      activityProgressPort = createSharedProgressPort({
        dockId: PROGRESS_DOCK_ID,
        initialTitle: 'Buscando datas',
        documentRef: document,
        isDarkTheme,
        ensureDock: ensureSharedProgressDock,
        applyTheme: applySharedProgressDockTheme,
        getElements: getSharedProgressDockElements,
        setVisible: setSharedProgressDockVisible,
      });
    }
    return activityProgressPort;
  };

  const activityProgressSnapshot = (progress) => {
    const candidateTotal = Math.max(0, Number(progress.candidateTotal || 0));
    const resolved = Math.max(0, Number(progress.resolvedCount || 0));
    const scanned = Math.max(0, Number(progress.scannedCardCount || 0));
    const loaded = Math.max(scanned, Number(progress.loadedCardCount || 0));
    const maxCards = Math.max(1, Number(progress.maxCards || loaded || 1));
    const rawStatus = progress.status || 'running';
    const pending = Math.max(0, candidateTotal - Math.min(resolved, candidateTotal));
    const status = rawStatus === 'completed' && pending > 0 ? 'failed' : rawStatus;
    let label = `${scanned} itens lidos`;
    if (status === 'completed') label = 'Todas as datas encontradas';
    else if (rawStatus === 'completed' && pending > 0) label = `${pending} pendente(s)`;
    else if (status === 'failed') label = 'Falhou';
    else if (loaded > scanned) label = `${scanned} itens lidos · ${loaded} carregados`;
    const total = candidateTotal > 0 ? candidateTotal : maxCards;
    const current = candidateTotal > 0 ? Math.min(resolved, candidateTotal) : scanned;
    return {
      title: 'Identificando chats',
      label,
      current,
      total,
      status,
      countLabel: candidateTotal > 0 ? `${Math.min(resolved, candidateTotal)} de ${candidateTotal}` : '',
    };
  };

  const updateActivityProgressDock = () => {
    const port = ensureActivityProgressPort();
    const progress = state.activityProgress;
    if (!progress) {
      port.hide();
      return;
    }
    const snapshot = activityProgressSnapshot(progress);
    port.update(snapshot);
    const { countEl } = getSharedProgressDockElements({
      dockId: PROGRESS_DOCK_ID,
    });
    if (countEl) countEl.textContent = snapshot.countLabel;
  };

  const beginActivityProgress = ({ candidateTotal = 0, maxCards = DEFAULT_MAX_CARDS } = {}) => {
    if (state.activityProgressHideTimer) {
      clearTimeout(state.activityProgressHideTimer);
      state.activityProgressHideTimer = 0;
    }
    state.activityProgress = {
      status: 'running',
      phase: 'scanning',
      candidateTotal,
      maxCards,
      scannedCardCount: 0,
      loadedCardCount: 0,
      resolvedCount: 0,
    };
    updateActivityProgressDock();
  };

  const updateActivityProgress = (patch = {}) => {
    if (!state.activityProgress) beginActivityProgress();
    state.activityProgress = {
      ...state.activityProgress,
      ...patch,
      status: patch.status || state.activityProgress?.status || 'running',
    };
    updateActivityProgressDock();
  };

  const finishActivityProgress = ({ status = 'completed', resolvedCount = null } = {}) => {
    if (!state.activityProgress) beginActivityProgress();
    state.activityProgress = {
      ...state.activityProgress,
      status,
      resolvedCount: resolvedCount ?? state.activityProgress.resolvedCount ?? 0,
    };
    updateActivityProgressDock();
    if (state.activityProgressHideTimer) clearTimeout(state.activityProgressHideTimer);
    state.activityProgressHideTimer = setTimeout(() => {
      state.activityProgress = null;
      state.activityProgressHideTimer = 0;
      updateActivityProgressDock();
    }, 3200);
    state.activityProgressHideTimer?.unref?.();
  };

  const sanitizedMatch = ({ candidate, card, score, cardIndex }) => ({
    chatId: String(candidate.chatId || ''),
    date: extractCardDate(card),
    kind: score.kind,
    score: Number(score.score.toFixed(4)),
    textHash: hashText(card.textContent || ''),
    sampleHash: score.sampleHash,
    sampleLength: score.sampleLength,
    cardIndex,
  });

  const scanLoadedCards = async (candidates, options = {}) => {
    const candidateMap = new Map(
      (candidates || [])
        .filter((candidate) => candidate?.chatId)
        .map((candidate) => [String(candidate.chatId), candidate]),
    );
    const foundKinds = new Map();
    const requiredKinds = new Map();
    for (const [chatId, candidate] of candidateMap.entries()) {
      const kinds = new Set(candidateFields(candidate).map((field) => field.kind));
      requiredKinds.set(chatId, kinds.size ? kinds : new Set(['unknown']));
      foundKinds.set(chatId, new Set());
    }
    const matches = [];
    let loadedCardCount = 0;
    let lastSeenActivityToken = null;

    const cards = findActivityCards().slice(0, options.maxCards || DEFAULT_MAX_CARDS);
    loadedCardCount = cards.length;
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
      const card = cards[cardIndex];
      const detail =
        options.openDetails === true
          ? await openDetailsForCard(card)
          : card.querySelector('[data-gm-activity-details]');
      const scoringText = `${card.textContent || ''}\n${detail?.textContent || ''}`;
      for (const [chatId, candidate] of candidateMap.entries()) {
        for (const score of scoreCandidateByKind(candidate, scoringText)) {
          if (score.score < MATCH_THRESHOLD) continue;
          if (foundKinds.get(chatId)?.has(score.kind)) continue;
          const match = sanitizedMatch({ candidate, card, score, cardIndex });
          if (!match.date) continue;
          matches.push(match);
          foundKinds.get(chatId)?.add(score.kind);
        }
      }
      lastSeenActivityToken = extractCardDate(card) || hashText(card.textContent || '');
      if (options.openDetails === true) await closeOpenDetails();
      const resolvedCount = Array.from(new Set(matches.map((match) => match.chatId))).length;
      options.onProgress?.({
        scannedCardCount: cardIndex + 1,
        loadedCardCount,
        resolvedCount,
        phase: 'scanning',
      });
      const allResolved = Array.from(candidateMap.keys()).every((chatId) => {
        const required = requiredKinds.get(chatId) || new Set();
        const found = foundKinds.get(chatId) || new Set();
        return Array.from(required).every((kind) => found.has(kind));
      });
      if (allResolved) break;
    }

    return {
      matches,
      loadedCardCount,
      lastSeenActivityToken,
      resolvedChatIds: Array.from(new Set(matches.map((match) => match.chatId))).sort(),
    };
  };

  const scanActivityPage = async (args = {}) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const maxCards = Math.max(1, Math.min(DEFAULT_MAX_CARDS, Number(args.maxCards || DEFAULT_MAX_CARDS)));
    const maxScrollRounds = Math.max(
      0,
      Math.min(DEFAULT_MAX_SCROLL_ROUNDS, Number(args.maxScrollRounds || DEFAULT_MAX_SCROLL_ROUNDS)),
    );
    beginActivityProgress({ candidateTotal: candidates.length, maxCards });
    try {
      const allMatches = [];
      let checkpoint = {
        lastSeenActivityToken: args.resume?.lastSeenActivityToken || null,
        loadedCardCount: 0,
        resolvedChatIds: [],
      };
      let previousCount = -1;
      for (let round = 0; round <= maxScrollRounds; round += 1) {
        const partial = await scanLoadedCards(candidates, {
          maxCards,
          onProgress: (progress) => {
            updateActivityProgress({
              ...progress,
              resolvedCount: Array.from(new Set(allMatches.map((match) => match.chatId))).length,
            });
          },
        });
        for (const match of partial.matches) {
          if (!allMatches.some((existing) => existing.chatId === match.chatId && existing.date === match.date)) {
            allMatches.push(match);
          }
        }
        checkpoint = {
          lastSeenActivityToken: partial.lastSeenActivityToken || checkpoint.lastSeenActivityToken,
          loadedCardCount: partial.loadedCardCount,
          resolvedChatIds: Array.from(new Set(allMatches.map((match) => match.chatId))).sort(),
        };
        updateActivityProgress({
          scannedCardCount: partial.loadedCardCount,
          loadedCardCount: partial.loadedCardCount,
          resolvedCount: checkpoint.resolvedChatIds.length,
          phase: 'scrolling',
        });
        if (checkpoint.resolvedChatIds.length >= candidates.length) break;
        if (partial.loadedCardCount >= maxCards) break;
        if (partial.loadedCardCount === previousCount) break;
        previousCount = partial.loadedCardCount;
        window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
        await sleep(SCROLL_SETTLE_MS);
      }
      await closeOpenDetails();
      finishActivityProgress({ status: 'completed', resolvedCount: checkpoint.resolvedChatIds.length });
      return {
        ok: true,
        source: 'my-activity-web',
        matches: allMatches,
        checkpoint,
      };
    } catch (err) {
      await closeOpenDetails();
      finishActivityProgress({ status: 'failed' });
      throw err;
    }
  };

  const buildHeartbeatPayload = () => ({
    clientId: state.clientId,
    kind: 'activity',
    extensionVersion: state.extensionVersion,
    protocolVersion: state.protocolVersion,
    buildStamp: state.buildStamp,
    tabId: state.tabId,
    windowId: state.windowId,
    isActiveTab: state.isActiveTab,
    tabClaim: state.tabClaim,
    page: {
      kind: 'activity',
      url: location.href,
      path: location.pathname,
      title: document.title,
    },
    capabilities: ['activity-scan-batch-v1', 'tab-activation-v1'],
  });

  let contentScriptMessageListenerInstalled = false;

  const contentScriptRuntimeStatus = () => {
    const heartbeat = buildHeartbeatPayload();
    return {
      ok: true,
      kind: 'activity',
      contentScript: true,
      extensionVersion: state.extensionVersion || '__VERSION__',
      version: state.extensionVersion || '__VERSION__',
      protocolVersion: state.protocolVersion ?? Number('__EXTENSION_PROTOCOL_VERSION__'),
      buildStamp: state.buildStamp || '__BUILD_STAMP__',
      tabId: state.tabId ?? null,
      windowId: state.windowId ?? null,
      isActiveTab: state.isActiveTab ?? null,
      clientId: state.clientId || null,
      page: heartbeat.page,
    };
  };

  const installContentScriptMessageListener = () => {
    if (
      contentScriptMessageListenerInstalled ||
      typeof chrome === 'undefined' ||
      !chrome.runtime?.onMessage?.addListener
    ) {
      return;
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== CONTENT_SCRIPT_PING_TYPE) return false;
      sendResponse(contentScriptRuntimeStatus());
      return false;
    });
    contentScriptMessageListenerInstalled = true;
  };

  const executeCommand = async (command) => {
    const sharedResult = await sharedTabCommands.execute(command);
    if (sharedResult !== undefined) return sharedResult;

    if (command.type === 'get-extension-info') {
      const response = await refreshExtensionInfo({ force: true });
      return {
        ...(response || { ok: false, reason: 'empty-extension-info-response' }),
        contentScript: true,
        serviceWorker: response?.ok === true,
      };
    }
    if (command.type === 'reload-extension-self') {
      return extensionSendMessage(
        {
          type: 'RELOAD_SELF',
          reason: command.args?.reason || 'activity-bridge-command',
          expectedExtensionVersion: command.args?.expectedExtensionVersion || null,
          expectedProtocolVersion: command.args?.expectedProtocolVersion || null,
          expectedBuildStamp: command.args?.expectedBuildStamp || null,
        },
        { timeoutMs: 3500 },
      );
    }
    if (command.type === 'activate-browser-tab') {
      const requestedTabId = Number(command.args?.tabId ?? command.args?.targetTabId);
      return extensionSendMessage(
        {
          type: 'gemini-md-export/activate-tab',
          tabId: Number.isInteger(requestedTabId) ? requestedTabId : undefined,
          reason: command.args?.reason || 'activity-bridge-command',
          focusWindow: command.args?.focusWindow === true,
        },
        { timeoutMs: 5000 },
      );
    }
    if (command.type === 'claim-tab') {
      const args = command.args || {};
      const claim = {
        claimId: String(args.claimId || '').trim(),
        sessionId: args.sessionId || null,
        label: args.label || TAB_CLAIM_DEFAULT_LABEL,
        color: args.color || 'blue',
        expiresAt: args.expiresAt || null,
      };
      if (!claim.claimId) return { ok: false, reason: 'claim-id-required' };
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/claim-tab',
          ...claim,
        },
        { timeoutMs: 5000 },
      );
      if (response?.ok) {
        state.tabClaim = {
          ...claim,
          tabId: response.tabId ?? response.visual?.tabId ?? state.tabId,
          windowId: response.windowId ?? state.windowId,
          visual: response.visual || response,
        };
      }
      return response || { ok: false, reason: 'empty-claim-response' };
    }
    if (command.type === 'release-tab-claim') {
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/release-tab-claim',
          tabId: command.args?.tabId ?? state.tabId,
          claimId: command.args?.claimId || state.tabClaim?.claimId || null,
          reason: command.args?.reason || 'activity-bridge-command',
        },
        { timeoutMs: 5000 },
      );
      if (response?.ok) state.tabClaim = null;
      return response || { ok: false, reason: 'empty-release-response' };
    }
    if (command.type === 'release-tab-claim-by-tab-id') {
      const requestedTabId = Number(command.args?.tabId);
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/release-tab-claim',
          tabId: Number.isInteger(requestedTabId) ? requestedTabId : state.tabId,
          claimId: command.args?.claimId || state.tabClaim?.claimId || null,
          reason: command.args?.reason || 'activity-bridge-command-tab-id-release',
        },
        { timeoutMs: 5000 },
      );
      const targetsThisTab =
        Number.isInteger(requestedTabId) &&
        Number.isInteger(Number(state.tabId)) &&
        requestedTabId === Number(state.tabId);
      const claimMatches =
        !command.args?.claimId || !state.tabClaim?.claimId || state.tabClaim.claimId === command.args.claimId;
      if (response?.ok && targetsThisTab && claimMatches) state.tabClaim = null;
      return response || { ok: false, reason: 'empty-release-response' };
    }
    if (command.type === 'activity-scan-batch') {
      return scanActivityPage(command.args || {});
    }
    return {
      ok: false,
      error: `Comando desconhecido para My Activity: ${command.type || 'sem tipo'}`,
    };
  };

  let activityBridgeClient = null;

  const syncActivityBridgeState = () => {
    if (!activityBridgeClient) return;
    state.clientId = activityBridgeClient.state.clientId;
    state.started = activityBridgeClient.state.started;
    state.heartbeatTimer = activityBridgeClient.state.heartbeatTimer;
    state.heartbeatInFlight = activityBridgeClient.state.heartbeatInFlight;
    state.eventSource = activityBridgeClient.state.eventSource;
    state.commandResultCache = activityBridgeClient.state.commandResultCache;
  };

  const getActivityBridgeClient = () => {
    if (activityBridgeClient) return activityBridgeClient;
    state.clientId = state.clientId || getOrCreateActivityClientId();
    activityBridgeClient = createBrowserBridgeClient({
      kind: 'activity',
      bridgeBaseUrl: BRIDGE_BASE_URL,
      capabilities: ['activity-scan-batch-v1', 'tab-activation-v1'],
      clientId: state.clientId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      pollTimeoutMs: COMMAND_POLL_TIMEOUT_MS,
      getPageSnapshot: () => buildHeartbeatPayload().page,
      buildHeartbeatPayload,
      beforeHeartbeat: () => refreshExtensionInfo(),
      executeCommand,
      bridgeRequest,
      eventSourceFactory: (url) => {
        if (typeof EventSource !== 'function') throw new Error('EventSource indisponível');
        return new EventSource(url);
      },
      onError: () => {
        // Bridge pode estar fechado enquanto o usuário navega. O próximo heartbeat tenta de novo.
      },
    });
    syncActivityBridgeState();
    return activityBridgeClient;
  };

  const sendHeartbeat = async () => {
    const client = getActivityBridgeClient();
    await client.sendHeartbeat();
    syncActivityBridgeState();
  };

  const pollCommands = async () => {
    const client = getActivityBridgeClient();
    await client.pollCommands();
    syncActivityBridgeState();
  };

  const connectEvents = () => {
    const client = getActivityBridgeClient();
    client.connectEvents();
    syncActivityBridgeState();
  };

  const startBridgeClient = async () => {
    const client = getActivityBridgeClient();
    if (client.state.started) {
      syncActivityBridgeState();
      return;
    }
    await client.start({ connectEvents: false });
    syncActivityBridgeState();
    await client.sendHeartbeat();
    client.connectEvents();
    syncActivityBridgeState();
  };

  const stopBridgeClient = () => {
    getActivityBridgeClient().stop();
    syncActivityBridgeState();
  };

  pageWindow.__geminiMdActivityDebug = {
    scanActivityPage,
    executeCommand,
    startBridgeClient,
    stopBridgeClient,
    _private: {
      beginActivityProgress,
      updateActivityProgress,
      finishActivityProgress,
      buildHeartbeatPayload,
      getActivityBridgeClient,
      extractCardDate,
      hashText,
      normalizeText,
    },
  };

  installContentScriptMessageListener();

  if (!pageWindow.__GEMINI_MD_ACTIVITY_DISABLE_AUTO_START__) {
    startBridgeClient();
  }
})();
