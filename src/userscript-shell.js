// ==UserScript==
// @name         Gemini Chat → Markdown Export
// @namespace    https://github.com/local/gemini-md-export
// @version      __VERSION__
// @description  Exporta a conversa atual do Gemini web como .md com frontmatter YAML preservando chat_id, URL e timestamp.
// @match        https://gemini.google.com/*
// @grant        GM_download
// @grant        unsafeWindow
// @noframes
// @run-at       document-idle
// ==/UserScript==

// Camada de browser do userscript.
// Este arquivo é a parte "suja": depende de window, location, document,
// Blob, URL.createObjectURL, etc. Toda a lógica de conversão DOM→Markdown
// mora em src/extract.mjs.
//
// O build (scripts/build.mjs) inline o conteúdo de extract.mjs substituindo
// o marcador abaixo.

(function () {
  'use strict';

  /* __INLINE_EXTRACT_MODULE__ */
  /* __INLINE_NOTEBOOK_RETURN_PLAN__ */
  /* __INLINE_BATCH_SESSION_MODULE__ */

  // --- config -----------------------------------------------------------

  const HOTKEY = { key: 'e', ctrl: true, shift: true }; // Ctrl+Shift+E
  const EXTENSION_PROTOCOL_VERSION = Number('__EXTENSION_PROTOCOL_VERSION__');
  // Namespace de UI isolado. Versões antigas usavam `gm-md-export-*`; se um
  // userscript/content script velho ainda estiver vivo, compartilhar ids faz
  // os MutationObservers brigarem pelo mesmo nó e pode travar o Gemini.
  const UI_ID_PREFIX = 'gm-md-export-modern';
  const LEGACY_UI_SELECTORS = [
    '#gm-md-export-btn',
    '#gm-md-export-btn-slot',
    '#gm-md-export-modal',
    '#gm-md-export-progress-dock',
    '#gm-md-export-toast',
  ];
  const BUTTON_ID = `${UI_ID_PREFIX}-btn`;
  const BUTTON_SLOT_ID = `${UI_ID_PREFIX}-btn-slot`;
  const BUTTON_LABEL = 'Exportar Markdown';
  // Material Symbols "download" (filled), 24x24, no container. currentColor
  // para herdar a cor do top-bar do Gemini (tema claro/escuro automático).
  const BUTTON_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/>' +
    '</svg>';
  const FOLDER_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/>' +
    '</svg>';
  const TOAST_ID = `${UI_ID_PREFIX}-toast`;
  const MODAL_ID = `${UI_ID_PREFIX}-modal`;
  const MODAL_LIST_ID = `${UI_ID_PREFIX}-list`;
  const MODAL_LIST_END_ID = `${UI_ID_PREFIX}-list-end`;
  const MODAL_STATUS_ID = `${UI_ID_PREFIX}-status`;
  const MODAL_PROGRESS_ID = `${UI_ID_PREFIX}-progress`;
  const MODAL_DIR_ID = `${UI_ID_PREFIX}-dir`;
  const MODAL_EXPORT_ID = `${UI_ID_PREFIX}-run`;
  const MODAL_COUNT_ID = `${UI_ID_PREFIX}-count`;
  const MODAL_SEARCH_ID = `${UI_ID_PREFIX}-search`;
  const PROGRESS_DOCK_ID = `${UI_ID_PREFIX}-progress-dock`;
  const DEBUG_GLOBAL = '__geminiMdExportDebug';
  const LOG_PREFIX = '[gemini-md-export]';
  const SCRIPT_VERSION = '__VERSION__';
  const BUILD_STAMP = '__BUILD_STAMP__';
  const FRAME_TIMEOUT_MS = 45000;
  const CONVERSATION_CONTAINER_SELECTOR = 'div.conversation-container';
  const HYDRATION_LOAD_WAIT_MS = 2000;
  const HYDRATION_MAX_TOTAL_MS = 30000;
  const HYDRATION_MAX_ATTEMPTS = 100;
  const PROGRESS_MIN_VISIBLE_MS = 900;
  // Container da área de ações da conversa (canto superior direito, mesma
  // linha do avatar e do kebab). `top-bar-actions` é o custom element
  // nativo do Gemini — MAS existem múltiplos na página (um na nav global
  // colada no sidebar, um na conversa). `querySelector` pega o primeiro,
  // que é justamente o errado (sidebar).
  //
  // Landmark para desambiguar: o avatar do usuário vive num OneGoogleBar
  // (OGB) separado, `#gb` / `.boqOnegoogleliteOgbOneGoogleBar`,
  // posicionado no canto superior direito por cima de tudo. O
  // `top-bar-actions` da conversa está na mesma faixa vertical do OGB e
  // imediatamente à esquerda dele. Usar essa geometria reduz "chute" e
  // elimina o bug clássico de cair no `top-bar-actions` da sidebar.
  const TOP_BAR_SELECTORS = [
    'top-bar-actions',
    '[data-test-id="top-bar-actions"]',
  ];
  const OGB_SELECTORS = [
    '.boqOnegoogleliteOgbOneGoogleBar',
    '#gb',
  ];
  const findOgbRect = () => {
    for (const sel of OGB_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { el, rect };
      }
    }
    return null;
  };
  const visibleRect = (el) => {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const controlLabel = (el) =>
    [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  const findGeminiRightSectionPlacement = () => {
    const topBars = Array.from(document.querySelectorAll('top-bar-actions'))
      .map((el) => ({ el, rect: visibleRect(el) }))
      .filter(({ rect }) => rect);

    for (const { el: topBar } of topBars) {
      const rightSection = topBar.querySelector('.top-bar-actions .right-section');
      if (!visibleRect(rightSection)) continue;

      const shareButton = rightSection.querySelector('[data-test-id="share-button"]');
      const menuButton = rightSection.querySelector(
        '[data-test-id="conversation-actions-menu-icon-button"]',
      );
      const saveChatButton = rightSection.querySelector('#gemini-exporter');
      const anchor =
        shareButton?.closest('.buttons-container.share') ||
        menuButton?.closest('conversation-actions-icon') ||
        saveChatButton ||
        null;

      if (!anchor || !visibleRect(anchor)) continue;

      return {
        target: rightSection,
        before: anchor,
        anchor,
        matchedBy: `Gemini right-section before ${anchor.id || anchor.tagName.toLowerCase()}`,
      };
    }

    return null;
  };
  const directChildOf = (ancestor, node) => {
    let current = node;
    while (current && current.parentElement && current.parentElement !== ancestor) {
      current = current.parentElement;
    }
    return current?.parentElement === ancestor ? current : null;
  };
  const findLayoutHostForAnchor = (anchor) => {
    for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
      const rect = visibleRect(el);
      if (!rect) continue;
      const style = getComputedStyle(el);
      const display = style.display;
      const layoutHost = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display);
      const rightSide = rect.left >= window.innerWidth * 0.45;
      const reasonablyScoped = rect.width <= 620;
      if (layoutHost && rightSide && reasonablyScoped) {
        return { host: el, before: directChildOf(el, anchor) || anchor };
      }
    }
    return { host: anchor.parentElement || document.body, before: anchor };
  };
  const findConversationActionPlacement = () => {
    const geminiRightSection = findGeminiRightSectionPlacement();
    if (geminiRightSection) return geminiRightSection;

    const ogb = findOgbRect();
    const controls = Array.from(
      document.querySelectorAll('button,[role="button"],a[role="button"]'),
    )
      .filter((el) => el.id !== BUTTON_ID && !el.closest?.(`#${BUTTON_SLOT_ID}`))
      .map((el) => ({ el, rect: visibleRect(el), label: controlLabel(el) }))
      .filter(({ rect }) => rect);

    const candidates = controls.filter(({ rect, label }) => {
      const centerY = rect.top + rect.height / 2;
      const labelLooksRight =
        /(share|compartilhar|more|mais|options|opções|opcoes)/i.test(label || '') ||
        rect.left >= window.innerWidth * 0.72;

      if (ogb) {
        const ogbCenterY = ogb.rect.top + ogb.rect.height / 2;
        return (
          Math.abs(centerY - ogbCenterY) <= 34 &&
          rect.right <= ogb.rect.left + 24 &&
          rect.left >= Math.max(window.innerWidth * 0.55, ogb.rect.left - 520) &&
          labelLooksRight
        );
      }

      return rect.top <= 96 && rect.left >= window.innerWidth * 0.62 && labelLooksRight;
    });

    if (candidates.length === 0) return null;

    const share = candidates.find(({ label }) => /share|compartilhar/i.test(label || ''));
    const menu = candidates.find(({ label, el }) =>
      el.getAttribute('aria-haspopup') === 'menu' ||
      /(more|mais|options|opções|opcoes)/i.test(label || ''),
    );
    const fallback = [...candidates].sort((a, b) => b.rect.right - a.rect.right)[0];
    const pick = share || menu || fallback;
    const placement = findLayoutHostForAnchor(pick.el);
    const label = pick.label ? ` "${pick.label.slice(0, 40)}"` : '';

    return {
      target: placement.host,
      before: placement.before,
      anchor: pick.el,
      matchedBy: `top-right action${label} @ left=${Math.round(pick.rect.left)} of ${candidates.length} candidate(s)`,
      candidates,
    };
  };
  const findTopBar = () => {
    const actionPlacement = findConversationActionPlacement();
    if (actionPlacement) return actionPlacement;

    const seen = new Set();
    const all = [];
    for (const sel of TOP_BAR_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          all.push(el);
        }
      });
    }
    if (all.length === 0) return null;

    const scored = all
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);

    if (scored.length === 0) return null;

    const ogb = findOgbRect();
    if (ogb) {
      // Filtra top-bar-actions que estejam na mesma faixa vertical do
      // OGB (dentro de 40px de folga) e cujo right ≤ OGB.left + 80px.
      // Entre esses, o mais perto do OGB (menor distância horizontal
      // entre o right do candidato e o left do OGB) é a área da conversa.
      const ogbTop = ogb.rect.top;
      const ogbLeft = ogb.rect.left;
      const near = scored
        .map(({ el, rect }) => {
          const sameRow = Math.abs(rect.top - ogbTop) <= 40;
          const leftOfOgb = rect.right <= ogbLeft + 80;
          const gap = Math.abs(ogbLeft - rect.right);
          return { el, rect, sameRow, leftOfOgb, gap };
        })
        .filter((c) => c.sameRow && c.leftOfOgb);

      if (near.length > 0) {
        near.sort((a, b) => a.gap - b.gap);
        const pick = near[0];
        return {
          target: pick.el,
          matchedBy: `top-bar-actions near OGB (gap=${Math.round(pick.gap)}px) of ${all.length} candidate(s)`,
        };
      }
    }

    // fallback sem OGB: rightmost visível.
    scored.sort((a, b) => b.rect.right - a.rect.right);
    const pick = scored[0];
    return {
      target: pick.el,
      matchedBy: `top-bar-actions rightmost @ right=${Math.round(pick.rect.right)} of ${all.length} candidate(s)`,
    };
  };
  const SIDEBAR_ITEM_SELECTOR = 'conversations-list [data-test-id="conversation"]';
  const NOTEBOOK_CHAT_ROW_SELECTOR = 'project-chat-history project-chat-row';
  const NOTEBOOK_CHAT_HISTORY_SELECTOR =
    'project-chat-history, infinite-scroller.project-chat-history-scroller, .project-chat-history-container';
  // Candidatos na ordem do mais interno (scroller real) para o mais externo
  // (wrapper). `document.querySelector(NOTEBOOK_CHAT_HISTORY_SELECTOR)` pega
  // o primeiro por ordem de documento, que costuma ser `project-chat-history`
  // — um wrapper sem overflow. `scrollTop = scrollHeight` nesse wrapper é
  // no-op e o infinite-scroller não dispara lazy-load. Varrer na ordem abaixo
  // e escolher o primeiro com overflow real é o que deixa o botão "Puxar
  // mais conversas" e o scroll-to-bottom do modal confiáveis no caderno.
  const NOTEBOOK_SCROLLER_SELECTORS = [
    '.project-chat-history-container',
    'infinite-scroller.project-chat-history-scroller',
    'project-chat-history',
  ];
  const NOTEBOOK_LOAD_MORE_ATTEMPTS = 1;
  const SIDEBAR_LOAD_MORE_ATTEMPTS = 3;
  const pageWindow =
    typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const BRIDGE_BASE_URL =
    pageWindow.__GEMINI_MCP_BRIDGE_URL || 'http://127.0.0.1:47283';
  const BRIDGE_HEARTBEAT_MS = 8000;
  const BRIDGE_POLL_TIMEOUT_MS = 30000;
  const BRIDGE_POLL_ERROR_BACKOFF_MS = 250;
  const BRIDGE_CLIENT_STALE_MS = 45000;
  const BRIDGE_FILE_TIMEOUT_MS = 60000;
  const BRIDGE_PICKER_TIMEOUT_MS = 5 * 60000;
  const BRIDGE_OUTPUT_DIR_STORAGE_KEY = 'gemini-md-export.bridgeOutputDir';
  const NOTEBOOK_CHAT_URL_CACHE_STORAGE_KEY = 'gemini-md-export.notebookChatUrls.v1';
  const BATCH_EXPORT_SESSION_STORAGE_KEY = 'gemini-md-export.batchExportSession.v1';
  const isExtensionContext =
    typeof chrome !== 'undefined' &&
    !!chrome.runtime?.id &&
    typeof chrome.runtime.sendMessage === 'function';
  const trustedHtmlPolicy = (() => {
    try {
      if (!pageWindow.trustedTypes?.createPolicy) return null;
      return pageWindow.trustedTypes.createPolicy('gemini-md-export', {
        createHTML: (value) => value,
      });
    } catch {
      return null;
    }
  })();
  const loadStoredBridgeOutputDir = () => {
    if (!isExtensionContext) return '';
    try {
      return pageWindow.localStorage?.getItem(BRIDGE_OUTPUT_DIR_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  };
  const state = {
    conversations: [],
    selectedChatIds: new Set(),
    directoryHandle: null,
    bridgeOutputDir: loadStoredBridgeOutputDir(),
    bridgeSaveFallbackNotified: false,
    browserDownloadFallbackNotified: false,
    isExporting: false,
    progress: null,
    progressCreepTimer: null,
    isLoadingMore: false,
    loadMoreFailures: 0,
    filterQuery: '',
    reachedSidebarEnd: false,
  };
  let sidebarConversationObserver = null;
  let sidebarRefreshTimer = 0;
  const DEFAULT_LOAD_MORE_OPTIONS = Object.freeze({
    ensureSidebarDelayMs: 250,
    growthTimeoutMs: 1800,
    preScrollPauseMs: 60,
    postLoadSettleMs: 220,
    retryPauseMs: 180,
    wheelDeltaY: 120,
    confirmEndGrowthTimeoutMs: 1800,
    confirmEndPostLoadSettleMs: 220,
  });
  const FAST_LOAD_MORE_OPTIONS = Object.freeze({
    ensureSidebarDelayMs: 70,
    growthTimeoutMs: 420,
    preScrollPauseMs: 12,
    postLoadSettleMs: 24,
    retryPauseMs: 18,
    wheelDeltaY: 240,
    confirmEndGrowthTimeoutMs: 900,
    confirmEndPostLoadSettleMs: 70,
  });
  const notebookChatIdCache = new WeakMap();
  let notebookChatUrlCache = null;
  const bridgeState = {
    started: false,
    clientId: '',
    tabId: null,
    windowId: null,
    isActiveTab: null,
    extensionVersion: '__VERSION__',
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    buildStamp: '__BUILD_STAMP__',
    lastError: null,
    heartbeatTimer: 0,
    polling: false,
    lastHeartbeatAt: 0,
    lastCommandPollStartedAt: 0,
    lastCommandPollEndedAt: 0,
    lastCommandReceivedAt: 0,
  };

  // --- metadata da página -----------------------------------------------

  const cleanText = (text) =>
    normalizeWhitespace(String(text || '').replace(/\u200b/g, ''));

  const escapeHtml = (text) =>
    String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const setHtml = (element, html) => {
    if (trustedHtmlPolicy) {
      element.innerHTML = trustedHtmlPolicy.createHTML(html);
      return;
    }
    element.innerHTML = html;
  };

  const scrapeTitleFromDocument = (doc) =>
    cleanText(doc.title.replace(/\s*[-—]\s*Gemini.*$/, ''));

  const scrapeTitle = () => scrapeTitleFromDocument(document);

  const scrapeModelFromDocument = (doc) => {
    const el = doc.querySelector(
      '[data-test-id="bard-mode-menu-button"], bard-mode-switcher button',
    );
    return el ? cleanText(el.textContent) : '';
  };

  const scrapeModel = () => scrapeModelFromDocument(document);

  const currentChatId = () => extractChatId(location.pathname);

  const isNotebookPage = () => location.pathname.startsWith('/notebook/');

  const currentNotebookId = () => {
    if (!isNotebookPage()) return null;
    try {
      const decoded = decodeURIComponent(location.pathname);
      const match = decoded.match(/\/notebook\/notebooks\/([^/?#]+)/);
      return match?.[1] || null;
    } catch {
      const match = location.pathname.match(/\/notebook\/notebooks%2F([^/?#]+)/i);
      return match?.[1] || null;
    }
  };

  const isDarkTheme = () => {
    const body = document.body;
    const html = document.documentElement;
    if (
      body.classList.contains('dark-theme') ||
      body.classList.contains('dark_mode_toggled') ||
      body.classList.contains('dark-mode') ||
      body.classList.contains('dark')
    ) {
      return true;
    }
    if (html.getAttribute('data-theme') === 'dark') return true;
    return pageWindow.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  };

  // --- debug / feedback -------------------------------------------------

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  // Durações padronizadas para toasts. Erro fica MUITO mais tempo porque o
  // usuário geralmente precisa ler, entender e agir; sucesso some rápido
  // porque é só confirmação; info fica intermediário porque costuma trazer
  // orientação sem urgência. Usuário pode clicar no toast pra fechar antes.
  const TOAST_DURATIONS = {
    error: 9000,
    success: 4200,
    info: 5200,
  };

  const showToast = (message, kind = 'info') => {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      // z-index precisa estar ACIMA do modal (10001) e do progress dock
      // (10002), senão o backdrop `blur(4px)` do modal fica por cima e deixa
      // o toast ilegível. Toast é interativo (click to dismiss), então
      // pointer-events: auto; mas ainda é compacto e canto inferior direito,
      // não bloqueia o fluxo.
      Object.assign(toast.style, {
        position: 'fixed',
        right: '24px',
        bottom: '72px',
        zIndex: '10050',
        maxWidth: '420px',
        minWidth: '260px',
        padding: '14px 18px',
        paddingRight: '40px',
        borderRadius: '12px',
        color: 'white',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        fontWeight: '500',
        lineHeight: '1.45',
        // sombra firme + borda dão contraste quando o fundo atrás estiver
        // com backdrop blur.
        boxShadow:
          '0 20px 48px rgba(0,0,0,0.34), 0 2px 6px rgba(0,0,0,0.26)',
        opacity: '0',
        transform: 'translateY(8px)',
        transition: 'opacity 180ms ease, transform 180ms ease',
        pointerEvents: 'auto',
        cursor: 'pointer',
        whiteSpace: 'pre-wrap',
      });
      toast.title = 'Clique para fechar';
      toast.addEventListener('click', () => {
        clearTimeout(showToast._timer);
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      });
      document.body.appendChild(toast);
    }

    const palette =
      kind === 'error'
        ? { bg: '#c5221f', border: '#8f1b13' }
        : kind === 'success'
          ? { bg: '#137333', border: '#0d5a27' }
          : { bg: '#1a73e8', border: '#1557b0' };

    // prefixo visual (emoji/ícone simples) ajuda a identificar severidade
    // mesmo quando o usuário só olha de canto de olho.
    const prefix =
      kind === 'error' ? '⚠️  ' : kind === 'success' ? '✅  ' : 'ℹ️  ';

    toast.textContent = `${prefix}${message}`;
    toast.style.background = palette.bg;
    toast.style.border = `1px solid ${palette.border}`;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    // Move para o fim do body em cada show — garante ordem de pintura
    // correta mesmo se outro overlay foi criado depois do toast.
    if (toast.parentElement === document.body && toast !== document.body.lastChild) {
      document.body.appendChild(toast);
    }

    const duration = TOAST_DURATIONS[kind] || TOAST_DURATIONS.info;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
    }, duration);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const nextPaint = () =>
    new Promise((resolve) => {
      if (typeof pageWindow.requestAnimationFrame !== 'function') {
        setTimeout(resolve, 50);
        return;
      }
      pageWindow.requestAnimationFrame(() => {
        pageWindow.requestAnimationFrame(resolve);
      });
    });

  const supportsDirectoryPicker = () =>
    typeof pageWindow.showDirectoryPicker === 'function';

  const buildFilename = (chatId) => `${chatId}.md`;

  const findScrollableParent = (element) => {
    let current = element?.parentElement || null;
    while (current && current !== document.body) {
      if (current.scrollHeight > current.clientHeight + 40) return current;
      current = current.parentElement;
    }
    return null;
  };

  const hasOverflow = (el) =>
    !!el && el.scrollHeight > el.clientHeight + 8;

  const isAtBottom = (el, threshold = 8) => {
    if (!el) return false;
    if (!hasOverflow(el)) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  };

  // Retorna { wrapper, scroller } do histórico de um caderno.
  // - wrapper: elemento externo estável p/ MutationObserver (sobrevive a
  //   re-renders do Angular dentro do infinite-scroller).
  // - scroller: elemento que realmente rola (tem overflow). Se nenhum dos
  //   candidatos tem overflow no momento (lista curta), cai em varredura de
  //   ancestrais rolaveis via findScrollableParent para não retornar um
  //   elemento que ignora `scrollTop =`.
  const findNotebookHistoryScroller = () => {
    const matches = new Map();
    for (const selector of NOTEBOOK_SCROLLER_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (!matches.has(el)) matches.set(el, selector);
      }
    }
    const all = Array.from(matches.keys());
    if (all.length === 0) return { wrapper: null, scroller: null };

    const wrapper =
      all.find((el) => el.tagName?.toLowerCase() === 'project-chat-history') ||
      all[all.length - 1];

    const scroller =
      all.find((el) => hasOverflow(el)) ||
      findScrollableParent(wrapper) ||
      wrapper;

    return { wrapper, scroller };
  };

  const getSidebarNav = () =>
    document.querySelector('mat-sidenav') || document.querySelector('[role="navigation"]');

  const isSidebarOpen = () => {
    const sideNav = getSidebarNav();
    if (!sideNav) return false;
    if (sideNav.getAttribute('aria-hidden') === 'true') return false;
    if (sideNav.classList.contains('mat-drawer-closed')) return false;
    if (sideNav.offsetWidth <= 100) return false;
    return true;
  };

  const ensureSidebarOpen = async () => {
    if (isSidebarOpen()) return true;

    const menuButton =
      document.querySelector('[data-test-id="side-nav-menu-button"]') ||
      document.querySelector('button[aria-label*="menu" i]') ||
      document.querySelector('button[aria-label*="navigation" i]');

    if (!menuButton) return false;

    menuButton.click();
    await sleep(700);
    return isSidebarOpen() || !!document.querySelector('conversations-list');
  };

  const getSidebarConversationElements = () => {
    const primary = Array.from(document.querySelectorAll(SIDEBAR_ITEM_SELECTOR));
    if (primary.length > 0) return primary;
    return Array.from(
      document.querySelectorAll(
        '[role="navigation"] [data-test-id="conversation"], [role="navigation"] [role="listitem"], .conversation-item',
      ),
    );
  };

  const getNotebookConversationElements = () =>
    Array.from(document.querySelectorAll(NOTEBOOK_CHAT_ROW_SELECTOR)).filter(
      (element) =>
        element.querySelector('[data-test-id="navigate-to-recent-chat"]') ||
        element.querySelector('[data-test-id="chat-title"]'),
    );

  const getConversationElementsForCurrentPage = () =>
    isNotebookPage() && getNotebookConversationElements().length > 0
      ? getNotebookConversationElements()
      : getSidebarConversationElements();

  const stableHash = (value) => {
    let hash = 5381;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  };

  const loadNotebookChatUrlCache = () => {
    if (notebookChatUrlCache) return notebookChatUrlCache;
    try {
      const raw = pageWindow.localStorage?.getItem(NOTEBOOK_CHAT_URL_CACHE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      notebookChatUrlCache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      notebookChatUrlCache = {};
    }
    return notebookChatUrlCache;
  };

  const saveNotebookChatUrlCache = () => {
    try {
      pageWindow.localStorage?.setItem(
        NOTEBOOK_CHAT_URL_CACHE_STORAGE_KEY,
        JSON.stringify(loadNotebookChatUrlCache()),
      );
    } catch {
      // Cache é conveniência; export continua funcionando via clique.
    }
  };

  const clearNotebookChatUrlCache = (notebookId) => {
    const cache = loadNotebookChatUrlCache();
    if (notebookId) {
      Object.keys(cache).forEach((key) => {
        if (cache[key]?.notebookId === notebookId || key.includes(`notebook:${notebookId}:`)) {
          delete cache[key];
        }
      });
    } else {
      Object.keys(cache).forEach((key) => delete cache[key]);
    }
    saveNotebookChatUrlCache();
    return cache;
  };

  const loadBatchExportSession = () => {
    try {
      const raw = pageWindow.sessionStorage?.getItem(BATCH_EXPORT_SESSION_STORAGE_KEY);
      return raw ? normalizeBatchExportSession(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  };

  const saveBatchExportSession = (session) => {
    try {
      const normalized = normalizeBatchExportSession(session);
      if (!normalized) {
        pageWindow.sessionStorage?.removeItem(BATCH_EXPORT_SESSION_STORAGE_KEY);
        return null;
      }
      pageWindow.sessionStorage?.setItem(
        BATCH_EXPORT_SESSION_STORAGE_KEY,
        JSON.stringify(normalized),
      );
      return normalized;
    } catch {
      return null;
    }
  };

  const clearBatchExportSession = () => {
    try {
      pageWindow.sessionStorage?.removeItem(BATCH_EXPORT_SESSION_STORAGE_KEY);
    } catch {
      // melhor esforço
    }
  };

  const notebookChatUrlCacheSummary = () => {
    const cache = loadNotebookChatUrlCache();
    const entries = Object.entries(cache).map(([key, value]) => ({
      key,
      ...value,
    }));
    return {
      size: entries.length,
      currentNotebookId: currentNotebookId(),
      entries,
    };
  };

  const getConversationUrlFromElement = (element) => {
    const anchor = element.querySelector('a[href*="/app/"]');
    if (!anchor) return null;
    try {
      return new URL(anchor.getAttribute('href') || anchor.href, location.origin).href;
    } catch {
      return null;
    }
  };

  const getChatIdFromSidebarElement = (element) => {
    const url = getConversationUrlFromElement(element);
    if (url) {
      const chatId = extractChatId(new URL(url).pathname);
      if (chatId) return chatId;
    }

    const testId = element.getAttribute('data-test-id');
    if (testId?.startsWith('conversation_')) {
      return testId.slice('conversation_'.length);
    }

    const jslog = element.getAttribute('jslog');
    if (jslog) {
      const match = jslog.match(/BardVeMetadataKey:\[[^\]]*\["([^"]+)"/);
      if (match?.[1]) return match[1];
    }

    return null;
  };

  const getConversationTitleFromElement = (element, fallbackId) => {
    const title =
      cleanText(element.querySelector('.conversation-title, .title')?.textContent) ||
      cleanText(element.getAttribute('aria-label')) ||
      cleanText(element.textContent).split('\n')[0];
    return title && !/new chat/i.test(title) ? title : fallbackId;
  };

  const getNotebookConversationTitleFromElement = (element, fallbackId) => {
    const title =
      cleanText(element.querySelector('[data-test-id="chat-title"]')?.textContent) ||
      cleanText(element.querySelector('.chat-title')?.textContent) ||
      cleanText(element.getAttribute('aria-label')) ||
      cleanText(element.textContent).split('\n')[0];
    return title || fallbackId;
  };

  const getNotebookConversationSubtitleFromElement = (element) =>
    cleanText(element.querySelector('[data-test-id="chat-subtitle"]')?.textContent);

  const getNotebookConversationTimestampFromElement = (element) =>
    cleanText(element.querySelector('[data-test-id="chat-timestamp"]')?.textContent);

  const buildNotebookConversationCacheKey = (element, index) => {
    const notebookId = currentNotebookId() || 'notebook';
    const title = getNotebookConversationTitleFromElement(element, `chat-${index + 1}`);
    const subtitle = getNotebookConversationSubtitleFromElement(element);
    const timestamp = getNotebookConversationTimestampFromElement(element);
    return `notebook:${notebookId}:${index}:${stableHash(`${title}|${subtitle}|${timestamp}`)}`;
  };

  const getCachedNotebookConversation = (cacheKey) => {
    const entry = loadNotebookChatUrlCache()[cacheKey];
    if (!entry?.chatId) return null;
    return {
      ...entry,
      url: entry.url || `https://gemini.google.com/app/${entry.chatId}`,
    };
  };

  const rememberNotebookConversationUrl = (item, chatId, url) => {
    if (!item?.cacheKey || !chatId) return;
    const cache = loadNotebookChatUrlCache();
    cache[item.cacheKey] = {
      chatId,
      url: url || `https://gemini.google.com/app/${chatId}`,
      title: item.title || '',
      subtitle: item.subtitle || '',
      timestamp: item.timestamp || '',
      notebookId: item.notebookId || '',
      rowIndex: item.rowIndex,
      updatedAt: new Date().toISOString(),
    };
    saveNotebookChatUrlCache();
  };

  const extractNotebookChatIdFromText = (value) => {
    const text = String(value || '');
    const urlMatch = text.match(/\/app\/([a-f0-9]{12,})/i);
    if (urlMatch?.[1]) return urlMatch[1];

    const prefixedMatch = text.match(/\bc_([a-f0-9]{12,})\b/i);
    if (prefixedMatch?.[1]) return prefixedMatch[1];

    return null;
  };

  const extractNotebookChatIdFromAttributes = (element) => {
    const candidates = [element, ...Array.from(element.querySelectorAll('*')).slice(0, 80)];
    for (const candidate of candidates) {
      for (const attr of Array.from(candidate.attributes || [])) {
        const chatId = extractNotebookChatIdFromText(attr.value);
        if (chatId) return chatId;
      }
    }
    return null;
  };

  const getAngularContextRoots = (element) => {
    const roots = [];
    let current = element;
    let depth = 0;
    while (current && depth < 4) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key.includes('ng') || key.startsWith('__')) {
          try {
            roots.push(current[key]);
          } catch {
            // Algumas propriedades nativas podem lançar ao acessar.
          }
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return roots;
  };

  const extractNotebookChatIdFromObjectGraph = (roots) => {
    const seen = new WeakSet();
    const queue = roots.map((value) => ({ value, depth: 0 }));
    let steps = 0;

    while (queue.length > 0 && steps < 1800) {
      steps += 1;
      const { value, depth } = queue.shift();
      if (value == null || depth > 8) continue;

      if (typeof value === 'string') {
        const chatId = extractNotebookChatIdFromText(value);
        if (chatId) return chatId;
        continue;
      }

      if (typeof value !== 'object' && typeof value !== 'function') continue;
      if (seen.has(value)) continue;
      seen.add(value);

      let keys;
      try {
        keys = Object.getOwnPropertyNames(value).slice(0, 120);
      } catch {
        continue;
      }

      const isDomNode = typeof Node !== 'undefined' && value instanceof Node;
      for (const key of keys) {
        if (
          isDomNode &&
          !(key.includes('ng') || key.startsWith('__') || key === 'textContent')
        ) {
          continue;
        }
        if (/ownerDocument|parentElement|parentNode|children|childNodes|document|window/i.test(key)) {
          continue;
        }

        try {
          queue.push({ value: value[key], depth: depth + 1 });
        } catch {
          // Propriedade accessor inacessível; segue procurando.
        }
      }
    }

    return null;
  };

  const getNotebookChatIdFromElement = (element) => {
    if (notebookChatIdCache.has(element)) return notebookChatIdCache.get(element);

    const chatId =
      extractNotebookChatIdFromAttributes(element) ||
      extractNotebookChatIdFromObjectGraph(getAngularContextRoots(element));

    notebookChatIdCache.set(element, chatId || null);
    return chatId || null;
  };

  const buildNotebookConversationId = (element, index) => {
    const chatId = getNotebookChatIdFromElement(element);
    if (chatId) return `c_${chatId}`;

    const cached = getCachedNotebookConversation(buildNotebookConversationCacheKey(element, index));
    if (cached?.chatId) return `c_${cached.chatId}`;

    return buildNotebookConversationCacheKey(element, index);
  };

  const collectNotebookConversationLinks = () => {
    const notebookId = currentNotebookId();
    const rows = getNotebookConversationElements();
    return rows.map((element, index) => {
      const cacheKey = buildNotebookConversationCacheKey(element, index);
      const directChatId = getNotebookChatIdFromElement(element);
      const cached = getCachedNotebookConversation(cacheKey);
      const chatId = directChatId || cached?.chatId || '';
      const id = buildNotebookConversationId(element, index);
      const title = getNotebookConversationTitleFromElement(element, `Conversa ${index + 1}`);
      const subtitle = getNotebookConversationSubtitleFromElement(element);
      const timestamp = getNotebookConversationTimestampFromElement(element);
      return {
        id,
        chatId: chatId || '',
        title,
        subtitle,
        timestamp,
        url: chatId
          ? cached?.url || `https://gemini.google.com/app/${chatId}`
          : location.href,
        notebookUrl: location.href,
        current: false,
        source: 'notebook',
        notebookId,
        rowIndex: index,
        cacheKey,
        exportable: true,
      };
    });
  };

  const stripConversationPrefix = (value) => String(value || '').replace(/^c_/, '');

  const collectSidebarConversationLinks = () => {
    const seen = new Set();
    const items = [];
    const currentId = currentChatId();

    getSidebarConversationElements().forEach((element, index) => {
      const id = getChatIdFromSidebarElement(element) || `chat-${index}`;
      if (seen.has(id)) return;
      seen.add(id);

      const url =
        getConversationUrlFromElement(element) ||
        (id ? `https://gemini.google.com/app/${id.startsWith('c_') ? id.slice(2) : id}` : null);
      if (!url) return;

      const title = getConversationTitleFromElement(element, id);
      const pathname = new URL(url).pathname;
      const itemChatId = extractChatId(pathname) || id;
      const current =
        !!currentId &&
        (pathname === location.pathname ||
          stripConversationPrefix(itemChatId) === currentId ||
          stripConversationPrefix(id) === currentId);

      items.push({
        id,
        chatId: itemChatId,
        title,
        url,
        current,
        source: 'sidebar',
      });
    });

    if (currentId && !items.some((item) => item.chatId === currentId || item.url === location.href)) {
      items.unshift({
        id: currentId,
        chatId: currentId,
        title: scrapeTitle() || currentId,
        url: location.href,
        current: true,
        source: 'sidebar',
      });
    }

    return items.sort((a, b) => Number(b.current) - Number(a.current));
  };

  const mergeConversationLists = (...lists) => {
    const seen = new Set();
    const merged = [];
    lists.flat().forEach((item) => {
      if (!item) return;
      const key = `${item.source || 'sidebar'}:${item.chatId || item.id || item.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
    return merged;
  };

  const collectConversationLinks = () => {
    if (isNotebookPage()) {
      const notebookConversations = collectNotebookConversationLinks();
      if (notebookConversations.length > 0) return notebookConversations;
    }

    return collectSidebarConversationLinks();
  };

  const collectBridgeConversationLinks = () =>
    isNotebookPage()
      ? mergeConversationLists(collectSidebarConversationLinks(), collectNotebookConversationLinks())
      : collectSidebarConversationLinks();

  const refreshConversationState = () => {
    const previousSelection = new Set(state.selectedChatIds);
    state.conversations = collectConversationLinks();
    state.selectedChatIds = new Set(
      state.conversations
        .filter((item) =>
          previousSelection.size > 0
            ? previousSelection.has(item.id)
            : item.current,
        )
        .map((item) => item.id),
    );
  };

  const conversationSearchText = (item) =>
    [
      item.title,
      item.chatId,
      item.id,
      item.subtitle,
      item.timestamp,
      item.notebookId,
      item.source,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

  const conversationDisplayId = (item) =>
    item.chatId ||
    item.timestamp ||
    (item.source === 'notebook' ? 'Conversa do caderno' : item.id);

  const currentListKind = () =>
    isNotebookPage() && state.conversations.some((item) => item.source === 'notebook')
      ? 'notebook'
      : 'sidebar';

  const listEndText = () => {
    const kind = currentListKind();
    if (state.isLoadingMore) {
      return kind === 'notebook'
        ? 'Buscando mais conversas no caderno...'
        : 'Buscando mais histórico no sidebar...';
    }
    if (state.reachedSidebarEnd) {
      return kind === 'notebook'
        ? 'Fim das conversas carregadas no caderno.'
        : 'Fim do histórico carregado no sidebar.';
    }
    return kind === 'notebook'
      ? 'Role até o fim ou use "Puxar mais conversas".'
      : 'Role até o fim ou use "Puxar mais histórico".';
  };

  const listIdleStatusText = () =>
    currentListKind() === 'notebook'
      ? 'A lista acompanha as conversas carregadas neste caderno.'
      : 'A lista acompanha o sidebar do Gemini e tenta puxar mais histórico quando você rola até o fim.';

  const listEndStatusText = () =>
    currentListKind() === 'notebook'
      ? 'Chegou no fim do caderno — não há mais conversas pra carregar.'
      : 'Chegou no fim do histórico carregado. Se ainda faltar conversa antiga, role o sidebar do Gemini manualmente pra forçar mais carregamento.';

  const hasConversationNode = (node) => {
    if (!(node instanceof Element)) return false;
    return (
      node.matches?.('[data-test-id="conversation"]') ||
      !!node.querySelector?.('[data-test-id="conversation"]') ||
      node.matches?.('project-chat-row') ||
      !!node.querySelector?.('project-chat-row')
    );
  };

  const scheduleSidebarRefresh = () => {
    clearTimeout(sidebarRefreshTimer);
    sidebarRefreshTimer = setTimeout(() => {
      refreshConversationState();
      const modal = document.getElementById(MODAL_ID);
      if (modal && !modal.hidden) {
        updateModalState();
      }
    }, 60);
  };

  const stopSidebarConversationObserver = () => {
    if (sidebarConversationObserver) {
      sidebarConversationObserver.disconnect();
      sidebarConversationObserver = null;
    }
    clearTimeout(sidebarRefreshTimer);
    sidebarRefreshTimer = 0;
  };

  const startSidebarConversationObserver = () => {
    stopSidebarConversationObserver();
    const conversationsList = isNotebookPage()
      ? findNotebookHistoryScroller().wrapper
      : document.querySelector('conversations-list');
    if (!conversationsList) return;

    sidebarConversationObserver = new MutationObserver((mutations) => {
      if (
        mutations.some((mutation) =>
          Array.from(mutation.addedNodes).some((node) => hasConversationNode(node)),
        )
      ) {
        scheduleSidebarRefresh();
      }
    });

    sidebarConversationObserver.observe(conversationsList, {
      childList: true,
      subtree: true,
    });
  };

  const resolveLoadMoreOptions = (options = {}) => ({
    ...DEFAULT_LOAD_MORE_OPTIONS,
    ...(options?.fastMode ? FAST_LOAD_MORE_OPTIONS : null),
    ...options,
  });

  const waitForSidebarConversationGrowth = (beforeCount, timeoutMs = 1800) =>
    new Promise((resolve) => {
      const conversationsList = isNotebookPage()
        ? findNotebookHistoryScroller().wrapper
        : document.querySelector('conversations-list');
      if (!conversationsList) {
        resolve(false);
        return;
      }

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };

      const checkGrowth = () => {
        const currentCount = getConversationElementsForCurrentPage().length;
        if (currentCount > beforeCount) {
          scheduleSidebarRefresh();
          finish(true);
        }
      };

      const observer = new MutationObserver((mutations) => {
        if (
          mutations.some((mutation) =>
            Array.from(mutation.addedNodes).some((node) => hasConversationNode(node)),
          )
        ) {
          checkGrowth();
        }
      });

      observer.observe(conversationsList, {
        childList: true,
        subtree: true,
      });

      const timer = setTimeout(() => finish(false), timeoutMs);
      checkGrowth();
    });

  // Retorna { loaded, scroller } — `scroller` é o elemento onde efetivamente
  // rolamos, para o caller inspecionar se chegou ao fundo de verdade e não
  // declarar "fim da lista" por no-op.
  const triggerSidebarLoading = async (options = {}) => {
    const loadOptions = resolveLoadMoreOptions(options);
    if (!isNotebookPage()) await ensureSidebarOpen();

    let scrollContainer = null;
    if (isNotebookPage()) {
      scrollContainer = findNotebookHistoryScroller().scroller;
    }
    scrollContainer =
      scrollContainer ||
      document.querySelector('conversations-list') ||
      document.querySelector('[role="navigation"]') ||
      findScrollableParent(document.querySelector('[data-test-id="conversation"]'));
    if (!scrollContainer) return { loaded: false, scroller: null };

    const before = getConversationElementsForCurrentPage().length;
    const growthPromise = waitForSidebarConversationGrowth(
      before,
      loadOptions.growthTimeoutMs,
    );
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(loadOptions.preScrollPauseMs);
    const lastConversation = getConversationElementsForCurrentPage().at(-1);
    if (lastConversation) {
      lastConversation.scrollIntoView({ block: 'end' });
      scrollContainer.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: loadOptions.wheelDeltaY,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    const loaded = await growthPromise;
    await sleep(loadOptions.postLoadSettleMs);
    const grew =
      loaded || getConversationElementsForCurrentPage().length > before;
    return { loaded: grew, scroller: scrollContainer };
  };

  const loadMoreConversations = async (attempts = 2, options = {}) => {
    const loadOptions = resolveLoadMoreOptions(options);
    if (state.isLoadingMore || state.loadMoreFailures >= 3) return false;
    state.isLoadingMore = true;
    try {
      let loaded = false;
      let scroller = null;
      for (let i = 0; i < attempts; i++) {
        const result = await triggerSidebarLoading(loadOptions);
        loaded = result.loaded;
        scroller = result.scroller || scroller;
        if (loaded) break;
        if (i < attempts - 1) {
          await sleep(loadOptions.retryPauseMs);
        }
      }
      state.loadMoreFailures = loaded ? 0 : state.loadMoreFailures + 1;

      // Só declarar "fim" se:
      //  (a) realmente rolamos até o fundo do scroller certo (ou ele nao
      //      tem overflow — lista inteira já cabe), e
      //  (b) a(s) tentativa(s) nao trouxeram novos itens.
      // Sem isso, um no-op de scroll (scroller errado) virava "fim" falso.
      let scrolledToBottom = isAtBottom(scroller);
      if (
        !loaded &&
        loadOptions.fastMode &&
        scrolledToBottom
      ) {
        const confirmation = await triggerSidebarLoading({
          ...loadOptions,
          growthTimeoutMs: Math.max(
            loadOptions.growthTimeoutMs,
            loadOptions.confirmEndGrowthTimeoutMs,
          ),
          postLoadSettleMs: Math.max(
            loadOptions.postLoadSettleMs,
            loadOptions.confirmEndPostLoadSettleMs,
          ),
        });
        loaded = confirmation.loaded;
        scroller = confirmation.scroller || scroller;
        if (loaded) {
          state.loadMoreFailures = 0;
        }
        scrolledToBottom = isAtBottom(scroller);
      }
      state.reachedSidebarEnd =
        !loaded && state.loadMoreFailures >= 1 && scrolledToBottom;
      if (loaded) {
        state.reachedSidebarEnd = false;
      }
      refreshConversationState();
      updateModalState();
      return loaded;
    } finally {
      state.isLoadingMore = false;
      updateModalState();
    }
  };

  const countNodes = (selector) => document.querySelectorAll(selector).length;

  const listCustomTags = () => {
    const counts = new Map();
    document.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (!tag.includes('-')) return;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));
  };

  const listLegacyUiNodes = () =>
    LEGACY_UI_SELECTORS.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((el) => ({
        selector,
        tag: el.tagName.toLowerCase(),
        visible: !!visibleRect(el),
      })),
    );

  const debugSnapshot = () => ({
    version: '__VERSION__',
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    buildStamp: '__BUILD_STAMP__',
    url: location.href,
    pathname: location.pathname,
    chatId: extractChatId(location.pathname),
    notebookId: currentNotebookId(),
    pageKind: isNotebookPage() ? 'notebook' : 'chat',
    title: scrapeTitle(),
    model: scrapeModel(),
    turnCount: scrapeTurns(document).length,
    selectorCounts: {
      'user-query': countNodes('user-query'),
      'model-response': countNodes('model-response'),
      'project-chat-row': countNodes('project-chat-row'),
    },
    customTags: listCustomTags(),
    buttonPresent: !!document.getElementById(BUTTON_ID),
    modalPresent: !!document.getElementById(MODAL_ID),
    legacyUiNodes: listLegacyUiNodes(),
    sidebarOpen: isSidebarOpen(),
    directoryPickerSupported: supportsDirectoryPicker(),
    listedConversationCount: collectConversationLinks().length,
    bridgeConversationCount: collectBridgeConversationLinks().length,
    reachedSidebarEnd: state.reachedSidebarEnd,
    batchExportSession: loadBatchExportSession(),
  });

  const compactOuterHtml = (el, maxLength = 1200) => {
    const html = String(el?.outerHTML || '');
    return html.length > maxLength ? `${html.slice(0, maxLength)}...` : html;
  };

  const inspectMediaElement = (el, { includeHtml = true } = {}) => {
    const rect = visibleRect(el);
    const target = mediaReplacementTarget(el, document.body);
    const targetRect = visibleRect(target);
    const turn = el.closest?.('user-query, model-response');
    const targetTurn = target?.closest?.('user-query, model-response') || turn;
    const targetButton = el.closest?.('button, [role="button"]');
    const source = mediaSourceOf(el);
    const kind = mediaKindOf(el);
    return {
      kind,
      tag: el.tagName?.toLowerCase() || null,
      role: targetTurn ? roleOf(targetTurn) : null,
      inTurn: !!targetTurn,
      turnIndex: targetTurn
        ? Array.from(document.querySelectorAll('user-query, model-response')).indexOf(targetTurn)
        : -1,
      source,
      description: describeMedia(el),
      alt: el.getAttribute?.('alt') || '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
      title: el.getAttribute?.('title') || '',
      className: String(el.getAttribute?.('class') || ''),
      visible: !!rect,
      rect: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
      targetTag: target?.tagName?.toLowerCase() || null,
      targetAriaLabel: target?.getAttribute?.('aria-label') || '',
      targetText: normalizeWhitespace(target?.textContent || '').slice(0, 240),
      targetVisible: !!targetRect,
      targetRect: targetRect
        ? {
            x: Math.round(targetRect.x),
            y: Math.round(targetRect.y),
            width: Math.round(targetRect.width),
            height: Math.round(targetRect.height),
          }
        : null,
      buttonAriaLabel: targetButton?.getAttribute?.('aria-label') || '',
      buttonText: normalizeWhitespace(targetButton?.textContent || '').slice(0, 240),
      outerHTML: includeHtml ? compactOuterHtml(el) : '',
      targetOuterHTML: includeHtml && target && target !== el ? compactOuterHtml(target) : '',
    };
  };

  const inspectMediaDom = () => {
    const allElements = Array.from(document.querySelectorAll(MEDIA_ASSET_SELECTOR));
    const mediaElements = allElements.filter((el) => mediaKindOf(el));
    const maxItems = 80;
    const items = mediaElements
      .slice(0, maxItems)
      .map((el) => inspectMediaElement(el, { includeHtml: mediaElements.length <= 30 }));
    return {
      url: location.href,
      chatId: currentChatId(),
      buildStamp: BUILD_STAMP,
      selector: MEDIA_ASSET_SELECTOR,
      matchedSelectorCount: allElements.length,
      total: mediaElements.length,
      returned: items.length,
      truncated: mediaElements.length > items.length,
      inTurns: items.filter((item) => item.inTurn).length,
      byKind: items.reduce((acc, item) => {
        const key = item.kind || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      items,
    };
  };

  const reportFailure = (message) => {
    const snapshot = debugSnapshot();
    warn(message, snapshot);
    showToast(message, 'error');
    return snapshot;
  };

  const randomId = () => {
    try {
      return pageWindow.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    } catch {
      return Math.random().toString(36).slice(2);
    }
  };

  const withTimeout = (promise, timeoutMs, message) =>
    new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
        () => reject(new Error(message || 'timeout')),
        timeoutMs,
      );
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      );
    });

  const extensionSendMessage = (message, { timeoutMs = 12000 } = {}) =>
    withTimeout(
      new Promise((resolve, reject) => {
        if (!isExtensionContext) {
          resolve(null);
          return;
        }

        try {
          chrome.runtime.sendMessage(message, (response) => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(response || null);
          });
        } catch (err) {
          reject(err);
        }
      }),
      timeoutMs,
      `Tempo esgotado ao falar com a extensão (${message?.type || 'mensagem'}).`,
    );

  const fetchWithTimeout = async (url, options = {}, timeoutMs = 10000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const bridgeRequest = async (path, { method = 'GET', payload, timeoutMs = 10000 } = {}) => {
    const response = await fetchWithTimeout(
      `${BRIDGE_BASE_URL}${path}`,
      {
        method,
        headers: payload
          ? { 'content-type': 'text/plain;charset=UTF-8' }
          : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        mode: 'cors',
        cache: 'no-store',
      },
      timeoutMs,
    );

    if (response.status === 204) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const setBridgeOutputDir = (outputDir) => {
    state.bridgeOutputDir = String(outputDir || '').trim();
    state.bridgeSaveFallbackNotified = false;
    try {
      if (state.bridgeOutputDir) {
        pageWindow.localStorage?.setItem(
          BRIDGE_OUTPUT_DIR_STORAGE_KEY,
          state.bridgeOutputDir,
        );
      } else {
        pageWindow.localStorage?.removeItem(BRIDGE_OUTPUT_DIR_STORAGE_KEY);
      }
    } catch {
      // localStorage pode estar bloqueado; a escolha ainda vale nesta sessão.
    }
  };

  // Retorna um status explícito pra que o chamador possa distinguir
  // "cancelou" (usuário fechou o seletor — não é erro) de "falhou" (MCP
  // offline, seletor quebrou, stderr vazio etc.). Antes isso ia tudo pro
  // mesmo catch e virava um toast de erro, o que confundia: cancelar uma
  // ação não deveria gerar erro.
  const pickBridgeOutputDir = async () => {
    let response;
    try {
      response = await bridgeRequest('/bridge/pick-directory', {
        method: 'POST',
        payload: {
          clientId: bridgeState.clientId,
          tabId: bridgeState.tabId,
        },
        timeoutMs: BRIDGE_PICKER_TIMEOUT_MS,
      });
    } catch (err) {
      // Erro de rede/bridge: extrai mensagem mas deixa claro que é falha
      // real, não cancelamento.
      const reason = err?.message || String(err) || 'erro desconhecido';
      return { status: 'error', reason };
    }

    if (response?.cancelled) return { status: 'cancelled' };

    // Algumas respostas do bridge em falha vêm com `ok: false` e
    // `error` como string humana; outras vêm com `error` contendo
    // mensagem de cancel (quando o MCP antigo não tratou o cancel ou
    // quando o locale do macOS retorna "Cancelado pelo usuário" etc.).
    // -128 é o código universal de cancelamento do AppleScript e funciona
    // independente de locale.
    if (!response?.ok || !response.outputDir) {
      const reason = response?.error || 'O MCP não devolveu uma pasta.';
      if (
        /-128\b|user canceled|cancelled|canceled|cancelado|annul|abgebrochen/i.test(
          reason,
        )
      ) {
        return { status: 'cancelled' };
      }
      return { status: 'error', reason };
    }

    setBridgeOutputDir(response.outputDir);
    state.directoryHandle = null;
    return { status: 'picked', outputDir: response.outputDir };
  };

  const saveExportViaBridge = async (payload, options = {}) => {
    const response = await bridgeRequest('/bridge/save-files', {
      method: 'POST',
      payload: {
        clientId: bridgeState.clientId,
        tabId: bridgeState.tabId,
        outputDir: (options.outputDir ?? state.bridgeOutputDir) || undefined,
        files: [
          {
            filename: payload.filename,
            content: payload.content,
          },
          ...(payload.mediaFiles || []),
        ],
      },
      timeoutMs: BRIDGE_FILE_TIMEOUT_MS,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Falha ao salvar via bridge MCP.');
    }

    return response.files?.[0] || null;
  };

  const writeBrowserFile = async (directoryHandle, filename, file) => {
    const parts = String(filename || '')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error('Nome de arquivo inválido para salvar no navegador.');
    }

    let parent = directoryHandle;
    for (const part of parts.slice(0, -1)) {
      parent = await parent.getDirectoryHandle(part, { create: true });
    }

    const fileHandle = await parent.getFileHandle(parts[parts.length - 1], {
      create: true,
    });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    if (file.contentBase64) {
      const binary = atob(file.contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      await writable.write(
        new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }),
      );
    } else {
      await writable.write(file.content || '');
    }
    await writable.close();
  };

  const saveExportViaDirectoryHandle = async (payload) => {
    await writeBrowserFile(state.directoryHandle, payload.filename, {
      content: payload.content,
    });
    for (const file of payload.mediaFiles || []) {
      await writeBrowserFile(state.directoryHandle, file.filename, file);
    }
  };

  const buildBridgeSummary = () => {
    const modalConversations = collectConversationLinks();
    const bridgeConversations = collectBridgeConversationLinks();
    return {
      clientId: bridgeState.clientId,
      tabId: bridgeState.tabId,
      windowId: bridgeState.windowId,
      isActiveTab: bridgeState.isActiveTab,
      extensionVersion: bridgeState.extensionVersion,
      protocolVersion: bridgeState.protocolVersion,
      buildStamp: bridgeState.buildStamp,
      commandPoll: {
        polling: bridgeState.polling,
        lastStartedAt: bridgeState.lastCommandPollStartedAt
          ? new Date(bridgeState.lastCommandPollStartedAt).toISOString()
          : null,
        lastEndedAt: bridgeState.lastCommandPollEndedAt
          ? new Date(bridgeState.lastCommandPollEndedAt).toISOString()
          : null,
        lastCommandReceivedAt: bridgeState.lastCommandReceivedAt
          ? new Date(bridgeState.lastCommandReceivedAt).toISOString()
          : null,
      },
      observedAt: new Date().toISOString(),
      staleAfterMs: BRIDGE_CLIENT_STALE_MS,
      page: {
        url: location.href,
        pathname: location.pathname,
        title: scrapeTitle(),
        chatId: currentChatId(),
        notebookId: currentNotebookId(),
        kind: isNotebookPage() ? 'notebook' : 'chat',
        model: scrapeModel(),
        turnCount: scrapeTurns(document).length,
        listedConversationCount: modalConversations.length,
        bridgeConversationCount: bridgeConversations.length,
        sidebarConversationCount: bridgeConversations.filter((item) => item.source !== 'notebook')
          .length,
        notebookConversationCount: bridgeConversations.filter((item) => item.source === 'notebook')
          .length,
        notebookCacheCount: notebookChatUrlCacheSummary().size,
        reachedSidebarEnd: state.reachedSidebarEnd,
        isActiveTab: bridgeState.isActiveTab,
        protocolVersion: bridgeState.protocolVersion,
        buildStamp: bridgeState.buildStamp,
      },
      conversations: bridgeConversations.slice(0, 100),
      modalConversations: modalConversations.slice(0, 100),
    };
  };

  // --- ação de exportar -------------------------------------------------

  const MEDIA_ASSET_SELECTOR = MEDIA_SELECTOR;
  const MEDIA_EXPORT_TOTAL_BUDGET_MS = 25000;
  const MEDIA_IMAGE_READY_TIMEOUT_MS = 2200;
  const MEDIA_IMAGE_SCROLL_SETTLE_MS = 180;
  const MEDIA_LIGHTBOX_TIMEOUT_MS = 2400;
  const LIGHTBOX_ROOT_SELECTOR = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    'image-lightbox',
    'mat-dialog-container',
    '.mat-mdc-dialog-container',
    '.cdk-overlay-pane',
    '.cdk-overlay-container',
    '.lightbox',
    '.image-lightbox',
  ].join(',');

  const mediaAssetExtensionFor = (mimeType, source) => {
    const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
    if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
    if (type === 'image/png') return 'png';
    if (type === 'image/webp') return 'webp';
    if (type === 'image/gif') return 'gif';
    if (type === 'image/avif') return 'avif';
    if (type === 'image/svg+xml') return 'svg';

    const sourceExt = String(source || '').match(
      /\.([a-z0-9]{2,5})(?:[?#].*)?$/i,
    )?.[1];
    if (sourceExt && /^(?:avif|gif|jpe?g|png|svg|webp)$/i.test(sourceExt)) {
      return sourceExt.toLowerCase() === 'jpeg' ? 'jpg' : sourceExt.toLowerCase();
    }
    return 'png';
  };

  const escapeMarkdownAlt = (value) =>
    normalizeWhitespace(value || 'Imagem do Gemini')
      .replace(/\\/g, '\\\\')
      .replace(/\]/g, '\\]');

  const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const parseDataUrlAsset = (source) => {
    const match = String(source || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
    if (!match) return null;
    const mimeType = match[1] || 'application/octet-stream';
    const isBase64 = !!match[2];
    const data = match[3] || '';
    return {
      mimeType,
      contentBase64: isBase64
        ? data
        : arrayBufferToBase64(new TextEncoder().encode(decodeURIComponent(data)).buffer),
    };
  };

  const shouldFetchWithCredentials = (source) => {
    try {
      const url = new URL(source, location.href);
      return url.origin === location.origin;
    } catch {
      return false;
    }
  };

  const shouldFetchViaBackgroundFirst = (source) => {
    if (!isExtensionContext) return false;
    try {
      const url = new URL(source, location.href);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin !== location.origin
      );
    } catch {
      return false;
    }
  };

  const shouldPrepareImageBeforeFetch = (source) =>
    !/^(?:blob|data):/i.test(String(source || ''));

  const canvasToAsset = (canvas) => {
    const dataUrl = canvas.toDataURL('image/png');
    return parseDataUrlAsset(dataUrl);
  };

  const imageElementToAsset = async (img) => {
    if (!(img instanceof HTMLImageElement)) return null;
    if (!img.complete) {
      await withTimeout(
        img.decode?.() || Promise.resolve(),
        1500,
        'Tempo esgotado ao decodificar imagem renderizada.',
      );
    }
    if (!img.naturalWidth || !img.naturalHeight) return null;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(img, 0, 0);
    return canvasToAsset(canvas);
  };

  const waitForImageElementReady = async (img, timeoutMs = MEDIA_IMAGE_READY_TIMEOUT_MS) => {
    if (!(img instanceof HTMLImageElement)) return false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return true;
      }
      try {
        await withTimeout(img.decode?.() || Promise.resolve(), 350, 'decode-timeout');
      } catch {
        await sleep(100);
      }
    }
    return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  };

  const prepareImageElementForExport = async (img) => {
    if (!(img instanceof HTMLImageElement)) return mediaSourceOf(img);

    try {
      img.loading = 'eager';
    } catch {
      // A imagem ainda pode ser preparada via scroll/decode.
    }

    try {
      img.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      try {
        img.scrollIntoView();
      } catch {
        // Se o host bloquear scrollIntoView, seguimos com o src atual.
      }
    }

    await sleep(MEDIA_IMAGE_SCROLL_SETTLE_MS);
    await waitForImageElementReady(img);
    return mediaSourceOf(img);
  };

  const visibleElement = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect?.();
    return !rect || rect.width > 0 || rect.height > 0;
  };

  const waitForCondition = async (predicate, timeoutMs, intervalMs = 80) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return predicate() || null;
  };

  const cssUrlValues = (value) => {
    const urls = [];
    const pattern = /url\((['"]?)(.*?)\1\)/gi;
    let match;
    while ((match = pattern.exec(String(value || '')))) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  };

  const srcsetUrls = (value) =>
    String(value || '')
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);

  const pushUnique = (list, value) => {
    const normalized = normalizeWhitespace(value || '');
    if (!normalized || list.includes(normalized)) return;
    list.push(normalized);
  };

  const mediaSourcesFromRoot = (root) => {
    const sources = [];
    if (!root?.querySelectorAll) return sources;

    root.querySelectorAll('img, video, audio, source, object, embed, a[href]').forEach((el) => {
      pushUnique(sources, el.currentSrc);
      pushUnique(sources, el.getAttribute?.('currentSrc'));
      pushUnique(sources, el.src);
      pushUnique(sources, el.getAttribute?.('src'));
      pushUnique(sources, el.getAttribute?.('data-src'));
      pushUnique(sources, el.href);
      pushUnique(sources, el.getAttribute?.('href'));
      pushUnique(sources, el.getAttribute?.('data-download-url'));
      pushUnique(sources, el.data);
      pushUnique(sources, el.getAttribute?.('data'));
      srcsetUrls(el.getAttribute?.('srcset')).forEach((source) => pushUnique(sources, source));
    });

    root.querySelectorAll('[style]').forEach((el) => {
      cssUrlValues(el.style?.backgroundImage || el.getAttribute?.('style')).forEach((source) =>
        pushUnique(sources, source),
      );
    });

    return sources;
  };

  const findLightboxTrigger = (img) => {
    if (!(img instanceof HTMLElement)) return null;
    return (
      img.closest('.image-button, .preview-image-button, button, [role="button"]') ||
      mediaReplacementTarget(img, document.body)
    );
  };

  const lightboxRoots = () =>
    Array.from(document.querySelectorAll(LIGHTBOX_ROOT_SELECTOR)).filter(
      (el) => !el.closest?.(`#${MODAL_ID}`),
    );

  const findOpenedLightbox = (previousRoots) => {
    const before = previousRoots || new Set();
    const roots = lightboxRoots().filter(visibleElement);
    return (
      roots.find((root) => !before.has(root) && mediaSourcesFromRoot(root).length > 0) ||
      roots.find((root) => mediaSourcesFromRoot(root).length > 0) ||
      null
    );
  };

  const closeLightbox = async (root, previousActiveElement) => {
    const closeButton = root?.querySelector?.(
      [
        'button[aria-label*="Close" i]',
        'button[aria-label*="Fechar" i]',
        'button[aria-label*="Dismiss" i]',
        'button[data-test-id*="close" i]',
        '[role="button"][aria-label*="Close" i]',
        '[role="button"][aria-label*="Fechar" i]',
        '[mat-dialog-close]',
      ].join(','),
    );
    if (closeButton) {
      closeButton.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await sleep(120);
    try {
      previousActiveElement?.focus?.({ preventScroll: true });
    } catch {
      // Foco é conforto visual; export continua sem isso.
    }
  };

  const fetchMediaFromSources = async (sources) => {
    const errors = [];
    for (const source of sources) {
      try {
        const asset = await fetchImageAsset(source);
        if (asset?.contentBase64) {
          return { asset, source };
        }
      } catch (err) {
        errors.push(`${source}: ${err?.message || String(err)}`);
      }
    }
    if (errors.length) {
      throw new Error(errors.join('; '));
    }
    return null;
  };

  const fetchImageAssetViaLightbox = async (img, originalSource) => {
    const trigger = findLightboxTrigger(img);
    if (!trigger || trigger === img) return null;

    const previousRoots = new Set(lightboxRoots());
    const previousActiveElement = document.activeElement;
    try {
      trigger.click();
      const root = await waitForCondition(
        () => findOpenedLightbox(previousRoots),
        MEDIA_LIGHTBOX_TIMEOUT_MS,
      );
      if (!root) return null;

      try {
        const sources = mediaSourcesFromRoot(root).filter((source) => source !== originalSource);
        return await fetchMediaFromSources(sources);
      } finally {
        await closeLightbox(root, previousActiveElement);
      }
    } catch (err) {
      throw new Error(`lightbox: ${err?.message || String(err)}`);
    }
  };

  const captureMediaScrollPosition = () => {
    try {
      const { el: scroller } = getGeminiScrollHost(document, window);
      const target = getScrollTarget(scroller, document, window);
      return {
        target,
        top: getScrollTop(target, window),
      };
    } catch {
      return null;
    }
  };

  const restoreMediaScrollPosition = async (position) => {
    if (!position) return;
    try {
      setScrollTop(position.target, window, position.top);
      await sleep(50);
    } catch {
      // Restauração de scroll é conforto visual, não deve quebrar export.
    }
  };

  const fetchImageAssetViaBackground = async (source) => {
    const response = await extensionSendMessage(
      {
        type: 'gemini-md-export/fetch-asset',
        source,
      },
      { timeoutMs: 9000 },
    );
    if (!response?.ok || !response.contentBase64) {
      throw new Error(response?.error || 'background-fetch-failed');
    }
    return {
      mimeType: response.mimeType || 'application/octet-stream',
      contentBase64: response.contentBase64,
    };
  };

  const fetchImageAsset = async (source) => {
    if (!source) return null;
    if (/^data:/i.test(source)) return parseDataUrlAsset(source);

    const fetchFromPage = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      try {
        const response = await fetch(source, {
          credentials: shouldFetchWithCredentials(source) ? 'include' : 'omit',
          cache: 'force-cache',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        return {
          mimeType: blob.type || 'application/octet-stream',
          contentBase64: arrayBufferToBase64(await blob.arrayBuffer()),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    if (shouldFetchViaBackgroundFirst(source)) {
      try {
        return await fetchImageAssetViaBackground(source);
      } catch (backgroundErr) {
        try {
          return await fetchFromPage();
        } catch (pageErr) {
          throw new Error(
            `background: ${backgroundErr?.message || String(backgroundErr)}; page: ${
              pageErr?.message || String(pageErr)
            }`,
          );
        }
      }
    }

    try {
      return await fetchFromPage();
    } catch (err) {
      if (isExtensionContext) {
        try {
          return await fetchImageAssetViaBackground(source);
        } catch (backgroundErr) {
          throw new Error(
            `page: ${err?.message || String(err)}; background: ${
              backgroundErr?.message || String(backgroundErr)
            }`,
          );
        }
      }
      throw err;
    }
  };

  const collectMediaCandidatesForTurn = (turnNode) => {
    const candidates = [];
    const replaced = new Set();
    Array.from(turnNode.querySelectorAll(MEDIA_ASSET_SELECTOR)).forEach((el) => {
      const kind = mediaKindOf(el);
      if (kind !== 'image' && kind !== 'canvas') return;

      const target = mediaReplacementTarget(el, turnNode);
      if (replaced.has(target) || !turnNode.contains(target)) return;

      const placeholder = mediaPlaceholderFor(el);
      if (!placeholder) return;

      replaced.add(target);
      candidates.push({
        el,
        kind,
        placeholder,
        description: describeMedia(el),
        source: mediaSourceOf(el),
      });
    });
    return candidates;
  };

  const replaceFirst = (text, search, replacement) => {
    const index = text.indexOf(search);
    if (index < 0) return text;
    return text.slice(0, index) + replacement + text.slice(index + search.length);
  };

  const collectMediaAssetsForExport = async (doc, chatId, turns) => {
    const nodes = Array.from(doc.querySelectorAll('user-query, model-response'));
    const updatedTurns = turns.map((turn) => ({ ...turn }));
    const files = [];
    const failures = [];
    let exportedTurnIndex = 0;
    const deadlineAt = Date.now() + MEDIA_EXPORT_TOTAL_BUDGET_MS;
    const scrollPosition = captureMediaScrollPosition();

    try {
      for (const node of nodes) {
        if (Date.now() >= deadlineAt) {
          warn('Tempo de importação de mídia esgotado; mantendo placeholders restantes.');
          break;
        }

        const role = roleOf(node);
        if (!role) continue;

        const extracted = extractMarkdown(node);
        if (!extracted.trim()) continue;

        const turn = updatedTurns[exportedTurnIndex];
        if (!turn) break;

        const candidates = collectMediaCandidatesForTurn(node);
        let mediaIndex = 0;
        for (const candidate of candidates) {
          if (Date.now() >= deadlineAt) {
            warn('Tempo de importação de mídia esgotado; mantendo placeholders restantes.');
            break;
          }

          mediaIndex += 1;
          let source = candidate.source;
          try {
            let asset = null;
            if (candidate.kind === 'canvas') {
              asset = canvasToAsset(candidate.el);
            } else {
              if (shouldPrepareImageBeforeFetch(source)) {
                source = (await prepareImageElementForExport(candidate.el)) || source;
              }
              try {
                asset = await fetchImageAsset(source);
              } catch (fetchErr) {
                let finalFetchErr = fetchErr;
                try {
                  asset = await imageElementToAsset(candidate.el);
                } catch {
                  asset = null;
                }
                if (!asset?.contentBase64) {
                  try {
                    const lightboxResult = await fetchImageAssetViaLightbox(candidate.el, source);
                    if (lightboxResult?.asset?.contentBase64) {
                      asset = lightboxResult.asset;
                      source = lightboxResult.source || source;
                    }
                  } catch (lightboxErr) {
                    finalFetchErr = new Error(
                      `${fetchErr?.message || String(fetchErr)}; ${
                        lightboxErr?.message || String(lightboxErr)
                      }`,
                    );
                  }
                }
                if (!asset?.contentBase64) throw finalFetchErr;
              }
            }
            if (!asset?.contentBase64) continue;

            const ext = mediaAssetExtensionFor(asset.mimeType, source);
            const rolePrefix = role === 'user' ? 'user' : 'gemini';
            const filename = `assets/${chatId}/${rolePrefix}-${String(
              exportedTurnIndex + 1,
            ).padStart(2, '0')}-image-${String(mediaIndex).padStart(2, '0')}.${ext}`;
            const markdownPath = filename;
            const markdownImage = `![${escapeMarkdownAlt(candidate.description)}](${markdownPath})`;

            files.push({
              filename,
              contentBase64: asset.contentBase64,
              mimeType: asset.mimeType,
            });
            turn.text = replaceFirst(turn.text, candidate.placeholder, markdownImage);
          } catch (err) {
            failures.push({
              turnIndex: exportedTurnIndex + 1,
              role,
              kind: candidate.kind,
              description: candidate.description,
              source,
              originalSource: source === candidate.source ? undefined : candidate.source,
              error: err?.message || String(err),
            });
            warn('Não consegui baixar a mídia; mantendo warning no Markdown.', {
              source,
              originalSource: source === candidate.source ? undefined : candidate.source,
              error: err?.message || String(err),
            });
          }
        }

        exportedTurnIndex += 1;
      }
    } finally {
      await restoreMediaScrollPosition(scrollPosition);
    }

    return {
      turns: updatedTurns,
      files,
      failures,
    };
  };

  const buildExportPayload = async (doc, url, options = {}) => {
    const chatId = extractChatId(new URL(url).pathname);
    const turns = options.turns || scrapeTurns(doc);
    if (!chatId) {
      throw new Error('Chat ID não encontrado para a conversa.');
    }
    if (turns.length === 0) {
      throw new Error('Nenhum turno detectado para esta conversa.');
    }

    const meta = {
      chatId,
      title: scrapeTitleFromDocument(doc),
      url,
      exportedAt: new Date().toISOString(),
      model: scrapeModelFromDocument(doc),
    };

    const fallbackContent = buildDocument({ meta, turns });
    if (state.progress) {
      updateExportProgress({ label: 'Baixando mídias da conversa...' });
    }
    const media = await collectMediaAssetsForExport(doc, chatId, turns);

    return {
      chatId,
      turns: media.turns,
      title: meta.title || chatId,
      filename: buildFilename(chatId),
      content: buildDocument({ meta, turns: media.turns }),
      fallbackContent,
      mediaFiles: media.files,
      mediaFailures: media.failures,
      hydration: options.hydration || null,
    };
  };

  const stripGeminiConversationPrefix = (value) => String(value || '').replace(/^c_/, '');

  const extractChatIdFromMaybeUrl = (value) => {
    if (!value || typeof value !== 'string') return null;
    try {
      return extractChatId(new URL(value, location.origin).pathname);
    } catch {
      return null;
    }
  };

  const findConversationForBridgeCommand = (args = {}) => {
    const conversations = collectBridgeConversationLinks();
    const item = args.item || {};

    if (item.source === 'notebook') {
      return item;
    }

    if (args.index !== undefined && args.index !== null) {
      const index = Number(args.index);
      if (!Number.isInteger(index) || index < 1) {
        throw new Error('index precisa ser um inteiro a partir de 1.');
      }
      const match = conversations[index - 1];
      if (!match) throw new Error(`A conversa na posição ${index} não está carregada no sidebar.`);
      return match;
    }

    const requestedChatId =
      stripGeminiConversationPrefix(args.chatId) ||
      extractChatIdFromMaybeUrl(args.url) ||
      stripGeminiConversationPrefix(item.chatId) ||
      extractChatIdFromMaybeUrl(item.url) ||
      stripGeminiConversationPrefix(item.id);

    if (requestedChatId) {
      const match = conversations.find((conversation) => {
        const chatId = stripGeminiConversationPrefix(conversation.chatId);
        const id = stripGeminiConversationPrefix(conversation.id);
        return chatId === requestedChatId || id === requestedChatId;
      });
      if (match) return match;
    }

    if (args.title) {
      const query = String(args.title).toLowerCase();
      const exact = conversations.find(
        (conversation) => String(conversation.title || '').toLowerCase() === query,
      );
      if (exact) return exact;
      const partial = conversations.find((conversation) =>
        String(conversation.title || '').toLowerCase().includes(query),
      );
      if (partial) return partial;
    }

    if (requestedChatId) {
      return {
        id: requestedChatId,
        chatId: requestedChatId,
        title: requestedChatId,
        url: `https://gemini.google.com/app/${requestedChatId}`,
        current: false,
      };
    }

    if (item.url || item.chatId || item.id) {
      return {
        id: item.id || item.chatId || requestedChatId,
        chatId: item.chatId || requestedChatId || item.id,
        title: item.title || item.chatId || requestedChatId || item.id,
        url:
          item.url ||
          (requestedChatId ? `https://gemini.google.com/app/${requestedChatId}` : null),
        current: item.current || false,
      };
    }

    const current = conversations.find((conversation) => conversation.current);
    if (current) return current;

    throw new Error('Informe index ou chatId para escolher a conversa.');
  };

  const executeBridgeCommand = async (command) => {
    if (!command?.type) {
      return {
        ok: false,
        error: 'Comando inválido.',
      };
    }

    if (command.type === 'ping' || command.type === 'snapshot') {
      return {
        ok: true,
        snapshot: debugSnapshot(),
      };
    }

    if (command.type === 'inspect-media') {
      return {
        ok: true,
        media: inspectMediaDom(),
        snapshot: debugSnapshot(),
      };
    }

    if (command.type === 'reload-page') {
      const delayMs = Math.max(0, Math.min(10_000, Number(command.args?.delayMs || 250)));
      setTimeout(() => {
        location.reload();
      }, delayMs);
      return {
        ok: true,
        reloading: true,
        delayMs,
        url: location.href,
      };
    }

    if (command.type === 'reload-gemini-tabs') {
      const response = await new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
          resolve({ ok: false, reason: 'runtime-message-unavailable', reloaded: 0 });
          return;
        }
        chrome.runtime.sendMessage(
          {
            type: 'gemini-md-export/reload-gemini-tabs',
            reason: command.args?.reason || 'bridge-command',
          },
          (result) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, reason: chrome.runtime.lastError.message, reloaded: 0 });
              return;
            }
            resolve(result || { ok: false, reason: 'empty-response', reloaded: 0 });
          },
        );
      });
      return response;
    }

    if (command.type === 'get-extension-info') {
      const response = await extensionSendMessage({ type: 'GET_EXTENSION_INFO' });
      if (response?.ok && response.protocolVersion !== undefined) {
        bridgeState.protocolVersion = response.protocolVersion;
      }
      if (response?.version || response?.extensionVersion) {
        bridgeState.extensionVersion = response.extensionVersion || response.version;
      }
      if (response?.buildStamp) bridgeState.buildStamp = response.buildStamp;
      return response || { ok: false, reason: 'empty-extension-info-response' };
    }

    if (command.type === 'reload-extension-self') {
      const response = await extensionSendMessage({
        type: 'RELOAD_SELF',
        reason: command.args?.reason || 'bridge-command',
        expectedExtensionVersion: command.args?.expectedExtensionVersion || null,
        expectedProtocolVersion: command.args?.expectedProtocolVersion || null,
        expectedBuildStamp: command.args?.expectedBuildStamp || null,
      });
      return response || { ok: false, reason: 'empty-reload-response' };
    }

    if (command.type === 'list-conversations') {
      if (command.args?.ensureSidebar !== false) {
        await ensureSidebarOpen();
        await sleep(DEFAULT_LOAD_MORE_OPTIONS.ensureSidebarDelayMs);
      }
      return {
        ok: true,
        conversations: collectBridgeConversationLinks(),
        modalConversations: collectConversationLinks(),
        snapshot: debugSnapshot(),
      };
    }

    if (command.type === 'load-more-conversations') {
      const loadOptions = resolveLoadMoreOptions({
        fastMode: command.args?.fastMode === true,
      });
      if (command.args?.ensureSidebar !== false) {
        await ensureSidebarOpen();
        await sleep(loadOptions.ensureSidebarDelayMs);
      }

      const untilEnd = command.args?.untilEnd === true;
      const targetCount = untilEnd
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.min(20000, Number(command.args?.targetCount || 10)));
      const attempts = Math.max(1, Math.min(5, Number(command.args?.attempts || 2)));
      const before = collectBridgeConversationLinks().length;
      let loadedAny = false;

      while (
        collectBridgeConversationLinks().length < targetCount &&
        !state.reachedSidebarEnd
      ) {
        const loaded = await loadMoreConversations(attempts, loadOptions);
        loadedAny = loadedAny || loaded;
        if (!loaded) break;
        await sleep(loadOptions.retryPauseMs);
      }

      return {
        ok: true,
        loadedAny,
        beforeCount: before,
        afterCount: collectBridgeConversationLinks().length,
        reachedEnd: state.reachedSidebarEnd,
        conversations:
          command.args?.includeConversations === false ? undefined : collectBridgeConversationLinks(),
        modalConversations:
          command.args?.includeConversations === false ? undefined : collectConversationLinks(),
        snapshot: command.args?.includeSnapshot === false ? undefined : debugSnapshot(),
      };
    }

    if (command.type === 'cache-status') {
      return {
        ok: true,
        cache: notebookChatUrlCacheSummary(),
      };
    }

    if (command.type === 'clear-cache') {
      const notebookId = command.args?.notebookId || null;
      clearNotebookChatUrlCache(notebookId);
      return {
        ok: true,
        clearedNotebookId: notebookId,
        cache: notebookChatUrlCacheSummary(),
      };
    }

    if (command.type === 'get-current-chat') {
      return {
        ok: true,
        payload: await collectExportForCurrentConversation(),
      };
    }

    if (command.type === 'open-chat') {
      try {
        const targetItem = findConversationForBridgeCommand(command.args || {});
        await navigateToConversation(targetItem);
        return {
          ok: true,
          conversation: targetItem,
          snapshot: debugSnapshot(),
        };
      } catch (err) {
        return {
          ok: false,
          error: err?.message || String(err),
        };
      }
    }

    if (command.type === 'get-chat-by-id') {
      const originalUrl = location.href;
      const originalWasNotebook = isNotebookPage();
      const originalNotebookId = currentNotebookId();
      const originalItem = collectBridgeConversationLinks().find((item) => item.current);
      const targetItem = findConversationForBridgeCommand(command.args || {});
      const originalNotebookReturnItem = originalWasNotebook
        ? {
            ...targetItem,
            source: 'notebook',
            title: targetItem.title || 'caderno',
            notebookUrl: targetItem.notebookUrl || originalUrl,
            url: targetItem.url || originalUrl,
            notebookId: targetItem.notebookId || originalNotebookId,
            rowIndex: Number.isInteger(targetItem.rowIndex) ? targetItem.rowIndex : 0,
          }
        : null;
      let payload;
      let returnedToOriginal = false;
      let returnError = null;

      try {
        payload = await collectExportForConversation(targetItem, {
          preferDirectNotebookReturn: command.args?.notebookReturnMode === 'direct',
          preserveNotebookContext: true,
        });
      } catch (err) {
        return {
          ok: false,
          conversation: targetItem,
          error: err?.message || String(err),
        };
      }

      if (
        command.args?.returnToOriginal !== false &&
        originalItem &&
        originalItem.chatId !== targetItem.chatId
      ) {
        try {
          await navigateToConversation(originalItem);
          returnedToOriginal = true;
        } catch (err) {
          returnError = err?.message || String(err);
        }
      } else if (
        command.args?.returnToOriginal !== false &&
        originalNotebookReturnItem &&
        !isNotebookPage()
      ) {
        try {
          await returnToNotebookPage(originalNotebookReturnItem, {
            preferDirect: command.args?.notebookReturnMode === 'direct',
            preserveContext: true,
          });
          returnedToOriginal = true;
        } catch (err) {
          returnError = err?.message || String(err);
        }
      }

      return {
        ok: true,
        conversation: targetItem,
        payload,
        returnedToOriginal,
        returnError,
      };
    }

    return {
      ok: false,
      error: `Comando desconhecido: ${command.type}`,
    };
  };

  const waitFor = async (check, { timeoutMs = 15000, intervalMs = 250, label = 'condição' } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await check()) return;
      } catch {
        // retry until timeout
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timeout aguardando ${label}.`);
  };

  const getGeminiScrollHost = (doc, win) => {
    const scrollableEnough = (el) => {
      if (!el) return false;
      if (el === doc.documentElement || el === doc.scrollingElement) {
        const viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
        return (doc.scrollingElement?.scrollHeight || doc.documentElement.scrollHeight || 0) > viewportHeight + 8;
      }
      return (el.scrollHeight || 0) > (el.clientHeight || 0) + 8;
    };

    const directMatches = [
      ['#chat-history[data-test-id="chat-history-container"]', 'chat-history data-test-id'],
      ['infinite-scroller.chat-history', 'infinite-scroller.chat-history'],
      ['.chat-history-scroll-container', 'chat-history-scroll-container'],
    ];

    const fallbackMatches = [];
    for (const [selector, matchedBy] of directMatches) {
      const el = doc.querySelector(selector);
      if (!el) continue;
      if (scrollableEnough(el)) return { el, matchedBy };
      fallbackMatches.push({ el, matchedBy: `${matchedBy} (non-scrollable)` });
    }

    const mainArea = doc.querySelector('main .conversation-area');
    if (mainArea) {
      const candidates = Array.from(mainArea.querySelectorAll('div'));
      for (const el of candidates) {
        const style = win.getComputedStyle(el);
        const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (scrollable && el.clientHeight > 300 && scrollableEnough(el)) {
          return { el, matchedBy: 'scrollable div inside main .conversation-area' };
        }
      }
    }

    const fallbackScroller = doc.querySelector('infinite-scroller');
    if (fallbackScroller && scrollableEnough(fallbackScroller)) {
      return { el: fallbackScroller, matchedBy: 'infinite-scroller fallback' };
    }

    const documentScroller = doc.scrollingElement || doc.documentElement;
    if (scrollableEnough(documentScroller)) {
      return {
        el: documentScroller,
        matchedBy: 'document scrollingElement fallback',
      };
    }

    if (fallbackMatches.length > 0) {
      return fallbackMatches[0];
    }

    return {
      el: documentScroller,
      matchedBy: 'document scrollingElement fallback (non-scrollable)',
    };
  };

  const getScrollTarget = (scroller, doc, win) =>
    scroller === doc.documentElement || scroller === doc.scrollingElement ? win : scroller;

  const getScrollTop = (target, win) =>
    target === win ? win.scrollY || win.pageYOffset || 0 : target.scrollTop || 0;

  const setScrollTop = (target, win, top) => {
    if (target === win) {
      win.scrollTo(0, top);
      return;
    }
    target.scrollTop = top;
    target.dispatchEvent(new win.Event('scroll', { bubbles: true }));
  };

  const countConversationContainers = (scroller, doc) => {
    const inScroller = scroller?.querySelectorAll?.(CONVERSATION_CONTAINER_SELECTOR).length || 0;
    if (inScroller > 0) return inScroller;
    const inDocument = doc.querySelectorAll(CONVERSATION_CONTAINER_SELECTOR).length;
    return inDocument || scrapeTurns(doc).length;
  };

  const firstConversationSignature = (scroller, doc) => {
    const first =
      scroller?.querySelector?.(CONVERSATION_CONTAINER_SELECTOR) ||
      doc.querySelector(CONVERSATION_CONTAINER_SELECTOR) ||
      doc.querySelector('user-query, model-response');
    return String(first?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  };

  const hydrateConversationToTop = async (
    doc,
    win,
    {
      loadWaitMs = HYDRATION_LOAD_WAIT_MS,
      maxTotalMs = HYDRATION_MAX_TOTAL_MS,
      maxAttempts = HYDRATION_MAX_ATTEMPTS,
    } = {},
  ) => {
    const { el: scroller, matchedBy } = getGeminiScrollHost(doc, win);
    const scrollTarget = getScrollTarget(scroller, doc, win);
    const scrollElement = scrollTarget === win ? doc.body || doc.documentElement : scroller;
    const startedAt = Date.now();
    let attempts = 0;
    let reachedTop = false;
    let timedOut = false;
    let lastContainerCount = countConversationContainers(scroller, doc);

    if (!scrollElement || scrollElement.scrollHeight <= scrollElement.clientHeight + 4) {
      const turns = scrapeTurns(doc);
      return {
        turns,
        stats: {
          strategy: 'scroll-top-stabilize',
          matchedBy,
          attempts,
          reachedTop: true,
          timedOut: false,
          conversationContainers: lastContainerCount,
          turnsAfterHydration: turns.length,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const waitForHydrationChange = async (beforeCount, beforeSignature) => {
      const waitStartedAt = Date.now();
      let count = beforeCount;
      let signature = beforeSignature;
      while (Date.now() - waitStartedAt < loadWaitMs) {
        await sleep(100);
        count = countConversationContainers(scroller, doc);
        signature = firstConversationSignature(scroller, doc);
        if (count > beforeCount || signature !== beforeSignature) {
          return { count, signature, changed: true };
        }
      }
      return { count, signature, changed: false };
    };

    while (attempts < maxAttempts) {
      if (Date.now() - startedAt > maxTotalMs) {
        timedOut = true;
        break;
      }

      attempts += 1;
      const beforeCount = countConversationContainers(scroller, doc);
      const beforeSignature = firstConversationSignature(scroller, doc);
      const beforeTop = getScrollTop(scrollTarget, win);

      if (beforeTop <= 2 && attempts > 1) {
        const finalCheck = await waitForHydrationChange(beforeCount, beforeSignature);
        lastContainerCount = finalCheck.count;
        if (!finalCheck.changed) {
          reachedTop = true;
          break;
        }
      }

      setScrollTop(scrollTarget, win, 0);
      const growth = await waitForHydrationChange(beforeCount, beforeSignature);
      lastContainerCount = growth.count;

      const afterTop = getScrollTop(scrollTarget, win);
      if (!growth.changed && afterTop <= 2) {
        reachedTop = true;
        break;
      }

      await sleep(50);
    }

    const turns = scrapeTurns(doc);
    return {
      turns,
      stats: {
        strategy: 'scroll-top-stabilize',
        matchedBy,
        attempts,
        reachedTop,
        timedOut,
        conversationContainers: lastContainerCount,
        turnsAfterHydration: turns.length,
        scrollTop: getScrollTop(scrollTarget, win),
        scrollHeight: scrollElement?.scrollHeight || null,
        clientHeight: scrollElement?.clientHeight || null,
        elapsedMs: Date.now() - startedAt,
      },
    };
  };

  const waitForChatToLoad = async (targetChatId) => {
    await waitFor(
      () => currentChatId() === targetChatId && scrapeTurns(document).length > 0,
      { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 400, label: `chat ${targetChatId}` },
    );
  };

  const getSidebarConversationById = (itemId) =>
    getSidebarConversationElements().find((element) => getChatIdFromSidebarElement(element) === itemId);

  const getNotebookConversationById = (itemId) =>
    getNotebookConversationElements().find(
      (element, index) => buildNotebookConversationId(element, index) === itemId,
    );

  const waitForNotebookToLoad = async (item) => {
    await waitFor(
      () => {
        if (!isNotebookPage()) return false;
        if (item.notebookId && currentNotebookId() !== item.notebookId) return false;
        const rows = getNotebookConversationElements();
        if (Number.isInteger(item.rowIndex)) return rows.length > item.rowIndex;
        return rows.length > 0;
      },
      {
        timeoutMs: item.timeoutMs || FRAME_TIMEOUT_MS,
        intervalMs: 400,
        label: `caderno ${item.notebookId || ''}`,
      },
    );
  };

  const findNotebookConversationElement = (item) => {
    const byId = getNotebookConversationById(item.id);
    if (byId) return byId;

    const rows = getNotebookConversationElements();
    if (Number.isInteger(item.rowIndex) && rows[item.rowIndex]) {
      const candidate = rows[item.rowIndex];
      const title = getNotebookConversationTitleFromElement(candidate, '');
      if (!item.title || title === item.title) return candidate;
    }

    return rows.find((element) => {
      const title = getNotebookConversationTitleFromElement(element, '');
      const timestamp = getNotebookConversationTimestampFromElement(element);
      return title === item.title && (!item.timestamp || timestamp === item.timestamp);
    });
  };

  const sameNotebookConversation = (candidate, item) => {
    if (!candidate || !item) return false;
    if (item.cacheKey && candidate.cacheKey === item.cacheKey) return true;

    const itemChatId = stripGeminiConversationPrefix(item.chatId || item.id);
    const candidateChatId = stripGeminiConversationPrefix(candidate.chatId || candidate.id);
    if (itemChatId && candidateChatId && itemChatId === candidateChatId) return true;

    if (item.id && candidate.id === item.id) return true;

    return (
      candidate.title === item.title &&
      (!item.timestamp || candidate.timestamp === item.timestamp) &&
      (!item.subtitle || candidate.subtitle === item.subtitle)
    );
  };

  const refreshNotebookConversationItem = (item) => {
    if (!isNotebookPage()) return item;
    const fresh = collectNotebookConversationLinks().find((candidate) =>
      sameNotebookConversation(candidate, item),
    );
    if (!fresh) return item;

    const knownChatId = item.chatId || fresh.chatId || '';
    const knownAppUrl =
      (item.url && String(item.url).includes('/app/') ? item.url : '') ||
      (fresh.url && String(fresh.url).includes('/app/') ? fresh.url : '');

    return {
      ...item,
      ...fresh,
      id: knownChatId ? `c_${knownChatId}` : fresh.id || item.id,
      chatId: knownChatId,
      url: knownAppUrl || fresh.url || item.url,
      notebookUrl: fresh.notebookUrl || item.notebookUrl || location.href,
      cacheKey: item.cacheKey || fresh.cacheKey,
    };
  };

  const waitForNotebookReturn = async (item, timeoutMs = 7000) => {
    try {
      await waitForNotebookToLoad({ ...item, timeoutMs });
      return true;
    } catch {
      return false;
    }
  };

  const clickNotebookUrl = async (notebookUrl) => {
    const link = document.createElement('a');
    link.href = notebookUrl;
    link.target = '_self';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const navigateDirectlyToNotebookPage = async (item, notebookUrl, options = {}) => {
    if (!notebookUrl) return false;

    await clickNotebookUrl(notebookUrl);
    if (await waitForNotebookReturn(item, 12000)) return true;

    if (options.allowHardReload === false) {
      return false;
    }

    // Último recurso: se o router SPA não aceitou o clique sintético,
    // navegar direto evita deixar o batch preso numa conversa.
    pageWindow.location.href = notebookUrl;
    return waitForNotebookReturn(item, FRAME_TIMEOUT_MS);
  };

  const returnToNotebookPage = async (item, options = {}) => {
    if (isNotebookPage()) {
      await waitForNotebookToLoad(item);
      return;
    }

    const notebookUrl =
      item.notebookUrl ||
      (String(item.url || '').includes('/notebook/') ? item.url : null);

    const returnPlan = buildNotebookReturnPlan(options);

    if (returnPlan.tryDirectFirst && notebookUrl) {
      try {
        if (
          await navigateDirectlyToNotebookPage(item, notebookUrl, {
            allowHardReload: returnPlan.allowHardDirectFallback,
          })
        ) {
          return;
        }
      } catch (err) {
        warn('Retorno direto para o caderno falhou; tentando histórico.', err);
      }
    }

    pageWindow.history.back();
    if (await waitForNotebookReturn(item)) return;

    if (returnPlan.allowSoftDirectFallback && notebookUrl) {
      if (
        await navigateDirectlyToNotebookPage(item, notebookUrl, {
          allowHardReload: returnPlan.allowHardDirectFallback,
        })
      ) {
        return;
      }
    }

    throw new Error('O histórico do browser não voltou para o caderno.');
  };

  const waitForAnyChatToLoad = async (previousChatId, label = 'chat do caderno') => {
    await waitFor(
      () => {
        const chatId = currentChatId();
        return (
          !!chatId &&
          chatId !== previousChatId &&
          location.pathname.startsWith('/app/') &&
          scrapeTurns(document).length > 0
        );
      },
      { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 400, label },
    );
  };

  const navigateToKnownChatUrl = async (item) => {
    if (item.chatId === currentChatId() && scrapeTurns(document).length > 0) {
      return;
    }

    if (item.chatId) {
      rememberNotebookConversationUrl(
        item,
        item.chatId,
        item.url || `https://gemini.google.com/app/${item.chatId}`,
      );
    }

    const link = document.createElement('a');
    link.href = item.url || `https://gemini.google.com/app/${item.chatId}`;
    link.target = '_self';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();

    await sleep(1200);
    await waitForChatToLoad(item.chatId);
  };

  const navigateToNotebookConversation = async (item, options = {}) => {
    await returnToNotebookPage(item, {
      preferDirect: options.preferDirectNotebookReturn,
      preserveContext: options.preserveNotebookContext !== false,
    });

    const targetItem = refreshNotebookConversationItem(item);
    if (targetItem !== item) {
      Object.assign(item, targetItem);
    }

    const element = findNotebookConversationElement(item);
    const conversationPlan = buildNotebookConversationPlan({
      preserveContext: options.preserveNotebookContext !== false,
      hasVisibleRow: !!element,
      hasKnownChatUrl: !!(item.chatId && item.url?.includes('/app/')),
    });

    if (!element && conversationPlan.allowDirectUrlFallback) {
      await navigateToKnownChatUrl(item);
      return;
    }

    if (!element) {
      throw new Error(`A conversa "${item.title}" não está mais visível no caderno.`);
    }

    const previousChatId = currentChatId();
    const clickable =
      element.querySelector('[data-test-id="navigate-to-recent-chat"]') ||
      element.querySelector('[role="button"]') ||
      element;

    clickable.click();
    await sleep(1200);
    await waitForAnyChatToLoad(previousChatId, item.title);
    const chatId = currentChatId();
    if (chatId) {
      item.chatId = chatId;
      item.url = location.href;
      item.id = `c_${chatId}`;
      rememberNotebookConversationUrl(item, chatId, location.href);
    }
  };

  const navigateToConversation = async (item, options = {}) => {
    if (item.source === 'notebook') {
      await navigateToNotebookConversation(item, options);
      return;
    }

    if (item.chatId === currentChatId() && scrapeTurns(document).length > 0) {
      return;
    }

    const element = getSidebarConversationById(item.id);
    if (!element) {
      if ((item.chatId || item.url) && String(item.url || '').includes('/app/')) {
        await navigateToKnownChatUrl(item);
        return;
      }
      throw new Error(`A conversa ${item.title} não está mais visível no sidebar.`);
    }

    const clickable = element.querySelector('a[href]') || element;
    clickable.click();
    await sleep(1200);
    await waitForChatToLoad(item.chatId);
  };

  const collectExportForCurrentConversation = async () => {
    const hydrated = await hydrateConversationToTop(document, window);
    if (!hydrated.stats.reachedTop || hydrated.stats.timedOut) {
      throw new Error(
        `Nao consegui carregar o inicio da conversa com seguranca antes de exportar (scroller: ${hydrated.stats.matchedBy}, tentativas: ${hydrated.stats.attempts}). Recarregue a aba e tente novamente.`,
      );
    }
    return await buildExportPayload(document, location.href, {
      turns: hydrated.turns,
      hydration: hydrated.stats,
    });
  };

  const collectExportForConversation = async (item, options = {}) => {
    await navigateToConversation(item, options);
    return collectExportForCurrentConversation();
  };

  const downloadBlob = (filename, content) =>
    new Promise((resolve) => {
      if (typeof GM_download === 'function') {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        GM_download({
          url,
          name: filename,
          saveAs: false,
          onload: () => {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            resolve();
          },
          onerror: (err) => {
            warn('GM_download falhou, tentando fallback com link <a>.', err);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            downloadViaAnchor(filename, content);
            resolve();
          },
        });
        return;
      }

      downloadViaAnchor(filename, content);
      resolve();
    });

  const downloadViaAnchor = (filename, content) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const markdownWithInlineMediaFallback = (payload) => {
    let content = payload?.content || payload?.fallbackContent || '';
    const mediaFiles = Array.isArray(payload?.mediaFiles) ? payload.mediaFiles : [];
    for (const file of mediaFiles) {
      if (!file?.filename || !file?.contentBase64) continue;
      const dataUrl = `data:${file.mimeType || 'application/octet-stream'};base64,${
        file.contentBase64
      }`;
      content = content.split(`](${file.filename})`).join(`](${dataUrl})`);
    }
    return content || payload?.fallbackContent || '';
  };

  const saveExportPayload = async (payload) => {
    if (state.bridgeOutputDir) {
      try {
        await saveExportViaBridge(payload);
        return;
      } catch (err) {
        warn('Falha ao salvar via bridge MCP; usando fallback de downloads.', err);
        if (!state.bridgeSaveFallbackNotified) {
          state.bridgeSaveFallbackNotified = true;
          showToast(
            'Não consegui gravar na pasta que você escolheu. Caindo para a pasta Downloads do navegador até o MCP voltar.',
            'error',
          );
        }
      }
    }

    if (state.directoryHandle) {
      await saveExportViaDirectoryHandle(payload);
      return;
    }

    if (isExtensionContext) {
      try {
        await saveExportViaBridge(payload, { outputDir: '' });
        return;
      } catch (err) {
        warn('Falha ao salvar em Downloads via bridge MCP; usando download nativo do browser.', err);
        if (!state.browserDownloadFallbackNotified) {
          state.browserDownloadFallbackNotified = true;
          showToast(
            'MCP local fora do ar. Vou usar o download padrão do navegador — se já existir um arquivo com o mesmo nome, pode ficar a versão antiga.',
            'error',
          );
        }
      }
    }

    await downloadBlob(payload.filename, markdownWithInlineMediaFallback(payload));
  };

  const exportNow = async () => {
    if (state.isExporting) {
      updateProgressDock();
      showToast('Já tem uma exportação rodando. Acompanhe pela barra de progresso no canto.', 'info');
      return;
    }

    const chatId = extractChatId(location.pathname);
    if (!chatId) {
      const message =
        'Abra uma conversa específica antes de exportar (URL precisa conter /app/<id>).';
      reportFailure(message);
      alert(message);
      return;
    }

    if (scrapeTurns(document).length === 0) {
      const message =
        'Nenhum turno detectado. Veja o console e use window.__geminiMdExportDebug.snapshot() para inspecionar o DOM.';
      reportFailure(message);
      alert(message);
      return;
    }

    try {
      await beginExportProgress({
        total: 1,
        label: 'Hidratando conversa atual...',
      });
      const payload = await collectExportForCurrentConversation();
      updateExportProgress({
        current: 0,
        label: `Salvando ${payload.filename}...`,
      });
      await saveExportPayload(payload);
      updateExportProgress({
        current: 1,
        label: payload.title || payload.filename,
      });
      log(`exported ${payload.turns.length} turns`, {
        chatId: payload.chatId,
        model: scrapeModel(),
        title: payload.title,
      });
      await finishExportProgress();
      showToast(
        `Pronto! ${payload.turns.length} turnos salvos em ${payload.filename}.`,
        'success',
      );
    } catch (err) {
      warn('Falha ao exportar conversa atual.', err);
      await finishExportProgress();
      showToast(
        'Não consegui exportar essa conversa. Abra o console (F12) para ver o motivo.',
        'error',
      );
    }
  };

  const renderListEndState = () => {
    const endEl = document.getElementById(MODAL_LIST_END_ID);
    if (!endEl) return;

    endEl.className = `gm-list-end ${
      state.isLoadingMore
        ? 'is-loading'
        : state.reachedSidebarEnd
          ? 'is-end'
          : 'is-idle'
    }`;
    setHtml(endEl, `
      <span class="gm-list-end-dot" aria-hidden="true"></span>
      <span>${escapeHtml(listEndText())}</span>
    `);
  };

  const renderConversationList = () => {
    const container = document.getElementById(MODAL_LIST_ID);
    const countEl = document.getElementById(MODAL_COUNT_ID);
    if (!container || !countEl) return;
    // Snapshot antes de reescrever innerHTML. Sem isso, toda re-render
    // (heartbeat, observer, mutacao do sidebar) mandava o usuario de volta
    // pro topo — UX terrivel em listas longas. Restauramos scrollTop depois
    // do reflow, a menos que usuario estivesse colado no fim (auto-scroll
    // de continuacao) ou tenhamos acabado de bater no fim da lista.
    const prevScrollTop = container.scrollTop;
    const wasNearBottom =
      container.scrollHeight > container.clientHeight &&
      container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    const finishRender = () => {
      renderListEndState();
      requestAnimationFrame(() => {
        if (state.reachedSidebarEnd || wasNearBottom) {
          container.scrollTop = container.scrollHeight;
        } else if (prevScrollTop > 0) {
          // Clamp contra encolhimento (filtro reduziu lista).
          const maxTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          container.scrollTop = Math.min(prevScrollTop, maxTop);
        }
      });
    };

    const filtered = state.conversations.filter((item) =>
      !state.filterQuery ||
      conversationSearchText(item).includes(state.filterQuery.toLowerCase()),
    );

    const selCount = state.selectedChatIds.size;
    const visCount = filtered.length;
    const selLabel = selCount === 1 ? '1 selecionada' : `${selCount} selecionadas`;
    const visLabel = visCount === 1 ? '1 visível' : `${visCount} visíveis`;
    countEl.textContent = `${selLabel} · ${visLabel}`;

    if (state.conversations.length === 0) {
      setHtml(container, `
        <div style="padding:20px;border:1px dashed var(--gm-border);border-radius:16px;background:var(--gm-surface-muted);color:var(--gm-text-muted);">
          Nenhuma conversa encontrada. Abra a barra lateral do Gemini e clique em atualizar.
        </div>
      `);
      finishRender();
      return;
    }

    if (filtered.length === 0) {
      setHtml(container, `
        <div style="padding:28px 20px;text-align:center;border:1px dashed var(--gm-border);border-radius:16px;background:var(--gm-surface-muted);color:var(--gm-text-muted);">
          Nenhuma conversa encontrada para "${escapeHtml(state.filterQuery)}".
        </div>
      `);
      finishRender();
      return;
    }

    setHtml(
      container,
      filtered
        .map((item) => {
        const checked = state.selectedChatIds.has(item.id) ? 'checked' : '';
        const currentBadge = item.current
          ? '<span class="gm-badge">Atual</span>'
          : '';
        const notebookBadge =
          item.source === 'notebook'
            ? '<span class="gm-badge">Caderno</span>'
            : '';
        const subtitle =
          item.subtitle && item.subtitle !== item.title
            ? `<span class="gm-conversation-id">${escapeHtml(item.subtitle)}</span>`
            : '';
        return `
          <label class="gm-conversation-item">
            <input class="gm-checkbox" type="checkbox" data-chat-id="${item.id}" ${checked}>
            <span class="gm-conversation-copy">
              <span class="gm-conversation-title-row">
                <strong class="gm-conversation-title">${escapeHtml(item.title)}</strong>
                ${currentBadge}
                ${notebookBadge}
              </span>
              <span class="gm-conversation-id">${escapeHtml(conversationDisplayId(item))}</span>
              ${subtitle}
            </span>
          </label>
        `;
        })
        .join(''),
    );
    finishRender();
  };

  const ensureProgressDock = () => {
    let dock = document.getElementById(PROGRESS_DOCK_ID);
    if (dock) return dock;

    dock = document.createElement('div');
    dock.id = PROGRESS_DOCK_ID;
    dock.hidden = true;
    Object.assign(dock.style, {
      position: 'fixed',
      left: '50%',
      bottom: '18px',
      transform: 'translateX(-50%)',
      zIndex: '10002',
      display: 'none',
      pointerEvents: 'none',
      width: 'min(360px, calc(100vw - 24px))',
    });

    // Estilos do dock injetados como <style> próprio do nó porque keyframes
    // não funcionam via style inline. O shimmer é o que dá a sensação de
    // fluidez quando o `current` ainda não mudou (ex.: hidratação longa de
    // uma única conversa) — uma faixa diagonal varre a parte preenchida e
    // mantém o feedback vivo.
    setHtml(
      dock,
      `
        <style>
          #${PROGRESS_DOCK_ID} .gm-dock-card {
            font-family: var(--gm-font);
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px 14px;
            border-radius: 18px;
            background: var(--gm-dock-bg);
            color: var(--gm-dock-text);
            border: 1px solid var(--gm-dock-border);
            box-shadow: 0 10px 30px rgba(0,0,0,0.16);
            backdrop-filter: blur(10px);
          }
          #${PROGRESS_DOCK_ID} .gm-dock-track {
            height: 6px;
            background: var(--gm-dock-track);
            border-radius: 999px;
            overflow: hidden;
            position: relative;
          }
          #${PROGRESS_DOCK_ID} .gm-dock-bar {
            height: 100%;
            width: 0%;
            background: var(--gm-accent);
            border-radius: 999px;
            position: relative;
            overflow: hidden;
            /* Easing Material para movimento natural de avanço; mais longo
               que .18s pra conseguir ler o crescimento mesmo em incrementos
               pequenos vindos do "creep" assintótico. */
            transition: width 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
            will-change: width;
          }
          #${PROGRESS_DOCK_ID} .gm-dock-bar::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(
              90deg,
              rgba(255,255,255,0) 0%,
              rgba(255,255,255,0.55) 50%,
              rgba(255,255,255,0) 100%
            );
            transform: translateX(-100%);
            animation: gm-dock-shimmer 1500ms linear infinite;
          }
          #${PROGRESS_DOCK_ID}.gm-dock-done .gm-dock-bar::after {
            animation: none;
            opacity: 0;
          }
          @keyframes gm-dock-shimmer {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
          }
        </style>
        <div class="gm-dock-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <strong style="font-size:12px;font-weight:600;letter-spacing:0.01em;">Exportando conversas</strong>
            <span id="${PROGRESS_DOCK_ID}-count" style="font-size:11px;color:var(--gm-dock-muted);white-space:nowrap;"></span>
          </div>
          <div id="${PROGRESS_DOCK_ID}-label" style="font-size:12px;color:var(--gm-dock-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          <div class="gm-dock-track">
            <div id="${PROGRESS_DOCK_ID}-bar" class="gm-dock-bar"></div>
          </div>
        </div>
      `,
    );

    document.body.appendChild(dock);
    return dock;
  };

  // "Creep" assintótico: entre uma chamada de updateExportProgress e a
  // próxima, deslocamos a porcentagem visual em direção ao próximo
  // milestone (sem ultrapassá-lo). Isso evita a sensação de barra
  // travada durante etapas lentas dentro de uma única conversa
  // (hidratação, scroll, salvar). Quando o current de fato avança,
  // pulamos pra esse alvo (animação CSS suaviza). Mecânica clássica
  // de YouTube/GitHub progress bar.
  const PROGRESS_CREEP_INTERVAL_MS = 240;
  const PROGRESS_CREEP_MAX_FRACTION = 0.85; // não passa de 85% até o próximo milestone

  const computeProgressMilestone = (progress) => {
    const total = Math.max(progress?.total || 1, 1);
    const current = Math.max(0, Math.min(progress?.current || 0, total));
    const base = (current / total) * 100;
    const next = (Math.min(current + 1, total) / total) * 100;
    return { base, next };
  };

  const stopProgressCreep = () => {
    if (state.progressCreepTimer) {
      clearInterval(state.progressCreepTimer);
      state.progressCreepTimer = null;
    }
  };

  const startProgressCreep = () => {
    stopProgressCreep();
    state.progressCreepTimer = setInterval(() => {
      if (!state.isExporting || !state.progress) {
        stopProgressCreep();
        return;
      }
      const { base, next } = computeProgressMilestone(state.progress);
      const ceiling = base + (next - base) * PROGRESS_CREEP_MAX_FRACTION;
      const display = state.progress.displayPercent ?? base;
      if (display >= ceiling - 0.05) return;
      // Fração aproxima exponencialmente: andamos 18% do caminho restante
      // por tick. Bem rápido no começo, vai diminuindo.
      const next_display = display + (ceiling - display) * 0.18;
      state.progress.displayPercent = next_display;
      const barEl = document.getElementById(`${PROGRESS_DOCK_ID}-bar`);
      if (barEl) barEl.style.width = `${next_display}%`;
    }, PROGRESS_CREEP_INTERVAL_MS);
  };

  const updateProgressDock = () => {
    const dock = ensureProgressDock();
    if (!state.isExporting || !state.progress) {
      stopProgressCreep();
      dock.hidden = true;
      dock.style.display = 'none';
      dock.classList.remove('gm-dock-done');
      return;
    }

    const dark = isDarkTheme();
    const vars = dark
      ? {
          '--gm-dock-bg': 'rgba(31,35,41,0.94)',
          '--gm-dock-text': '#e8eaed',
          '--gm-dock-muted': '#aab4be',
          '--gm-dock-border': 'rgba(255,255,255,0.08)',
          '--gm-dock-track': 'rgba(255,255,255,0.08)',
          '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
          '--gm-accent': '#8ab4f8',
        }
      : {
          '--gm-dock-bg': 'rgba(255,255,255,0.94)',
          '--gm-dock-text': '#202124',
          '--gm-dock-muted': '#5f6368',
          '--gm-dock-border': 'rgba(60,64,67,0.12)',
          '--gm-dock-track': 'rgba(60,64,67,0.12)',
          '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
          '--gm-accent': '#1a73e8',
        };

    Object.entries(vars).forEach(([key, value]) => dock.style.setProperty(key, value));

    const countEl = document.getElementById(`${PROGRESS_DOCK_ID}-count`);
    const labelEl = document.getElementById(`${PROGRESS_DOCK_ID}-label`);
    const barEl = document.getElementById(`${PROGRESS_DOCK_ID}-bar`);
    const errorSuffix =
      state.progress.errorCount > 0
        ? ` · ${state.progress.errorCount} erro${state.progress.errorCount > 1 ? 's' : ''}`
        : '';

    if (countEl) {
      countEl.textContent = `${state.progress.current}/${state.progress.total}${errorSuffix}`;
    }
    if (labelEl) {
      labelEl.textContent = state.progress.label || 'Preparando exportação...';
    }
    if (barEl) {
      const { base, next } = computeProgressMilestone(state.progress);
      // Se o `current` real avançou, pulamos a barra pra base nova; caso
      // contrário, mantemos o valor que o creep está alimentando (sem
      // regredir nem ultrapassar a base nova).
      const prevDisplay = state.progress.displayPercent ?? 0;
      const display = Math.max(prevDisplay, base);
      state.progress.displayPercent = display;
      barEl.style.width = `${display}%`;
      // Quando bate o total, marca como pronto pra parar o shimmer.
      if (state.progress.current >= state.progress.total) {
        dock.classList.add('gm-dock-done');
      } else {
        dock.classList.remove('gm-dock-done');
      }
      // Garante que o creep está rodando (idempotente).
      if (!state.progressCreepTimer && next > base + 0.5) {
        startProgressCreep();
      }
    }

    dock.hidden = false;
    dock.style.display = 'block';
  };

  const beginExportProgress = async ({ total, label }) => {
    state.isExporting = true;
    state.browserDownloadFallbackNotified = false;
    state.progress = {
      total,
      current: 0,
      label,
      errorCount: 0,
      startedAt: Date.now(),
      displayPercent: 0,
    };
    hideExportModal();
    updateProgressDock();
    startProgressCreep();
    await nextPaint();
  };

  const updateExportProgress = (patch = {}) => {
    if (!state.progress) return;
    Object.assign(state.progress, patch);
    updateProgressDock();
  };

  const finishExportProgress = async () => {
    const startedAt = state.progress?.startedAt || Date.now();
    const remaining = PROGRESS_MIN_VISIBLE_MS - (Date.now() - startedAt);
    // Antes de sumir, pula a barra para 100% e desliga o shimmer pra dar
    // a sensação de "concluído" — caso contrário ela some de 60% direto
    // pra invisível, o que parecia um fade abrupto.
    if (state.progress) {
      state.progress.current = state.progress.total || 0;
      state.progress.displayPercent = 100;
    }
    stopProgressCreep();
    const dock = document.getElementById(PROGRESS_DOCK_ID);
    const barEl = document.getElementById(`${PROGRESS_DOCK_ID}-bar`);
    if (dock) dock.classList.add('gm-dock-done');
    if (barEl) barEl.style.width = '100%';
    if (remaining > 0) await sleep(remaining);
    state.isExporting = false;
    state.progress = null;
    updateProgressDock();
  };

  const runBatchExport = async (
    items,
    {
      session = null,
      originalItem = null,
      originalWasNotebook = false,
      originalNotebookReturnItem = null,
      resume = false,
    } = {},
  ) => {
    const normalizedItems = Array.isArray(items)
      ? items.map(serializeConversationItem).filter(Boolean)
      : [];
    if (normalizedItems.length === 0) {
      showToast('Nenhuma conversa selecionada pôde ser exportada.', 'error');
      return;
    }

    let activeSession =
      normalizeBatchExportSession(session) ||
      createBatchExportSession({
        items: normalizedItems,
        originalItem,
        originalWasNotebook,
        originalNotebookReturnItem,
      });

    activeSession = saveBatchExportSession(activeSession) || activeSession;

    await beginExportProgress({
      total: activeSession.items.length,
      label: resume ? 'Retomando exportação...' : 'Preparando exportação...',
    });

    const failures = new Set(activeSession.failureIds || []);
    for (let i = activeSession.nextIndex; i < activeSession.items.length; i += 1) {
      const item = activeSession.items[i];
      updateExportProgress({
        current: i,
        label: `Exportando ${item.title}...`,
        errorCount: failures.size,
      });

      try {
        const payload = await collectExportForConversation(item, {
          preferDirectNotebookReturn: false,
          preserveNotebookContext: true,
        });
        updateExportProgress({
          current: i,
          label: `Salvando ${payload.filename}...`,
          errorCount: failures.size,
        });
        await saveExportPayload(payload);
        activeSession.nextIndex = i + 1;
        activeSession.failureIds = [...failures];
        activeSession = saveBatchExportSession(activeSession) || activeSession;
        updateExportProgress({
          current: i + 1,
          label: item.title,
          errorCount: failures.size,
        });
      } catch (err) {
        const failureKey = String(item.id || item.chatId || `item-${i}`);
        failures.add(failureKey);
        activeSession.nextIndex = i + 1;
        activeSession.failureIds = [...failures];
        activeSession = saveBatchExportSession(activeSession) || activeSession;
        updateExportProgress({
          current: i + 1,
          label: `Falha em ${item.title}`,
          errorCount: failures.size,
        });
        warn(`Falha ao exportar ${item.chatId || item.id || i}.`, err);
      }
    }

    const resumeOriginalItem = activeSession.originalItem || null;
    const resumeOriginalNotebookReturnItem = activeSession.originalNotebookReturnItem || null;
    const resumeOriginalWasNotebook = !!activeSession.originalWasNotebook;
    clearBatchExportSession();

    if (resumeOriginalItem) {
      try {
        updateExportProgress({
          current: activeSession.items.length,
          label: `Voltando para ${resumeOriginalItem.title}...`,
          errorCount: failures.size,
        });
        await navigateToConversation(resumeOriginalItem);
      } catch (err) {
        warn('Falha ao voltar para a conversa original.', err);
      }
    } else if (resumeOriginalNotebookReturnItem && resumeOriginalWasNotebook && !isNotebookPage()) {
      try {
        updateExportProgress({
          current: activeSession.items.length,
          label: 'Voltando para o caderno...',
          errorCount: failures.size,
        });
        await returnToNotebookPage(resumeOriginalNotebookReturnItem, {
          preferDirect: false,
          preserveContext: true,
        });
      } catch (err) {
        warn('Falha ao voltar para o caderno original.', err);
      }
    }

    await finishExportProgress();

    if (failures.size === 0) {
      const n = activeSession.items.length;
      showToast(
        `Pronto! ${n} ${n === 1 ? 'conversa exportada' : 'conversas exportadas'} com sucesso.`,
        'success',
      );
    } else {
      const failed = failures.size;
      const total = activeSession.items.length;
      showToast(
        `Terminou com ${failed} de ${total} ${failed === 1 ? 'falha' : 'falhas'}. Abra o console (F12) para ver os detalhes.`,
        'error',
      );
    }
  };

  const updateModalState = () => {
    renderConversationList();

    const dirEl = document.getElementById(MODAL_DIR_ID);
    const statusEl = document.getElementById(MODAL_STATUS_ID);
    const progressEl = document.getElementById(MODAL_PROGRESS_ID);
    const exportBtn = document.getElementById(MODAL_EXPORT_ID);
    const folderBtn = document.querySelector(`[data-action="pick-dir"]`);
    const refreshBtn = document.querySelector(`[data-action="refresh-list"]`);
    const selectAllBtn = document.querySelector(`[data-action="select-all"]`);
    const clearBtn = document.querySelector(`[data-action="clear-selection"]`);
    const closeBtn = document.querySelector(`[data-action="close-modal"]`);
    const currentBtn = document.querySelector(`[data-action="export-current"]`);
    const searchEl = document.getElementById(MODAL_SEARCH_ID);
    const canExport =
      state.selectedChatIds.size > 0 &&
      !state.isExporting;

    updateProgressDock();

    if (searchEl && searchEl.value !== state.filterQuery) {
      searchEl.value = state.filterQuery;
    }

    if (dirEl) {
      if (state.bridgeOutputDir) {
        dirEl.textContent = state.bridgeOutputDir;
        dirEl.title = `Pasta escolhida via MCP: ${state.bridgeOutputDir}`;
      } else if (state.directoryHandle) {
        dirEl.textContent = state.directoryHandle.name;
        dirEl.title = `Pasta escolhida pelo browser: ${state.directoryHandle.name}`;
      } else if (isExtensionContext) {
        dirEl.textContent = 'Downloads (fallback padrão)';
        dirEl.title =
          'Clique em Alterar para escolher outra pasta via MCP local. Sem pasta escolhida, o fallback é a pasta padrão de downloads.';
      } else if (supportsDirectoryPicker()) {
        dirEl.textContent = state.directoryHandle
          ? state.directoryHandle.name
          : 'Downloads (pasta padrão do browser)';
        dirEl.title = state.directoryHandle
          ? `Pasta escolhida: ${state.directoryHandle.name}`
          : 'Clique em Alterar para escolher uma subpasta. Pastas raiz, Home e Library podem ser bloqueadas pelo browser.';
      } else {
        dirEl.textContent = 'Downloads (browser sem showDirectoryPicker)';
        dirEl.title =
          'Seu browser não expõe showDirectoryPicker(); os arquivos vão para a pasta padrão de downloads.';
      }
    }

    if (statusEl) {
      if (state.progress) {
        const prefix = state.progress.errorCount > 0 ? 'com erros' : 'em andamento';
        statusEl.textContent = `${state.progress.current}/${state.progress.total} ${prefix}: ${state.progress.label}`;
      } else {
        statusEl.textContent =
          state.reachedSidebarEnd
            ? listEndStatusText()
            : listIdleStatusText();
      }
    }

    if (progressEl) {
      progressEl.max = state.progress?.total || 1;
      progressEl.value = state.progress?.current || 0;
      progressEl.style.visibility = state.progress ? 'visible' : 'hidden';
    }

    if (exportBtn) {
      exportBtn.disabled = !canExport;
      exportBtn.textContent = state.isExporting
        ? 'Exportando...'
        : 'Exportar selecionadas';
    }

    [folderBtn, refreshBtn, selectAllBtn, clearBtn, closeBtn, currentBtn].forEach((btn) => {
      if (btn) btn.disabled = state.isExporting;
    });
    if (searchEl) searchEl.disabled = state.isExporting;
  };

  const ensureModal = () => {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.hidden = true;
    Object.assign(modal.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '10001',
      background: 'rgba(15, 23, 42, 0.26)',
      display: 'none',
      placeItems: 'center',
      padding: '12px',
      backdropFilter: 'blur(4px)',
    });

    setHtml(modal, `
      <style>
        #${MODAL_ID} .gm-modal-panel {
          width: min(760px, calc(100vw - 24px));
          max-height: min(680px, calc(100vh - 24px));
          display: flex;
          flex-direction: column;
          gap: 12px;
          box-sizing: border-box;
          overflow: hidden;
          background: var(--gm-panel-bg);
          color: var(--gm-text);
          border-radius: 22px;
          border: 1px solid var(--gm-border);
          box-shadow: 0 20px 70px rgba(0,0,0,0.22);
          padding: 18px;
          font-family: var(--gm-font);
          font-size: 14px;
          line-height: 1.35;
        }
        #${MODAL_ID} *,
        #${MODAL_ID} *::before,
        #${MODAL_ID} *::after {
          box-sizing: border-box;
        }
        #${MODAL_ID} .gm-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
        }
        #${MODAL_ID} .gm-modal-title {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex-wrap: wrap;
        }
        #${MODAL_ID} .gm-modal-title strong {
          font-size: 18px;
          line-height: 1.2;
          font-weight: 600;
        }
        #${MODAL_ID} .gm-count-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 22px;
          padding: 0 8px;
          border-radius: 999px;
          background: var(--gm-surface-muted);
          border: 1px solid var(--gm-border);
          font-size: 12px;
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-btn-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 32px;
          width: 32px;
          height: 32px;
          padding: 0;
          border-radius: 999px;
          border: none;
          background: transparent;
          color: var(--gm-text-muted);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        #${MODAL_ID} .gm-btn-close:hover {
          background: var(--gm-surface-muted);
          color: var(--gm-text);
        }
        #${MODAL_ID} .gm-toolbar {
          display: grid;
          grid-template-columns: minmax(280px, 1fr) max-content;
          gap: 8px;
          align-items: center;
        }
        #${MODAL_ID} .gm-toolbar-actions {
          display: flex;
          gap: 6px;
          align-items: center;
          justify-content: flex-end;
          min-width: 0;
        }
        #${MODAL_ID} .gm-input,
        #${MODAL_ID} .gm-btn {
          font: inherit;
          font-family: var(--gm-font);
        }
        #${MODAL_ID} .gm-input {
          width: 100%;
          min-width: 0;
          height: 36px;
          padding: 0 12px;
          border-radius: 12px;
          border: 1px solid var(--gm-border);
          background: var(--gm-surface-muted);
          color: var(--gm-text);
          outline: none;
          font-size: 14px;
          line-height: 36px;
        }
        #${MODAL_ID} .gm-input::placeholder {
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          height: 36px;
          min-width: 0;
          border-radius: 999px;
          padding: 0 12px;
          border: 1px solid var(--gm-border);
          background: var(--gm-surface-elevated);
          color: var(--gm-text);
          cursor: pointer;
          appearance: none;
          font-size: 13px;
          font-weight: 500;
          line-height: 1;
          transition: background .16s ease, border-color .16s ease, transform .16s ease;
          white-space: nowrap;
        }
        #${MODAL_ID} .gm-btn:hover:not(:disabled) {
          background: var(--gm-surface-muted);
        }
        #${MODAL_ID} .gm-btn:disabled {
          opacity: 0.55;
          cursor: default;
        }
        #${MODAL_ID} .gm-btn-primary {
          background: var(--gm-accent);
          border-color: transparent;
          color: white;
        }
        #${MODAL_ID} .gm-btn-primary:hover:not(:disabled) {
          background: var(--gm-accent-strong);
        }
        #${MODAL_ID} .gm-btn-success {
          background: var(--gm-success);
          border-color: transparent;
          color: white;
          padding: 0 18px;
          font-weight: 500;
        }
        #${MODAL_ID} .gm-btn-success:hover:not(:disabled) {
          filter: brightness(1.08);
        }
        #${MODAL_ID} .gm-btn-ghost {
          background: transparent;
          border-color: transparent;
          color: var(--gm-text-muted);
          padding: 0 12px;
        }
        #${MODAL_ID} .gm-btn-ghost:hover:not(:disabled) {
          background: var(--gm-surface-muted);
          color: var(--gm-text);
        }
        #${MODAL_ID} .gm-destination {
          display: grid;
          grid-template-columns: 32px minmax(0, 1fr) auto;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: 14px;
          background: var(--gm-surface-muted);
          border: 1px solid var(--gm-border);
        }
        #${MODAL_ID} .gm-destination-icon {
          width: 32px;
          height: 32px;
          border-radius: 10px;
          background: var(--gm-badge-bg);
          color: var(--gm-badge-text);
          display: grid;
          place-items: center;
          flex-shrink: 0;
        }
        #${MODAL_ID} .gm-destination-icon svg {
          display: block;
          width: 18px;
          height: 18px;
        }
        #${MODAL_ID} .gm-destination-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-width: 0;
        }
        #${MODAL_ID} .gm-destination-label {
          font-size: 11px;
          color: var(--gm-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
        #${MODAL_ID} .gm-destination-value {
          font-size: 13px;
          color: var(--gm-text);
          line-height: 1.35;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${MODAL_ID} .gm-destination-hint {
          font-size: 11px;
          color: var(--gm-text-muted);
          line-height: 1.35;
        }
        #${MODAL_ID} .gm-helper-text,
        #${MODAL_ID} .gm-status {
          font-size: 12px;
          line-height: 1.45;
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow-y: auto;
          overflow-x: hidden;
          /* flex:1 + min-height:0 deixa a lista crescer dentro do painel
             (que ja tem max-height propria) sem quebrar o footer. Antes o
             max-height fixo em 360px deixava muita area vazia no modal
             e uma barra de scroll apertada mesmo em telas grandes. */
          flex: 1 1 auto;
          min-height: 160px;
          padding-right: 4px;
          scrollbar-gutter: stable;
          /* Evita que o scroll da lista empurre o scroll do Gemini atras
             quando o usuario chega no topo/fundo. */
          overscroll-behavior: contain;
        }
        #${MODAL_ID} .gm-list:focus-visible {
          outline: 2px solid var(--gm-accent);
          outline-offset: 2px;
        }
        /* Scrollbar mais discreto e coerente com o tema do modal. */
        #${MODAL_ID} .gm-list::-webkit-scrollbar {
          width: 10px;
        }
        #${MODAL_ID} .gm-list::-webkit-scrollbar-track {
          background: transparent;
        }
        #${MODAL_ID} .gm-list::-webkit-scrollbar-thumb {
          background: var(--gm-border-strong);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        #${MODAL_ID} .gm-list::-webkit-scrollbar-thumb:hover {
          background: var(--gm-text-muted);
          background-clip: padding-box;
          border: 2px solid transparent;
        }
        #${MODAL_ID} .gm-conversation-item {
          display: grid;
          grid-template-columns: 24px minmax(0, 1fr);
          gap: 12px;
          align-items: center;
          box-sizing: border-box;
          padding: 11px 12px;
          min-height: 64px;
          border: 1px solid var(--gm-border);
          border-radius: 14px;
          background: var(--gm-surface-elevated);
          cursor: pointer;
          transition: border-color .16s ease, background .16s ease;
        }
        #${MODAL_ID} .gm-conversation-item:hover {
          border-color: var(--gm-border-strong);
          background: var(--gm-surface-muted);
        }
        #${MODAL_ID} .gm-checkbox {
          flex: 0 0 auto;
          justify-self: center;
          width: 16px;
          height: 16px;
          margin: 0;
          accent-color: var(--gm-accent);
        }
        #${MODAL_ID} .gm-conversation-copy {
          display: flex;
          flex-direction: column;
          gap: 3px;
          flex: 1;
          min-width: 0;
          align-self: center;
        }
        #${MODAL_ID} .gm-conversation-title-row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }
        #${MODAL_ID} .gm-conversation-title {
          font-size: 13px;
          line-height: 1.35;
          color: var(--gm-text);
          font-weight: 500;
        }
        #${MODAL_ID} .gm-conversation-id {
          font-size: 11px;
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-badge {
          font-size: 10px;
          line-height: 1;
          padding: 3px 7px;
          border-radius: 999px;
          background: var(--gm-badge-bg);
          color: var(--gm-badge-text);
        }
        #${MODAL_ID} .gm-list-end {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 24px;
          padding: 8px 10px 0;
          border-top: 1px solid var(--gm-border);
          font-size: 11px;
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-list-end-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: currentColor;
          opacity: 0.55;
          flex-shrink: 0;
        }
        #${MODAL_ID} .gm-list-end.is-loading {
          color: var(--gm-accent);
        }
        #${MODAL_ID} .gm-list-end.is-end {
          color: var(--gm-success);
        }
        #${MODAL_ID} .gm-progress-area {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-height: 28px;
        }
        #${MODAL_ID} .gm-progress {
          width: 100%;
          height: 8px;
          visibility: hidden;
        }
        #${MODAL_ID} .gm-footer {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          align-items: center;
        }
        #${MODAL_ID} .gm-footer > .gm-btn {
          justify-self: start;
        }
        #${MODAL_ID} .gm-footer-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
          min-width: 0;
        }
        @media (max-width: 640px) {
          #${MODAL_ID} .gm-modal-panel {
            width: calc(100vw - 20px);
            max-height: calc(100vh - 20px);
            padding: 14px;
            border-radius: 18px;
          }
          #${MODAL_ID} .gm-toolbar,
          #${MODAL_ID} .gm-footer {
            grid-template-columns: 1fr;
          }
          #${MODAL_ID} .gm-toolbar-actions,
          #${MODAL_ID} .gm-footer-actions {
            justify-content: flex-start;
          }
          #${MODAL_ID} .gm-destination {
            grid-template-columns: 32px minmax(0, 1fr);
          }
          #${MODAL_ID} .gm-destination > .gm-btn {
            grid-column: 2;
            justify-self: start;
          }
        }
      </style>
      <div data-role="panel" class="gm-modal-panel">
        <div class="gm-modal-header">
          <div class="gm-modal-title">
            <strong>Exportar conversas</strong>
            <span id="${MODAL_COUNT_ID}" class="gm-count-chip"></span>
          </div>
          <button data-action="close-modal" class="gm-btn-close" aria-label="Fechar">×</button>
        </div>

        <div class="gm-toolbar">
          <input id="${MODAL_SEARCH_ID}" class="gm-input" type="search" placeholder="Buscar conversas…">
          <div class="gm-toolbar-actions">
            <button data-action="select-all" class="gm-btn gm-btn-ghost">Selecionar visíveis</button>
            <button data-action="clear-selection" class="gm-btn gm-btn-ghost">Limpar</button>
          </div>
        </div>

        <div class="gm-destination">
          <div class="gm-destination-icon" aria-hidden="true">${FOLDER_ICON_SVG}</div>
          <div class="gm-destination-text">
            <span class="gm-destination-label">Destino</span>
            <span id="${MODAL_DIR_ID}" class="gm-destination-value"></span>
          </div>
          <button data-action="pick-dir" class="gm-btn gm-btn-ghost">Alterar</button>
        </div>

        <div id="${MODAL_LIST_ID}" class="gm-list"></div>
        <div id="${MODAL_LIST_END_ID}" class="gm-list-end" aria-live="polite"></div>

        <div class="gm-progress-area">
          <div id="${MODAL_STATUS_ID}" class="gm-status"></div>
          <progress id="${MODAL_PROGRESS_ID}" class="gm-progress" max="1" value="0"></progress>
        </div>

        <div class="gm-footer">
          <button data-action="refresh-list" class="gm-btn gm-btn-ghost">Puxar mais histórico</button>
          <div class="gm-footer-actions">
            <button data-action="export-current" class="gm-btn">Exportar atual</button>
            <button id="${MODAL_EXPORT_ID}" data-action="run-export" class="gm-btn gm-btn-success">Exportar selecionadas</button>
          </div>
        </div>
      </div>
    `);

    modal.addEventListener('click', (event) => {
      if (event.target === modal && !state.isExporting) {
        hideExportModal();
      }
    });

    modal.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'checkbox' || !target.dataset.chatId) return;

      if (target.checked) {
        state.selectedChatIds.add(target.dataset.chatId);
      } else {
        state.selectedChatIds.delete(target.dataset.chatId);
      }
      updateModalState();
    });

    modal.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.id !== MODAL_SEARCH_ID) return;
      state.filterQuery = target.value.trim();
      updateModalState();
    });

    modal.addEventListener(
      'scroll',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.id !== MODAL_LIST_ID) return;
        if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
          loadMoreConversations(
            isNotebookPage() ? NOTEBOOK_LOAD_MORE_ATTEMPTS : SIDEBAR_LOAD_MORE_ATTEMPTS,
          );
        }
      },
      true,
    );

    modal.addEventListener('click', async (event) => {
      const trigger = event.target.closest('[data-action]');
      if (!trigger) return;

      const action = trigger.dataset.action;
      if (action === 'close-modal') {
        if (!state.isExporting) hideExportModal();
        return;
      }

      if (action === 'refresh-list') {
        state.loadMoreFailures = 0;
        state.reachedSidebarEnd = false;
        const loaded = await loadMoreConversations(
          isNotebookPage() ? NOTEBOOK_LOAD_MORE_ATTEMPTS : SIDEBAR_LOAD_MORE_ATTEMPTS,
        );
        if (!loaded) {
          refreshConversationState();
          updateModalState();
          showToast(listEndStatusText(), 'info');
        }
        return;
      }

      if (action === 'select-all') {
        const visibleIds = state.conversations
          .filter(
            (item) =>
              !state.filterQuery ||
              conversationSearchText(item).includes(state.filterQuery.toLowerCase()),
          )
          .map((item) => item.id);
        state.selectedChatIds = new Set([...state.selectedChatIds, ...visibleIds]);
        updateModalState();
        return;
      }

      if (action === 'clear-selection') {
        state.selectedChatIds.clear();
        updateModalState();
        return;
      }

      if (action === 'pick-dir') {
        if (isExtensionContext) {
          const result = await pickBridgeOutputDir();
          if (result.status === 'picked') {
            bridgeState.lastError = null;
            updateModalState();
            showToast('Pasta de destino salva. Os próximos exports vão pra lá.', 'success');
          } else if (result.status === 'cancelled') {
            // Usuário fechou o seletor — comportamento esperado, sem toast.
            updateModalState();
          } else {
            bridgeState.lastError = result.reason;
            warn('Falha ao escolher pasta via bridge MCP:', result.reason);
            showToast(
              'Não consegui abrir o seletor. Verifique se o MCP local está rodando (rode o install-windows.cmd de novo ou reabra o Claude/Gemini CLI).',
              'error',
            );
            updateModalState();
          }
          return;
        }

        if (!supportsDirectoryPicker()) {
          showToast(
            'Este navegador não suporta escolher pasta. Use Chrome/Edge ou rode o MCP local.',
            'error',
          );
          return;
        }
        try {
          state.directoryHandle = await pageWindow.showDirectoryPicker({
            id: 'gemini-md-export',
            mode: 'readwrite',
          });
          setBridgeOutputDir('');
          updateModalState();
          showToast('Pasta de destino salva. Os próximos exports vão pra lá.', 'success');
        } catch (err) {
          // Cancelamento do picker não é erro — apenas silencia.
          if (err?.name === 'AbortError') return;
          warn('Falha ao escolher pasta.', err);
          const errorText = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
          if (
            errorText.includes('system files') ||
            errorText.includes('sensitive') ||
            errorText.includes('restricted')
          ) {
            showToast(
              'O navegador bloqueou essa pasta. Escolha uma subpasta comum, por exemplo Downloads/Gemini Exports.',
              'error',
            );
          } else {
            showToast(
              'Não consegui salvar a pasta escolhida. Tente outra pasta ou reinicie o MCP.',
              'error',
            );
          }
        }
        return;
      }

      if (action === 'export-current') {
        await exportNow();
        return;
      }

      if (action === 'run-export') {
        const selected = state.conversations.filter((item) =>
          state.selectedChatIds.has(item.id),
        );
        if (selected.length === 0) {
          showToast('Marque pelo menos uma conversa na lista antes de exportar.', 'info');
          return;
        }
        if (selected.some((item) => item.exportable === false)) {
          showToast(
            'Algumas conversas do caderno não expõem ID — não consigo exportar em lote. Abra uma por uma e use "Exportar essa conversa".',
            'error',
          );
          return;
        }
        const originalChatId = currentChatId();
        const originalWasNotebook = isNotebookPage();
        const originalNotebookReturnItem = originalWasNotebook
          ? selected.find((item) => item.source === 'notebook') || {
              source: 'notebook',
              title: 'caderno',
              notebookUrl: location.href,
              url: location.href,
              notebookId: currentNotebookId(),
              rowIndex: 0,
            }
          : null;
        const originalItem = state.conversations.find(
          (item) => item.chatId === originalChatId || item.id === originalChatId,
        );
        await runBatchExport(selected, {
          originalItem,
          originalWasNotebook,
          originalNotebookReturnItem,
        });
      }
    });

    document.body.appendChild(modal);
    return modal;
  };

  const openExportModal = async () => {
    state.loadMoreFailures = 0;
    state.reachedSidebarEnd = false;
    if (!isNotebookPage()) {
      await ensureSidebarOpen();
    }
    refreshConversationState();
    const modal = ensureModal();
    startSidebarConversationObserver();
    const dark = isDarkTheme();
    const vars = dark
      ? {
          '--gm-panel-bg': '#1f2329',
          '--gm-surface-elevated': '#2a2f36',
          '--gm-surface-muted': '#171b20',
          '--gm-border': 'rgba(255,255,255,0.08)',
          '--gm-border-strong': 'rgba(138,180,248,0.45)',
          '--gm-text': '#e8eaed',
          '--gm-text-muted': '#aab4be',
          '--gm-accent': '#8ab4f8',
          '--gm-accent-strong': '#6ea3f7',
          '--gm-success': '#1e8e3e',
          '--gm-badge-bg': 'rgba(138,180,248,0.16)',
          '--gm-badge-text': '#8ab4f8',
          '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
        }
      : {
          '--gm-panel-bg': '#ffffff',
          '--gm-surface-elevated': '#ffffff',
          '--gm-surface-muted': '#f6f8fb',
          '--gm-border': 'rgba(60,64,67,0.14)',
          '--gm-border-strong': 'rgba(26,115,232,0.28)',
          '--gm-text': '#202124',
          '--gm-text-muted': '#5f6368',
          '--gm-accent': '#1a73e8',
          '--gm-accent-strong': '#1557b0',
          '--gm-success': '#137333',
          '--gm-badge-bg': '#e8f0fe',
          '--gm-badge-text': '#1557b0',
          '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
        };
    Object.entries(vars).forEach(([key, value]) => modal.style.setProperty(key, value));
    modal.removeAttribute('hidden');
    modal.hidden = false;
    modal.style.display = 'grid';
    updateModalState();
  };

  const hideExportModal = () => {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    stopSidebarConversationObserver();
    modal.setAttribute('hidden', '');
    modal.hidden = true;
    modal.style.display = 'none';
  };

  const safeOpenExportModal = async () => {
    try {
      if (state.isExporting) {
        updateProgressDock();
        showToast('Já tem uma exportação rodando. Acompanhe pela barra de progresso no canto.', 'info');
        return;
      }
      log('abrindo modal de exportação');
      await openExportModal();
    } catch (err) {
      console.error(LOG_PREFIX, 'falha ao abrir o modal', err);
      alert(`Falha ao abrir o modal: ${err?.message || err}`);
      showToast(
        'Não consegui abrir o modal de exportação. Abra o console (F12) para ver o motivo.',
        'error',
      );
    }
  };

  const sendBridgeHeartbeat = async () => {
    if (!bridgeState.started) return;

    try {
      const extensionContext = await extensionSendMessage({ type: 'gemini-md-export/ping' });
      if (extensionContext?.tabId !== undefined) bridgeState.tabId = extensionContext.tabId;
      if (extensionContext?.windowId !== undefined) bridgeState.windowId = extensionContext.windowId;
      if (extensionContext?.isActiveTab !== undefined) {
        bridgeState.isActiveTab = extensionContext.isActiveTab;
      }
      if (extensionContext?.version) bridgeState.extensionVersion = extensionContext.version;
      if (extensionContext?.protocolVersion !== undefined) {
        bridgeState.protocolVersion = extensionContext.protocolVersion;
      }
      if (extensionContext?.buildStamp) bridgeState.buildStamp = extensionContext.buildStamp;
    } catch {
      // O service worker pode acordar entre heartbeats; o bridge HTTP continua tentando.
    }

    const response = await bridgeRequest('/bridge/heartbeat', {
      method: 'POST',
      payload: buildBridgeSummary(),
      timeoutMs: 4000,
    });

    bridgeState.lastHeartbeatAt = Date.now();
    if (response?.clientId && !bridgeState.clientId) {
      bridgeState.clientId = response.clientId;
    }
    if (response?.command) {
      await handleBridgeCommand(response.command);
    }
    // Se o bridge acabou de voltar, o heartbeat já serve como nudge para o
    // loop de comandos sair rápido de backoff/transiente e reabrir o long-poll.
    pollBridgeCommands();
  };

  const postBridgeCommandResult = async (command, result) => {
    await bridgeRequest('/bridge/command-result', {
      method: 'POST',
      payload: {
        clientId: bridgeState.clientId,
        commandId: command.id,
        result,
      },
      timeoutMs: 10000,
    });
  };

  const handleBridgeCommand = async (command) => {
    bridgeState.lastCommandReceivedAt = Date.now();
    let result;
    try {
      result = await executeBridgeCommand(command);
    } catch (err) {
      result = {
        ok: false,
        error: err?.message || String(err),
      };
    }
    await postBridgeCommandResult(command, result);
  };

  const pollBridgeCommands = async () => {
    if (!bridgeState.started || bridgeState.polling) return;
    bridgeState.polling = true;

    while (bridgeState.started) {
      try {
        bridgeState.lastCommandPollStartedAt = Date.now();
        const response = await bridgeRequest(
          `/bridge/command?clientId=${encodeURIComponent(bridgeState.clientId)}`,
          { timeoutMs: BRIDGE_POLL_TIMEOUT_MS },
        );
        bridgeState.lastCommandPollEndedAt = Date.now();

        if (!response?.command) {
          continue;
        }

        await handleBridgeCommand(response.command);
      } catch (err) {
        bridgeState.lastCommandPollEndedAt = Date.now();
        bridgeState.lastError = err?.message || String(err);
        await sleep(BRIDGE_POLL_ERROR_BACKOFF_MS);
      }
    }

    bridgeState.polling = false;
  };

  const installExtensionBridge = async () => {
    if (!isExtensionContext || bridgeState.started) return;

    bridgeState.clientId = randomId();

    try {
      const response = await extensionSendMessage({ type: 'gemini-md-export/ping' });
      if (response?.tabId !== undefined) bridgeState.tabId = response.tabId;
      if (response?.windowId !== undefined) bridgeState.windowId = response.windowId;
      if (response?.isActiveTab !== undefined) bridgeState.isActiveTab = response.isActiveTab;
      if (response?.version) bridgeState.extensionVersion = response.version;
      if (response?.protocolVersion !== undefined) bridgeState.protocolVersion = response.protocolVersion;
      if (response?.buildStamp) bridgeState.buildStamp = response.buildStamp;
    } catch (err) {
      warn('Falha ao obter contexto da extensão.', err);
    }

    bridgeState.started = true;

    const heartbeatTick = async () => {
      try {
        await sendBridgeHeartbeat();
      } catch {
        // bridge offline; retry silently
      }
    };

    await heartbeatTick();
    bridgeState.heartbeatTimer = setInterval(heartbeatTick, BRIDGE_HEARTBEAT_MS);
    pollBridgeCommands();
    log('bridge da extensão iniciado', {
      bridgeBaseUrl: BRIDGE_BASE_URL,
      clientId: bridgeState.clientId,
      tabId: bridgeState.tabId,
    });
  };

  // --- UI: botão -------------------------------------------------------

  // Aplica o visual idiomático do top-bar do Gemini no botão. Idempotente
  // (pode ser chamado em re-parenting sem duplicar listeners, porque quem
  // monta o botão só o faz uma vez — re-parenting só reseta estilos).
  const styleAsTopBarIconButton = (btn) => {
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 40px',
      padding: '0',
      width: '40px',
      height: '40px',
      borderRadius: '999px',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      outline: 'none',
      boxShadow: 'none',
      lineHeight: '0',
      verticalAlign: 'middle',
      appearance: 'none',
      transition: 'background-color 160ms ease',
      // limpa resíduo de um eventual render FAB legado
      position: '',
      right: '',
      bottom: '',
      zIndex: '',
    });
  };

  const styleAsTopBarSlot = (slot) => {
    Object.assign(slot.dataset, {
      role: 'gemini-md-export-slot',
      gmMdExportVersion: SCRIPT_VERSION,
      gmMdExportBuildStamp: BUILD_STAMP,
      gmMdExportKind: 'topbar-slot',
    });
    Object.assign(slot.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 40px',
      width: '40px',
      height: '40px',
      margin: '0 2px',
      padding: '0',
      boxSizing: 'border-box',
      alignSelf: 'center',
      lineHeight: '0',
      verticalAlign: 'middle',
      position: 'relative',
    });
  };

  const markButtonAsCurrentBuild = (btn) => {
    Object.assign(btn.dataset, {
      role: 'gemini-md-export',
      gmMdExportVersion: SCRIPT_VERSION,
      gmMdExportBuildStamp: BUILD_STAMP,
      gmMdExportKind: 'topbar-icon',
    });
  };

  const createExportButton = () => {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Exportar como Markdown (Ctrl+Shift+E: conversa atual)';
    btn.setAttribute('aria-label', BUTTON_LABEL);
    markButtonAsCurrentBuild(btn);
    setHtml(btn, BUTTON_ICON_SVG);
    styleAsTopBarIconButton(btn);

    const hoverIn = 'rgba(138,180,248,0.12)';
    const focusIn = 'rgba(138,180,248,0.18)';
    btn.addEventListener('mouseenter', () => {
      btn.style.backgroundColor = hoverIn;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.backgroundColor = 'transparent';
    });
    btn.addEventListener('focus', () => {
      btn.style.backgroundColor = focusIn;
    });
    btn.addEventListener('blur', () => {
      btn.style.backgroundColor = 'transparent';
    });
    btn.addEventListener('click', safeOpenExportModal);

    return btn;
  };

  const isVisibleControl = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.id === BUTTON_ID || el.closest?.(`#${BUTTON_SLOT_ID}`)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findTopBarPlacementAnchor = (topBar) => {
    const controls = Array.from(
      topBar.querySelectorAll('button,[role="button"],a[role="button"]'),
    ).filter(isVisibleControl);
    if (controls.length === 0) return null;

    const menuControl = controls.find((el) => {
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return (
        el.getAttribute('aria-haspopup') === 'menu' ||
        /(^|\s)(more|mais|options|opcoes|opções)(\s|$)/i.test(label)
      );
    });

    return menuControl || controls.at(-1);
  };

  const resolveTopBarPlacement = (topBar, anchor) => {
    if (!anchor) return { host: topBar, before: null };

    const parent = anchor.parentElement;
    if (parent && parent !== topBar && topBar.contains(parent)) {
      const display = getComputedStyle(parent).display;
      if (['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display)) {
        return { host: parent, before: anchor };
      }
    }

    return { host: topBar, before: directChildOf(topBar, anchor) };
  };

  // Coloca o botão num slot próprio antes do menu/kebab quando houver uma
  // ação nativa detectável. O slot é o item de layout, o botão fica isolado
  // dentro dele; isso evita herdar espaçamentos estranhos do Angular/Material.
  //
  // Robustez: `insertBefore(node, ref)` exige que `ref` seja filho *direto*
  // de `this`. Duas fontes de erro acontecem em produção:
  //   1. `placement.before` é um ancestor detectado por `.closest(...)` que
  //      mora dentro de `placement.host`, mas tem um wrapper Angular/Material
  //      no caminho — não é filho direto. Solução: subir de `before` até
  //      achar o filho direto de `host` via `directChildOf`.
  //   2. Entre a detecção do anchor e a chamada do insertBefore, o Gemini
  //      re-renderiza o top-bar e substitui o anchor. Nesse caso mesmo
  //      `directChildOf` retorna null. Solução: try/catch em volta da
  //      inserção e, em último caso, `appendChild` para ainda colocar o
  //      botão na barra em vez de explodir no console.
  const placeInTopBar = (btn, placementTarget) => {
    const topBar = placementTarget?.target || placementTarget;
    const preferredBefore = placementTarget?.before || null;
    let slot = document.getElementById(BUTTON_SLOT_ID);
    if (!slot) {
      slot = document.createElement('span');
      slot.id = BUTTON_SLOT_ID;
      Object.assign(slot.dataset, { role: 'gemini-md-export-slot' });
    }

    styleAsTopBarSlot(slot);
    if (btn.parentElement !== slot) {
      slot.appendChild(btn);
    }

    const anchor = preferredBefore || findTopBarPlacementAnchor(topBar);
    const placement = preferredBefore
      ? { host: topBar, before: preferredBefore }
      : resolveTopBarPlacement(topBar, anchor);

    // Normaliza `before` para um filho direto de `host`, senão vira null.
    let safeBefore = placement.before || null;
    if (safeBefore) {
      if (safeBefore.parentNode !== placement.host) {
        safeBefore = directChildOf(placement.host, safeBefore);
      }
    }

    const alreadyInPlace =
      slot.parentElement === placement.host &&
      slot.nextSibling === safeBefore;
    if (alreadyInPlace) return;

    // Race final: entre `directChildOf` e `insertBefore`, o Angular pode ter
    // detachado o nó. Confere `parentNode` imediatamente antes de chamar, e
    // se não for mais filho direto, zera safeBefore (vira appendChild).
    if (safeBefore && safeBefore.parentNode !== placement.host) {
      safeBefore = null;
    }

    try {
      if (safeBefore) {
        placement.host.insertBefore(slot, safeBefore);
      } else {
        placement.host.appendChild(slot);
      }
    } catch {
      // Host detached ou outra race extrema; próximo tick do
      // MutationObserver reposiciona. Não ruidar o console.
    }
  };

  // Loga o diagnóstico da injeção só em transições (mudança de estado),
  // não toda vez que o MutationObserver dispara. Content scripts MV3 rodam
  // em isolated world, então `__geminiMdExportDebug` não é acessível do
  // console da página — esses logs servem como substituto, basta filtrar
  // por "gemini-md-export" no DevTools.
  //
  // Política de ruído: "not-found" é estado transitório normal (durante
  // boot do Angular, em rotas sem conversa, etc.). Só consideramos erro
  // se estivermos numa URL de conversa `/app/<id>` e continuarmos em
  // "not-found" por mais de 4s seguidos — aí vale avisar, porque aí é
  // provavelmente Gemini ter mudado a estrutura do top-bar.
  const injectState = {
    lastKey: '',
    notFoundSince: 0,
    notFoundWarned: false,
    scheduled: false,
  };
  const NOT_FOUND_GRACE_MS = 4000;

  const scheduleInjectButton = () => {
    if (injectState.scheduled) return;
    injectState.scheduled = true;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    schedule(() => {
      injectState.scheduled = false;
      injectButton();
    });
  };

  const injectButton = () => {
    if (!document.body) return;
    let existing = document.getElementById(BUTTON_ID);
    const existingSlot = document.getElementById(BUTTON_SLOT_ID);
    const found = findTopBar();

    const stateKey = found
      ? `found:${found.matchedBy}`
      : 'not-found';
    const changed = stateKey !== injectState.lastKey;
    injectState.lastKey = stateKey;

    // Sem top-bar identificável: não injeta nada. A hotkey Ctrl+Shift+E e
    // `__geminiMdExportDebug.openExportModal()` continuam funcionando.
    // Preferimos ausência a um botão em área errada.
    if (!found) {
      if (existing) existing.remove();
      if (existingSlot) existingSlot.remove();
      if (changed) {
        injectState.notFoundSince = Date.now();
        injectState.notFoundWarned = false;
      }
      // Só avisa se: (a) estiver numa URL de conversa, e (b) tiver passado
      // do grace period sem achar. Assim não polui o console em rotas sem
      // conversa (home, settings) nem durante o boot inicial.
      const onConversationUrl = !!extractChatId(location.pathname);
      const stuck =
        onConversationUrl &&
        !injectState.notFoundWarned &&
        injectState.notFoundSince > 0 &&
        Date.now() - injectState.notFoundSince >= NOT_FOUND_GRACE_MS;
      if (stuck) {
        injectState.notFoundWarned = true;
        const all = [];
        for (const sel of TOP_BAR_SELECTORS) {
          document.querySelectorAll(sel).forEach((el) => all.push(el));
        }
        warn(
          'top-bar não encontrado após 4s numa URL de conversa. Candidatos no DOM:',
          all.length,
          'seletores tentados:',
          TOP_BAR_SELECTORS,
        );
      }
      return;
    }

    // Achou: zera contadores de not-found para o próximo ciclo.
    injectState.notFoundSince = 0;
    injectState.notFoundWarned = false;

    const topBar = found.target;
    if (changed) {
      // diagnóstico: quantos top-bar-actions existem, onde cada um está e
      // qual foi escolhido (o rightmost visível).
      const allRects = [];
      for (const sel of TOP_BAR_SELECTORS) {
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect();
          allRects.push({
            tag: el.tagName.toLowerCase(),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            visible: r.width > 0 && r.height > 0,
            isPick: el === topBar,
          });
        });
      }
      log('top-bar escolhido:', found.matchedBy, 'candidatos:', allRects);
    }

    if (existing) {
      markButtonAsCurrentBuild(existing);
      if (!existing.querySelector('svg')) {
        setHtml(existing, BUTTON_ICON_SVG);
      }
      placeInTopBar(existing, found);
      // sempre reaplica os estilos — defende contra render legado (FAB azul)
      // que tenha ficado de versões anteriores da extensão.
      styleAsTopBarIconButton(existing);
      return;
    }

    const btn = createExportButton();
    placeInTopBar(btn, found);
  };

  const installDebugApi = () => {
    pageWindow[DEBUG_GLOBAL] = {
      version: '__VERSION__',
      exportNow,
      openExportModal: safeOpenExportModal,
      listConversations: () => collectConversationLinks(),
      listBridgeConversations: () => collectBridgeConversationLinks(),
      loadMoreConversations: () => {
        state.loadMoreFailures = 0;
        state.reachedSidebarEnd = false;
        return loadMoreConversations(
          isNotebookPage() ? NOTEBOOK_LOAD_MORE_ATTEMPTS : SIDEBAR_LOAD_MORE_ATTEMPTS,
        );
      },
      bridgeStatus: () => ({
        started: bridgeState.started,
        clientId: bridgeState.clientId,
        tabId: bridgeState.tabId,
        windowId: bridgeState.windowId,
        isActiveTab: bridgeState.isActiveTab,
        extensionVersion: bridgeState.extensionVersion,
        buildStamp: bridgeState.buildStamp,
        lastError: bridgeState.lastError,
        bridgeBaseUrl: BRIDGE_BASE_URL,
        lastHeartbeatAt: bridgeState.lastHeartbeatAt || null,
      }),
      destination: () => ({
        bridgeOutputDir: state.bridgeOutputDir || null,
        browserDirectoryHandle: state.directoryHandle?.name || null,
        fallback: 'Downloads',
      }),
      notebookChatUrlCache: () => notebookChatUrlCacheSummary(),
      clearNotebookChatUrlCache: (notebookId) => clearNotebookChatUrlCache(notebookId),
      snapshot: debugSnapshot,
      hydrateCurrentConversation: () => hydrateConversationToTop(document, window),
      exportPayload: () => buildExportPayload(document, location.href),
      findTopBar: () => {
        const res = findTopBar();
        if (!res) return { matchedBy: null, target: null };
        return { matchedBy: res.matchedBy, target: res.target };
      },
      scrapeTurns: () => scrapeTurns(document),
      markdown: () =>
        buildDocument({
          meta: {
            chatId: extractChatId(location.pathname) || 'unknown',
            title: scrapeTitle(),
            url: location.href,
            exportedAt: new Date().toISOString(),
            model: scrapeModel(),
          },
          turns: scrapeTurns(document),
        }),
    };
  };

  const resumePendingBatchExport = async () => {
    if (state.isExporting) return;
    const session = loadBatchExportSession();
    if (!session || session.nextIndex >= session.items.length) {
      clearBatchExportSession();
      return;
    }

    log('retomando exportação em lote pendente', {
      nextIndex: session.nextIndex,
      total: session.items.length,
      failureIds: session.failureIds,
    });
    showToast(
      `Retomando exportação interrompida — conversa ${session.nextIndex + 1} de ${session.items.length}...`,
      'info',
    );
    try {
      await runBatchExport(session.items, {
        session,
        resume: true,
      });
    } catch (err) {
      warn('Falha ao retomar exportação em lote.', err);
      showToast(
        'Não consegui retomar a exportação pendente. Abra o console (F12) para ver o motivo.',
        'error',
      );
    }
  };

  // --- hotkey -----------------------------------------------------------

  const isEditableTarget = (target) =>
    !!target &&
    (target.isContentEditable ||
      /^(input|textarea|select)$/i.test(target.tagName || ''));

  document.addEventListener('keydown', (e) => {
    if (isEditableTarget(e.target)) return;
    if (e.key === 'Escape' && !state.isExporting) {
      const modal = document.getElementById(MODAL_ID);
      if (modal && !modal.hidden) {
        hideExportModal();
        return;
      }
    }
    if (
      e.key.toLowerCase() === HOTKEY.key &&
      e.ctrlKey === HOTKEY.ctrl &&
      e.shiftKey === HOTKEY.shift
    ) {
      e.preventDefault();
      exportNow();
    }
  });

  // --- bootstrap --------------------------------------------------------

  const bootstrap = () => {
    if (!document.body) return;
    installDebugApi();
    installExtensionBridge().catch((err) => {
      warn('Falha ao iniciar bridge da extensão.', err);
    });

    // O Gemini é uma SPA que re-renderiza o body; precisamos re-injetar o
    // botão quando isso acontece.
    const observer = new MutationObserver(() => scheduleInjectButton());
    observer.observe(document.body, { childList: true, subtree: true });
    injectButton();
    setTimeout(() => {
      resumePendingBatchExport().catch((err) => {
        warn('Falha ao agendar retomada do batch export.', err);
      });
    }, 300);
    log(`userscript carregado (v__VERSION__ build __BUILD_STAMP__)`);
    log(`debug API disponível em window.${DEBUG_GLOBAL}`);
  };

  if (document.body) {
    bootstrap();
  } else {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
})();
