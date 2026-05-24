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

// @ts-nocheck

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
  /* __INLINE_DOM_RUNNER_MODULE__ */
  /* __INLINE_PROGRESS_DOCK_UI__ */
  /* __INLINE_PROGRESS_PORT__ */
  /* __INLINE_TAB_COMMANDS__ */
  /* __INLINE_BRIDGE_CLIENT__ */
  /* __INLINE_PAGE_BLOCKER__ */
  /* __INLINE_BROWSER_NAVIGATION_STACK__ */

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
  const BUTTON_LABEL = 'Baixar Markdown';
  // Ícone SVG dentro do slot nativo do botão. Não usar ligature textual:
  // se a fonte Material Symbols não estiver disponível, o texto "download"
  // aparece literal no topo da página.
  const BUTTON_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" data-role="gm-md-export-download-icon" viewBox="0 -960 960 960" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M480-336 288-528l51-51 105 105v-342h72v342l105-105 51 51-192 192ZM263-192q-29.7 0-50.85-21.15Q191-234.3 191-264v-72h72v72h434v-72h72v72q0 29.7-21.15 50.85Q726.7-192 697-192H263Z"/>' +
    '</svg>';
  const MENU_CHECK_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" data-role="gm-menu-check-icon" viewBox="0 -960 960 960" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/>' +
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
  const MENU_ID = `${UI_ID_PREFIX}-menu`;
  const TOPBAR_TOOLTIP_ID = `${UI_ID_PREFIX}-tooltip`;
  const DEBUG_GLOBAL = '__geminiMdExportDebug';
  const LOG_PREFIX = '[gemini-md-export]';
  const SCRIPT_VERSION = '__VERSION__';
  const BUILD_STAMP = '__BUILD_STAMP__';
  const FRAME_TIMEOUT_MS = 45000;
  const CONVERSATION_CONTAINER_SELECTOR = 'div.conversation-container';
  const HYDRATION_LOAD_WAIT_MS = 900;
  const HYDRATION_TOP_SETTLE_MS = 8000;
  const HYDRATION_SMALL_TOP_SETTLE_MS = 900;
  const HYDRATION_STALL_TIMEOUT_MS = 45000;
  const HYDRATION_MAX_TOTAL_MS = 10 * 60 * 1000;
  const HYDRATION_MAX_ATTEMPTS = 900;
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
  const TOP_BAR_NOT_FOUND_GRACE_MS = 4000;
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
  const viewportDistanceForRect = (rect) => {
    if (!rect) return Number.POSITIVE_INFINITY;
    const width = Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 0);
    const height = Math.max(0, window.innerHeight || document.documentElement?.clientHeight || 0);
    const dx = rect.right < 0 ? -rect.right : rect.left > width ? rect.left - width : 0;
    const dy = rect.bottom < 0 ? -rect.bottom : rect.top > height ? rect.top - height : 0;
    return Math.hypot(dx, dy);
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

      // Anchors históricos: Gemini "clássico" expunha share/menu/save chat
      // como filhos do right-section. O redesign lr26 deixou só o kebab
      // dentro de um `.buttons-container`. Tentamos anchors antigos primeiro
      // e depois caímos no primeiro container visível.
      const shareButton = rightSection.querySelector('[data-test-id="share-button"]');
      const menuButton = rightSection.querySelector(
        '[data-test-id="conversation-actions-menu-icon-button"]',
      );
      const saveChatButton = rightSection.querySelector('#gemini-exporter');
      const legacyAnchor =
        shareButton?.closest('.buttons-container.share') ||
        menuButton?.closest('conversation-actions-icon') ||
        saveChatButton ||
        null;

      let anchor = legacyAnchor && visibleRect(legacyAnchor) ? legacyAnchor : null;
      let matchedBy = anchor
        ? `Gemini right-section before ${anchor.id || anchor.tagName.toLowerCase()}`
        : null;

      if (!anchor) {
        const containers = Array.from(
          rightSection.querySelectorAll(':scope > .buttons-container'),
        ).filter((el) => visibleRect(el));
        if (containers.length) {
          anchor = containers[0];
          matchedBy = `Gemini right-section before .buttons-container (${containers.length} visible)`;
        }
      }

      if (!anchor) continue;

      return {
        target: rightSection,
        before: anchor,
        anchor,
        matchedBy,
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

    // Caminho feliz do Gemini lr26: só existe um `top-bar-actions` visível
    // (o da conversa, ocupando a largura cheia do header). Retorna direto
    // sem depender do OneGoogleBar, que virou um sliver pouco confiável.
    if (scored.length === 1) {
      return {
        target: scored[0].el,
        matchedBy: 'top-bar-actions single visible candidate',
      };
    }

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
  const summarizeDiagnosticRect = (rect) => ({
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  const summarizeDiagnosticElement = (el, selector = null) => {
    const rect = el.getBoundingClientRect();
    return {
      selector,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: String(el.className || '').slice(0, 80) || null,
      label: controlLabel(el).slice(0, 80) || null,
      visible: rect.width > 0 && rect.height > 0,
      rect: summarizeDiagnosticRect(rect),
    };
  };
  const collectTopBarDiagnosticCandidates = ({ limit = 8, includeActions = false } = {}) => {
    const seen = new Set();
    const topBars = [];
    for (const selector of TOP_BAR_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        topBars.push(summarizeDiagnosticElement(el, selector));
      });
    }

    const controls = includeActions
      ? Array.from(document.querySelectorAll('button,[role="button"],a[role="button"]'))
          .filter((el) => el.id !== BUTTON_ID && !el.closest?.(`#${BUTTON_SLOT_ID}`))
          .map((el) => ({ el, rect: visibleRect(el), label: controlLabel(el) }))
          .filter(
            ({ rect }) => rect && (rect.top <= 120 || rect.left >= window.innerWidth * 0.55),
          )
      : [];

    return {
      selectorAttempts: TOP_BAR_SELECTORS,
      topBarCandidateCount: topBars.length,
      visibleTopBarCandidateCount: topBars.filter((item) => item.visible).length,
      topBars: topBars.slice(0, limit),
      actionControlCount: controls.length,
      actionControls: controls
        .slice(0, limit)
        .map(({ el }) => summarizeDiagnosticElement(el, 'button,[role="button"],a[role="button"]')),
    };
  };
  const buildTopBarDiagnostics = ({ includeCandidates = false } = {}) => {
    const onConversationUrl = !!extractChatId(location.pathname);
    const found = findTopBar();
    const candidates = collectTopBarDiagnosticCandidates({
      limit: includeCandidates ? 12 : 4,
      includeActions: includeCandidates || (!found && onConversationUrl),
    });
    return {
      status: found ? 'found' : onConversationUrl ? 'missing_on_conversation' : 'not_expected_here',
      route: onConversationUrl ? 'conversation' : isNotebookPage() ? 'notebook' : 'other',
      matchedBy: found?.matchedBy || null,
      warning:
        !found && onConversationUrl
          ? 'top-bar da conversa não encontrado; hotkey/API de debug ainda podem abrir o modal'
          : null,
      graceMs: TOP_BAR_NOT_FOUND_GRACE_MS,
      ...candidates,
    };
  };
  const SIDEBAR_ITEM_SELECTOR = [
    'conversations-list [data-test-id="conversation"]',
    'gem-nav-list-item',
    'mat-nav-list [role="listitem"]',
    '[role="navigation"] [data-conversation-id]',
    '[role="navigation"] [data-chat-id]',
    '[role="navigation"] [data-test-id^="conversation_"]',
  ].join(',');
  const SIDEBAR_SCROLL_ROOT_SELECTOR = [
    'conversations-list',
    'infinite-scroller',
    'mat-nav-list',
    'mat-sidenav',
    '[role="navigation"]',
  ].join(',');
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
  const RUNTIME_GUARD_KEY = '__geminiMdExportModernRuntime';
  const TAB_IGNORE_SESSION_STORAGE_KEY_BOOTSTRAP = 'gemini-md-export.ignoreThisTab.v1';
  const TAB_IGNORE_CHANGED_EVENT_BOOTSTRAP = 'gm-md-export:tab-ignored-changed';
  const existingRuntime = pageWindow[RUNTIME_GUARD_KEY];
  if (
    existingRuntime?.buildStamp === BUILD_STAMP &&
    Number(existingRuntime?.protocolVersion) === Number(EXTENSION_PROTOCOL_VERSION)
  ) {
    return;
  }
  const quiesceExistingRuntime = (runtime) => {
    if (!runtime) return;
    try {
      if (typeof runtime.stop === 'function') {
        runtime.stop('runtime-superseded');
        return;
      }
    } catch {
      // Se a runtime anterior falhar ao desligar, usamos o fallback legado.
    }
    try {
      pageWindow.sessionStorage?.setItem(TAB_IGNORE_SESSION_STORAGE_KEY_BOOTSTRAP, '1');
      const event =
        typeof CustomEvent === 'function'
          ? new CustomEvent(TAB_IGNORE_CHANGED_EVENT_BOOTSTRAP, {
              detail: { ignored: true, reason: 'runtime-superseded' },
            })
          : null;
      if (event) pageWindow.dispatchEvent(event);
      pageWindow.sessionStorage?.removeItem(TAB_IGNORE_SESSION_STORAGE_KEY_BOOTSTRAP);
    } catch {
      // Fallback melhor-esforço para builds antigas que só escutam o toggle.
    }
  };
  try {
    if (existingRuntime && existingRuntime.buildStamp !== BUILD_STAMP) {
      quiesceExistingRuntime(existingRuntime);
      existingRuntime.supersededAt = Date.now();
      existingRuntime.supersededBy = BUILD_STAMP;
    }
    pageWindow[RUNTIME_GUARD_KEY] = {
      version: SCRIPT_VERSION,
      extensionVersion: SCRIPT_VERSION,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      buildStamp: BUILD_STAMP,
      installedAt: Date.now(),
    };
  } catch {
    // Se a página bloquear escrita no window, seguimos sem o guard.
  }
  const BRIDGE_HEARTBEAT_MS = 8000;
  const BRIDGE_POLL_TIMEOUT_MS = 30000;
  const BRIDGE_POLL_ERROR_BACKOFF_MS = 250;
  const BRIDGE_EVENTS_BASE_BACKOFF_MS = 500;
  const BRIDGE_EVENTS_MAX_BACKOFF_MS = 15000;
  const BRIDGE_HEARTBEAT_PING_MS = 30000;
  const TAB_BROKER_REPORT_MIN_MS = 3000;
  const NATIVE_BRIDGE_TRANSPORT_COOLDOWN_MS = 60_000;
  const BRIDGE_SNAPSHOT_MIN_INTERVAL_MS = 1200;
  const BRIDGE_SNAPSHOT_MAX_INTERVAL_MS = 30000;
  const BRIDGE_PROTOCOL_CAPABILITIES = [
    'events-v1',
    'snapshot-v1',
    'heartbeat-incremental-v1',
    'command-result-retry-v1',
    'tab-backpressure-v1',
    'tab-claim-v1',
  ];
  const MODAL_VIRTUALIZATION_THRESHOLD = 120;
  const MODAL_VIRTUAL_ITEM_HEIGHT = 78;
  const MODAL_VIRTUAL_BUFFER = 10;
  const BRIDGE_CLIENT_STALE_MS = 45000;
  const BRIDGE_FILE_TIMEOUT_MS = 60000;
  const BRIDGE_PICKER_TIMEOUT_MS = 5 * 60000;
  const BRIDGE_OUTPUT_DIR_STORAGE_KEY = 'gemini-md-export.bridgeOutputDir';
  const NOTEBOOK_CHAT_URL_CACHE_STORAGE_KEY = 'gemini-md-export.notebookChatUrls.v1';
  const BATCH_EXPORT_SESSION_STORAGE_KEY = 'gemini-md-export.batchExportSession.v1';
  const MCP_PROGRESS_SESSION_STORAGE_KEY = 'gemini-md-export.mcpProgress.v1';
  const CHAT_CLIENT_ID_STORAGE_KEY = 'gemini-md-export.chatClientId.v1';
  const MCP_PROGRESS_STALE_GRACE_MS = 45_000;
  const MCP_PROGRESS_CANCEL_STALE_MS = 15_000;
  const MCP_PROGRESS_WATCHDOG_MS = 1000;
  // Por aba (sessionStorage): quando '1', a aba não envia heartbeat nem
  // long-poll de comandos para a bridge MCP. Usuário liga/desliga pelo menu
  // do botão. Sobrevive reload da própria aba; some quando a aba é fechada.
  const TAB_IGNORE_SESSION_STORAGE_KEY = 'gemini-md-export.ignoreThisTab.v1';
  const TAB_IGNORE_CHANGED_EVENT = 'gm-md-export:tab-ignored-changed';
  const TAB_CLAIM_DEFAULT_LABEL = '✨ Em uso';
  const TAB_CLAIM_TITLE_PREFIX_RE = /^\[(?:✨ Em uso|🔎 Conferindo|📥 Exportando|🔄 Sincroniza)\]\s+/u;
  const LEGACY_TAB_CLAIM_TITLE_PREFIX_RE = /^\[GME(?: [^\]]+)?\]\s+/;
  const isExtensionContext =
    typeof chrome !== 'undefined' &&
    !!chrome.runtime?.id &&
    typeof chrome.runtime.sendMessage === 'function';
  const isExtensionContextInvalidatedError = (err) =>
    /Extension context invalidated/i.test(String(err?.message || err || ''));
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
  const isTabIgnored = () => {
    try {
      return pageWindow.sessionStorage?.getItem(TAB_IGNORE_SESSION_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  };
  const setTabIgnored = (value) => {
    const next = !!value;
    try {
      if (next) {
        pageWindow.sessionStorage?.setItem(TAB_IGNORE_SESSION_STORAGE_KEY, '1');
      } else {
        pageWindow.sessionStorage?.removeItem(TAB_IGNORE_SESSION_STORAGE_KEY);
      }
    } catch {
      // sessionStorage pode estar bloqueado em modos restritos; o fluxo
      // continua e a bridge respeita o estado em memória até o próximo reload.
    }
    try {
      const detail = { ignored: next };
      const event =
        typeof CustomEvent === 'function'
          ? new CustomEvent(TAB_IGNORE_CHANGED_EVENT, { detail })
          : null;
      if (event) pageWindow.dispatchEvent(event);
    } catch {
      // dispatchEvent pode não estar disponível em runtimes degradados
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
    exportSource: null, // 'gui' | 'mcp' | null
    progress: null,
    previousProgressForDisplay: null,
    progressCreepTimer: null,
    mcpProgressActive: false,
    mcpProgressJobId: null,
    mcpProgressLastSeenAt: 0,
    mcpProgressCancelSinceAt: 0,
    mcpProgressWatchdogTimer: 0,
    isLoadingMore: false,
    loadMoreFailures: 0,
    lastLoadMoreTrace: [],
    listLoadStatus: 'idle',
    filterQuery: '',
    reachedSidebarEnd: false,
    sidebarConversationCache: new Map(),
    domScheduler: {
      scheduled: false,
      pending: new Set(),
      lastRunAt: 0,
      runs: 0,
      skipped: 0,
      reasons: [],
    },
    activeTabOperation: null,
    completedTabOperations: 0,
    rejectedTabOperations: 0,
    tabClaim: null,
    tabClaimExpiryTimer: 0,
    tabClaimOriginalTitle: '',
    modalVirtual: {
      active: false,
      scheduled: false,
      renderedStart: 0,
      renderedEnd: 0,
      lastKey: '',
      lastTotal: 0,
    },
    bridgeSnapshotDirty: true,
    bridgeSnapshotDirtyReason: 'startup',
    bridgeSnapshotHash: '',
    lastBridgeSnapshotAt: 0,
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
  const SIDEBAR_OPEN_WAIT_MS = 6000;
  const SIDEBAR_OPEN_POLL_MS = 120;
  const SIDEBAR_OPEN_CLICK_ATTEMPTS = 3;
  const notebookChatIdCache = new WeakMap();
  let notebookChatUrlCache = null;
  let lastTabBrokerReportAt = 0;
  let extensionContextRefreshInFlight = null;
  let tabBrokerReportInFlight = null;
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
    lastHeartbeatStartedAt: 0,
    lastHeartbeatDurationMs: null,
    lastExtensionPingAt: 0,
    lastExtensionPingOkAt: 0,
    lastExtensionPingAttempts: 0,
    lastExtensionPingError: null,
    heartbeatInFlight: false,
    snapshotInFlight: false,
    eventSource: null,
    eventsConnected: false,
    eventsConnecting: false,
    eventsReconnectTimer: 0,
    eventsBackoffMs: BRIDGE_EVENTS_BASE_BACKOFF_MS,
    commandResultCache: new Map(),
    lastCommandPollStartedAt: 0,
    lastCommandPollEndedAt: 0,
    lastCommandReceivedAt: 0,
  };
  const bridgeTransportState = {
    preferred: 'native',
    active: 'http',
    nativeDisabledUntil: 0,
    nativeLastOkAt: 0,
    nativeLastError: null,
  };
  const MIN_FAST_POLL_BACKOFF_MS = 250;

  const markBridgeSnapshotDirty = (reason = 'changed') => {
    state.bridgeSnapshotDirty = true;
    state.bridgeSnapshotDirtyReason = reason;
  };

  const scheduleDomWork = (reason = 'changed', flags = {}) => {
    const scheduler = state.domScheduler;
    if (reason) {
      scheduler.reasons.push(String(reason));
      if (scheduler.reasons.length > 12) scheduler.reasons.shift();
    }
    if (flags.topBar) scheduler.pending.add('topBar');
    if (flags.conversations) scheduler.pending.add('conversations');
    if (flags.modal) scheduler.pending.add('modal');
    if (scheduler.scheduled) {
      scheduler.skipped += 1;
      return;
    }

    scheduler.scheduled = true;
    const schedule =
      typeof pageWindow.requestAnimationFrame === 'function'
        ? pageWindow.requestAnimationFrame.bind(pageWindow)
        : (callback) => setTimeout(callback, 16);

    schedule(() => {
      const pending = new Set(scheduler.pending);
      scheduler.pending.clear();
      scheduler.scheduled = false;
      scheduler.lastRunAt = Date.now();
      scheduler.runs += 1;

      if (pending.has('topBar')) {
        scheduleInjectButton();
      }
      if (pending.has('conversations')) {
        refreshConversationState();
      }
      if (pending.has('modal')) {
        const modal = document.getElementById(MODAL_ID);
        if (modal && !modal.hidden) updateModalState();
      }
    });
  };

  const bridgeBackoffWithJitter = (currentMs, baseMs, maxMs) => {
    const current = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : baseMs;
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(current * 0.25)));
    return Math.min(maxMs, current + jitter);
  };

  const resetBridgeEventBackoff = () => {
    bridgeState.eventsBackoffMs = BRIDGE_EVENTS_BASE_BACKOFF_MS;
  };

  const increaseBridgeEventBackoff = () => {
    bridgeState.eventsBackoffMs = Math.min(
      BRIDGE_EVENTS_MAX_BACKOFF_MS,
      bridgeBackoffWithJitter(
        bridgeState.eventsBackoffMs * 2,
        BRIDGE_EVENTS_BASE_BACKOFF_MS,
        BRIDGE_EVENTS_MAX_BACKOFF_MS,
      ),
    );
    return bridgeState.eventsBackoffMs;
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

  const buildNativeStyleProfile = () =>
    buildGeminiNativeStyleProfile({ documentRef: document, isDark: isDarkTheme() });

  const applyNativeStyleProfile = (element) => {
    const profile = buildNativeStyleProfile();
    element.dataset.gmNativeStyleProfile = profile.name;
    applyGeminiNativeStyleVars(element, profile);
    return profile;
  };

  const nativeStyleVar = (name, fallback) => `var(${name}, ${fallback})`;

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

    const errorBase = readHostCssToken('--gem-sys-color--error', '', { documentRef: document });
    const primaryBase = readHostCssToken('--gem-sys-color--primary', '', { documentRef: document });
    const palette =
      kind === 'error'
        ? {
            bg: errorBase ? `color-mix(in srgb, ${errorBase} 88%, black)` : '#c5221f',
            border: errorBase ? `color-mix(in srgb, ${errorBase} 70%, black)` : '#8f1b13',
          }
        : kind === 'success'
          ? { bg: '#137333', border: '#0d5a27' }
          : {
              bg: primaryBase ? `color-mix(in srgb, ${primaryBase} 80%, black)` : '#1a73e8',
              border: primaryBase
                ? `color-mix(in srgb, ${primaryBase} 60%, black)`
                : '#1557b0',
            };

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

  const withTimeoutValue = (promise, timeoutMs, fallbackValue) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallbackValue), Math.max(1, timeoutMs));
      Promise.resolve(promise).then(finish, () => finish(fallbackValue));
    });

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

  const getSidebarNav = () => {
    const explicitSideNav = document.querySelector('mat-sidenav');
    if (explicitSideNav) return explicitSideNav;
    return Array.from(document.querySelectorAll('[role="navigation"], mat-nav-list')).find((el) =>
      !!el.querySelector?.(SIDEBAR_ITEM_SELECTOR),
    ) || null;
  };

  const isSidebarOpen = () => {
    const sideNav = getSidebarNav();
    if (!sideNav) return false;
    if (sideNav.getAttribute('aria-hidden') === 'true') return false;
    if (sideNav.classList.contains('mat-drawer-closed')) return false;
    const rect = visibleRect(sideNav);
    const width = rect?.width || sideNav.offsetWidth || 0;
    if (width > 0 && width <= 100) return false;
    return getSidebarConversationElements().some((element) => !!getChatIdFromSidebarElement(element));
  };

  const findSidebarMenuButton = () => {
    const selectors = [
      '[data-test-id="side-nav-menu-button"]',
      'button[aria-label*="main menu" i]',
      'button[aria-label*="show menu" i]',
      'button[aria-label*="open menu" i]',
      'button[aria-label*="expand menu" i]',
      'button[aria-label*="open navigation" i]',
      'button[aria-label*="show navigation" i]',
      'button[aria-label*="side navigation" i]',
      'button[aria-label*="sidebar" i]',
      'button[aria-label*="abrir navegação" i]',
      'button[aria-label*="abrir menu" i]',
      'button[aria-label*="expandir" i]',
      'button[aria-label*="barra lateral" i]',
      'button[aria-label*="menu principal" i]',
      'button[aria-label*="navigation" i]',
      'button[aria-label*="menu" i]',
    ];
    const candidates = selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    const seen = new Set();
    return candidates
      .filter((button) => {
        if (seen.has(button)) return false;
        seen.add(button);
        const rect = visibleRect(button);
        if (!rect) return false;
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        const label = controlLabel(button);
        const explicit = button.matches?.('[data-test-id="side-nav-menu-button"]');
        const labelLooksRight =
          /(^menu$|main menu|show menu|open menu|expand menu|open navigation|show navigation|side navigation|sidebar|side nav|abrir navegação|abrir navegacao|abrir menu|expandir|barra lateral|menu principal|navigation)/i.test(label);
        const leftSide = rect.left <= Math.max(420, (window.innerWidth || 0) * 0.35);
        const topSide = rect.top <= Math.max(96, (window.innerHeight || 0) * 0.18);
        return explicit || (labelLooksRight && leftSide && topSide);
      })
      .sort((a, b) => {
        const aExplicit = a.matches?.('[data-test-id="side-nav-menu-button"]') ? 0 : 1;
        const bExplicit = b.matches?.('[data-test-id="side-nav-menu-button"]') ? 0 : 1;
        if (aExplicit !== bExplicit) return aExplicit - bExplicit;
        return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
      })[0] || null;
  };

  const waitForSidebarOpen = async (timeoutMs = SIDEBAR_OPEN_WAIT_MS, pollMs = SIDEBAR_OPEN_POLL_MS) => {
    const startedAt = Date.now();
    const budgetMs = Math.max(0, Number(timeoutMs) || 0);
    const intervalMs = Math.max(25, Number(pollMs) || SIDEBAR_OPEN_POLL_MS);
    do {
      if (isSidebarOpen()) return true;
      await sleep(intervalMs);
    } while (Date.now() - startedAt < budgetMs);
    return isSidebarOpen();
  };

  const ensureSidebarOpen = async (options = {}) => {
    if (isSidebarOpen()) return true;
    const timeoutMs = Math.max(700, Number(options.timeoutMs || SIDEBAR_OPEN_WAIT_MS));
    const pollMs = Math.max(25, Number(options.pollMs || SIDEBAR_OPEN_POLL_MS));
    const startedAt = Date.now();
    let attempts = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const menuButton = findSidebarMenuButton();
      if (menuButton && attempts < SIDEBAR_OPEN_CLICK_ATTEMPTS) {
        attempts += 1;
        menuButton.click();
      }

      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      if (await waitForSidebarOpen(Math.min(1200, remainingMs), pollMs)) return true;
    }
    return isSidebarOpen();
  };

  const ensureSidebarOpenForCommand = async (command, settleMs) => {
    if (command.args?.ensureSidebar === false || isNotebookPage()) return { ok: true };
    const opened = await ensureSidebarOpen({
      timeoutMs: command.args?.ensureSidebarTimeoutMs,
      pollMs: command.args?.ensureSidebarPollMs,
    });
    await sleep(settleMs);
    if (opened && isSidebarOpen()) return { ok: true };
    return {
      ok: false,
      code: 'sidebar_not_open',
      error: 'Não consegui abrir o sidebar do Gemini. Abra a lista de conversas e tente novamente.',
      sidebarDiagnostics: sidebarDiagnostics(),
    };
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

  const CONVERSATION_TURN_DOM_SELECTOR = 'user-query, model-response';
  const HIDDEN_CONVERSATION_STYLE_RE =
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i;

  const isHiddenConversationDomNode = (node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    while (el && el.nodeType === 1) {
      if (el.hidden || el.getAttribute?.('aria-hidden') === 'true' || el.hasAttribute?.('inert')) {
        return true;
      }
      if (HIDDEN_CONVERSATION_STYLE_RE.test(el.getAttribute?.('style') || '')) return true;
      const style =
        typeof pageWindow.getComputedStyle === 'function' ? pageWindow.getComputedStyle(el) : null;
      if (
        style &&
        (style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse')
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  };

  const conversationDomNodes = (doc = document) =>
    Array.from(doc.querySelectorAll(CONVERSATION_TURN_DOM_SELECTOR)).filter(
      (node) => !isHiddenConversationDomNode(node),
    );

  const conversationDomSignature = (doc = document) => {
    const nodes = conversationDomNodes(doc);
    if (nodes.length === 0) return '';

    const indexes = [...new Set([0, Math.floor((nodes.length - 1) / 2), nodes.length - 1])];
    const sample = indexes
      .map((index) => {
        const node = nodes[index];
        return `${node.tagName}:${cleanText(node.textContent).slice(0, 2000)}`;
      })
      .join('|');

    return `${nodes.length}:${stableHash(sample)}`;
  };

  const conversationDomTurnCount = (doc = document) => conversationDomNodes(doc).length;

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

  const normalizeConcreteChatId = (value) => {
    const chatId = String(value || '').trim().replace(/^c_/, '');
    return /^[a-f0-9]{12,}$/i.test(chatId) ? chatId : null;
  };

  const findChatIdInAttributeValue = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    const appPathMatch = text.match(/\/app\/(?:c_)?([a-f0-9]{12,})/i);
    const appPathChatId = normalizeConcreteChatId(appPathMatch?.[1]);
    if (appPathChatId) return appPathChatId;

    const prefixedMatch = text.match(/\bc_([a-f0-9]{12,})\b/i);
    const prefixedChatId = normalizeConcreteChatId(prefixedMatch?.[1]);
    if (prefixedChatId) return prefixedChatId;

    const exactChatId = normalizeConcreteChatId(text);
    if (exactChatId) return exactChatId;
    return null;
  };

  const getChatIdFromElementAttributes = (element) => {
    const candidates = [
      element,
      ...Array.from(element.querySelectorAll?.('*') || []).slice(0, 80),
    ];
    for (const candidate of candidates) {
      for (const attr of Array.from(candidate.attributes || [])) {
        const chatId = findChatIdInAttributeValue(attr.value);
        if (chatId) return chatId;
      }
    }
    return null;
  };

  const getChatIdFromSidebarElement = (element) => {
    const url = getConversationUrlFromElement(element);
    if (url) {
      const chatId = extractChatId(new URL(url).pathname);
      if (chatId) return chatId;
    }

    const testId = element.getAttribute('data-test-id');
    if (testId?.startsWith('conversation_')) {
      const chatId = normalizeConcreteChatId(testId.slice('conversation_'.length));
      if (chatId) return chatId;
    }

    const jslog = element.getAttribute('jslog');
    if (jslog) {
      const match = jslog.match(/BardVeMetadataKey:\[[^\]]*\["([^"]+)"/);
      const chatId = normalizeConcreteChatId(match?.[1]);
      if (chatId) return chatId;
    }

    return getChatIdFromElementAttributes(element);
  };

  const getConversationTitleFromElement = (element, fallbackId) => {
    const title =
      cleanText(
        element.querySelector(
          '.conversation-title, .title, [data-test-id="conversation-title"], [data-test-id="chat-title"]',
        )?.textContent,
      ) ||
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
    if (!isSidebarOpen()) return [];

    const seen = new Set();
    const items = [];
    const currentId = currentChatId();

    getSidebarConversationElements().forEach((element, index) => {
      const chatId = getChatIdFromSidebarElement(element);
      if (!chatId) return;
      const id = chatId;
      if (seen.has(id)) return;
      seen.add(id);

      const url =
        getConversationUrlFromElement(element) ||
        `https://gemini.google.com/app/${chatId}`;
      if (!url) return;

      const title = getConversationTitleFromElement(element, id);
      const pathname = new URL(url).pathname;
      const itemChatId = extractChatId(pathname) || chatId;
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

  const collectCurrentConversationLink = () => {
    const currentId = currentChatId();
    if (!currentId) return [];
    return [
      {
        id: currentId,
        chatId: currentId,
        title: scrapeTitle() || currentId,
        url: location.href,
        current: true,
        source: 'current',
      },
    ];
  };

  const mergeConversationLists = (...lists) => {
    const seen = new Set();
    const merged = [];
    lists.flat().forEach((item) => {
      if (!item) return;
      const chatId = stripConversationPrefix(item.chatId || item.id || '');
      const key = /^[a-f0-9]{12,}$/i.test(chatId)
        ? `chat:${chatId.toLowerCase()}`
        : `${item.source || 'sidebar'}:${item.url || item.id || item.title || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
    return merged;
  };

  const conversationCacheKey = (item) => {
    const chatId = stripConversationPrefix(item?.chatId || item?.id || '');
    if (/^[a-f0-9]{12,}$/i.test(chatId)) return `chat:${chatId.toLowerCase()}`;
    if (item?.url && /\/app\/[a-f0-9]{12,}/i.test(item.url)) return `url:${item.url}`;
    return `title:${item?.title || ''}:${item?.timestamp || ''}`;
  };

  const rememberSidebarConversationLinks = (items) => {
    for (const item of items) {
      if (!item || item.source === 'notebook') continue;
      const key = conversationCacheKey(item);
      if (!key) continue;
      const existing = state.sidebarConversationCache.get(key);
      state.sidebarConversationCache.set(key, {
        ...existing,
        ...item,
        source: 'sidebar',
        current: item.current || false,
      });
    }
    return Array.from(state.sidebarConversationCache.values());
  };

  const collectCachedSidebarConversationLinks = () =>
    rememberSidebarConversationLinks(collectSidebarConversationLinks());

  const collectConversationLinks = () => {
    if (isNotebookPage()) {
      const notebookConversations = collectNotebookConversationLinks();
      if (notebookConversations.length > 0) return notebookConversations;
    }

    return collectCachedSidebarConversationLinks();
  };

  const collectBridgeConversationLinks = () =>
    isNotebookPage()
      ? mergeConversationLists(
          collectCachedSidebarConversationLinks(),
          collectNotebookConversationLinks(),
          collectCurrentConversationLink(),
        )
      : mergeConversationLists(collectCachedSidebarConversationLinks(), collectCurrentConversationLink());

  const collectConversationLinkSnapshot = () => {
    const notebookPage = isNotebookPage();
    const sidebarConversations = collectCachedSidebarConversationLinks();
    const currentConversation = collectCurrentConversationLink();
    const notebookConversations = notebookPage ? collectNotebookConversationLinks() : [];
    const modalConversations =
      notebookPage && notebookConversations.length > 0
        ? notebookConversations
        : sidebarConversations;
    const bridgeConversations = notebookPage
      ? mergeConversationLists(sidebarConversations, notebookConversations, currentConversation)
      : mergeConversationLists(sidebarConversations, currentConversation);

    return {
      modalConversations,
      bridgeConversations,
      sidebarConversations,
      notebookConversations,
    };
  };

  const refreshConversationState = () => {
    const previousSelection = new Set(state.selectedChatIds);
    state.conversations = collectConversationLinks();
    markBridgeSnapshotDirty('conversation-state');
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
    if (state.listLoadStatus === 'inconclusive' || state.loadMoreFailures > 0) {
      return kind === 'notebook'
        ? 'Não carregou mais agora; ainda não confirmei o fim do caderno.'
        : 'Não carregou mais agora; ainda não confirmei o fim do histórico.';
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
      ? 'Fim do caderno confirmado: não há mais conversas pra carregar.'
      : 'Fim do histórico confirmado no sidebar.';

  const listInconclusiveStatusText = () =>
    currentListKind() === 'notebook'
      ? 'Não consegui confirmar o fim do caderno. Use "Puxar mais conversas" novamente.'
      : 'Não consegui confirmar o fim do histórico. Use "Puxar mais histórico" novamente.';

  const hasConversationNode = (node) => {
    if (!(node instanceof Element)) return false;
    return (
      node.matches?.('[data-test-id="conversation"]') ||
      !!node.querySelector?.('[data-test-id="conversation"]') ||
      node.matches?.('gem-nav-list-item, [data-conversation-id], [data-chat-id]') ||
      !!node.querySelector?.('gem-nav-list-item, [data-conversation-id], [data-chat-id]') ||
      node.matches?.('project-chat-row') ||
      !!node.querySelector?.('project-chat-row')
    );
  };

  const uniqueElements = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      if (!(item instanceof Element) || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  };

  const sidebarConversationItemsWithin = (root) => {
    if (!(root instanceof Element)) return [];
    return uniqueElements([
      ...(root.matches?.(SIDEBAR_ITEM_SELECTOR) ? [root] : []),
      ...Array.from(root.querySelectorAll?.(SIDEBAR_ITEM_SELECTOR) || []),
    ]);
  };

  const sidebarRootHasExtractableConversation = (root) =>
    sidebarConversationItemsWithin(root).some((element) => !!getChatIdFromSidebarElement(element));

  const findSidebarHistoryScroller = () => {
    const roots = uniqueElements(
      Array.from(document.querySelectorAll(SIDEBAR_SCROLL_ROOT_SELECTOR)),
    );
    const relevantRoots = roots.filter(sidebarRootHasExtractableConversation);
    if (relevantRoots.length === 0) return { wrapper: null, scroller: null, matchedBy: null };

    const preferredWrapper =
      relevantRoots.find((el) => el.tagName?.toLowerCase() === 'conversations-list') ||
      relevantRoots.find((el) => el.tagName?.toLowerCase() === 'mat-nav-list') ||
      relevantRoots.find((el) => el.tagName?.toLowerCase() === 'infinite-scroller') ||
      relevantRoots[0];

    const scroller =
      relevantRoots.find((el) => hasOverflow(el)) ||
      findScrollableParent(preferredWrapper) ||
      preferredWrapper;

    return {
      wrapper: preferredWrapper,
      scroller,
      matchedBy: scroller?.tagName?.toLowerCase() || null,
    };
  };

  const scheduleSidebarRefresh = () => {
    markBridgeSnapshotDirty('sidebar-mutation');
    scheduleDomWork('sidebar-mutation', {
      conversations: true,
      modal: true,
    });
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
      : findSidebarHistoryScroller().wrapper;
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

  const describeScrollContainer = (el, matchedBy = null) => {
    if (!el) {
      return {
        found: false,
        matchedBy,
      };
    }
    const rect = el.getBoundingClientRect?.();
    return {
      found: true,
      matchedBy,
      tag: el.tagName?.toLowerCase() || '',
      id: el.id || '',
      className: String(el.className || ''),
      role: el.getAttribute?.('role') || '',
      testId: el.getAttribute?.('data-test-id') || '',
      scrollTop: Math.round(Number(el.scrollTop || 0)),
      scrollHeight: Math.round(Number(el.scrollHeight || 0)),
      clientHeight: Math.round(Number(el.clientHeight || 0)),
      hasOverflow: hasOverflow(el),
      atBottom: isAtBottom(el),
      rect: rect
        ? {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
          }
        : null,
    };
  };

  const scrollInfoIsNearBottom = (info, threshold = 160) => {
    if (!info?.found) return false;
    if (info.atBottom === true || info.hasOverflow === false) return true;
    const remaining =
      Number(info.scrollHeight || 0) -
      Number(info.scrollTop || 0) -
      Number(info.clientHeight || 0);
    return Number.isFinite(remaining) && remaining <= threshold;
  };

  const traceConfirmsStableBottom = (trace) =>
    trace.some((entry) => {
      if (entry.loaded === true) return false;
      const beforeKnown = Number(entry.beforeKnown);
      const afterKnown = Number(entry.afterKnown);
      if (!Number.isFinite(beforeKnown) || !Number.isFinite(afterKnown)) return false;
      if (beforeKnown !== afterKnown) return false;
      return scrollInfoIsNearBottom(entry.scrollAfter);
    });

  const conversationTailSignature = (items = collectConversationLinks(), size = 5) => {
    const normalized = Array.isArray(items) ? items : [];
    const tail = normalized.slice(-size).map((item) =>
      [
        item?.source || '',
        item?.chatId || item?.id || '',
        item?.url || '',
        item?.title || '',
        item?.timestamp || '',
      ].join(':'),
    );
    return `${normalized.length}|${tail.join('|')}`;
  };

  const traceConfirmsStableTail = (trace) =>
    trace.some((entry) => {
      if (entry.loaded === true || entry.phase !== 'confirm-end') return false;
      const beforeKnown = Number(entry.beforeKnown);
      const afterKnown = Number(entry.afterKnown);
      if (!Number.isFinite(beforeKnown) || beforeKnown <= 0 || beforeKnown !== afterKnown) {
        return false;
      }
      if (!entry.beforeTail || entry.beforeTail !== entry.afterTail) return false;
      if (entry.actionability?.receivingEvents === false) return false;
      return true;
    });

  const waitForSidebarConversationGrowth = (
    beforeCount,
    timeoutMs = 1800,
    beforeKnownCount = null,
  ) =>
    new Promise((resolve) => {
      const conversationsList = isNotebookPage()
        ? findNotebookHistoryScroller().wrapper
        : findSidebarHistoryScroller().wrapper;
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
        const currentKnownCount =
          beforeKnownCount === null ? null : collectBridgeConversationLinks().length;
        if (
          currentCount > beforeCount ||
          (currentKnownCount !== null && currentKnownCount > beforeKnownCount)
        ) {
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
    let scrollContainerMatchedBy = null;
    const before = getConversationElementsForCurrentPage().length;
    const beforeKnown = collectBridgeConversationLinks().length;
    const beforeTail = conversationTailSignature();
    const pickScrollContainer = (candidate, matchedBy) => {
      if (!scrollContainer && candidate) {
        scrollContainer = candidate;
        scrollContainerMatchedBy = matchedBy;
      }
    };

    if (isNotebookPage()) {
      pickScrollContainer(findNotebookHistoryScroller().scroller, 'notebook-history-scroller');
    }
    if (!isNotebookPage()) {
      const sidebarScroller = findSidebarHistoryScroller();
      pickScrollContainer(sidebarScroller.scroller, sidebarScroller.matchedBy || 'sidebar-history-scroller');
    }
    const sidebarList = document.querySelector('conversations-list');
    pickScrollContainer(
      hasOverflow(sidebarList) ? sidebarList : null,
      'conversations-list overflow',
    );
    pickScrollContainer(findScrollableParent(sidebarList), 'conversations-list scroll-parent');
    const navigation = document.querySelector('[role="navigation"]');
    pickScrollContainer(
      hasOverflow(navigation) ? navigation : null,
      'navigation overflow',
    );
    pickScrollContainer(findScrollableParent(navigation), 'navigation scroll-parent');
    pickScrollContainer(
      findScrollableParent(document.querySelector('[data-test-id="conversation"]')),
      'conversation scroll-parent',
    );
    if (!scrollContainer) {
      return {
        loaded: false,
        scroller: null,
        detail: {
          reason: 'no-scroll-container',
          actionability: describeDomActionability({
            name: 'sidebar scroller',
            count: 0,
            attached: false,
            visible: false,
            stable: true,
            enabled: true,
            receivingEvents: false,
            routeMatches: true,
          }),
          beforeVisible: before,
          beforeKnown,
          beforeTail,
          afterVisible: before,
          afterKnown: beforeKnown,
          afterTail: beforeTail,
          scrollBefore: describeScrollContainer(null),
          scrollAfter: describeScrollContainer(null),
        },
      };
    }

    const growthPromise = waitForSidebarConversationGrowth(
      before,
      loadOptions.growthTimeoutMs,
      beforeKnown,
    );
    const scrollBefore = describeScrollContainer(scrollContainer, scrollContainerMatchedBy);
    const scrollerActionability = describeDomActionability({
      name: 'sidebar scroller',
      count: 1,
      attached: scrollContainer.isConnected !== false,
      visible: !!visibleRect(scrollContainer) || hasOverflow(scrollContainer),
      stable: true,
      enabled: true,
      receivingEvents: true,
      routeMatches: true,
      details: {
        matchedBy: scrollContainerMatchedBy,
        hasOverflow: hasOverflow(scrollContainer),
      },
    });
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
    const afterKnown = collectBridgeConversationLinks().length;
    const afterTail = conversationTailSignature();
    const afterVisible = getConversationElementsForCurrentPage().length;
    const grew =
      loaded ||
      afterVisible > before ||
      afterKnown > beforeKnown;
    return {
      loaded: grew,
      scroller: scrollContainer,
      detail: {
        reason: grew ? 'growth' : 'no-growth',
        beforeVisible: before,
        beforeKnown,
        beforeTail,
        afterVisible,
        afterKnown,
        afterTail,
        growthObserved: loaded,
        actionability: scrollerActionability,
        scrollBefore,
        scrollAfter: describeScrollContainer(scrollContainer, scrollContainerMatchedBy),
      },
    };
  };

  const loadMoreConversations = async (attempts = 2, options = {}) => {
    const loadOptions = resolveLoadMoreOptions(options);
    const ignoreFailureCap = loadOptions.ignoreFailureCap === true;
    const endFailureThreshold = Math.max(
      3,
      Math.min(20, Number(loadOptions.endFailureThreshold || 3)),
    );
    if (state.isLoadingMore || (!ignoreFailureCap && state.loadMoreFailures >= endFailureThreshold)) {
      state.lastLoadMoreTrace = [
        {
          phase: 'skipped',
          reason: state.isLoadingMore ? 'already-loading' : 'too-many-failures',
          loadMoreFailures: state.loadMoreFailures,
          endFailureThreshold,
          ignoreFailureCap,
          reachedSidebarEnd: state.reachedSidebarEnd,
        },
      ];
      return false;
    }
    state.isLoadingMore = true;
    state.listLoadStatus = 'loading';
    updateModalState();
    const trace = [];
    try {
      let loaded = false;
      let scroller = null;
      for (let i = 0; i < attempts; i++) {
        const result = await triggerSidebarLoading(loadOptions);
        loaded = result.loaded;
        scroller = result.scroller || scroller;
        trace.push({
          phase: 'attempt',
          attempt: i + 1,
          loaded,
          ...(result.detail || {}),
        });
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
      let scrolledToBottom = isAtBottom(scroller) || traceConfirmsStableBottom(trace);
      if (
        !loaded &&
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
        trace.push({
          phase: 'confirm-end',
          attempt: attempts + 1,
          loaded,
          ...(confirmation.detail || {}),
        });
        if (loaded) {
          state.loadMoreFailures = 0;
        }
        scrolledToBottom = isAtBottom(scroller) || traceConfirmsStableBottom(trace);
      }
      const confirmedStableTail = !loaded && traceConfirmsStableTail(trace);
      const confirmedStableBottom =
        !loaded &&
        scrolledToBottom &&
        trace.some(
          (entry) =>
            entry.phase === 'confirm-end' &&
            entry.loaded !== true &&
            Number(entry.beforeKnown) === Number(entry.afterKnown) &&
            scrollInfoIsNearBottom(entry.scrollAfter),
        );
      const requiredEndFailures =
        confirmedStableBottom || confirmedStableTail ? 1 : endFailureThreshold;
      state.reachedSidebarEnd =
        !loaded &&
        state.loadMoreFailures >= requiredEndFailures &&
        (scrolledToBottom || confirmedStableTail);
      if (loaded) {
        state.reachedSidebarEnd = false;
      }
      state.listLoadStatus = loaded
        ? 'loaded'
        : state.reachedSidebarEnd
          ? 'end-confirmed'
          : 'inconclusive';
      refreshConversationState();
      updateModalState();
      state.lastLoadMoreTrace = trace;
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

  const summarizeSidebarCandidateElement = (el, index) => {
    const rect = visibleRect(el);
    const attrs = {};
    for (const name of [
      'data-test-id',
      'data-conversation-id',
      'data-chat-id',
      'aria-label',
      'href',
      'jslog',
      'class',
      'role',
    ]) {
      const value = el.getAttribute?.(name);
      if (value) attrs[name] = String(value).slice(0, 240);
    }
    const anchor = el.matches?.('a[href]') ? el : el.querySelector?.('a[href]');
    if (anchor?.getAttribute?.('href')) {
      attrs.anchorHref = String(anchor.getAttribute('href')).slice(0, 240);
    }
    return {
      index,
      tag: el.tagName?.toLowerCase() || null,
      visible: !!rect,
      rect: rect
        ? {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
      chatId: getChatIdFromSidebarElement(el),
      text: normalizeWhitespace(el.textContent || '').slice(0, 160),
      attrs,
    };
  };

  const sidebarDiagnostics = () => {
    const candidates = getSidebarConversationElements();
    const extractable = candidates.filter((el) => !!getChatIdFromSidebarElement(el));
    const roots = Array.from(document.querySelectorAll(SIDEBAR_SCROLL_ROOT_SELECTOR));
    const scroller = findSidebarHistoryScroller();
    const menuButtons = Array.from(
      document.querySelectorAll(
        [
          '[data-test-id="side-nav-menu-button"]',
          'button[aria-label*="menu" i]',
          'button[aria-label*="navigation" i]',
          'button[aria-label*="navegação" i]',
        ].join(','),
      ),
    )
      .slice(0, 12)
      .map((button, index) => summarizeDiagnosticElement(button, `sidebar-menu-button-${index + 1}`));
    return {
      sidebarOpen: isSidebarOpen(),
      candidateConversationItemCount: candidates.length,
      extractableConversationItemCount: extractable.length,
      scrollRootCount: roots.length,
      scrollRoots: roots.slice(0, 12).map((root, index) => ({
        index,
        tag: root.tagName?.toLowerCase() || null,
        visible: !!visibleRect(root),
        childConversationItemCount: sidebarConversationItemsWithin(root).length,
        childExtractableConversationItemCount: sidebarConversationItemsWithin(root).filter(
          (el) => !!getChatIdFromSidebarElement(el),
        ).length,
        hasOverflow: hasOverflow(root),
      })),
      scroller: scroller.scroller
        ? {
            matchedBy: scroller.matchedBy,
            ...describeScrollContainer(scroller.scroller, scroller.matchedBy),
          }
        : { found: false },
      samples: candidates.slice(0, 16).map(summarizeSidebarCandidateElement),
      extractableSamples: extractable.slice(0, 8).map(summarizeSidebarCandidateElement),
      menuButtons,
    };
  };

  const debugSnapshot = ({ includeDomDiagnostics = true } = {}) => {
    const {
      modalConversations,
      bridgeConversations,
    } = collectConversationLinkSnapshot();

    return {
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
      turnCount: conversationDomTurnCount(document),
      selectorCounts: {
        'user-query': countNodes('user-query'),
        'model-response': countNodes('model-response'),
        'project-chat-row': countNodes('project-chat-row'),
      },
      customTags: includeDomDiagnostics ? listCustomTags() : [],
      sidebarDiagnostics: includeDomDiagnostics ? sidebarDiagnostics() : null,
      buttonPresent: !!document.getElementById(BUTTON_ID),
      modalPresent: !!document.getElementById(MODAL_ID),
      menuPresent: !!document.getElementById(MENU_ID),
      tabIgnored: isTabIgnored(),
      tabClaim: tabClaimSummary(),
      legacyUiNodes: includeDomDiagnostics ? listLegacyUiNodes() : [],
      sidebarOpen: isSidebarOpen(),
      directoryPickerSupported: supportsDirectoryPicker(),
      listedConversationCount: modalConversations.length,
      bridgeConversationCount: bridgeConversations.length,
      reachedSidebarEnd: state.reachedSidebarEnd,
      isLoadingMore: state.isLoadingMore,
      loadMoreFailures: state.loadMoreFailures,
      lastLoadMoreTrace: state.lastLoadMoreTrace,
      domScheduler: {
        scheduled: state.domScheduler.scheduled,
        pending: Array.from(state.domScheduler.pending),
        runs: state.domScheduler.runs,
        skipped: state.domScheduler.skipped,
        lastRunAt: state.domScheduler.lastRunAt || null,
        recentReasons: state.domScheduler.reasons.slice(-8),
      },
      activeTabOperation: activeTabOperationSummary(),
      tabOperationCounts: {
        completed: state.completedTabOperations,
        rejected: state.rejectedTabOperations,
      },
      modalVirtual: {
        active: state.modalVirtual.active,
        renderedStart: state.modalVirtual.renderedStart,
        renderedEnd: state.modalVirtual.renderedEnd,
        total: state.modalVirtual.lastTotal,
      },
      batchExportSession: loadBatchExportSession(),
    };
  };

  let contentScriptMessageListenerInstalled = false;

  const contentScriptRuntimeStatus = () => ({
    ok: true,
    contentScript: true,
    version: SCRIPT_VERSION,
    extensionVersion: SCRIPT_VERSION,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    buildStamp: BUILD_STAMP,
    url: location.href,
    pathname: location.pathname,
    chatId: extractChatId(location.pathname),
    notebookId: currentNotebookId(),
    title: document.title || '',
    bridge: {
      started: bridgeState.started,
      clientId: bridgeState.clientId || null,
      tabId: bridgeState.tabId ?? null,
      windowId: bridgeState.windowId ?? null,
      isActiveTab: bridgeState.isActiveTab ?? null,
      lastHeartbeatAt: bridgeState.lastHeartbeatAt || null,
      eventsConnected: bridgeState.eventsConnected,
      polling: bridgeState.polling,
      lastError: bridgeState.lastError || null,
    },
    tabIgnored: isTabIgnored(),
    tabClaim: tabClaimSummary(),
    activeTabOperation: activeTabOperationSummary(),
    runtimeGuard: (() => {
      try {
        const runtime = pageWindow[RUNTIME_GUARD_KEY] || null;
        return runtime
          ? {
              version: runtime.version || null,
              protocolVersion: runtime.protocolVersion ?? null,
              buildStamp: runtime.buildStamp || null,
              installedAt: runtime.installedAt || null,
              supersededAt: runtime.supersededAt || null,
              supersededBy: runtime.supersededBy || null,
            }
          : null;
      } catch {
        return null;
      }
    })(),
  });

  const installContentScriptMessageListener = () => {
    if (
      contentScriptMessageListenerInstalled ||
      typeof chrome === 'undefined' ||
      !chrome.runtime?.onMessage?.addListener
    ) {
      return;
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'gemini-md-export/content-ping') return false;
      sendResponse(contentScriptRuntimeStatus());
      return false;
    });
    contentScriptMessageListenerInstalled = true;
  };

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

  const ARTIFACT_IFRAME_SELECTOR = 'iframe';
  const ARTIFACT_LAUNCHER_SELECTOR = [
    'model-response button',
    'model-response [role="button"]',
    'model-response a[href]',
    'model-response a[role="button"]',
    '[data-test-id*="artifact" i]',
    '[data-test-id*="immersive" i]',
    '[aria-label*="artifact" i]',
    '[aria-label*="artefato" i]',
    '[aria-label*="interactive" i]',
    '[aria-label*="interativo" i]',
  ].join(',');
  const ARTIFACT_LAUNCHER_STRONG_RE =
    /(artifact|artefato|immersive|gemini-code|usercontent\.goog|scf\.usercontent|interactive|interativo)/i;
  const ARTIFACT_LAUNCHER_WEAK_RE =
    /(preview|prévia|previsuali|visualizar|abrir|open|launch|run|executar|app|aplicativo|canvas|code|c[oó]digo)/i;
  const ARTIFACT_LAUNCHER_NEGATIVE_RE =
    /(gemini-md-export|exportar markdown|share|compartilhar|more options|open menu|menu|fechar|close|copy|copiar|editar|edit|like|dislike|regenerar|retry|ouvir|listen|download)/i;

  const frameSandboxTokens = (el) => {
    try {
      if (el?.sandbox && typeof el.sandbox[Symbol.iterator] === 'function') {
        return Array.from(el.sandbox);
      }
    } catch {
      // Fallback para browsers/jsdom sem DOMTokenList iterável.
    }
    return String(el?.getAttribute?.('sandbox') || '')
      .split(/\s+/)
      .filter(Boolean);
  };

  const frameAllowTokens = (el) =>
    String(el?.getAttribute?.('allow') || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);

  const classifyArtifactFrameSource = (el) => {
    const src = String(el?.getAttribute?.('src') || el?.src || '').trim();
    const srcdoc = String(el?.getAttribute?.('srcdoc') || '');
    if (srcdoc) return { srcKind: 'srcdoc', host: null, pathname: null };
    if (!src) return { srcKind: 'empty', host: null, pathname: null };
    if (/^data:text\/html/i.test(src)) return { srcKind: 'data_html', host: null, pathname: null };
    if (/^data:/i.test(src)) return { srcKind: 'data', host: null, pathname: null };
    if (/^blob:/i.test(src)) return { srcKind: 'blob', host: null, pathname: null };
    try {
      const url = new URL(src, location.href);
      const host = url.hostname;
      const pathname = url.pathname;
      if (/(?:^|\.)usercontent\.goog$/i.test(host)) {
        return { srcKind: 'remote_usercontent_goog', host, pathname };
      }
      if (/(?:^|\.)googleusercontent\.com$/i.test(host)) {
        return { srcKind: 'remote_googleusercontent_com', host, pathname };
      }
      return { srcKind: url.origin === location.origin ? 'remote_same_origin' : 'remote_cross_origin', host, pathname };
    } catch {
      return { srcKind: 'unparseable', host: null, pathname: null };
    }
  };

  const artifactKindForFrame = (el, sourceInfo) => {
    const src = String(el?.getAttribute?.('src') || el?.src || '');
    if (/\/gemini-code-immersive\//i.test(sourceInfo?.pathname || '') || /gemini-code-immersive/i.test(src)) {
      return 'gemini_code_immersive';
    }
    if (/usercontent\.goog/i.test(src)) return 'usercontent_frame';
    return 'iframe';
  };

  const isArtifactFrameCandidate = (el) => {
    const sourceInfo = classifyArtifactFrameSource(el);
    const kind = artifactKindForFrame(el, sourceInfo);
    if (kind !== 'iframe') return true;
    if (visibleRect(el)) return true;
    return sourceInfo.srcKind === 'srcdoc' || sourceInfo.srcKind === 'data_html' || sourceInfo.srcKind === 'blob';
  };

  const artifactFrameElements = () =>
    Array.from(document.querySelectorAll(ARTIFACT_IFRAME_SELECTOR)).filter(isArtifactFrameCandidate);

  const elementArtifactText = (el) =>
    [
      el?.getAttribute?.('data-test-id'),
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('href'),
      el?.getAttribute?.('class'),
      el?.id,
      normalizeWhitespace(el?.textContent || '').slice(0, 240),
    ]
      .filter(Boolean)
      .join(' ');

  const normalizeArtifactLauncherElement = (el) =>
    el?.closest?.('button,[role="button"],a[href],a[role="button"]') || el;

  const scoreArtifactLauncher = (el) => {
    if (!el || el.id === BUTTON_ID || el.closest?.(`#${MODAL_ID},#${MENU_ID},#${BUTTON_SLOT_ID}`)) {
      return { score: -100, signals: [] };
    }
    const turn = el.closest?.('model-response');
    const text = elementArtifactText(el);
    const signals = [];
    let score = turn ? 2 : 0;
    if (visibleRect(el)) score += 1;
    if (ARTIFACT_LAUNCHER_STRONG_RE.test(text)) {
      score += 5;
      signals.push('strong-text');
    }
    if (ARTIFACT_LAUNCHER_WEAK_RE.test(text)) {
      score += 2;
      signals.push('open-preview-text');
    }
    if (el.querySelector?.('iframe,canvas,img,svg')) {
      score += 1;
      signals.push('rich-control');
    }
    if (ARTIFACT_LAUNCHER_NEGATIVE_RE.test(text)) {
      score -= 7;
      signals.push('negative-ui-control');
    }
    return { score, signals };
  };

  const inspectArtifactLauncherElement = (el, { includeHtml = false } = {}) => {
    const rect = visibleRect(el);
    const turnNodes = Array.from(document.querySelectorAll('user-query, model-response'));
    const turn = el.closest?.('user-query, model-response');
    const { score, signals } = scoreArtifactLauncher(el);
    return {
      id: '',
      kind: 'artifact_launcher',
      tag: el.tagName?.toLowerCase() || null,
      role: turn ? roleOf(turn) : null,
      inTurn: !!turn,
      turnIndex: turn ? turnNodes.indexOf(turn) + 1 : null,
      score,
      signals,
      text: normalizeWhitespace(el.textContent || '').slice(0, 240),
      ariaLabel: el.getAttribute?.('aria-label') || '',
      title: el.getAttribute?.('title') || '',
      dataTestId: el.getAttribute?.('data-test-id') || '',
      href: el.getAttribute?.('href') || '',
      visible: !!rect,
      rect: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
      outerHTML: includeHtml ? compactOuterHtml(el) : '',
    };
  };

  const findArtifactLaunchers = ({ includeHtml = false } = {}) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll(ARTIFACT_LAUNCHER_SELECTOR))
      .map(normalizeArtifactLauncherElement)
      .filter((el) => {
        if (!el || seen.has(el)) return false;
        seen.add(el);
        const { score } = scoreArtifactLauncher(el);
        return score >= 4;
      })
      .sort((a, b) => {
        const scoreDelta = scoreArtifactLauncher(b).score - scoreArtifactLauncher(a).score;
        if (scoreDelta) return scoreDelta;
        const aRect = visibleRect(a);
        const bRect = visibleRect(b);
        const distanceDelta = viewportDistanceForRect(aRect) - viewportDistanceForRect(bRect);
        if (distanceDelta) return distanceDelta;
        return (aRect?.top ?? Number.POSITIVE_INFINITY) - (bRect?.top ?? Number.POSITIVE_INFINITY);
      })
      .map((el, index) => ({
        ...inspectArtifactLauncherElement(el, { includeHtml }),
        id: `artifact-launcher-${String(index + 1).padStart(3, '0')}`,
        element: el,
      }));
  };

  const summarizeArtifactLauncher = (launcher) => {
    const { element: _element, outerHTML: _outerHTML, ...summary } = launcher || {};
    return summary;
  };

  const closeOpenedArtifactSurface = async (previousActiveElement) => {
    const closeButton = Array.from(
      document.querySelectorAll(
        [
          'button[aria-label*="Close" i]',
          'button[aria-label*="Fechar" i]',
          'button[aria-label*="Dismiss" i]',
          'button[data-test-id*="close" i]',
          '[role="button"][aria-label*="Close" i]',
          '[role="button"][aria-label*="Fechar" i]',
          '[mat-dialog-close]',
        ].join(','),
      ),
    ).find((el) => visibleRect(el) && !el.closest?.(`#${MODAL_ID},#${MENU_ID}`));

    if (closeButton) {
      closeButton.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await sleep(160);
    try {
      previousActiveElement?.focus?.({ preventScroll: true });
    } catch {
      // Melhor esforço para devolver o foco sem interferir no diagnóstico.
    }
  };

  const openArtifactLaunchersForDiagnosis = async (launchers, options = {}) => {
    const maxOpen = Math.max(0, Math.min(3, Number(options.maxOpenArtifactLaunchers ?? 3)));
    const waitMs = Math.max(800, Math.min(15000, Number(options.artifactOpenWaitMs || 6000)));
    const beforeFrames = artifactFrameElements();
    const beforeSet = new Set(beforeFrames);
    const beforeInterestingCount = beforeFrames.filter((frame) => {
      const sourceInfo = classifyArtifactFrameSource(frame);
      return artifactKindForFrame(frame, sourceInfo) !== 'iframe';
    }).length;
    const previousActiveElement = document.activeElement;
    const clicked = [];
    let closed = null;

    for (const launcher of launchers.slice(0, maxOpen)) {
      const el = launcher.element;
      const actionability = describeDomActionability({
        name: 'botão de artefato',
        count: el ? 1 : 0,
        attached: !!el?.isConnected,
        visible: !!(el && visibleRect(el)),
        stable: true,
        enabled: !el?.disabled && el?.getAttribute?.('aria-disabled') !== 'true',
        receivingEvents: true,
        routeMatches: true,
      });
      if (!actionability.ok) {
        clicked.push({
          ...summarizeArtifactLauncher(launcher),
          ok: false,
          error: actionability.code || 'not_actionable',
          actionability,
        });
        continue;
      }
      const beforeCount = artifactFrameElements().length;
      try {
        try {
          el.scrollIntoView?.({ block: 'center', inline: 'center' });
        } catch {
          // Scroll é só conforto visual.
        }
        el.click();
        const observedFrames = await waitForCondition(() => {
          const frames = artifactFrameElements();
          const opened = frames.filter((frame) => !beforeSet.has(frame));
          if (opened.length > 0) return frames;
          const interesting = frames.filter((frame) => {
            const sourceInfo = classifyArtifactFrameSource(frame);
            return artifactKindForFrame(frame, sourceInfo) !== 'iframe';
          });
          return interesting.length > beforeInterestingCount ? frames : null;
        }, waitMs);
        await sleep(250);
        const framesAfterClick = artifactFrameElements();
        const openedForClick = framesAfterClick.filter((frame) => !beforeSet.has(frame)).length;
        const interestingAfterClick = framesAfterClick.filter((frame) => {
          const sourceInfo = classifyArtifactFrameSource(frame);
          return artifactKindForFrame(frame, sourceInfo) !== 'iframe';
        }).length;
        const opened = !!observedFrames || openedForClick > 0 || interestingAfterClick > beforeInterestingCount;
        clicked.push({
          ...summarizeArtifactLauncher(launcher),
          ok: opened,
          beforeFrameCount: beforeCount,
          afterFrameCount: framesAfterClick.length,
          openedFrameCount: openedForClick,
          actionability,
          ...(opened ? {} : { error: 'no_artifact_frame_after_click' }),
        });
        if (opened) break;
      } catch (err) {
        clicked.push({
          ...summarizeArtifactLauncher(launcher),
          ok: false,
          beforeFrameCount: beforeCount,
          afterFrameCount: artifactFrameElements().length,
          error: err?.message || String(err),
        });
      }
    }

    const afterFrames = artifactFrameElements();
    const openedFrameCount = afterFrames.filter((frame) => !beforeSet.has(frame)).length;
    return {
      attempted: launchers.length > 0 && maxOpen > 0,
      clicked,
      beforeFrameCount: beforeFrames.length,
      afterFrameCount: afterFrames.length,
      openedFrameCount,
      close: async () => {
        if (!clicked.some((item) => item.ok) || options.closeOpenedLaunchers === false) return null;
        try {
          await closeOpenedArtifactSurface(previousActiveElement);
          closed = { ok: true };
        } catch (err) {
          closed = { ok: false, error: err?.message || String(err) };
        }
        return closed;
      },
      closed: () => closed,
    };
  };

  const probeParentFrameDocument = (el) => {
    try {
      const doc = el?.contentDocument || el?.contentWindow?.document || null;
      const html = doc?.documentElement?.outerHTML || '';
      return {
        readable: !!html,
        htmlLength: html.length,
        title: doc?.title || '',
        readyState: doc?.readyState || '',
        error: null,
      };
    } catch (err) {
      return {
        readable: false,
        htmlLength: 0,
        title: '',
        readyState: '',
        error: err?.message || String(err),
        errorName: err?.name || null,
      };
    }
  };

  const recommendedProbeForArtifact = (sourceInfo, parentProbe) => {
    if (parentProbe?.readable) return 'parent_dom';
    if (sourceInfo?.srcKind === 'srcdoc' || sourceInfo?.srcKind === 'data_html') return 'inline_html';
    if (
      sourceInfo?.srcKind === 'remote_usercontent_goog' ||
      sourceInfo?.srcKind === 'remote_googleusercontent_com'
    ) {
      return 'chrome_scripting_frame';
    }
    if (sourceInfo?.srcKind === 'blob') return 'live_blob_fetch';
    return 'fallback';
  };

  const artifactExportRecommendation = (item) => {
    if (item.htmlExtractable) return 'html_asset';
    if (item.recommendedProbe === 'chrome_scripting_frame') return 'reload_extension_or_frame_probe';
    if (item.recommendedProbe === 'live_blob_fetch') return 'try_blob_fetch';
    return 'fallback_warning';
  };

  const inspectArtifactElement = (el, { includeHtml = false } = {}) => {
    const rect = visibleRect(el);
    const turnNodes = Array.from(document.querySelectorAll('user-query, model-response'));
    const turn = el.closest?.('user-query, model-response');
    const source = String(el.getAttribute?.('src') || el.src || '');
    const srcdoc = String(el.getAttribute?.('srcdoc') || '');
    const sourceInfo = classifyArtifactFrameSource(el);
    const parentProbe = probeParentFrameDocument(el);
    const recommendedProbe = recommendedProbeForArtifact(sourceInfo, parentProbe);
    const item = {
      id: '',
      kind: artifactKindForFrame(el, sourceInfo),
      tag: el.tagName?.toLowerCase() || 'iframe',
      role: turn ? roleOf(turn) : null,
      inTurn: !!turn,
      turnIndex: turn ? turnNodes.indexOf(turn) + 1 : null,
      source,
      srcKind: sourceInfo.srcKind,
      host: sourceInfo.host,
      pathname: sourceInfo.pathname,
      hasSrcdoc: !!srcdoc,
      srcdocLength: srcdoc.length,
      allow: el.getAttribute?.('allow') || '',
      allowTokens: frameAllowTokens(el),
      sandbox: el.getAttribute?.('sandbox') || '',
      sandboxTokens: frameSandboxTokens(el),
      visible: !!rect,
      rect: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
      title: el.getAttribute?.('title') || '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
      parentDomReadable: parentProbe.readable,
      parentDomProbe: parentProbe,
      recommendedProbe,
      extensionFrameProbePossible:
        recommendedProbe === 'chrome_scripting_frame' || sourceInfo.srcKind === 'remote_same_origin',
      frameProbe: null,
      htmlExtractable:
        parentProbe.readable ||
        sourceInfo.srcKind === 'srcdoc' ||
        sourceInfo.srcKind === 'data_html',
      extractionMethod: parentProbe.readable
        ? 'parent_dom'
        : sourceInfo.srcKind === 'srcdoc'
          ? 'srcdoc'
          : sourceInfo.srcKind === 'data_html'
            ? 'data_html'
            : null,
      outerHTML: includeHtml ? compactOuterHtml(el) : '',
    };
    item.recommendedExport = artifactExportRecommendation(item);
    return item;
  };

  const summarizeArtifactItems = (items) => {
    const byKind = {};
    const bySourceKind = {};
    let htmlExtractable = 0;
    let frameProbeReadable = 0;
    let parentDomReadable = 0;
    let opaque = 0;
    items.forEach((item) => {
      byKind[item.kind || 'unknown'] = (byKind[item.kind || 'unknown'] || 0) + 1;
      bySourceKind[item.srcKind || 'unknown'] = (bySourceKind[item.srcKind || 'unknown'] || 0) + 1;
      if (item.htmlExtractable) htmlExtractable += 1;
      if (item.frameProbe?.htmlReadable) frameProbeReadable += 1;
      if (item.parentDomReadable) parentDomReadable += 1;
      if (!item.htmlExtractable) opaque += 1;
    });
    return {
      total: items.length,
      htmlExtractable,
      frameProbeReadable,
      parentDomReadable,
      opaque,
      byKind,
      bySourceKind,
    };
  };

  const mergeFrameProbeResults = (items, frameProbeResult) => {
    if (!frameProbeResult?.ok || !Array.isArray(frameProbeResult.frames)) return items;
    const byUrl = new Map();
    frameProbeResult.frames.forEach((frame) => {
      if (!frame?.url) return;
      const list = byUrl.get(frame.url) || [];
      list.push(frame);
      byUrl.set(frame.url, list);
    });

    return items.map((item) => {
      const candidates = byUrl.get(item.source) || [];
      const frame = candidates.shift() || null;
      if (candidates.length === 0) byUrl.delete(item.source);
      const next = { ...item, frameProbe: frame };
      if (frame?.htmlReadable) {
        next.htmlExtractable = true;
        next.extractionMethod = 'chrome_scripting_frame';
      }
      next.recommendedExport = artifactExportRecommendation(next);
      return next;
    });
  };

  const inspectArtifactDom = async (options = {}) => {
    const initialLaunchers = findArtifactLaunchers({
      includeHtml: options.includeHtml === true,
    });
    let launcherOpenResult = null;
    if (options.openArtifactLaunchers !== false && initialLaunchers.length > 0) {
      launcherOpenResult = await openArtifactLaunchersForDiagnosis(initialLaunchers, options);
    }

    const allFrames = artifactFrameElements();
    const includeHtml = options.includeHtml === true && allFrames.length <= 30;
    let items = allFrames.map((el, index) => ({
      ...inspectArtifactElement(el, { includeHtml }),
      id: `artifact-${String(index + 1).padStart(3, '0')}`,
    }));
    let frameProbeResult = null;
    if (options.includeFrameProbe !== false && isExtensionContext) {
      try {
        frameProbeResult = await extensionSendMessage(
          {
            type: 'gemini-md-export/probe-artifact-frames',
            includeHtmlSample: options.includeHtmlSample === true,
            maxSampleLength: options.maxSampleLength || 1200,
            maxListItems: options.maxListItems || 25,
          },
          { timeoutMs: 12000 },
        );
        items = mergeFrameProbeResults(items, frameProbeResult);
      } catch (err) {
        frameProbeResult = {
          ok: false,
          reason: err?.message || String(err),
          frames: [],
        };
      }
    }

    const launchers = initialLaunchers.map(summarizeArtifactLauncher);
    const summary = summarizeArtifactItems(items);
    summary.launcherCount = launchers.length;
    summary.clickedLauncherCount = launcherOpenResult?.clicked?.filter((item) => item.ok).length || 0;
    summary.openedFrameCount = launcherOpenResult?.openedFrameCount || 0;

    const payload = {
      ok: true,
      url: location.href,
      chatId: currentChatId(),
      title: scrapeTitle(),
      buildStamp: BUILD_STAMP,
      selector: ARTIFACT_IFRAME_SELECTOR,
      frameProbe: frameProbeResult
        ? {
            ok: frameProbeResult.ok === true,
            reason: frameProbeResult.reason || null,
            tabId: frameProbeResult.tabId ?? null,
            frameCount: frameProbeResult.frameCount ?? frameProbeResult.frames?.length ?? 0,
          }
        : {
            ok: false,
            reason: isExtensionContext ? 'not-requested' : 'extension-context-unavailable',
            tabId: null,
            frameCount: 0,
          },
      launcherOpen: launcherOpenResult
        ? {
            attempted: launcherOpenResult.attempted,
            clicked: launcherOpenResult.clicked,
            beforeFrameCount: launcherOpenResult.beforeFrameCount,
            afterFrameCount: launcherOpenResult.afterFrameCount,
            openedFrameCount: launcherOpenResult.openedFrameCount,
          }
        : null,
      summary,
      launchers,
      items,
      nextAction:
        items.some((item) => item.htmlExtractable)
          ? {
              code: 'implement_html_asset_export',
              message: 'Há artefato com HTML legível; próxima etapa é salvar HTML como asset e embedar no Obsidian.',
            }
          : items.some((item) => item.recommendedProbe === 'chrome_scripting_frame')
            ? {
                code: 'frame_probe_unavailable_or_blocked',
                message:
                  'Há iframe em usercontent.goog, mas o probe de frame não leu HTML. Recarregue a extensão se a permissão nova ainda não estiver ativa.',
              }
            : {
                code: 'fallback_only',
                message: launchers.length
                  ? 'Há botão candidato de artefato, mas nenhum iframe/HTML legível foi confirmado após a tentativa de abrir.'
                  : 'Nenhum artefato HTML legível foi confirmado; manter fallback com aviso/link/screenshot.',
              },
    };
    if (launcherOpenResult) {
      payload.launcherOpen.close = await launcherOpenResult.close();
    }
    return payload;
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

  const getOrCreateChatClientId = () =>
    getOrCreateBridgeClientId({
      storage: pageWindow.sessionStorage,
      storageKey: CHAT_CLIENT_ID_STORAGE_KEY,
      prefix: 'chat',
      randomId,
    });

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

  const extensionSendMessageWithRetry = async (
    message,
    { timeoutMs = 2500, attempts = 2, retryDelayMs = 180 } = {},
  ) => {
    let lastError = null;
    const totalAttempts = Math.max(1, Math.min(4, Number(attempts) || 1));
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await extensionSendMessage(message, { timeoutMs });
        return { ok: true, response, attempts: attempt };
      } catch (err) {
        lastError = err;
        if (attempt < totalAttempts) {
          await sleep(retryDelayMs * attempt);
        }
      }
    }
    const error = new Error(
      `${lastError?.message || 'Não consegui falar com a extensão.'} ` +
        `Tentei ${totalAttempts} vez(es).`,
    );
    error.cause = lastError;
    error.attempts = totalAttempts;
    throw error;
  };

  const tabClaimSummary = () => {
    if (!state.tabClaim) return null;
    return {
      claimId: state.tabClaim.claimId,
      sessionId: state.tabClaim.sessionId || null,
      label: state.tabClaim.label || null,
      color: state.tabClaim.color || null,
      visual: state.tabClaim.visual || null,
      claimedAt: state.tabClaim.claimedAt || null,
      expiresAt: state.tabClaim.expiresAt || null,
    };
  };

  const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const stripTabClaimTitlePrefix = (title, label = '') => {
    let text = String(title || '');
    const cleanLabel = String(label || '').replace(/[\[\]]/g, '').trim();
    if (cleanLabel) {
      const dynamicRe = new RegExp(`^\\[${escapeRegExp(cleanLabel)}\\]\\s+`, 'u');
      text = text.replace(dynamicRe, '');
    }
    return text.replace(TAB_CLAIM_TITLE_PREFIX_RE, '').replace(LEGACY_TAB_CLAIM_TITLE_PREFIX_RE, '');
  };

  const restoreTabClaimTitleFallback = (claim = state.tabClaim) => {
    if (!state.tabClaimOriginalTitle) {
      const restored = stripTabClaimTitlePrefix(document.title, claim?.label || '');
      if (restored !== String(document.title || '')) {
        document.title = restored;
      }
      return;
    }
    if (document.title === state.tabClaimOriginalTitle) {
      state.tabClaimOriginalTitle = '';
      return;
    }
    if (stripTabClaimTitlePrefix(document.title, claim?.label || '') !== String(document.title || '')) {
      document.title = state.tabClaimOriginalTitle;
    }
    state.tabClaimOriginalTitle = '';
  };

  const applyTabClaimTitleFallback = (claim) => {
    const label =
      String(claim?.label || TAB_CLAIM_DEFAULT_LABEL).replace(/[\[\]]/g, '').trim() ||
      TAB_CLAIM_DEFAULT_LABEL;
    const current = String(document.title || '');
    const baseTitle = stripTabClaimTitlePrefix(current, label) || current || 'Gemini';
    if (!state.tabClaimOriginalTitle) {
      state.tabClaimOriginalTitle = baseTitle;
    }
    document.title = `[${label}] ${baseTitle}`;
  };

  const clearTabClaimExpiryTimer = () => {
    if (!state.tabClaimExpiryTimer) return;
    clearTimeout(state.tabClaimExpiryTimer);
    state.tabClaimExpiryTimer = 0;
  };

  const clearLocalTabClaim = () => {
    clearTabClaimExpiryTimer();
    restoreTabClaimTitleFallback();
    state.tabClaim = null;
    markBridgeSnapshotDirty('tab-claim-cleared');
  };

  const releaseTabClaimViaExtension = async ({ claimId, reason } = {}) =>
    extensionSendMessage(
      {
        type: 'gemini-md-export/release-tab-claim',
        claimId: claimId || state.tabClaim?.claimId || null,
        reason: reason || 'content-script',
      },
      { timeoutMs: 5000 },
    );

  const releaseCurrentTabClaim = async ({ claimId, reason, notifyServiceWorker = true } = {}) => {
    const active = state.tabClaim;
    let response = null;
    if (notifyServiceWorker && (active?.claimId || claimId)) {
      try {
        response = await releaseTabClaimViaExtension({
          claimId: claimId || active?.claimId,
          reason,
        });
      } catch (err) {
        if (!isExtensionContextInvalidatedError(err)) throw err;
        response = {
          ok: false,
          claimId: claimId || active?.claimId || null,
          reason: 'extension-context-invalidated',
          localOnly: true,
        };
      }
    }
    if (!claimId || !active?.claimId || active.claimId === claimId || response?.ok) {
      clearLocalTabClaim();
      reportTabBrokerState('claim-released', { force: true });
    }
    return response || { ok: true, claimId: claimId || active?.claimId || null };
  };

  const scheduleTabClaimExpiry = () => {
    clearTabClaimExpiryTimer();
    const expiresAt = Date.parse(state.tabClaim?.expiresAt || '');
    if (!Number.isFinite(expiresAt)) return;
    const delayMs = Math.max(0, expiresAt - Date.now() + 250);
    state.tabClaimExpiryTimer = setTimeout(() => {
      releaseCurrentTabClaim({ reason: 'claim-expired' }).catch((err) => {
        if (isExtensionContextInvalidatedError(err)) {
          clearLocalTabClaim();
          return;
        }
        warn('Falha ao liberar claim expirada da aba.', err);
        clearLocalTabClaim();
      });
    }, delayMs);
  };

  const rememberTabClaim = (claim, visualResponse) => {
    const visual = visualResponse?.visual || visualResponse || null;
    state.tabClaim = {
      claimId: claim.claimId,
      sessionId: claim.sessionId || null,
      label: claim.label || TAB_CLAIM_DEFAULT_LABEL,
      color: claim.color || 'green',
      expiresAt: claim.expiresAt || null,
      claimedAt: new Date().toISOString(),
      visual,
    };
    if (visual?.mode === 'tab-group') {
      restoreTabClaimTitleFallback();
    } else {
      applyTabClaimTitleFallback(state.tabClaim);
    }
    scheduleTabClaimExpiry();
    markBridgeSnapshotDirty('tab-claim-applied');
    reportTabBrokerState('claim-applied', { force: true });
  };

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

  const nativeBridgeRequest = async (
    path,
    { method = 'GET', payload, timeoutMs = 10000 } = {},
  ) => {
    if (!isExtensionContext || Date.now() < bridgeTransportState.nativeDisabledUntil) {
      return null;
    }

    const response = await extensionSendMessage(
      {
        type: 'gemini-md-export/native-proxy-http',
        bridgeUrl: BRIDGE_BASE_URL,
        path,
        method,
        payload,
        timeoutMs,
      },
      { timeoutMs: Math.max(1500, timeoutMs + 1800) },
    );

    if (!response?.ok) {
      bridgeTransportState.nativeLastError =
        response?.error || response?.code || 'native-proxy-unavailable';
      bridgeTransportState.nativeDisabledUntil =
        Date.now() + NATIVE_BRIDGE_TRANSPORT_COOLDOWN_MS;
      return null;
    }

    bridgeTransportState.active = 'native';
    bridgeTransportState.nativeLastOkAt = Date.now();
    bridgeTransportState.nativeLastError = null;

    if (response.status === 204) return { handled: true, value: null };
    if (response.status && response.status >= 400) {
      throw new Error(`bridge ${response.status}: ${response.text || response.status}`);
    }
    return {
      handled: true,
      value: response.data ?? null,
    };
  };

  const bridgeRequest = async (path, { method = 'GET', payload, timeoutMs = 10000 } = {}) => {
    const nativeResult = await nativeBridgeRequest(path, { method, payload, timeoutMs });
    if (nativeResult?.handled) return nativeResult.value;

    bridgeTransportState.active = 'http';
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
      throw new Error(response?.error || 'Falha ao salvar pela conexão local.');
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

  const stableSnapshotHash = (items) => {
    let hash = 2166136261;
    const text = JSON.stringify(
      (items || []).map((item) => [
        item.chatId || '',
        item.id || '',
        item.title || '',
        item.url || '',
        item.source || '',
      ]),
    );
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  const buildBridgePageSummary = () => ({
    url: location.href,
    pathname: location.pathname,
    title: scrapeTitle(),
    chatId: currentChatId(),
    notebookId: currentNotebookId(),
    kind: isNotebookPage() ? 'notebook' : 'chat',
    model: scrapeModel(),
    turnCount: conversationDomTurnCount(document),
    sidebarOpen: isSidebarOpen(),
    reachedSidebarEnd: state.reachedSidebarEnd,
    isActiveTab: bridgeState.isActiveTab,
    protocolVersion: bridgeState.protocolVersion,
    buildStamp: bridgeState.buildStamp,
    blocker: detectGooglePageBlocker({
      url: location.href,
      title: document.title,
      bodyText: '',
    }),
    topBar: buildTopBarDiagnostics(),
  });

  const buildBridgeHeartbeatPayload = () => ({
    clientId: bridgeState.clientId,
    tabId: bridgeState.tabId,
    windowId: bridgeState.windowId,
    isActiveTab: bridgeState.isActiveTab,
    extensionVersion: bridgeState.extensionVersion,
    protocolVersion: bridgeState.protocolVersion,
    buildStamp: bridgeState.buildStamp,
    tabClaim: tabClaimSummary(),
    capabilities: BRIDGE_PROTOCOL_CAPABILITIES,
    commandPoll: {
      polling: bridgeState.polling,
      eventsConnected: bridgeState.eventsConnected,
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
    snapshotDirty: state.bridgeSnapshotDirty,
    snapshotDirtyReason: state.bridgeSnapshotDirtyReason,
    snapshotHash: state.bridgeSnapshotHash || null,
    metrics: {
      lastHeartbeatDurationMs: bridgeState.lastHeartbeatDurationMs,
      lastError: bridgeState.lastError,
      eventsConnected: bridgeState.eventsConnected,
      extensionPing: {
        lastAttemptAt: bridgeState.lastExtensionPingAt
          ? new Date(bridgeState.lastExtensionPingAt).toISOString()
          : null,
        lastOkAt: bridgeState.lastExtensionPingOkAt
          ? new Date(bridgeState.lastExtensionPingOkAt).toISOString()
          : null,
        lastAttempts: bridgeState.lastExtensionPingAttempts,
        lastError: bridgeState.lastExtensionPingError,
      },
      domScheduler: {
        scheduled: state.domScheduler.scheduled,
        pending: Array.from(state.domScheduler.pending),
        runs: state.domScheduler.runs,
        skipped: state.domScheduler.skipped,
        lastRunAt: state.domScheduler.lastRunAt
          ? new Date(state.domScheduler.lastRunAt).toISOString()
          : null,
        recentReasons: state.domScheduler.reasons.slice(-5),
      },
      tabOperation: {
        active: activeTabOperationSummary(),
        completed: state.completedTabOperations,
        rejected: state.rejectedTabOperations,
      },
    },
    page: {
      ...buildBridgePageSummary(),
      listedConversationCount: state.conversations.length,
      bridgeConversationCount: state.sidebarConversationCache.size,
      sidebarConversationCount: state.sidebarConversationCache.size,
      notebookCacheCount: notebookChatUrlCacheSummary().size,
    },
  });

  const buildBridgeSnapshotPayload = () => {
    const {
      modalConversations,
      bridgeConversations,
      sidebarConversations,
      notebookConversations,
    } = collectConversationLinkSnapshot();
    const snapshotHash = stableSnapshotHash(bridgeConversations);
    return {
      clientId: bridgeState.clientId,
      tabId: bridgeState.tabId,
      windowId: bridgeState.windowId,
      isActiveTab: bridgeState.isActiveTab,
      extensionVersion: bridgeState.extensionVersion,
      protocolVersion: bridgeState.protocolVersion,
    buildStamp: bridgeState.buildStamp,
    tabClaim: tabClaimSummary(),
    capabilities: BRIDGE_PROTOCOL_CAPABILITIES,
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
      snapshotHash,
      staleAfterMs: BRIDGE_CLIENT_STALE_MS,
      page: {
        ...buildBridgePageSummary(),
        listedConversationCount: modalConversations.length,
        bridgeConversationCount: bridgeConversations.length,
        sidebarConversationCount: sidebarConversations.length,
        notebookConversationCount: notebookConversations.length,
        notebookCacheCount: notebookChatUrlCacheSummary().size,
      },
      conversations: bridgeConversations.slice(0, 1000),
      modalConversations: modalConversations.slice(0, 1000),
    };
  };

  // --- ação de baixar ---------------------------------------------------

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
        url.origin !== location.origin &&
        (
          /(?:^|\.)googleusercontent\.com$/i.test(url.hostname) ||
          /(?:^|\.)google\.com$/i.test(url.hostname)
        )
      );
    } catch {
      return false;
    }
  };

  const shouldFetchViaBridgeFirst = (source) => {
    try {
      const url = new URL(source, location.href);
      return (
        isExtensionContext &&
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin !== location.origin &&
        !shouldFetchViaBackgroundFirst(source)
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

  const fetchImageAssetViaBridge = async (source) => {
    const response = await bridgeRequest('/bridge/fetch-asset', {
      method: 'POST',
      payload: { source },
      timeoutMs: 15000,
    });
    if (!response?.ok || !response.contentBase64) {
      throw new Error(response?.error || 'bridge-fetch-failed');
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

    if (shouldFetchViaBridgeFirst(source)) {
      try {
        return await fetchImageAssetViaBridge(source);
      } catch (bridgeErr) {
        try {
          return await fetchFromPage();
        } catch (pageErr) {
          try {
            return await fetchImageAssetViaBackground(source);
          } catch (backgroundErr) {
            throw new Error(
              `bridge: ${bridgeErr?.message || String(bridgeErr)}; page: ${
                pageErr?.message || String(pageErr)
              }; background: ${backgroundErr?.message || String(backgroundErr)}`,
            );
          }
        }
      }
    }

    if (shouldFetchViaBackgroundFirst(source)) {
      try {
        return await fetchImageAssetViaBackground(source);
      } catch (backgroundErr) {
        try {
          return await fetchImageAssetViaBridge(source);
        } catch {
          // O bridge é fallback sem CORS do navegador. Se ele também falhar,
          // mantemos a mensagem combinada background+page abaixo.
        }
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
          return await fetchImageAssetViaBridge(source);
        } catch {
          // Mantém o background como último fallback para instalações sem MCP
          // local ou quando o bridge está temporariamente fora.
        }
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
    const metrics = {
      candidateCount: 0,
      attemptedFetches: 0,
      successfulFetches: 0,
      failedFetches: 0,
      timedOut: false,
      elapsedMs: 0,
      byKind: {},
      byRole: {},
    };
    let exportedTurnIndex = 0;
    const deadlineAt = Date.now() + MEDIA_EXPORT_TOTAL_BUDGET_MS;
    const startedAt = Date.now();
    const scrollPosition = captureMediaScrollPosition();

    try {
      for (const node of nodes) {
        if (Date.now() >= deadlineAt) {
          metrics.timedOut = true;
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
        metrics.candidateCount += candidates.length;
        let mediaIndex = 0;
        for (const candidate of candidates) {
          if (Date.now() >= deadlineAt) {
            metrics.timedOut = true;
            warn('Tempo de importação de mídia esgotado; mantendo placeholders restantes.');
            break;
          }

          mediaIndex += 1;
          let source = candidate.source;
          try {
            let asset = null;
            metrics.attemptedFetches += 1;
            metrics.byKind[candidate.kind] = (metrics.byKind[candidate.kind] || 0) + 1;
            metrics.byRole[role] = (metrics.byRole[role] || 0) + 1;
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
            metrics.successfulFetches += 1;
            turn.text = replaceFirst(turn.text, candidate.placeholder, markdownImage);
          } catch (err) {
            metrics.failedFetches += 1;
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
      metrics.elapsedMs = Date.now() - startedAt;
    }

    return {
      turns: updatedTurns,
      files,
      failures,
      metrics,
    };
  };

  const buildExportPayload = async (doc, url, options = {}) => {
    const startedAt = Date.now();
    const timings = {
      ...(options.metrics?.timings || {}),
    };
    const counters = {
      ...(options.metrics?.counters || {}),
    };
    const chatId = extractChatId(new URL(url).pathname);
    const scrapeStartedAt = Date.now();
    const turns = options.turns || scrapeTurns(doc);
    timings.extractMarkdownMs = Date.now() - scrapeStartedAt;
    counters.turnCount = turns.filter((turn) => turn?.role === 'assistant').length;
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
      dateExported: portableIsoSeconds(new Date()),
      turnCount: counters.turnCount,
      model: scrapeModelFromDocument(doc),
    };

    const fallbackStartedAt = Date.now();
    const fallbackContent = buildDocument({ meta, turns });
    timings.buildFallbackMarkdownMs = Date.now() - fallbackStartedAt;
    if (state.progress && state.exportSource === 'gui') {
      updateExportProgress({ label: 'Baixando mídias da conversa...' });
    }
    const mediaStartedAt = Date.now();
    const media = await collectMediaAssetsForExport(doc, chatId, turns);
    timings.fetchAssetsMs = Date.now() - mediaStartedAt;
    counters.mediaFileCount = media.files.length;
    counters.mediaFailureCount = media.failures.length;
    counters.mediaCandidateCount = media.metrics?.candidateCount || 0;
    const buildStartedAt = Date.now();
    const content = buildDocument({ meta, turns: media.turns });
    timings.buildMarkdownMs = Date.now() - buildStartedAt;
    timings.totalBrowserExportMs = Date.now() - startedAt;

    return {
      chatId,
      turns: media.turns,
      title: meta.title || chatId,
      filename: buildFilename(chatId),
      content,
      fallbackContent,
      mediaFiles: media.files,
      mediaFailures: media.failures,
      hydration: options.hydration || null,
      metrics: {
        version: 1,
        timings,
        counters,
        media: media.metrics || null,
      },
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

  const normalizeExpectedChatId = (item = {}) => {
    const candidates = [
      stripGeminiConversationPrefix(item.chatId || ''),
      extractChatIdFromMaybeUrl(item.url),
      stripGeminiConversationPrefix(item.id || ''),
    ];
    return candidates.find((candidate) => /^[a-f0-9]{12,}$/i.test(candidate || '')) || '';
  };

  const TAB_OPERATION_COMMAND_TYPES = new Set([
    'list-conversations',
    'load-more-conversations',
    'get-current-chat',
    'open-chat',
    'get-chat-by-id',
  ]);

  const tabOperationLabel = (command) => {
    const type = command?.type || 'comando';
    if (type === 'load-more-conversations') return 'carregando histórico';
    if (type === 'list-conversations') return 'listando conversas';
    if (type === 'get-current-chat') return 'exportando conversa atual';
    if (type === 'get-chat-by-id') return 'exportando conversa por ID';
    if (type === 'open-chat') return 'abrindo conversa';
    return type;
  };

  const activeTabOperationSummary = () => {
    const active = state.activeTabOperation;
    if (!active) return null;
    return {
      type: active.type,
      label: active.label,
      commandId: active.commandId || null,
      operationId: active.operationId || null,
      jobId: active.jobId || null,
      targetChatId: active.targetChatId || null,
      phase: active.phase || null,
      startedAt: new Date(active.startedAt).toISOString(),
      elapsedMs: Date.now() - active.startedAt,
      cancelRequestedAt: active.cancelRequestedAt
        ? new Date(active.cancelRequestedAt).toISOString()
        : null,
      cancelReason: active.cancelReason || null,
    };
  };

  const activeTabOperationCancelRequested = () =>
    Boolean(
      state.activeTabOperation?.cancelRequestedAt ||
        state.activeTabOperation?.abortController?.signal?.aborted,
    );

  const throwIfOperationAborted = (signal, message) => {
    if (!signal?.aborted) return;
    const error = new Error(message || 'Operação cancelada.');
    error.code = 'operation_cancelled';
    throw error;
  };

  const maybeReleaseClaimAfterTabOperation = async (command, result, startedAt) => {
    const args = command?.args || {};
    const claimId = args.releaseClaimOnOperationEnd ? String(args.claimId || '').trim() : '';
    if (!claimId) return result;

    const elapsedMs = Date.now() - startedAt;
    const slowOperationMs = Math.max(0, Number(args.releaseClaimOnSlowOperationMs || 0));
    const terminalOnly = args.releaseClaimOnOperationTerminalOnly !== false;
    const terminal =
      result?.reachedEnd === true ||
      result?.timedOut === true ||
      result?.ok === false ||
      (slowOperationMs > 0 && elapsedMs >= slowOperationMs);
    if (terminalOnly && !terminal) return result;

    let tabClaimRelease = null;
    try {
      tabClaimRelease = await releaseCurrentTabClaim({
        claimId,
        reason: args.releaseClaimReason || `${command.type}-operation-end`,
      });
    } catch (err) {
      tabClaimRelease = {
        ok: false,
        claimId,
        error: err?.message || String(err),
        code: err?.code || null,
      };
      if (isExtensionContextInvalidatedError(err)) {
        clearLocalTabClaim();
      }
    }

    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        ...result,
        tabClaimRelease,
      };
    }
    return result;
  };

  const reportTabBrokerState = async (reason = 'heartbeat', { force = false } = {}) => {
    if (!isExtensionContext) return null;
    const now = Date.now();
    if (!force && now - lastTabBrokerReportAt < TAB_BROKER_REPORT_MIN_MS) return null;
    lastTabBrokerReportAt = now;
    try {
      return await extensionSendMessage(
        {
          type: 'gemini-md-export/tab-broker-update',
          reason,
          status: contentScriptRuntimeStatus(),
          tabClaim: tabClaimSummary(),
          activeTabOperation: activeTabOperationSummary(),
        },
        { timeoutMs: 1200 },
      );
    } catch (err) {
      bridgeState.lastExtensionPingError = err?.message || String(err);
      return null;
    }
  };

  const refreshExtensionContextSoon = ({ force = false, reason = 'background' } = {}) => {
    if (!isExtensionContext || extensionContextRefreshInFlight) return;
    extensionContextRefreshInFlight = Promise.resolve()
      .then(() => refreshExtensionContext({ force }))
      .catch((err) => {
        bridgeState.lastExtensionPingAt = Date.now();
        bridgeState.lastExtensionPingError = err?.message || String(err);
        bridgeState.lastError = bridgeState.lastExtensionPingError;
        warn(`Falha ao atualizar contexto da extensão (${reason}).`, err);
      })
      .finally(() => {
        extensionContextRefreshInFlight = null;
      });
  };

  const reportTabBrokerStateSoon = (reason = 'heartbeat', { force = false } = {}) => {
    if (!isExtensionContext || tabBrokerReportInFlight) return;
    tabBrokerReportInFlight = Promise.resolve()
      .then(() => reportTabBrokerState(reason, { force }))
      .catch((err) => {
        bridgeState.lastExtensionPingError = err?.message || String(err);
      })
      .finally(() => {
        tabBrokerReportInFlight = null;
      });
  };

  const runWithTabOperationBackpressure = async (command, fn) => {
    if (!TAB_OPERATION_COMMAND_TYPES.has(command?.type)) {
      return fn();
    }

    if (state.activeTabOperation) {
      state.rejectedTabOperations += 1;
      return {
        ok: false,
        busy: true,
        code: 'tab_operation_in_progress',
        error:
          'Esta aba do Gemini já está ocupada com outro comando pesado. Aguarde terminar antes de enviar outro.',
        activeOperation: activeTabOperationSummary(),
      };
    }

    const abortController = new AbortController();
    const operationId =
      command.args?.operationId ||
      `${command.type}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    state.activeTabOperation = {
      type: command.type,
      label: tabOperationLabel(command),
      commandId: command.id || null,
      operationId,
      jobId: command.args?.jobId || null,
      targetChatId: command.args?.targetChatId || command.args?.chatId || command.args?.item?.chatId || null,
      phase: command.args?.phase || 'queued',
      startedAt: now,
      lastProgressAt: now,
      abortController,
    };
    const operationStartedAt = state.activeTabOperation.startedAt;
    reportTabBrokerState('operation-start', { force: true });

    try {
      const result = await fn({
        operationId,
        abortSignal: abortController.signal,
        setOperationPhase: (phase) => {
          if (state.activeTabOperation?.operationId === operationId) {
            state.activeTabOperation.phase = phase;
            state.activeTabOperation.lastProgressAt = Date.now();
            reportTabBrokerStateSoon('operation-progress', { force: true });
          }
        },
      });
      return await maybeReleaseClaimAfterTabOperation(command, result, operationStartedAt);
    } catch (err) {
      await maybeReleaseClaimAfterTabOperation(
        command,
        {
          ok: false,
          error: err?.message || String(err),
          code: err?.code || null,
        },
        operationStartedAt,
      );
      throw err;
    } finally {
      state.completedTabOperations += 1;
      state.activeTabOperation = null;
      reportTabBrokerState('operation-end', { force: true });
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
        source: item.source === 'sidebar' ? 'sidebar' : 'unknown',
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
        source: item.source === 'sidebar' ? 'sidebar' : 'unknown',
      };
    }

    const current = conversations.find((conversation) => conversation.current);
    if (current) return current;

    throw new Error('Informe index ou chatId para escolher a conversa.');
  };

  const sharedTabCommands = createSharedTabCommandHandlers({
    defaultReason: 'bridge-command',
    defaultClaimLabel: TAB_CLAIM_DEFAULT_LABEL,
    defaultClaimColor: 'green',
    extensionSendMessage,
    getTabId: () => bridgeState.tabId,
    getWindowId: () => bridgeState.windowId,
    getTabClaim: () => state.tabClaim,
    setTabClaim: (claim) => {
      state.tabClaim = claim;
    },
    clearTabClaim: clearLocalTabClaim,
    setIsActiveTab: (value) => {
      bridgeState.isActiveTab = value;
    },
    getExtensionInfo: async () => {
      const localInfo = () => ({
        ok: true,
        version: bridgeState.extensionVersion || SCRIPT_VERSION,
        extensionVersion: bridgeState.extensionVersion || SCRIPT_VERSION,
        protocolVersion: bridgeState.protocolVersion ?? EXTENSION_PROTOCOL_VERSION,
        extensionId: null,
        manifestVersion: 3,
        tabId: bridgeState.tabId ?? null,
        windowId: bridgeState.windowId ?? null,
        isActiveTab: bridgeState.isActiveTab ?? null,
        buildStamp: bridgeState.buildStamp || BUILD_STAMP,
        source: 'content-script-fallback',
        contentScript: true,
        serviceWorker: false,
      });
      try {
        const ping = await extensionSendMessageWithRetry(
          { type: 'GET_EXTENSION_INFO' },
          { timeoutMs: 1200, attempts: 1, retryDelayMs: 0 },
        );
        const response = ping.response;
        if (response?.ok && response.protocolVersion !== undefined) {
          bridgeState.protocolVersion = response.protocolVersion;
        }
        if (response?.version || response?.extensionVersion) {
          bridgeState.extensionVersion = response.extensionVersion || response.version;
        }
        if (response?.buildStamp) bridgeState.buildStamp = response.buildStamp;
        return {
          ...localInfo(),
          ...(response || {}),
          contentScript: true,
          serviceWorker: response?.ok === true,
          attempts: ping.attempts,
          source: response?.source || 'service-worker',
        };
      } catch (err) {
        return {
          ...localInfo(),
          fallback: true,
          reason: 'service-worker-info-unavailable',
          error: err?.message || String(err),
          attempts: err?.attempts || 1,
        };
      }
    },
    rememberTabClaim,
    releaseCurrentTabClaim,
    afterReleaseByTabId: async ({ command, response, requestedTabId }) => {
      const currentTabId = Number(bridgeState.tabId);
      const targetsThisTab =
        Number.isInteger(requestedTabId) &&
        Number.isInteger(currentTabId) &&
        requestedTabId === currentTabId;
      const claimMatches =
        !command.args?.claimId ||
        !state.tabClaim?.claimId ||
        state.tabClaim.claimId === command.args.claimId;
      if (targetsThisTab && claimMatches && response?.ok) {
        clearLocalTabClaim();
        reportTabBrokerState('claim-released-by-tab-id', { force: true });
      }
    },
  });

  const browserSideEffectCommands = new Set([
    'get-chat-by-id',
    'load-more-conversations',
    'open-chat',
    'reload-gemini-tabs',
    'reload-page',
  ]);

  const hasExplicitBrowserCommandIntent = (command) =>
    command.args?.explicit === true ||
    command.args?.explicitBrowserSideEffect === true ||
    command.args?.browserSideEffectExplicit === true ||
    command.args?.force === true;

  const explicitBrowserCommandIntentRequired = (command) => ({
    ok: false,
    code: 'explicit_browser_intent_required',
    status: 'explicit-browser-intent-required',
    reason: command.args?.reason || 'bridge-command',
    skipped: true,
  });

  const captureHostStylesProbe = () => {
    const pageDoc = pageWindow.document;
    const visible = (el) => {
      if (!el) return false;
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const cs = pageWindow.getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
      } catch {
        return false;
      }
    };
    const visAll = (sel) => {
      try {
        return Array.from(pageDoc.querySelectorAll(sel)).filter(visible);
      } catch {
        return [];
      }
    };
    const first = (sel) => visAll(sel)[0] || null;
    const readToken = (name) => {
      try {
        const html = pageWindow.getComputedStyle(pageDoc.documentElement).getPropertyValue(name).trim();
        if (html) return html;
        if (pageDoc.body) {
          const body = pageWindow.getComputedStyle(pageDoc.body).getPropertyValue(name).trim();
          if (body) return body;
        }
      } catch {}
      return '';
    };
    const pick = (el, props) => {
      if (!el) return null;
      let cs;
      try {
        cs = pageWindow.getComputedStyle(el);
      } catch {
        return null;
      }
      const out = {};
      for (const p of props) {
        try {
          out[p] = cs.getPropertyValue(p).trim();
        } catch {
          out[p] = '';
        }
      }
      const r = el.getBoundingClientRect();
      out.__rect = { w: Math.round(r.width), h: Math.round(r.height) };
      out.__tag = el.tagName.toLowerCase();
      out.__cls = typeof el.className === 'string' ? el.className.slice(0, 160) : '';
      out.__aria = el.getAttribute('aria-label') || '';
      return out;
    };

    const surfaceProps = [
      'background-color',
      'color',
      'border',
      'border-color',
      'border-radius',
      'box-shadow',
      'padding',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'backdrop-filter',
    ];
    const buttonProps = [
      'background-color',
      'color',
      'border',
      'border-color',
      'border-radius',
      'width',
      'height',
      'padding',
      'min-width',
      'min-height',
      'box-shadow',
      'transition',
      'font-family',
      'font-size',
      'font-weight',
    ];
    const inputProps = [
      'background-color',
      'color',
      'border',
      'border-color',
      'border-radius',
      'padding',
      'font-size',
      'box-shadow',
    ];

    const tokenNames = [
      '--gem-sys-color--surface',
      '--gem-sys-color--surface-container',
      '--gem-sys-color--surface-container-low',
      '--gem-sys-color--surface-container-high',
      '--gem-sys-color--surface-container-highest',
      '--gem-sys-color--on-surface',
      '--gem-sys-color--on-surface-variant',
      '--gem-sys-color--outline',
      '--gem-sys-color--outline-variant',
      '--gem-sys-color--primary',
      '--gem-sys-color--on-primary',
      '--gem-sys-color--primary-container',
      '--gem-sys-color--on-primary-container',
      '--gem-sys-color--secondary',
      '--gem-sys-color--secondary-container',
      '--gem-sys-color--on-secondary-container',
      '--gem-sys-color--tertiary-container',
      '--gem-sys-color--error',
      '--gem-sys-color--inverse-surface',
      '--gem-sys-color--inverse-on-surface',
      '--gem-sys-elevation--level1',
      '--gem-sys-elevation--level2',
      '--gem-sys-elevation--level3',
      '--gem-sys-shape--corner-small',
      '--gem-sys-shape--corner-medium',
      '--gem-sys-shape--corner-large',
      '--gem-sys-shape--corner-extra-large',
      '--gem-sys-typescale--body-large-font',
      '--gem-sys-typescale--label-large-font',
      '--mat-sys-surface',
      '--mat-sys-on-surface',
      '--mat-sys-primary',
      '--mat-sys-secondary-container',
      '--mat-sys-outline',
    ];
    const tokens = {};
    for (const name of tokenNames) tokens[name] = readToken(name);

    const topBars = Array.from(pageDoc.querySelectorAll('top-bar-actions'));
    const topBar = topBars.find(visible) || topBars[0] || null;
    const rightSection = topBar?.querySelector('.right-section') || null;
    const buttonsContainers = rightSection
      ? Array.from(rightSection.querySelectorAll('.buttons-container')).filter(visible)
      : [];

    const kebab =
      (topBar &&
        (topBar.querySelector('button[aria-haspopup="menu"]') ||
          topBar.querySelector('button.mat-mdc-icon-button') ||
          topBar.querySelector('mat-icon-button'))) ||
      first('top-bar-actions button[mat-icon-button]') ||
      first('button.mat-mdc-icon-button');

    let kebabIcon = null;
    if (kebab) {
      const ic = kebab.querySelector(
        'mat-icon, gem-icon, .material-symbols-outlined, .gds-icon, svg, i',
      );
      if (ic) {
        try {
          const cs = pageWindow.getComputedStyle(ic);
          const r = ic.getBoundingClientRect();
          kebabIcon = {
            tag: ic.tagName.toLowerCase(),
            cls: typeof ic.className === 'string' ? ic.className.slice(0, 160) : '',
            text: (ic.textContent || '').trim().slice(0, 40),
            fontFamily: cs.getPropertyValue('font-family').trim(),
            fontSize: cs.getPropertyValue('font-size').trim(),
            color: cs.getPropertyValue('color').trim(),
            size: { w: Math.round(r.width), h: Math.round(r.height) },
          };
        } catch {
          kebabIcon = null;
        }
      }
    }

    const sidebarItem =
      first(
        'side-nav-action-button.is-selected, .conversations-list .selected, mat-list-item.mdc-list-item--selected, [data-test-id="conversation"].is-selected, gem-nav-list-item.is-selected',
      ) || first('gem-nav-list-item');
    const inputArea = first('input-area-v2 .input-container, input-area-v2 .text-input-field, input-area-v2');
    const dialog = first('mat-dialog-container, .cdk-overlay-pane mat-dialog-container, .cdk-overlay-pane[role="dialog"]');
    const menu = first('.mat-mdc-menu-panel, .cdk-overlay-pane .menu-content, gem-popover, [role="menu"]');
    const menuItem = menu?.querySelector('[role="menuitem"], .mat-mdc-menu-item, .menu-item') || null;
    const chip = first('mat-chip, .mdc-evolution-chip, [class*="chip"]:not([class*="chips"])');
    const toast = first('.mat-mdc-snack-bar-container, .gmat-snack-bar, simple-snack-bar');

    return {
      capturedAt: new Date().toISOString(),
      href: pageWindow.location.href,
      bodyClass: (pageDoc.body && pageDoc.body.className ? pageDoc.body.className : '').slice(0, 240),
      htmlClass: pageDoc.documentElement.className.slice(0, 240),
      tokens,
      geometry: {
        topBarCount: topBars.length,
        topBarVisibleCount: topBars.filter(visible).length,
        topBarRect: topBar ? topBar.getBoundingClientRect().toJSON?.() || null : null,
        rightSectionRect: rightSection ? rightSection.getBoundingClientRect().toJSON?.() || null : null,
        buttonsContainerCount: rightSection ? rightSection.querySelectorAll('.buttons-container').length : 0,
        buttonsContainerVisibleCount: buttonsContainers.length,
      },
      kebab: pick(kebab, buttonProps),
      kebabIcon,
      sidebarItem: pick(sidebarItem, surfaceProps),
      inputArea: pick(inputArea, inputProps),
      dialog: pick(dialog, surfaceProps),
      menu: pick(menu, surfaceProps),
      menuItem: pick(menuItem, surfaceProps),
      chip: pick(chip, surfaceProps),
      toast: pick(toast, surfaceProps),
    };
  };

  const executeBridgeCommand = async (command, operationContext = {}) => {
    if (!command?.type) {
      return {
        ok: false,
        error: 'Comando inválido.',
      };
    }

    const sharedResult = await sharedTabCommands.execute(command);
    if (sharedResult !== undefined) return sharedResult;

    if (
      browserSideEffectCommands.has(String(command.type || '')) &&
      !hasExplicitBrowserCommandIntent(command)
    ) {
      return explicitBrowserCommandIntentRequired(command);
    }

    if (command.type === 'ping' || command.type === 'snapshot') {
      let hostStyles = null;
      try {
        hostStyles = captureHostStylesProbe();
      } catch {
        hostStyles = null;
      }
      return {
        ok: true,
        snapshot: debugSnapshot(),
        hostStyles,
      };
    }

    if (command.type === 'cancel-active-operation') {
      if (!state.activeTabOperation) {
        return {
          ok: true,
          cancelled: false,
          reason: 'no-active-operation',
        };
      }
      const hasRequestedOperationId =
        Object.prototype.hasOwnProperty.call(command.args || {}, 'operationId') &&
        command.args?.operationId !== null;
      const requestedOperationId = hasRequestedOperationId ? String(command.args.operationId) : null;
      if (
        hasRequestedOperationId &&
        (typeof state.activeTabOperation.operationId !== 'string' ||
          requestedOperationId !== state.activeTabOperation.operationId)
      ) {
        return {
          ok: true,
          cancelled: false,
          reason: 'operation-id-mismatch',
          activeOperation: activeTabOperationSummary(),
        };
      }
      state.activeTabOperation.cancelRequestedAt = Date.now();
      state.activeTabOperation.cancelReason = command.args?.reason || 'bridge-command';
      if (state.activeTabOperation.abortController) {
        state.activeTabOperation.abortController.abort(
          state.activeTabOperation.cancelReason || 'bridge-command',
        );
      }
      reportTabBrokerState('operation-cancel-requested', { force: true });
      return {
        ok: true,
        cancelled: true,
        activeOperation: activeTabOperationSummary(),
      };
    }

    if (command.type === 'inspect-media') {
      return {
        ok: true,
        media: inspectMediaDom(),
        snapshot: debugSnapshot(),
      };
    }

    if (command.type === 'capture-host-styles') {
      return {
        ok: true,
        hostStyles: captureHostStylesProbe(),
      };
    }

    if (command.type === 'diagnose-artifacts') {
      return {
        ok: true,
        artifacts: await inspectArtifactDom({
          includeFrameProbe: command.args?.includeFrameProbe !== false,
          includeHtml: command.args?.includeHtml === true,
          includeHtmlSample: command.args?.includeHtmlSample === true,
          maxSampleLength: command.args?.maxSampleLength,
          maxListItems: command.args?.maxListItems,
          openArtifactLaunchers: command.args?.openArtifactLaunchers !== false,
          closeOpenedLaunchers: command.args?.closeOpenedLaunchers !== false,
          maxOpenArtifactLaunchers: command.args?.maxOpenArtifactLaunchers,
          artifactOpenWaitMs: command.args?.artifactOpenWaitMs,
        }),
        snapshot: debugSnapshot({
          includeDomDiagnostics: command.args?.includeDomDiagnostics === true,
        }),
      };
    }

    if (command.type === 'artifact-captures') {
      try {
        const response = await extensionSendMessage(
          {
            type: 'gemini-md-export/artifact-captures',
            action: command.args?.action || 'list',
            tabId: command.args?.tabId,
            includeBodies: command.args?.includeBodies === true,
          },
          { timeoutMs: 12000 },
        );
        return response || {
          ok: false,
          error: 'Contexto da extensão indisponível.',
        };
      } catch (err) {
        return {
          ok: false,
          error: err?.message || String(err),
        };
      }
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
      if (command.args?.explicit !== true && command.args?.force !== true) {
        return {
          ok: false,
          status: 'explicit-reload-required',
          reason: command.args?.reason || 'bridge-command',
          skipped: true,
          reloaded: 0,
        };
      }
      const response = await new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
          resolve({ ok: false, reason: 'runtime-message-unavailable', reloaded: 0 });
          return;
        }
        chrome.runtime.sendMessage(
          {
            type: 'gemini-md-export/reload-gemini-tabs',
            reason: command.args?.reason || 'bridge-command',
            explicit: command.args?.explicit === true,
            force: command.args?.force === true,
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
      const ping = await extensionSendMessageWithRetry(
        { type: 'GET_EXTENSION_INFO' },
        { timeoutMs: 3500, attempts: 2, retryDelayMs: 200 },
      );
      const response = ping.response;
      if (response?.ok && response.protocolVersion !== undefined) {
        bridgeState.protocolVersion = response.protocolVersion;
      }
      if (response?.version || response?.extensionVersion) {
        bridgeState.extensionVersion = response.extensionVersion || response.version;
      }
      if (response?.buildStamp) bridgeState.buildStamp = response.buildStamp;
      return {
        ...(response || { ok: false, reason: 'empty-extension-info-response' }),
        contentScript: true,
        serviceWorker: response?.ok === true,
        attempts: ping.attempts,
      };
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

    if (command.type === 'activate-tab' || command.type === 'activate-browser-tab') {
      const requestedTabId = Number(command.args?.tabId ?? command.args?.targetTabId);
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/activate-tab',
          tabId: Number.isInteger(requestedTabId) ? requestedTabId : undefined,
          reason: command.args?.reason || 'bridge-command',
          focusWindow: command.args?.focusWindow === true,
        },
        { timeoutMs: 5000 },
      );
      if (
        response?.isActiveTab !== undefined &&
        (!Number.isInteger(requestedTabId) || requestedTabId === bridgeState.tabId)
      ) {
        bridgeState.isActiveTab = response.isActiveTab;
      }
      return response || { ok: false, reason: 'empty-activate-tab-response' };
    }

    if (command.type === 'claim-tab') {
      const args = command.args || {};
      const claimId = String(args.claimId || '').trim();
      if (!claimId) {
        return { ok: false, reason: 'claim-id-required' };
      }
      const claim = {
        claimId,
        sessionId: args.sessionId || null,
        label: args.label || TAB_CLAIM_DEFAULT_LABEL,
        color: args.color || 'green',
        expiresAt: args.expiresAt || null,
      };
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/claim-tab',
          ...claim,
        },
        { timeoutMs: 5000 },
      );
      if (response?.ok) {
        rememberTabClaim(claim, response);
      }
      return response || { ok: false, reason: 'empty-claim-response' };
    }

    if (command.type === 'release-tab-claim') {
      const response = await releaseCurrentTabClaim({
        claimId: command.args?.claimId || null,
        reason: command.args?.reason || 'bridge-command',
      });
      return response || { ok: false, reason: 'empty-release-response' };
    }

    if (command.type === 'release-tab-claim-by-tab-id') {
      const requestedTabId = Number(command.args?.tabId);
      const currentTabId = Number(bridgeState.tabId);
      const response = await extensionSendMessage(
        {
          type: 'gemini-md-export/release-tab-claim',
          tabId: requestedTabId,
          claimId: command.args?.claimId || null,
          reason: command.args?.reason || 'bridge-command-tab-id-release',
        },
        { timeoutMs: 5000 },
      );
      const targetsThisTab =
        Number.isInteger(requestedTabId) &&
        Number.isInteger(currentTabId) &&
        requestedTabId === currentTabId;
      const claimMatches =
        !command.args?.claimId ||
        !state.tabClaim?.claimId ||
        state.tabClaim.claimId === command.args.claimId;
      if (targetsThisTab && claimMatches && response?.ok) {
        clearLocalTabClaim();
        reportTabBrokerState('claim-released-by-tab-id', { force: true });
      }
      return response || { ok: false, reason: 'empty-release-response' };
    }

    if (command.type === 'list-conversations') {
      const sidebarReady = await ensureSidebarOpenForCommand(command, DEFAULT_LOAD_MORE_OPTIONS.ensureSidebarDelayMs);
      if (!sidebarReady.ok) return sidebarReady;
      return {
        ok: true,
        conversations: collectBridgeConversationLinks(),
        modalConversations: collectConversationLinks(),
        snapshot: debugSnapshot({
          includeDomDiagnostics: command.args?.includeDomDiagnostics === true,
        }),
      };
    }

    if (command.type === 'load-more-conversations') {
      const loadOptions = resolveLoadMoreOptions({
        fastMode: command.args?.fastMode === true,
        ignoreFailureCap: command.args?.ignoreFailureCap === true,
        endFailureThreshold: command.args?.endFailureThreshold,
      });
      const sidebarReady = await ensureSidebarOpenForCommand(command, loadOptions.ensureSidebarDelayMs);
      if (!sidebarReady.ok) return sidebarReady;
      if (command.args?.resetReachedEnd === true) {
        state.reachedSidebarEnd = false;
        state.loadMoreFailures = 0;
        state.listLoadStatus = 'idle';
      }

      const untilEnd = command.args?.untilEnd === true;
      const targetCount = untilEnd
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.min(20000, Number(command.args?.targetCount || 10)));
      const attempts = Math.max(1, Math.min(5, Number(command.args?.attempts || 2)));
      const maxRounds = Math.max(1, Math.min(20, Number(command.args?.maxRounds || 6)));
      const endFailureThreshold = Math.max(
        3,
        Math.min(20, Number(command.args?.endFailureThreshold || loadOptions.endFailureThreshold || 3)),
      );
      const timeoutMs = Math.max(
        500,
        Math.min(30_000, Number(command.args?.timeoutMs || (command.args?.fastMode ? 3500 : 8000))),
      );
      const startedAt = Date.now();
      const before = collectBridgeConversationLinks().length;
      let loadedAny = false;
      let timedOut = false;
      let roundsCompleted = 0;
      let previousCount = before;
      let noGrowthRounds = 0;
      const loadTrace = [];

      for (let round = 0; round < maxRounds; round += 1) {
        const currentCount = collectBridgeConversationLinks().length;
        if (currentCount >= targetCount || state.reachedSidebarEnd) break;

        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }

        const timeoutSentinel = { timedOut: true };
        const loadedResult = await withTimeoutValue(
          loadMoreConversations(attempts, loadOptions),
          remainingMs,
          timeoutSentinel,
        );
        const roundTimedOut = loadedResult === timeoutSentinel;
        const loaded = roundTimedOut ? false : loadedResult === true;
        timedOut = timedOut || roundTimedOut;
        roundsCompleted += 1;
        const afterCount = collectBridgeConversationLinks().length;
        const delta = Math.max(0, afterCount - previousCount);
        const grew = afterCount > previousCount;
        loadedAny = loadedAny || grew;
        noGrowthRounds = grew ? 0 : noGrowthRounds + 1;
        loadTrace.push({
          round: round + 1,
          beforeCount: previousCount,
          afterCount,
          delta,
          loaded,
          grew,
          timedOut: roundTimedOut,
          reachedEnd: state.reachedSidebarEnd,
          noGrowthRounds,
          attempts: Array.isArray(state.lastLoadMoreTrace) ? state.lastLoadMoreTrace : [],
        });
        if (state.reachedSidebarEnd) break;
        if (roundTimedOut) break;
        if ((afterCount <= previousCount || !loaded) && !untilEnd) break;
        if ((afterCount <= previousCount || !loaded) && noGrowthRounds >= endFailureThreshold) break;
        await sleep(loadOptions.retryPauseMs);
        previousCount = afterCount;
      }

      return {
        ok: true,
        loadedAny,
        beforeCount: before,
        afterCount: collectBridgeConversationLinks().length,
        reachedEnd: state.reachedSidebarEnd,
        timedOut,
        roundsCompleted,
        loadTrace: command.args?.includeLoadTrace === false ? undefined : loadTrace,
        conversations:
          command.args?.includeConversations === false ? undefined : collectBridgeConversationLinks(),
        modalConversations:
          command.args?.includeConversations === false ||
          command.args?.includeModalConversations === false
            ? undefined
            : collectConversationLinks(),
        snapshot:
          command.args?.includeSnapshot === false
            ? undefined
            : debugSnapshot({
                includeDomDiagnostics: command.args?.includeDomDiagnostics === true,
              }),
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
        payload: await collectExportForCurrentConversation({
          hydration: normalizeHydrationOptions(command.args || {}),
          abortSignal: operationContext.abortSignal,
          setOperationPhase: operationContext.setOperationPhase,
          operationId: operationContext.operationId,
        }),
      };
    }

    if (command.type === 'open-chat') {
      try {
        const targetItem = findConversationForBridgeCommand(command.args || {});
        const navigation = await openChatWithNavigationEngine(targetItem, {
          ignoreBusy: true,
        });
        return {
          ok: true,
          conversation: targetItem,
          navigation: navigation?.navigationEngine || navigation || null,
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
          hydration: normalizeHydrationOptions(command.args || {}),
          abortSignal: operationContext.abortSignal,
          setOperationPhase: operationContext.setOperationPhase,
          operationId: operationContext.operationId,
        });
      } catch (err) {
        return {
          ok: false,
          conversation: targetItem,
          error: err?.message || String(err),
          code: err?.code || null,
        };
      }

      if (
        command.args?.returnToOriginal !== false &&
        originalItem &&
        originalItem.chatId !== targetItem.chatId
      ) {
        try {
          await openChatWithNavigationEngine(originalItem, {
            ignoreBusy: true,
          });
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
        const result = await check();
        if (result) return result;
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

  const boundedHydrationMs = (value, fallback, min, max) => {
    const parsed = Number(value ?? fallback);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
  };

  const normalizeHydrationOptions = (options = {}) => {
    const maxTotalMs = boundedHydrationMs(
      options.maxTotalMs ?? options.hydrationMaxTotalMs ?? options.hydrationTimeoutMs,
      HYDRATION_MAX_TOTAL_MS,
      5000,
      30 * 60 * 1000,
    );
    return {
      loadWaitMs: boundedHydrationMs(
        options.loadWaitMs ?? options.hydrationLoadWaitMs,
        HYDRATION_LOAD_WAIT_MS,
        500,
        30_000,
      ),
      topSettleMs: boundedHydrationMs(
        options.topSettleMs ?? options.hydrationTopSettleMs,
        HYDRATION_TOP_SETTLE_MS,
        1000,
        60_000,
      ),
      stallTimeoutMs: boundedHydrationMs(
        options.stallTimeoutMs ?? options.hydrationStallTimeoutMs,
        HYDRATION_STALL_TIMEOUT_MS,
        5000,
        maxTotalMs,
      ),
      maxTotalMs,
      maxAttempts: Math.max(
        1,
        Math.min(
          5000,
          Number(options.maxAttempts ?? options.hydrationMaxAttempts ?? HYDRATION_MAX_ATTEMPTS) ||
            HYDRATION_MAX_ATTEMPTS,
        ),
      ),
    };
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

  const conversationHydrationState = (scroller, doc, scrollTarget, win) => {
    const scrollElement = scrollTarget === win ? doc.body || doc.documentElement : scroller;
    return {
      containerCount: countConversationContainers(scroller, doc),
      turnDomCount: conversationDomTurnCount(doc),
      firstSignature: firstConversationSignature(scroller, doc),
      domSignature: conversationDomSignature(doc),
      scrollTop: getScrollTop(scrollTarget, win),
      scrollHeight: Math.round(scrollElement?.scrollHeight || 0),
      clientHeight: Math.round(scrollElement?.clientHeight || win.innerHeight || 0),
    };
  };

  const conversationHydrationChanged = (before, after) =>
    hydrationDomProgressChanged(before, after);

  const topHydrationConfirmationMs = (state, { loadWaitMs, topSettleMs }) =>
    hydrationConfirmationWaitMs(state, {
      loadWaitMs,
      topSettleMs,
      smallSettleMs: HYDRATION_SMALL_TOP_SETTLE_MS,
    });

  const nudgeConversationTop = async (scrollTarget, scrollElement, doc, win) => {
    try {
      const top = getScrollTop(scrollTarget, win);
      setScrollTop(scrollTarget, win, Math.max(0, top + 96));
      await sleep(80);
      setScrollTop(scrollTarget, win, 0);
    } catch {
      // Nudge é só para acordar lazy-load; falha aqui não deve abortar export.
    }

    try {
      const wheel = new win.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -900,
      });
      (scrollElement || doc).dispatchEvent(wheel);
    } catch {
      // Ambientes de teste/hosts antigos podem não expor WheelEvent.
    }
  };

  const hydrateConversationToTop = async (
    doc,
    win,
    options = {},
  ) => {
    const {
      loadWaitMs,
      topSettleMs,
      stallTimeoutMs,
      maxTotalMs,
      maxAttempts,
    } = normalizeHydrationOptions(options);
    const { el: scroller, matchedBy } = getGeminiScrollHost(doc, win);
    const scrollTarget = getScrollTarget(scroller, doc, win);
    const scrollElement = scrollTarget === win ? doc.body || doc.documentElement : scroller;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let attempts = 0;
    let reachedTop = false;
    let timedOut = false;
    let stalled = false;
    let finalReason = null;
    let lastContainerCount = countConversationContainers(scroller, doc);
    let lastTurnDomCount = conversationDomTurnCount(doc);
    const hydrationAbortMessage =
      'Exportação cancelada antes de terminar a hidratação da conversa.';

    const throwIfHydrationCancelled = () => {
      if (options.isCancelled?.() || options.abortSignal?.aborted) {
        throwIfOperationAborted(options.abortSignal, hydrationAbortMessage);
        const error = new Error(hydrationAbortMessage);
        error.code = 'operation_cancelled';
        throw error;
      }
    };

    throwIfOperationAborted(options.abortSignal, hydrationAbortMessage);

    if (!scrollElement || scrollElement.scrollHeight <= scrollElement.clientHeight + 4) {
      const turns = scrapeTurns(doc);
      options.onProgress?.({
        attempts,
        elapsedMs: Date.now() - startedAt,
        state: conversationHydrationState(scroller, doc, scrollTarget, win),
      });
      return {
        turns,
        stats: {
          strategy: 'scroll-top-stabilize',
          matchedBy,
          attempts,
          reachedTop: true,
          timedOut: false,
          stalled: false,
          finalReason: 'not-scrollable',
          loadWaitMs,
          topSettleMs,
          stallTimeoutMs,
          maxTotalMs,
          maxAttempts,
          conversationContainers: lastContainerCount,
          turnDomCount: conversationDomTurnCount(doc),
          turnsAfterHydration: turns.length,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const waitForHydrationChange = async (beforeState, waitMs) => {
      const waitStartedAt = Date.now();
      let state = beforeState;
      while (Date.now() - waitStartedAt < waitMs) {
        throwIfHydrationCancelled();
        await sleep(100);
        state = conversationHydrationState(scroller, doc, scrollTarget, win);
        if (conversationHydrationChanged(beforeState, state)) {
          return { state, changed: true };
        }
      }
      return {
        state: conversationHydrationState(scroller, doc, scrollTarget, win),
        changed: false,
      };
    };

    while (attempts < maxAttempts) {
      throwIfHydrationCancelled();
      if (Date.now() - startedAt > maxTotalMs) {
        timedOut = true;
        finalReason = 'max-total-time';
        break;
      }
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        stalled = true;
        finalReason = 'no-dom-growth';
        break;
      }

      attempts += 1;
      const beforeState = conversationHydrationState(scroller, doc, scrollTarget, win);
      const beforeTop = beforeState.scrollTop;

      if (beforeTop <= 2 && attempts > 1) {
        await nudgeConversationTop(scrollTarget, scrollElement, doc, win);
        const finalCheck = await waitForHydrationChange(
          beforeState,
          topHydrationConfirmationMs(beforeState, { loadWaitMs, topSettleMs }),
        );
        lastContainerCount = finalCheck.state.containerCount;
        lastTurnDomCount = finalCheck.state.turnDomCount;
        if (!finalCheck.changed) {
          reachedTop = true;
          finalReason = 'stable-at-top';
          break;
        }
        lastProgressAt = Date.now();
        options.onProgress?.({
          attempts,
          elapsedMs: Date.now() - startedAt,
          state: finalCheck.state,
        });
        await sleep(50);
        continue;
      }

      setScrollTop(scrollTarget, win, 0);
      const growth = await waitForHydrationChange(beforeState, loadWaitMs);
      lastContainerCount = growth.state.containerCount;
      lastTurnDomCount = growth.state.turnDomCount;

      if (growth.changed) {
        lastProgressAt = Date.now();
        options.onProgress?.({
          attempts,
          elapsedMs: Date.now() - startedAt,
          state: growth.state,
        });
      } else if (growth.state.scrollTop <= 2) {
        await nudgeConversationTop(scrollTarget, scrollElement, doc, win);
        const confirmation = await waitForHydrationChange(
          growth.state,
          topHydrationConfirmationMs(growth.state, { loadWaitMs, topSettleMs }),
        );
        lastContainerCount = confirmation.state.containerCount;
        lastTurnDomCount = confirmation.state.turnDomCount;
        if (!confirmation.changed) {
          reachedTop = true;
          finalReason = 'stable-at-top-after-scroll';
          break;
        }
        lastProgressAt = Date.now();
        options.onProgress?.({
          attempts,
          elapsedMs: Date.now() - startedAt,
          state: confirmation.state,
        });
      }

      await sleep(50);
    }

    if (!reachedTop && !timedOut && !stalled && attempts >= maxAttempts) {
      finalReason = 'max-attempts';
    }

    const turns = scrapeTurns(doc);
    options.onProgress?.({
      attempts,
      elapsedMs: Date.now() - startedAt,
      state: conversationHydrationState(scroller, doc, scrollTarget, win),
    });
    return {
      turns,
      stats: {
        strategy: 'scroll-top-stabilize',
        matchedBy,
        attempts,
        reachedTop,
        timedOut,
        stalled,
        finalReason,
        loadWaitMs,
        topSettleMs,
        stallTimeoutMs,
        maxTotalMs,
        maxAttempts,
        lastProgressElapsedMs: Date.now() - lastProgressAt,
        conversationContainers: lastContainerCount,
        turnDomCount: lastTurnDomCount,
        turnsAfterHydration: turns.length,
        scrollTop: getScrollTop(scrollTarget, win),
        scrollHeight: scrollElement?.scrollHeight || null,
        clientHeight: scrollElement?.clientHeight || null,
        elapsedMs: Date.now() - startedAt,
      },
    };
  };

  const waitForChatToLoad = async (targetChatId, options = {}) => {
    const normalizedTargetChatId = stripGeminiConversationPrefix(targetChatId);
    const previousSignature = options.previousSignature || '';
    const previousChatId = stripGeminiConversationPrefix(options.previousChatId || '');
    let lastState = null;

    return waitFor(
      () => {
        const chatId = currentChatId();
        const signature = conversationDomSignature(document);
        const turnCount = conversationDomTurnCount(document);
        const changedFromPrevious = !previousSignature || signature !== previousSignature;
        lastState = {
          chatId,
          targetChatId: normalizedTargetChatId,
          previousChatId,
          signature,
          previousSignature,
          turnCount,
          changedFromPrevious,
          title: scrapeTitle(),
        };

        if (chatId !== normalizedTargetChatId) return false;
        if (!location.pathname.startsWith('/app/')) return false;
        if (turnCount === 0) return false;

        // A URL do Gemini pode trocar antes do Angular substituir os turns.
        // Sem esta barreira, o export pode gravar o conteúdo do chat anterior
        // usando o chatId novo.
        if (previousSignature && !changedFromPrevious) return false;

        return lastState;
      },
      {
        timeoutMs: FRAME_TIMEOUT_MS,
        intervalMs: 200,
        label: `chat ${normalizedTargetChatId || targetChatId} com DOM atualizado`,
      },
    ).catch((err) => {
      if (lastState) {
        err.message = `${err.message} Ultimo estado: chat=${lastState.chatId || 'nenhum'}, turns=${lastState.turnCount}, mudouDOM=${lastState.changedFromPrevious ? 'sim' : 'nao'}.`;
      }
      throw err;
    });
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

  const waitForAnyChatToLoad = async (previousChatId, label = 'chat do caderno', options = {}) => {
    const normalizedPreviousChatId = stripGeminiConversationPrefix(previousChatId || '');
    const previousSignature = options.previousSignature || '';
    let lastState = null;

    return waitFor(
      () => {
        const chatId = currentChatId();
        const signature = conversationDomSignature(document);
        const turnCount = conversationDomTurnCount(document);
        const changedFromPrevious = !previousSignature || signature !== previousSignature;
        lastState = {
          chatId,
          previousChatId: normalizedPreviousChatId,
          signature,
          previousSignature,
          turnCount,
          changedFromPrevious,
          title: scrapeTitle(),
        };

        if (!chatId || chatId === normalizedPreviousChatId) return false;
        if (!location.pathname.startsWith('/app/')) return false;
        if (turnCount === 0) return false;
        if (previousSignature && !changedFromPrevious) return false;
        return lastState;
      },
      { timeoutMs: FRAME_TIMEOUT_MS, intervalMs: 200, label },
    ).catch((err) => {
      if (lastState) {
        err.message = `${err.message} Ultimo estado: chat=${lastState.chatId || 'nenhum'}, turns=${lastState.turnCount}, mudouDOM=${lastState.changedFromPrevious ? 'sim' : 'nao'}.`;
      }
      throw err;
    });
  };

  const navigateToKnownChatUrl = async (item) => {
    const previousChatId = currentChatId();
    const previousSignature = conversationDomSignature(document);
    const targetChatId = normalizeExpectedChatId(item);
    if (!targetChatId) {
      throw new Error(`Nao consegui identificar o ID da conversa "${item.title || item.id || ''}".`);
    }

    if (targetChatId === previousChatId && conversationDomTurnCount(document) > 0) {
      return {
        chatId: previousChatId,
        previousChatId,
        previousSignature: '',
        signature: previousSignature,
        turnCount: conversationDomTurnCount(document),
        skipped: true,
      };
    }

    if (targetChatId) {
      rememberNotebookConversationUrl(
        item,
        targetChatId,
        item.url || `https://gemini.google.com/app/${targetChatId}`,
      );
    }

    const link = document.createElement('a');
    link.href = item.url || `https://gemini.google.com/app/${targetChatId}`;
    link.target = '_self';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();

    return waitForChatToLoad(targetChatId, {
      previousChatId,
      previousSignature,
    });
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
      return navigateToKnownChatUrl(item);
    }

    if (!element) {
      throw new Error(`A conversa "${item.title}" não está mais visível no caderno.`);
    }

    const previousChatId = currentChatId();
    const previousSignature = conversationDomSignature(document);
    const clickable =
      element.querySelector('[data-test-id="navigate-to-recent-chat"]') ||
      element.querySelector('[role="button"]') ||
      element;

    clickable.click();
    const navigationState = await waitForAnyChatToLoad(previousChatId, item.title, {
      previousSignature,
    });
    const chatId = currentChatId();
    if (chatId) {
      item.chatId = chatId;
      item.url = location.href;
      item.id = `c_${chatId}`;
      rememberNotebookConversationUrl(item, chatId, location.href);
    }
    return navigationState;
  };

  const navigateToConversation = async (item, options = {}) => {
    if (item.source === 'notebook') {
      return navigateToNotebookConversation(item, options);
    }

    const previousChatId = currentChatId();
    const previousSignature = conversationDomSignature(document);
    const targetChatId = normalizeExpectedChatId(item);
    if (!targetChatId) {
      throw new Error(`Nao consegui identificar o ID da conversa "${item.title || item.id || ''}".`);
    }

    if (targetChatId === previousChatId && conversationDomTurnCount(document) > 0) {
      return {
        chatId: previousChatId,
        previousChatId,
        previousSignature: '',
        signature: previousSignature,
        turnCount: conversationDomTurnCount(document),
        skipped: true,
      };
    }

    const preferSidebarNavigation =
      item.source === 'sidebar' || options.preferSidebarNavigation === true;
    if (preferSidebarNavigation && !isSidebarOpen()) {
      try {
        await ensureSidebarOpen({
          timeoutMs: Math.min(FRAME_TIMEOUT_MS, Number(options.sidebarOpenTimeoutMs || 5000)),
          pollMs: 100,
        });
      } catch {
        // Se o sidebar não abrir, o fallback por URL direta ainda preserva o export.
      }
    }

    if (!isSidebarOpen() && String(item.url || '').includes('/app/')) {
      return navigateToKnownChatUrl(item);
    }

    const element = getSidebarConversationById(item.id || targetChatId);
    if (!element) {
      if ((item.chatId || item.url) && String(item.url || '').includes('/app/')) {
        return navigateToKnownChatUrl(item);
      }
      throw new Error(`A conversa ${item.title} não está mais visível no sidebar.`);
    }

    const clickable = element.querySelector('a[href]') || element;
    clickable.click();
    return waitForChatToLoad(targetChatId, {
      previousChatId,
      previousSignature,
    });
  };

  const getGeminiDomAdapter = () =>
    createGeminiWebDomAdapter({
      documentRef: document,
      locationHref: location.href,
    });

  const navigationRowFromConversationItem = (item = {}) => {
    const chatId = normalizeExpectedChatId(item);
    const url =
      item.url ||
      (chatId ? `https://gemini.google.com/app/${chatId}` : null);
    const warnings = chatId && url ? [] : ['missing_chat_id'];
    return {
      source: item.source === 'notebook' || item.source === 'sidebar' ? item.source : 'unknown',
      index: Number.isInteger(item.index) ? item.index : 0,
      title: item.title || item.id || chatId || '',
      url,
      chatId: chatId || null,
      exportable: Boolean(chatId && url),
      current: Boolean(chatId && chatId === currentChatId()),
      warnings,
      evidence: [
        {
          source: 'chat-dom',
          kind: chatId ? 'conversation-item-chat-id' : 'conversation-item-missing-chat-id',
          confidence: chatId ? 'strong' : 'missing',
          warnings,
        },
      ],
    };
  };

  const openChatWithNavigationEngine = async (target = {}, options = {}) => {
    const item = target.item || target.row || target;
    const row = navigationRowFromConversationItem(item);
    let legacyNavigation = null;
    const previousChatId = currentChatId();
    const previousSignature = conversationDomSignature(document);
    const engine = createNavigationEngine({
      adapter: getGeminiDomAdapter(),
      isBusy: () => Boolean(state.activeTabOperation && options.ignoreBusy !== true),
      openUrl: async () => {
        legacyNavigation = await navigateToConversation(item, options);
      },
      waitForHydration: async ({ chatId }) => {
        try {
          const loaded = await waitForChatToLoad(chatId, {
            previousChatId,
            previousSignature: previousChatId && previousChatId !== chatId ? previousSignature : '',
          });
          return {
            ok: true,
            turnCount: loaded.turnCount,
            warnings: [],
            evidence: [
              {
                source: 'chat-dom',
                kind: 'conversation-hydrated-before-export',
                confidence: 'strong',
                warnings: [],
              },
            ],
          };
        } catch (err) {
          return {
            ok: false,
            code: 'timeout',
            message: err?.message || String(err),
            requestedChatId: chatId,
            observedChatId: currentChatId() || undefined,
            warnings: ['conversation_hydration_timeout'],
            evidence: [
              {
                source: 'chat-dom',
                kind: 'conversation-hydration-timeout',
                confidence: 'missing',
                warnings: ['conversation_hydration_timeout'],
              },
            ],
          };
        }
      },
    });
    const result = await engine.openChat({
      chatId: row.chatId,
      url: row.url,
      row,
    });
    if (!result.ok) {
      const error = new Error(result.message);
      error.code = result.code;
      error.navigation = result;
      throw error;
    }
    if (legacyNavigation) {
      return {
        ...legacyNavigation,
        navigationEngine: result,
      };
    }
    return {
      chatId: result.chatId,
      previousChatId: currentChatId(),
      previousSignature: '',
      signature: conversationDomSignature(document),
      turnCount: result.turnCount ?? conversationDomTurnCount(document),
      skipped: result.reason === 'already-current',
      navigationEngine: result,
    };
  };

  const collectExportForCurrentConversation = async (options = {}) => {
    options.setOperationPhase?.('hydrating');
    const hydrationStartedAt = Date.now();
    const hydrated = await hydrateConversationToTop(document, window, {
      ...(options.hydration || {}),
      isCancelled: activeTabOperationCancelRequested,
      abortSignal: options.abortSignal,
      onProgress: ({ state: hydrationState, elapsedMs }) => {
        if (state.progress && state.exportSource === 'gui') {
          updateExportProgress({
            current: 0,
            label: `Hidratando conversa... ${
              hydrationState.turnDomCount || hydrationState.containerCount || 0
            } turnos vistos`,
            phase: `hidratação ${Math.round(elapsedMs / 1000)}s`,
          });
        }
        options.hydration?.onProgress?.({ state: hydrationState, elapsedMs });
      },
    });
    const hydrateDomMs = Date.now() - hydrationStartedAt;
    if (!hydrated.stats.reachedTop || hydrated.stats.timedOut) {
      const reason =
        hydrated.stats.timedOut
          ? `timeout de ${Math.round(hydrated.stats.maxTotalMs / 1000)}s`
          : hydrated.stats.stalled
            ? `sem progresso por ${Math.round(hydrated.stats.stallTimeoutMs / 1000)}s`
            : hydrated.stats.finalReason || 'fim nao confirmado';
      throw new Error(
        `Nao consegui carregar o inicio da conversa com seguranca antes de baixar (${reason}; scroller: ${hydrated.stats.matchedBy}; tentativas: ${hydrated.stats.attempts}; turnos vistos: ${hydrated.stats.turnDomCount || hydrated.stats.turnsAfterHydration || 0}). Recarregue a aba e tente novamente.`,
      );
    }
    options.setOperationPhase?.('extracting');
    throwIfOperationAborted(options.abortSignal, 'Exportação cancelada antes de extrair Markdown.');
    const payload = await buildExportPayload(document, location.href, {
      turns: hydrated.turns,
      metrics: {
        ...(options.metrics || {}),
        timings: {
          ...(options.metrics?.timings || {}),
          hydrateDomMs,
        },
      },
      hydration: {
        ...hydrated.stats,
        navigation: options.navigation || null,
        finalSignature: conversationDomSignature(document),
      },
    });

    const expectedChatId = stripGeminiConversationPrefix(options.expectedChatId || '');
    if (expectedChatId && payload.chatId !== expectedChatId) {
      throw new Error(
        `Download abortado: o navegador abriu o chat ${payload.chatId}, mas a ferramenta local pediu ${expectedChatId}. Nenhum arquivo foi salvo.`,
      );
    }

    if (
      options.previousSignature &&
      options.previousChatId &&
      stripGeminiConversationPrefix(options.previousChatId) !== payload.chatId &&
      conversationDomSignature(document) === options.previousSignature
    ) {
      throw new Error(
        'Download abortado: a URL mudou, mas o conteúdo da conversa ainda parece ser o chat anterior. Tente novamente depois que a página terminar de carregar.',
      );
    }

    return payload;
  };

  const collectExportForConversation = async (item, options = {}) => {
    options.setOperationPhase?.('navigating');
    throwIfOperationAborted(
      options.abortSignal,
      'Exportação cancelada antes de navegar para a conversa.',
    );
    const navigationStartedAt = Date.now();
    const navigation = await openChatWithNavigationEngine(item, {
      ...options,
      ignoreBusy: true,
    });
    throwIfOperationAborted(
      options.abortSignal,
      'Exportação cancelada antes de coletar a conversa.',
    );
    const openConversationMs = Date.now() - navigationStartedAt;
    return collectExportForCurrentConversation({
      expectedChatId: normalizeExpectedChatId(item),
      previousChatId: navigation?.previousChatId || '',
      previousSignature: navigation?.previousSignature || '',
      navigation: navigation || null,
      hydration: options.hydration || null,
      abortSignal: options.abortSignal,
      setOperationPhase: options.setOperationPhase,
      operationId: options.operationId,
      metrics: {
        timings: {
          openConversationMs,
        },
      },
    });
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
        warn('Falha ao salvar pela conexão local; usando fallback de downloads.', err);
        if (!state.bridgeSaveFallbackNotified) {
          state.bridgeSaveFallbackNotified = true;
          showToast(
            'Não consegui gravar na pasta escolhida. Vou cair em Downloads; mídias que não baixarem ficam avisadas no Markdown.',
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
        warn('Falha ao salvar em Downloads pela conexão local; usando download nativo do browser.', err);
        if (!state.browserDownloadFallbackNotified) {
          state.browserDownloadFallbackNotified = true;
          showToast(
            'A conexão local não respondeu. Vou usar Downloads do navegador. Para salvar direto no vault, reabra o Gemini CLI e clique em Alterar.',
            'error',
          );
        }
      }
    }

    await downloadBlob(payload.filename, markdownWithInlineMediaFallback(payload));
  };

  const exportNow = async () => {
    if (state.isExporting || state.activeTabOperation) {
      updateProgressDock();
      showToast('Esta aba já está ocupada. Aguarde o comando atual terminar.', 'info');
      return;
    }

    const chatId = extractChatId(location.pathname);
    if (!chatId) {
      const message =
        'Abra uma conversa específica antes de baixar (URL precisa conter /app/<id>).';
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
        phase: 'hidratação',
      });
      const payload = await collectExportForCurrentConversation();
      updateExportProgress({
        current: 0,
        label: `Salvando ${payload.filename}...`,
        phase: 'escrita',
      });
      await saveExportPayload(payload);
      updateExportProgress({
        current: 1,
        label: payload.title || payload.filename,
        phase: 'concluído',
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
      warn('Falha ao baixar conversa atual.', err);
      await finishExportProgress();
      showToast(
        'Não consegui baixar essa conversa. Abra o console (F12) para ver o motivo.',
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
          : state.listLoadStatus === 'inconclusive' || state.loadMoreFailures > 0
            ? 'is-inconclusive'
          : 'is-idle'
    }`;
    setHtml(endEl, `
      <span class="gm-list-end-dot" aria-hidden="true"></span>
      <span>${escapeHtml(listEndText())}</span>
    `);
  };

  const filteredConversationsForModal = () =>
    state.conversations.filter(
      (item) =>
        !state.filterQuery ||
        conversationSearchText(item).includes(state.filterQuery.toLowerCase()),
    );

  const renderConversationItemHtml = (item) => {
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
  };

  const modalVirtualListKey = (filtered) =>
    `${state.filterQuery}|${state.selectedChatIds.size}|${filtered.length}|${
      filtered[0]?.id || ''
    }|${filtered.at(-1)?.id || ''}`;

	  const scheduleVirtualListRender = () => {
	    if (!state.modalVirtual.active || state.modalVirtual.scheduled) return;
	    state.modalVirtual.scheduled = true;
	    const schedule =
      typeof pageWindow.requestAnimationFrame === 'function'
        ? pageWindow.requestAnimationFrame.bind(pageWindow)
        : (callback) => setTimeout(callback, 16);
    schedule(() => {
      state.modalVirtual.scheduled = false;
	      renderConversationList({ fromVirtualScroll: true });
	    });
	  };

  const modalListWheelMetrics = (target) => ({
    scrollTop: Number(target.scrollTop || 0),
    clientHeight: Number(target.clientHeight || 0),
    scrollHeight: Number(target.scrollHeight || 0),
    itemHeight: MODAL_VIRTUAL_ITEM_HEIGHT,
    virtualItemCount: state.modalVirtual.active ? state.modalVirtual.lastTotal : 0,
  });

  const modalListMaxScrollTop = (target) =>
    computeModalVirtualScrollRange(modalListWheelMetrics(target));

  const handleModalListScrollPosition = (target) => {
    scheduleVirtualListRender();
    if (modalListMaxScrollTop(target) - target.scrollTop < 120) {
      loadMoreConversations(
        isNotebookPage() ? NOTEBOOK_LOAD_MORE_ATTEMPTS : SIDEBAR_LOAD_MORE_ATTEMPTS,
      );
    }
  };

  const scrollModalListByWheel = (target, event) => {
    const result = computeModalWheelScroll({
      ...modalListWheelMetrics(target),
      deltaY: Number(event.deltaY || 0),
      ctrlKey: event.ctrlKey === true,
      metaKey: event.metaKey === true,
    });
    if (!result.shouldScroll) return false;
    event.preventDefault();
    event.stopPropagation();
    target.scrollTop = result.nextScrollTop;
    handleModalListScrollPosition(target);
    return true;
  };

  const handleModalListWheel = (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    scrollModalListByWheel(target, event);
  };

  const handleModalPanelWheel = (event) => {
    const list = document.getElementById(MODAL_LIST_ID);
    if (!(list instanceof HTMLElement)) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest(`#${MODAL_LIST_ID}`)) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    }
    scrollModalListByWheel(list, event);
  };

  const renderConversationList = ({ fromVirtualScroll = false } = {}) => {
    const container = document.getElementById(MODAL_LIST_ID);
    const countEl = document.getElementById(MODAL_COUNT_ID);
    if (!container || !countEl) return;
    // Snapshot antes de reescrever innerHTML. Sem isso, toda re-render
    // (heartbeat, observer, mutacao do sidebar) mandava o usuario de volta
    // pro topo — UX terrivel em listas longas. Restauramos scrollTop depois
    // do reflow, a menos que usuario estivesse colado no fim (auto-scroll
    // de continuacao) ou tenhamos acabado de bater no fim da lista.
    const prevScrollTop = container.scrollTop;
    const maxScrollTopBeforeRender = modalListMaxScrollTop(container);
    const wasNearBottom =
      maxScrollTopBeforeRender > 0 && maxScrollTopBeforeRender - container.scrollTop < 48;
    const finishRender = () => {
      renderListEndState();
      requestAnimationFrame(() => {
        if (state.reachedSidebarEnd || wasNearBottom) {
          container.scrollTop = container.scrollHeight;
        } else if (prevScrollTop > 0) {
          // Clamp contra encolhimento (filtro reduziu lista).
          const maxTop = modalListMaxScrollTop(container);
          container.scrollTop = Math.min(prevScrollTop, maxTop);
        }
      });
    };

    const filtered = filteredConversationsForModal();

    const selCount = state.selectedChatIds.size;
    const visCount = filtered.length;
    const selLabel = selCount === 1 ? '1 selecionada' : `${selCount} selecionadas`;
    const visLabel = visCount === 1 ? '1 visível' : `${visCount} visíveis`;
    countEl.textContent = `${selLabel} · ${visLabel}`;

    if (state.conversations.length === 0) {
      state.modalVirtual.active = false;
      container.classList.remove('is-virtual');
      setHtml(container, `
        <div style="padding:20px;border:1px dashed var(--gm-border);border-radius:16px;background:var(--gm-surface-muted);color:var(--gm-text-muted);">
          Nenhuma conversa encontrada. Abra a barra lateral do Gemini e clique em atualizar.
        </div>
      `);
      finishRender();
      return;
    }

    if (filtered.length === 0) {
      state.modalVirtual.active = false;
      container.classList.remove('is-virtual');
      setHtml(container, `
        <div style="padding:28px 20px;text-align:center;border:1px dashed var(--gm-border);border-radius:16px;background:var(--gm-surface-muted);color:var(--gm-text-muted);">
          Nenhuma conversa encontrada para "${escapeHtml(state.filterQuery)}".
        </div>
      `);
      finishRender();
      return;
    }

    const shouldVirtualize = filtered.length >= MODAL_VIRTUALIZATION_THRESHOLD;
    state.modalVirtual.active = shouldVirtualize;
    container.classList.toggle('is-virtual', shouldVirtualize);

    if (shouldVirtualize) {
      const key = modalVirtualListKey(filtered);
      const prevScrollTop = container.scrollTop;
      const viewportHeight = Math.max(container.clientHeight || 360, MODAL_VIRTUAL_ITEM_HEIGHT * 4);
      const start = Math.max(
        0,
        Math.floor(prevScrollTop / MODAL_VIRTUAL_ITEM_HEIGHT) - MODAL_VIRTUAL_BUFFER,
      );
      const visibleCount =
        Math.ceil(viewportHeight / MODAL_VIRTUAL_ITEM_HEIGHT) + MODAL_VIRTUAL_BUFFER * 2;
      const end = Math.min(filtered.length, start + visibleCount);
      const unchangedWindow =
        fromVirtualScroll &&
        key === state.modalVirtual.lastKey &&
        start >= state.modalVirtual.renderedStart &&
        end <= state.modalVirtual.renderedEnd;

      if (!unchangedWindow) {
        state.modalVirtual.lastKey = key;
        state.modalVirtual.lastTotal = filtered.length;
        state.modalVirtual.renderedStart = start;
        state.modalVirtual.renderedEnd = end;
        setHtml(
          container,
          `
            <div class="gm-virtual-spacer" style="height:${start * MODAL_VIRTUAL_ITEM_HEIGHT}px"></div>
            ${filtered.slice(start, end).map(renderConversationItemHtml).join('')}
            <div class="gm-virtual-spacer" style="height:${Math.max(
              0,
              (filtered.length - end) * MODAL_VIRTUAL_ITEM_HEIGHT,
            )}px"></div>
          `,
        );
        if (prevScrollTop > 0) container.scrollTop = prevScrollTop;
      }
      finishRender();
      return;
    }

    state.modalVirtual.renderedStart = 0;
    state.modalVirtual.renderedEnd = filtered.length;
    state.modalVirtual.lastKey = modalVirtualListKey(filtered);
    setHtml(
      container,
      filtered.map(renderConversationItemHtml).join(''),
    );
    finishRender();
  };

  const ensureProgressDock = () => {
    return ensureSharedProgressDock({
      dockId: PROGRESS_DOCK_ID,
      initialTitle: 'Baixando conversas',
    });
  };

  // "Creep" assintótico: entre uma chamada de updateExportProgress e a
  // próxima, deslocamos a porcentagem visual em direção ao próximo
  // milestone (sem ultrapassá-lo). Isso evita a sensação de barra
  // travada durante etapas lentas dentro de uma única conversa
  // (hidratação, scroll, salvar). Quando o current de fato avança,
  // pulamos pra esse alvo (animação CSS suaviza). Mecânica clássica
  // de YouTube/GitHub progress bar.
  const PROGRESS_CREEP_INTERVAL_MS = 240;

  const UI_TECHNICAL_COPY_RE =
    /\b(MCP|bridge|claim|job|payload|phase|reexport(?:ando|acao|ação)?)\b/i;

  const shortChatId = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > 16 ? text.slice(0, 16) : text;
  };

  const safeProgressItemLabel = (progress) => {
    const label = String(progress?.title || progress?.label || '').trim();
    if (label && !UI_TECHNICAL_COPY_RE.test(label)) return label;
    return shortChatId(progress?.currentChatId || progress?.chatId) || 'conversa';
  };

  const progressDisplayCurrent = (progress) => {
    if (progress?.displayCurrent != null && Number.isFinite(Number(progress.displayCurrent))) {
      return Number(progress.displayCurrent);
    }
    const total = Math.max(progress?.total || 1, 1);
    const status = progress?.status || '';
    if (status === 'completed' || status === 'completed_with_errors') return total;
    const raw = Number(progress?.position ?? progress?.current ?? 0);
    return Math.max(0, Math.min(Number.isFinite(raw) ? raw : 0, total));
  };

  const progressBarCurrent = (progress) => {
    if (progress?.barCurrent != null && Number.isFinite(Number(progress.barCurrent))) {
      return Number(progress.barCurrent);
    }
    return sharedProgressBarCurrent(progress);
  };

  const progressTitleFor = (progress) => {
    if (progress?.sourceKind && progress?.title) return progress.title;
    const flow = progress?.workflow || progress?.kind || '';
    if (flow === 'vault-incremental-sync') return 'Sincronizando vault';
    if (flow === 'vault-reconciliation' || flow === 'full-history-export') {
      return 'Importando histórico';
    }
    if (flow === 'notebook-export') return 'Exportando caderno';
    return 'Baixando conversas';
  };

  const humanProgressLabelFor = (progress) => {
    if (progress?.sourceKind && progress?.label) return progress.label;
    const total = Math.max(progress?.total || 1, 1);
    const current = progressDisplayCurrent(progress);
    const count = current > 0 && total > 1 ? ` (${current} de ${total})` : '';
    const item = safeProgressItemLabel(progress);
    const flow = progress?.workflow || progress?.kind || '';
    const status = progress?.status || '';
    const phase = progress?.phase || '';

    if (status === 'cancel_requested') return 'Cancelando com segurança...';
    if (status === 'completed') return 'Concluído';
    if (status === 'completed_with_errors') return 'Concluído com erros';
    if (status === 'cancelled') return 'Cancelado';
    if (status === 'failed') return 'Falhou';

    if (phase === 'loading-history') return 'Lendo histórico do Gemini...';
    if (phase === 'scanning-vault') return 'Comparando com o vault...';
    if (phase === 'writing-report') return 'Salvando relatório...';

    if (phase === 'exporting') {
      if (flow === 'direct-chats-export' || flow === 'direct-reexport') {
        return `Baixando conversa selecionada${count}: ${item}`;
      }
      if (flow === 'notebook-export') {
        return `Exportando conversa do caderno${count}: ${item}`;
      }
      if (flow === 'vault-incremental-sync') {
        return `Baixando conversa nova${count}: ${item}`;
      }
      return `Baixando conversa${count}: ${item}`;
    }

    const fallback = String(progress?.label || '').trim();
    if (fallback && !UI_TECHNICAL_COPY_RE.test(fallback)) return fallback;
    return 'Preparando...';
  };

  const humanCountFor = (progress) => {
    if (progress?.sourceKind && progress?.countLabel) return progress.countLabel;
    const total = Math.max(progress?.total || 1, 1);
    const current = progressDisplayCurrent(progress);
    const errors = Math.max(0, Number(progress?.errorCount || 0));
    const parts = total > 1 ? [`${current} de ${total}`] : [];
    if (errors > 0) parts.push(`${errors} erro${errors === 1 ? '' : 's'}`);
    return parts.join(' · ');
  };

  const buildBrowserProgressView = (progress, sourceKind = 'gui-export') => {
    const raw = { ...(progress || {}) };
    const textSource = {
      ...raw,
      sourceKind: null,
      countLabel: null,
      displayCurrent: null,
      barCurrent: null,
    };
    const total = Math.max(Number(raw.total || 1) || 1, 1);
    const current = Number(raw.current ?? raw.completed ?? 0);
    const currentItem =
      raw.title || raw.currentChatId || raw.chatId
        ? {
            title: raw.title || null,
            chatId: raw.currentChatId || raw.chatId || null,
          }
        : null;
    const view = buildProgressViewModel({
      sourceKind,
      status: raw.status || 'running',
      phase: raw.phase || null,
      title: progressTitleFor(textSource),
      label: humanProgressLabelFor(textSource),
      current: Number.isFinite(current) ? current : 0,
      completed: raw.completed ?? null,
      total,
      position: raw.position ?? null,
      displayPercent: raw.displayPercent ?? null,
      currentItem,
      counts: {
        failed: raw.errorCount ?? 0,
      },
      countLabel: humanCountFor(textSource),
    });
    return {
      ...raw,
      ...view,
      sourceKind,
      source: raw.source || null,
      jobId: raw.jobId || null,
      kind: raw.kind || null,
      workflow: raw.workflow || raw.kind || null,
      currentChatId: raw.currentChatId || raw.chatId || null,
      chatId: raw.chatId || null,
      errorCount: Math.max(0, Number(raw.errorCount || 0)),
      startedAt: raw.startedAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now(),
    };
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
      if (!sharedShouldRunProgressCreep(state.progress)) {
        stopProgressCreep();
        return;
      }
      const { base } = sharedComputeProgressMilestone(state.progress);
      const ceiling = sharedProgressCreepCeiling(state.progress);
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
      setSharedProgressDockVisible(dock, false);
      dock.classList.remove('gm-dock-done');
      return;
    }

    applySharedProgressDockTheme(dock, { dark: isDarkTheme(), documentRef: document });

    const { titleEl, countEl, labelEl, barEl } = getSharedProgressDockElements({
      dockId: PROGRESS_DOCK_ID,
    });

    if (titleEl) {
      titleEl.textContent = progressTitleFor(state.progress);
    }
    if (countEl) {
      countEl.textContent = humanCountFor(state.progress);
    }
    if (labelEl) {
      labelEl.textContent = humanProgressLabelFor(state.progress);
    }
    if (barEl) {
      const { base, next } = sharedComputeProgressMilestone(state.progress);
      // Se o `current` real avançou, pulamos a barra pra base nova; caso
      // contrário, mantemos o valor que o creep está alimentando (sem
      // regredir nem ultrapassar a base nova).
      const prevDisplay = state.progress.displayPercent ?? 0;
      const display = sharedNormalizeProgressDisplayPercent({
        previousProgress: state.previousProgressForDisplay || state.progress,
        nextProgress: state.progress,
        previousDisplayPercent: prevDisplay,
      });
      state.previousProgressForDisplay = { ...state.progress };
      state.progress.displayPercent = display;
      barEl.style.width = `${display}%`;
      // Quando bate o total, marca como pronto pra parar o shimmer.
      if (progressBarCurrent(state.progress) >= state.progress.total) {
        dock.classList.add('gm-dock-done');
      } else {
        dock.classList.remove('gm-dock-done');
      }
      // Garante que o creep está rodando (idempotente).
      if (sharedShouldRunProgressCreep(state.progress) && !state.progressCreepTimer && next > base + 0.5) {
        startProgressCreep();
      } else if (!sharedShouldRunProgressCreep(state.progress)) {
        stopProgressCreep();
      }
    }

    setSharedProgressDockVisible(dock, true);
  };

  const beginExportProgress = async ({
    total,
    label,
    phase = 'preparando',
    kind = null,
    workflow = null,
    status = 'running',
  }) => {
    state.activeTabOperation = state.activeTabOperation || {
      type: 'gui-export',
      label: 'download pela interface',
      commandId: null,
      startedAt: Date.now(),
    };
    state.isExporting = true;
    state.exportSource = 'gui';
    state.browserDownloadFallbackNotified = false;
    state.progress = buildBrowserProgressView({
      total,
      current: 0,
      label,
      kind,
      workflow,
      status,
      phase,
      errorCount: 0,
      startedAt: Date.now(),
      displayPercent: 0,
    }, 'gui-export');
    state.previousProgressForDisplay = null;
    hideExportModal();
    updateProgressDock();
    startProgressCreep();
    await nextPaint();
  };

  const updateExportProgress = (patch = {}) => {
    if (!state.progress) return;
    const previousProgress = { ...state.progress };
    const normalizedPatch = {
      ...patch,
      errorCount:
        state.exportSource === 'mcp'
          ? Math.max(Number(previousProgress.errorCount || 0), Number(patch.errorCount || 0))
          : patch.errorCount,
    };
    const nextProgress = buildBrowserProgressView({
      ...state.progress,
      ...normalizedPatch,
    }, state.exportSource === 'mcp' ? 'export-job' : 'gui-export');
    state.progress = mergeProgressViewModel(previousProgress, nextProgress);
    state.progress.displayPercent = normalizeProgressDisplayPercent(
      previousProgress,
      state.progress,
      previousProgress.displayPercent ?? state.progress.displayPercent ?? 0,
    );
    state.previousProgressForDisplay = previousProgress;
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
    state.exportSource = null;
    state.progress = null;
    state.previousProgressForDisplay = null;
    if (state.activeTabOperation?.type === 'gui-export') {
      state.completedTabOperations += 1;
      state.activeTabOperation = null;
    }
    updateProgressDock();
  };

  // --- MCP-driven progress -----------------------------------------------
  // Quando o MCP está exportando conversas pelo bridge, ele envia o
  // jobProgress no payload do /bridge/heartbeat. A aba do Gemini reaproveita
  // o mesmo dock visual usado pelo botão "Baixar selecionadas". Se o
  // usuário disparou export pela GUI, o GUI tem prioridade e o MCP é ignorado
  // até a GUI terminar.
  const TERMINAL_MCP_STATUSES = new Set([
    'completed',
    'completed_with_errors',
    'failed',
    'cancelled',
  ]);

  const stopMcpProgressWatchdog = () => {
    if (state.mcpProgressWatchdogTimer) {
      clearInterval(state.mcpProgressWatchdogTimer);
      state.mcpProgressWatchdogTimer = 0;
    }
  };

  const noteMcpProgressStatus = (status) => {
    if (status === 'cancel_requested') {
      state.mcpProgressCancelSinceAt = state.mcpProgressCancelSinceAt || Date.now();
      return;
    }
    state.mcpProgressCancelSinceAt = 0;
  };

  const clearStaleMcpProgressIfNeeded = () => {
    if (!state.mcpProgressActive || state.exportSource !== 'mcp') {
      stopMcpProgressWatchdog();
      return false;
    }
    const status = state.progress?.status || '';
    const now = Date.now();
    const staleMs =
      status === 'cancel_requested'
        ? now - (state.mcpProgressCancelSinceAt || state.mcpProgressLastSeenAt || now)
        : now - (state.mcpProgressLastSeenAt || now);
    const limitMs =
      status === 'cancel_requested' ? MCP_PROGRESS_CANCEL_STALE_MS : MCP_PROGRESS_STALE_GRACE_MS;
    if (staleMs < limitMs) return false;

    if (status === 'cancel_requested' && state.progress) {
      state.progress.status = 'cancelled';
      state.progress.phase = 'cancelled';
      state.progress.label = 'Cancelado';
      stopMcpProgressWatchdog();
      state.mcpProgressActive = false;
      state.mcpProgressJobId = null;
      state.mcpProgressLastSeenAt = 0;
      state.mcpProgressCancelSinceAt = 0;
      clearMcpProgressSnapshot();
      updateProgressDock();
      void finishExportProgress();
    } else {
      clearMcpProgressState();
    }
    return true;
  };

  const startMcpProgressWatchdog = () => {
    if (state.mcpProgressWatchdogTimer) return;
    state.mcpProgressWatchdogTimer = setInterval(
      clearStaleMcpProgressIfNeeded,
      MCP_PROGRESS_WATCHDOG_MS,
    );
  };

  const serializeMcpProgress = (jobProgress) => {
    if (!jobProgress || typeof jobProgress !== 'object') return null;
    const completedRaw = Number(jobProgress.completed ?? 0);
    const completed = Math.max(0, Number.isFinite(completedRaw) ? completedRaw : 0);
    const currentRaw = Number(jobProgress.current ?? completed);
    return {
      source: 'mcp',
      jobId: jobProgress.jobId || null,
      status: jobProgress.status || null,
      kind: jobProgress.kind || null,
      workflow: jobProgress.workflow || jobProgress.kind || null,
      total: Math.max(jobProgress.total || 1, 1),
      current: Math.max(0, Number.isFinite(currentRaw) ? currentRaw : completed),
      position: jobProgress.position ?? null,
      completed,
      title: jobProgress.title || null,
      chatId: jobProgress.chatId || null,
      currentChatId: jobProgress.currentChatId || jobProgress.chatId || null,
      label: jobProgress.label || 'Baixando conversas...',
      phase: jobProgress.phase || null,
      errorCount: Math.max(0, Number(jobProgress.errorCount || 0)),
      updatedAt: Date.now(),
    };
  };

  const saveMcpProgressSnapshot = (jobProgress) => {
    const snapshot = serializeMcpProgress(jobProgress);
    if (!snapshot) return;
    try {
      pageWindow.sessionStorage?.setItem(
        MCP_PROGRESS_SESSION_STORAGE_KEY,
        JSON.stringify(snapshot),
      );
    } catch {
      // sessionStorage pode estar indisponível; o dock ao vivo continua.
    }
  };

  const clearMcpProgressSnapshot = () => {
    try {
      pageWindow.sessionStorage?.removeItem(MCP_PROGRESS_SESSION_STORAGE_KEY);
    } catch {
      // Sem impacto funcional.
    }
  };

  const loadMcpProgressSnapshot = () => {
    try {
      const raw = pageWindow.sessionStorage?.getItem(MCP_PROGRESS_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const snapshot = JSON.parse(raw);
      if (!snapshot || snapshot.source !== 'mcp') return null;
      const ageMs = Date.now() - Number(snapshot.updatedAt || 0);
      if (ageMs > MCP_PROGRESS_STALE_GRACE_MS) {
        clearMcpProgressSnapshot();
        return null;
      }
      if (snapshot.status === 'cancel_requested' && ageMs > MCP_PROGRESS_CANCEL_STALE_MS) {
        clearMcpProgressSnapshot();
        return null;
      }
      if (snapshot.status && TERMINAL_MCP_STATUSES.has(snapshot.status)) {
        clearMcpProgressSnapshot();
        return null;
      }
      return snapshot;
    } catch {
      clearMcpProgressSnapshot();
      return null;
    }
  };

  const beginMcpProgress = (jobProgress) => {
    const snapshot = serializeMcpProgress(jobProgress);
    if (!snapshot) return;
    state.mcpProgressActive = true;
    state.mcpProgressJobId = snapshot.jobId || null;
    state.mcpProgressLastSeenAt = Date.now();
    noteMcpProgressStatus(snapshot.status);
    state.isExporting = true;
    state.exportSource = 'mcp';
    state.progress = buildBrowserProgressView({
      total: snapshot.total,
      current: snapshot.current || 0,
      label: snapshot.label || 'Preparando...',
      kind: snapshot.kind || null,
      workflow: snapshot.workflow || snapshot.kind || null,
      status: snapshot.status || 'running',
      phase: snapshot.phase || 'preparing',
      position: snapshot.position ?? null,
      completed: snapshot.completed ?? 0,
      title: snapshot.title || null,
      chatId: snapshot.chatId || null,
      currentChatId: snapshot.currentChatId || snapshot.chatId || null,
      errorCount: snapshot.errorCount || 0,
      startedAt: Date.now(),
      displayPercent: 0,
    }, 'export-job');
    state.previousProgressForDisplay = null;
    saveMcpProgressSnapshot(snapshot);
    updateProgressDock();
    startProgressCreep();
    startMcpProgressWatchdog();
  };

  const clearMcpProgressState = () => {
    stopMcpProgressWatchdog();
    state.mcpProgressActive = false;
    state.mcpProgressJobId = null;
    state.mcpProgressLastSeenAt = 0;
    state.mcpProgressCancelSinceAt = 0;
    clearMcpProgressSnapshot();
    if (state.exportSource === 'mcp') {
      stopProgressCreep();
      state.isExporting = false;
      state.exportSource = null;
      state.progress = null;
      state.previousProgressForDisplay = null;
      updateProgressDock();
    }
  };

  const handleMcpJobProgressBroadcast = (jobProgress) => {
    if (state.exportSource === 'gui') {
      // Export iniciado pelo botão local tem prioridade visual.
      return;
    }

    if (!jobProgress) {
      // Um heartbeat/SSE pode chegar sem snapshot durante navegação da SPA ou
      // reconexão do content script. Mantemos o dock por uma janela curta para
      // evitar sumiço no meio do job; se o MCP realmente parou, aí limpamos.
      if (state.mcpProgressActive) {
        if (clearStaleMcpProgressIfNeeded()) return;
        const ageMs = Date.now() - (state.mcpProgressLastSeenAt || 0);
        const status = state.progress?.status || '';
        const limitMs =
          status === 'cancel_requested' ? MCP_PROGRESS_CANCEL_STALE_MS : MCP_PROGRESS_STALE_GRACE_MS;
        if (ageMs < limitMs) {
          updateProgressDock();
          return;
        }
        clearMcpProgressState();
      }
      return;
    }

    if (jobProgress.source && jobProgress.source !== 'mcp') return;
    state.mcpProgressLastSeenAt = Date.now();
    noteMcpProgressStatus(jobProgress.status);
    startMcpProgressWatchdog();

    if (!state.mcpProgressActive) {
      beginMcpProgress(jobProgress);
    } else {
      if (jobProgress.jobId && jobProgress.jobId !== state.mcpProgressJobId) {
        const snapshot = serializeMcpProgress(jobProgress);
        if (!snapshot) return;
        // Novo job começou — reinicia o dock para refletir totais novos.
        state.mcpProgressJobId = snapshot.jobId;
        noteMcpProgressStatus(snapshot.status);
        state.progress = buildBrowserProgressView({
          total: snapshot.total,
          current: snapshot.current || 0,
          label: snapshot.label || 'Preparando...',
          kind: snapshot.kind || null,
          workflow: snapshot.workflow || snapshot.kind || null,
          status: snapshot.status || 'running',
          phase: snapshot.phase || 'preparing',
          position: snapshot.position ?? null,
          completed: snapshot.completed ?? 0,
          title: snapshot.title || null,
          chatId: snapshot.chatId || null,
          currentChatId: snapshot.currentChatId || snapshot.chatId || null,
          errorCount: snapshot.errorCount || 0,
          startedAt: Date.now(),
          displayPercent: 0,
        }, 'export-job');
        state.previousProgressForDisplay = null;
        saveMcpProgressSnapshot({
          source: 'mcp',
          jobId: state.mcpProgressJobId,
          ...state.progress,
        });
      } else {
        const snapshot = serializeMcpProgress(jobProgress);
        if (!snapshot) return;
        updateExportProgress(snapshot);
        saveMcpProgressSnapshot({
          source: 'mcp',
          jobId: state.mcpProgressJobId,
          ...state.progress,
        });
      }
      updateProgressDock();
    }

    if (jobProgress.status && TERMINAL_MCP_STATUSES.has(jobProgress.status)) {
      // Terminal: anima 100% + shimmer off + fade-out, mantendo a sensação
      // de "concluído" antes de esconder.
      stopMcpProgressWatchdog();
      state.mcpProgressActive = false;
      state.mcpProgressJobId = null;
      state.mcpProgressLastSeenAt = 0;
      state.mcpProgressCancelSinceAt = 0;
      clearMcpProgressSnapshot();
      void finishExportProgress();
    }
  };

  const restoreMcpProgressSnapshot = () => {
    const snapshot = loadMcpProgressSnapshot();
    if (!snapshot) return;
    beginMcpProgress({
      ...snapshot,
      label: snapshot.label || 'Retomando indicador de download...',
    });
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
      showToast('Nenhuma conversa selecionada pôde ser baixada.', 'error');
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
      label: resume ? 'Retomando download...' : 'Preparando download...',
      kind: originalWasNotebook ? 'notebook-export' : 'direct-chats-export',
      workflow: originalWasNotebook ? 'notebook-export' : 'direct-chats-export',
      phase: resume ? 'retomada' : 'preparo',
    });

    const failures = new Set(activeSession.failureIds || []);
    for (let i = activeSession.nextIndex; i < activeSession.items.length; i += 1) {
      const item = activeSession.items[i];
      updateExportProgress({
        current: i,
        position: i + 1,
        completed: i,
        title: item.title || item.chatId || item.id || null,
        currentChatId: item.chatId || item.id || null,
        label: `Baixando ${item.title}...`,
        phase: 'navegação/hidratação',
        errorCount: failures.size,
      });

      try {
        const payload = await collectExportForConversation(item, {
          preferDirectNotebookReturn: false,
          preserveNotebookContext: true,
        });
        updateExportProgress({
          current: i,
          position: i + 1,
          completed: i,
          title: payload.title || item.title || payload.chatId || null,
          currentChatId: payload.chatId || item.chatId || item.id || null,
          label: `Salvando ${payload.filename}...`,
          phase: 'escrita',
          errorCount: failures.size,
        });
        await saveExportPayload(payload);
        activeSession.nextIndex = i + 1;
        activeSession.failureIds = [...failures];
        activeSession = saveBatchExportSession(activeSession) || activeSession;
        updateExportProgress({
          current: i + 1,
          position: i + 1,
          completed: i + 1,
          title: item.title || item.chatId || item.id || null,
          currentChatId: item.chatId || item.id || null,
          label: item.title,
          phase: 'concluído',
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
          position: i + 1,
          completed: i + 1,
          title: item.title || item.chatId || item.id || null,
          currentChatId: item.chatId || item.id || null,
          label: `Falha em ${item.title}`,
          phase: 'falha',
          errorCount: failures.size,
        });
        warn(`Falha ao baixar ${item.chatId || item.id || i}.`, err);
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
          phase: 'retorno',
          errorCount: failures.size,
        });
        await openChatWithNavigationEngine(resumeOriginalItem, {
          ignoreBusy: true,
        });
      } catch (err) {
        warn('Falha ao voltar para a conversa original.', err);
      }
    } else if (resumeOriginalNotebookReturnItem && resumeOriginalWasNotebook && !isNotebookPage()) {
      try {
        updateExportProgress({
          current: activeSession.items.length,
          label: 'Voltando para o caderno...',
          phase: 'retorno',
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
        `Pronto! ${n} ${n === 1 ? 'conversa baixada' : 'conversas baixadas'} com sucesso.`,
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
        dirEl.title = `Pasta escolhida pela conexão local: ${state.bridgeOutputDir}`;
      } else if (state.directoryHandle) {
        dirEl.textContent = state.directoryHandle.name;
        dirEl.title = `Pasta escolhida pelo browser: ${state.directoryHandle.name}`;
      } else if (isExtensionContext) {
        dirEl.textContent = 'Downloads (fallback padrão)';
        dirEl.title =
          'Clique em Alterar para escolher uma pasta pela ferramenta local. Sem conexão local, cai em Downloads; mídias que falharem ficam como aviso no Markdown.';
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
        const count = humanCountFor(state.progress);
        const label = humanProgressLabelFor(state.progress);
        statusEl.textContent = count ? `${count}: ${label}` : label;
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
        ? 'Baixando...'
        : 'Baixar selecionadas';
    }

    [folderBtn, refreshBtn, selectAllBtn, clearBtn, closeBtn, currentBtn].forEach((btn) => {
      if (btn) btn.disabled = state.isExporting;
    });
    if (searchEl) searchEl.disabled = state.isExporting;
  };

  const ensureModal = () => {
    let modal = document.getElementById(MODAL_ID);
    if (modal?.dataset?.gmMdExportBuildStamp && modal.dataset.gmMdExportBuildStamp !== BUILD_STAMP) {
      modal.remove();
      modal = null;
    }
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.dataset.gmMdExportBuildStamp = BUILD_STAMP;
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
	          width: var(--gmn-modal-panel-width, min(760px, calc(100vw - 24px)));
	          height: var(--gmn-modal-panel-height, min(680px, calc(100vh - 24px)));
	          max-height: var(--gmn-modal-panel-max-height, min(680px, calc(100vh - 24px)));
	          display: flex;
	          flex-direction: column;
	          gap: var(--gmn-modal-panel-gap, 14px);
	          min-height: 0;
	          box-sizing: border-box;
          overflow: hidden;
          background: var(--gm-panel-bg);
          color: var(--gm-text);
          border-radius: var(--gmn-modal-panel-radius, 28px);
          border: 1px solid var(--gm-border);
          box-shadow:
            0 28px 64px rgba(0,0,0,0.40),
            0 2px 8px rgba(0,0,0,0.24);
          padding: var(--gmn-modal-panel-padding, 22px);
          font-family: var(--gm-font);
          font-size: var(--gmn-modal-font-size, 14px);
          line-height: var(--gmn-modal-line-height, 1.4);
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
          font-size: var(--gmn-modal-title-font-size, 20px);
          line-height: var(--gmn-modal-title-line-height, 1.2);
          font-weight: 500;
          letter-spacing: 0;
        }
        #${MODAL_ID} .gm-count-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 22px;
          padding: 0;
          background: transparent;
          border: 0;
          font-size: 13px;
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-count-chip:not(:empty)::before {
          content: "·";
          display: inline-block;
          margin-right: 8px;
          opacity: 0.6;
        }
        #${MODAL_ID} .gm-btn-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 36px;
          width: 36px;
          height: 36px;
          padding: 0;
          border-radius: 999px;
          border: none;
          background: transparent;
          color: var(--gm-text-muted);
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
          transition: background-color 180ms cubic-bezier(0.22, 0.61, 0.36, 1), color 180ms ease;
        }
        #${MODAL_ID} .gm-btn-close:hover {
          background: color-mix(in srgb, var(--gm-text) 8%, transparent);
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
          height: var(--gmn-modal-input-height, 40px);
          padding: 0 16px;
          border-radius: var(--gmn-modal-input-radius, 999px);
          border: 1px solid transparent;
          background: var(--gm-surface-muted);
          color: var(--gm-text);
          outline: none;
          font-size: 14px;
          line-height: var(--gmn-modal-input-height, 40px);
          transition: border-color 160ms ease, background-color 160ms ease;
        }
        #${MODAL_ID} .gm-input:focus {
          border-color: var(--gm-accent);
          background: var(--gm-surface-elevated);
        }
        #${MODAL_ID} .gm-input::placeholder {
          color: var(--gm-text-muted);
        }
        #${MODAL_ID} .gm-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          height: var(--gmn-modal-button-height, 40px);
          min-width: 0;
          border-radius: var(--gmn-modal-button-radius, 999px);
          padding: 0 18px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--gm-text);
          cursor: pointer;
          appearance: none;
          font-size: var(--gmn-modal-button-font-size, 13px);
          font-weight: var(--gmn-modal-button-font-weight, 500);
          line-height: 1;
          letter-spacing: 0.005em;
          transition:
            background-color 180ms cubic-bezier(0.22, 0.61, 0.36, 1),
            border-color 180ms ease,
            color 180ms ease,
            transform 120ms ease;
          white-space: nowrap;
        }
        #${MODAL_ID} .gm-btn:hover:not(:disabled) {
          background: color-mix(in srgb, var(--gm-text) 8%, transparent);
        }
        #${MODAL_ID} .gm-btn:active:not(:disabled) {
          transform: scale(0.97);
        }
        #${MODAL_ID} .gm-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        #${MODAL_ID} .gm-btn-primary {
          background: var(--gm-accent);
          border-color: transparent;
          color: var(--gm-accent-text);
        }
        #${MODAL_ID} .gm-btn-primary:hover:not(:disabled) {
          background: color-mix(in srgb, var(--gm-accent) 88%, white);
        }
        #${MODAL_ID} .gm-btn-success {
          background: var(--gm-accent-strong);
          border-color: transparent;
          color: var(--gm-accent-on-strong);
          padding: 0 22px;
          font-weight: 500;
        }
        #${MODAL_ID} .gm-btn-success:hover:not(:disabled) {
          background: color-mix(in srgb, var(--gm-accent-strong) 86%, white);
        }
        #${MODAL_ID} .gm-btn-ghost {
          background: transparent;
          border-color: transparent;
          color: var(--gm-text-muted);
          padding: 0 16px;
        }
        #${MODAL_ID} .gm-btn-ghost:hover:not(:disabled) {
          background: color-mix(in srgb, var(--gm-text) 8%, transparent);
          color: var(--gm-text);
        }
        #${MODAL_ID} .gm-destination {
          display: grid;
          grid-template-columns: 36px minmax(0, 1fr) auto;
          align-items: center;
          gap: 14px;
          padding: 12px 16px;
          border-radius: var(--gmn-modal-destination-radius, 18px);
          background: var(--gm-surface-muted);
          border: 1px solid transparent;
        }
        #${MODAL_ID} .gm-destination-icon {
          width: var(--gmn-modal-destination-icon-size, 36px);
          height: var(--gmn-modal-destination-icon-size, 36px);
          border-radius: 999px;
          background: var(--gm-badge-bg);
          color: var(--gm-badge-text);
          display: grid;
          place-items: center;
          flex-shrink: 0;
        }
        #${MODAL_ID} .gm-destination-icon svg {
          display: block;
          width: var(--gmn-modal-destination-icon-glyph-size, 18px);
          height: var(--gmn-modal-destination-icon-glyph-size, 18px);
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
	          gap: var(--gmn-modal-list-gap, 2px);
	          overflow-y: auto;
	          overflow-x: hidden;
	          flex: var(--gmn-modal-list-flex, 1 1 0);
	          min-height: var(--gmn-modal-list-min-height, 0);
	          max-height: none;
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
        #${MODAL_ID} .gm-list.is-virtual {
          gap: 0;
        }
        #${MODAL_ID} .gm-list.is-virtual .gm-conversation-item {
          margin-bottom: 2px;
        }
        #${MODAL_ID} .gm-virtual-spacer {
          flex: 0 0 auto;
          pointer-events: none;
        }
        /* Scrollbar mais discreto e coerente com o tema do modal. */
        #${MODAL_ID} .gm-list::-webkit-scrollbar {
          width: var(--gmn-modal-list-scrollbar-width, 10px);
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
          gap: var(--gmn-modal-list-row-gap, 12px);
          align-items: center;
          box-sizing: border-box;
          padding: var(--gmn-modal-list-row-padding, 10px 14px);
          min-height: var(--gmn-modal-list-row-min-height, 56px);
          border: 1px solid transparent;
          border-radius: var(--gmn-modal-list-row-radius, 16px);
          background: transparent;
          cursor: pointer;
          transition: background-color 180ms cubic-bezier(0.22, 0.61, 0.36, 1), border-color 180ms ease;
        }
        #${MODAL_ID} .gm-conversation-item:hover {
          background: color-mix(in srgb, var(--gm-text) 6%, transparent);
        }
        #${MODAL_ID} .gm-conversation-item:has(.gm-checkbox:checked) {
          background: var(--gm-badge-bg);
          color: var(--gm-badge-text);
        }
        #${MODAL_ID} .gm-conversation-item:has(.gm-checkbox:checked) .gm-conversation-title,
        #${MODAL_ID} .gm-conversation-item:has(.gm-checkbox:checked) .gm-conversation-id {
          color: var(--gm-badge-text);
        }
        #${MODAL_ID} .gm-checkbox {
          flex: 0 0 auto;
          justify-self: center;
          width: var(--gmn-modal-checkbox-size, 18px);
          height: var(--gmn-modal-checkbox-size, 18px);
          margin: 0;
          accent-color: var(--gm-accent);
          cursor: pointer;
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
        #${MODAL_ID} .gm-list-end.is-inconclusive {
          color: var(--gm-text);
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
            <strong>Baixar conversas</strong>
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
            <button data-action="export-current" class="gm-btn">Baixar atual</button>
            <button id="${MODAL_EXPORT_ID}" data-action="run-export" class="gm-btn gm-btn-success">Baixar selecionadas</button>
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
      state.modalVirtual.lastKey = '';
      const list = document.getElementById(MODAL_LIST_ID);
      if (list) list.scrollTop = 0;
      updateModalState();
    });

    const modalList = modal.querySelector(`#${MODAL_LIST_ID}`);
    if (modalList) {
      modalList.addEventListener('scroll', (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) handleModalListScrollPosition(target);
      });
      modalList.addEventListener('wheel', handleModalListWheel, { passive: false });
    }
    const modalPanel = modal.querySelector('[data-role="panel"]');
    if (modalPanel) {
      modalPanel.addEventListener('wheel', handleModalPanelWheel, { passive: false });
    }

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
        state.listLoadStatus = 'idle';
        const loaded = await loadMoreConversations(
          isNotebookPage() ? NOTEBOOK_LOAD_MORE_ATTEMPTS : SIDEBAR_LOAD_MORE_ATTEMPTS,
        );
        if (!loaded) {
          refreshConversationState();
          updateModalState();
          showToast(
            state.reachedSidebarEnd ? listEndStatusText() : listInconclusiveStatusText(),
            'info',
          );
        }
        return;
      }

      if (action === 'select-all') {
        const visibleIds = filteredConversationsForModal().map((item) => item.id);
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
            warn('Falha ao escolher pasta pela conexão local:', result.reason);
            showToast(
              'Não consegui abrir o seletor. Reabra o Gemini CLI ou rode o instalador de novo para restaurar a ferramenta local.',
              'error',
            );
            updateModalState();
          }
          return;
        }

        if (!supportsDirectoryPicker()) {
          showToast(
            'Este navegador não suporta escolher pasta. Use Chrome/Edge ou a ferramenta local.',
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
              'Não consegui salvar a pasta escolhida. Tente outra pasta ou reinicie a ferramenta local.',
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
          showToast('Marque pelo menos uma conversa na lista antes de baixar.', 'info');
          return;
        }
        if (selected.some((item) => item.exportable === false)) {
          showToast(
            'Algumas conversas do caderno não expõem ID — não consigo baixar em lote. Abra uma por uma e use "Baixar atual".',
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
    state.listLoadStatus = 'idle';
    if (!isNotebookPage()) {
      await ensureSidebarOpen();
    }
    refreshConversationState();
    const modal = ensureModal();
    startSidebarConversationObserver();
    applyCssVars(modal, buildHostPalette({ documentRef: document, isDark: isDarkTheme() }));
    applyNativeStyleProfile(modal);
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
      if (state.isExporting || state.activeTabOperation) {
        updateProgressDock();
        showToast('Esta aba já está ocupada. Aguarde o comando atual terminar.', 'info');
        return;
      }
      log('abrindo modal de download');
      await openExportModal();
    } catch (err) {
      console.error(LOG_PREFIX, 'falha ao abrir o modal', err);
      alert(`Falha ao abrir o modal: ${err?.message || err}`);
      showToast(
        'Não consegui abrir o modal de download. Abra o console (F12) para ver o motivo.',
        'error',
      );
    }
  };

  const refreshExtensionContext = async ({ force = false } = {}) => {
    const missingContext =
      bridgeState.tabId === null ||
      bridgeState.windowId === null ||
      !bridgeState.extensionVersion ||
      !bridgeState.buildStamp;
    if (
      !force &&
      !missingContext &&
      Date.now() - bridgeState.lastExtensionPingAt < BRIDGE_HEARTBEAT_PING_MS
    ) {
      return;
    }
    try {
      const ping = await extensionSendMessageWithRetry(
        { type: 'gemini-md-export/ping' },
        { timeoutMs: 2500, attempts: 2, retryDelayMs: 160 },
      );
      const extensionContext = ping.response;
      bridgeState.lastExtensionPingAt = Date.now();
      bridgeState.lastExtensionPingOkAt = bridgeState.lastExtensionPingAt;
      bridgeState.lastExtensionPingAttempts = ping.attempts;
      bridgeState.lastExtensionPingError = null;
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
    } catch (err) {
      bridgeState.lastExtensionPingAt = Date.now();
      bridgeState.lastExtensionPingAttempts = err?.attempts || 1;
      bridgeState.lastExtensionPingError = err?.message || String(err);
      bridgeState.lastError = err?.message || String(err);
    }
  };

  const sendBridgeSnapshot = async ({ force = false } = {}) => {
    if (!bridgeState.started || bridgeState.snapshotInFlight) return null;
    const ageMs = Date.now() - state.lastBridgeSnapshotAt;
    if (!force && !state.bridgeSnapshotDirty && ageMs < BRIDGE_SNAPSHOT_MAX_INTERVAL_MS) {
      return null;
    }
    if (!force && ageMs < BRIDGE_SNAPSHOT_MIN_INTERVAL_MS) return null;

    bridgeState.snapshotInFlight = true;
    try {
      const payload = buildBridgeSnapshotPayload();
      const response = await bridgeRequest('/bridge/snapshot', {
        method: 'POST',
        payload,
        timeoutMs: 10000,
      });
      if (response?.ok) {
        state.bridgeSnapshotHash = payload.snapshotHash;
        state.bridgeSnapshotDirty = false;
        state.bridgeSnapshotDirtyReason = '';
        state.lastBridgeSnapshotAt = Date.now();
      }
      return response;
    } finally {
      bridgeState.snapshotInFlight = false;
    }
  };

  const sendBridgeHeartbeat = async () => {
    if (!bridgeState.started || bridgeState.heartbeatInFlight) return;
    const client = getChatBridgeClient();
    bridgeState.heartbeatInFlight = true;
    bridgeState.lastHeartbeatStartedAt = Date.now();

    try {
      const response = await client.sendHeartbeat();
      syncChatBridgeClientState();
      if (client.state.lastError) {
        bridgeState.lastError = client.state.lastError;
        return;
      }

      bridgeState.lastHeartbeatAt = Date.now();
      bridgeState.lastHeartbeatDurationMs =
        bridgeState.lastHeartbeatAt - bridgeState.lastHeartbeatStartedAt;
      bridgeState.lastError = null;
      if (response?.snapshotRequested) {
        await sendBridgeSnapshot({ force: true });
      }
      const commandPollRequired = response?.commandPollRequired === true;
      if (!response?.transport?.eventsConnected) {
        closeBridgeEvents();
      }
      if (commandPollRequired || !response?.transport?.eventsConnected) {
        pollBridgeCommands(true, { force: commandPollRequired });
      } else {
        pollBridgeCommands(false);
      }
    } catch (err) {
      bridgeState.lastError = err?.message || String(err);
      throw err;
    } finally {
      bridgeState.heartbeatInFlight = false;
      syncChatBridgeClientState({ preserveHeartbeatInFlight: true });
    }
  };

  const postBridgeCommandResult = async (command, result) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await bridgeRequest('/bridge/command-result', {
          method: 'POST',
          payload: {
            clientId: bridgeState.clientId,
            commandId: command.id,
            result,
          },
          timeoutMs: 10000,
        });
        clearPendingBridgeCommand(pageWindow.sessionStorage, command.id);
        return response;
      } catch (err) {
        lastError = err;
        await sleep(150 * (attempt + 1));
      }
    }
    throw lastError;
  };

  let chatBridgeClient = null;

  const syncChatBridgeClientState = ({ preserveHeartbeatInFlight = false } = {}) => {
    if (!chatBridgeClient) return;
    bridgeState.clientId = chatBridgeClient.state.clientId;
    bridgeState.commandResultCache = chatBridgeClient.state.commandResultCache;
    if (!preserveHeartbeatInFlight) {
      bridgeState.heartbeatInFlight = chatBridgeClient.state.heartbeatInFlight;
    }
  };

  const getChatBridgeClient = () => {
    if (chatBridgeClient) {
      if (bridgeState.clientId && chatBridgeClient.state.clientId !== bridgeState.clientId) {
        chatBridgeClient.state.clientId = bridgeState.clientId;
      }
      syncChatBridgeClientState();
      return chatBridgeClient;
    }
    if (!bridgeState.clientId) bridgeState.clientId = randomId();
    chatBridgeClient = createBrowserBridgeClient({
      kind: 'chat',
      bridgeBaseUrl: BRIDGE_BASE_URL,
      capabilities: BRIDGE_PROTOCOL_CAPABILITIES,
      clientId: bridgeState.clientId,
      heartbeatIntervalMs: BRIDGE_HEARTBEAT_MS,
      heartbeatTimeoutMs: 4000,
      pollTimeoutMs: BRIDGE_POLL_TIMEOUT_MS,
      getPageSnapshot: buildBridgePageSummary,
      buildHeartbeatPayload: buildBridgeHeartbeatPayload,
      beforeHeartbeat: () => {
        refreshExtensionContextSoon({ reason: 'heartbeat' });
        reportTabBrokerStateSoon('heartbeat');
      },
      executeCommand: (command) =>
        runWithTabOperationBackpressure(command, (operationContext) =>
          executeBridgeCommand(command, operationContext),
        ),
      postCommandResult: postBridgeCommandResult,
      bridgeRequest,
      onCommandReceived: () => {
        bridgeState.lastCommandReceivedAt = Date.now();
      },
      onJobProgress: (jobProgress) => {
        try {
          handleMcpJobProgressBroadcast(jobProgress || null);
        } catch (err) {
          warn('Falha ao processar jobProgress do bridge.', err);
        }
      },
      onError: (err) => {
        bridgeState.lastError = err?.message || String(err);
      },
    });
    syncChatBridgeClientState();
    return chatBridgeClient;
  };

  const handleBridgeCommand = async (command) => {
    if (!command?.id) return;
    savePendingBridgeCommand(pageWindow.sessionStorage, command);
    const client = getChatBridgeClient();
    await client.handleCommand(command);
    syncChatBridgeClientState();
  };

  let pendingBridgeCommandResumeInFlight = false;
  const resumePendingBridgeCommand = async () => {
    if (pendingBridgeCommandResumeInFlight || !bridgeState.started) return;
    const command = readPendingBridgeCommand(pageWindow.sessionStorage);
    if (!command) return;
    pendingBridgeCommandResumeInFlight = true;
    try {
      await handleBridgeCommand(command);
    } finally {
      pendingBridgeCommandResumeInFlight = false;
    }
  };

  const resumePendingBridgeCommandSoon = () => {
    setTimeout(() => {
      resumePendingBridgeCommand().catch((err) => {
        bridgeState.lastError = err?.message || String(err);
      });
    }, 0);
  };

  const handleBridgeEventMessage = async (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data || '{}');
    } catch {
      payload = null;
    }
    if (event.type === 'command' && payload?.command) {
      await handleBridgeCommand(payload.command);
      return;
    }
    if (event.type === 'jobProgress') {
      handleMcpJobProgressBroadcast(payload || null);
    }
  };

  const closeBridgeEvents = () => {
    if (bridgeState.eventsReconnectTimer) {
      clearTimeout(bridgeState.eventsReconnectTimer);
      bridgeState.eventsReconnectTimer = 0;
    }
    if (bridgeState.eventSource) {
      try {
        bridgeState.eventSource.close();
      } catch {
        // ignore stale EventSource
      }
      bridgeState.eventSource = null;
    }
    bridgeState.eventsConnected = false;
    bridgeState.eventsConnecting = false;
  };

  const scheduleBridgeEventsReconnect = () => {
    if (!bridgeState.started || bridgeState.eventsReconnectTimer) return;
    const delayMs = increaseBridgeEventBackoff();
    bridgeState.eventsReconnectTimer = setTimeout(() => {
      bridgeState.eventsReconnectTimer = 0;
      connectBridgeEvents();
    }, delayMs);
  };

  const buildBridgeEventsSearchParams = () => {
    const params = new URLSearchParams();
    params.set('clientId', String(bridgeState.clientId || ''));
    if (bridgeState.tabId !== null && bridgeState.tabId !== undefined) {
      params.set('tabId', String(bridgeState.tabId));
    }
    if (bridgeState.windowId !== null && bridgeState.windowId !== undefined) {
      params.set('windowId', String(bridgeState.windowId));
    }
    if (bridgeState.isActiveTab !== null && bridgeState.isActiveTab !== undefined) {
      params.set('isActiveTab', bridgeState.isActiveTab ? '1' : '0');
    }
    if (bridgeState.extensionVersion) {
      params.set('extensionVersion', String(bridgeState.extensionVersion));
    }
    if (bridgeState.protocolVersion !== null && bridgeState.protocolVersion !== undefined) {
      params.set('protocolVersion', String(bridgeState.protocolVersion));
    }
    if (bridgeState.buildStamp) {
      params.set('buildStamp', String(bridgeState.buildStamp));
    }
    const claim = tabClaimSummary();
    if (claim?.claimId) params.set('claimId', String(claim.claimId));
    if (claim?.sessionId) params.set('claimSessionId', String(claim.sessionId));
    return params.toString();
  };

  function connectBridgeEvents() {
    if (
      !bridgeState.started ||
      bridgeState.eventsConnected ||
      bridgeState.eventsConnecting ||
      typeof EventSource !== 'function'
    ) {
      return;
    }
    bridgeState.eventsConnecting = true;
    const url = `${BRIDGE_BASE_URL}/bridge/events?${buildBridgeEventsSearchParams()}`;
    const events = new EventSource(url);
    bridgeState.eventSource = events;
    events.addEventListener('open', () => {
      bridgeState.eventsConnected = true;
      bridgeState.eventsConnecting = false;
      bridgeState.lastError = null;
      resetBridgeEventBackoff();
      pollBridgeCommands(false);
    });
    events.addEventListener('command', (event) => {
      handleBridgeEventMessage(event).catch((err) => {
        bridgeState.lastError = err?.message || String(err);
      });
    });
    events.addEventListener('jobProgress', (event) => {
      handleBridgeEventMessage(event).catch((err) => {
        bridgeState.lastError = err?.message || String(err);
      });
    });
    events.addEventListener('error', () => {
      if (bridgeState.eventSource === events) {
        closeBridgeEvents();
        scheduleBridgeEventsReconnect();
        pollBridgeCommands(true);
      }
    });
  }

  const pollBridgeCommands = async (enabled = true, { force = false } = {}) => {
    if (!enabled) return;
    if (!bridgeState.started || bridgeState.polling || (bridgeState.eventsConnected && !force)) return;
    bridgeState.polling = true;
    let errorBackoffMs = BRIDGE_POLL_ERROR_BACKOFF_MS;

    while (bridgeState.started && (!bridgeState.eventsConnected || force)) {
      try {
        bridgeState.lastCommandPollStartedAt = Date.now();
        const response = await bridgeRequest(
          `/bridge/command?clientId=${encodeURIComponent(bridgeState.clientId)}`,
          { timeoutMs: BRIDGE_POLL_TIMEOUT_MS },
        );
        bridgeState.lastCommandPollEndedAt = Date.now();
        errorBackoffMs = BRIDGE_POLL_ERROR_BACKOFF_MS;

        if (!response?.command) {
          if (Date.now() - bridgeState.lastCommandPollStartedAt < MIN_FAST_POLL_BACKOFF_MS) {
            await sleep(MIN_FAST_POLL_BACKOFF_MS);
          }
          continue;
        }

        await handleBridgeCommand(response.command);
      } catch (err) {
        bridgeState.lastCommandPollEndedAt = Date.now();
        bridgeState.lastError = err?.message || String(err);
        await sleep(errorBackoffMs);
        errorBackoffMs = Math.min(
          BRIDGE_EVENTS_MAX_BACKOFF_MS,
          bridgeBackoffWithJitter(
            errorBackoffMs * 2,
            BRIDGE_POLL_ERROR_BACKOFF_MS,
            BRIDGE_EVENTS_MAX_BACKOFF_MS,
          ),
        );
      }
    }

    bridgeState.polling = false;
  };

  const installExtensionBridge = async () => {
    if (!isExtensionContext || bridgeState.started) return;
    if (isTabIgnored()) {
      log('aba marcada como ignorada; bridge MCP não vai iniciar nesta aba.');
      return;
    }

    bridgeState.clientId = getOrCreateChatClientId();
    refreshExtensionContextSoon({ force: true, reason: 'install' });

    const client = getChatBridgeClient();
    await client.start({ connectEvents: false, startHeartbeatTimer: false });
    bridgeState.started = client.state.started;
    connectBridgeEvents();

    const heartbeatTick = async () => {
      try {
        await sendBridgeHeartbeat();
      } catch {
        // bridge offline; retry silently
      }
    };

    await heartbeatTick();
    bridgeState.heartbeatTimer = setInterval(heartbeatTick, BRIDGE_HEARTBEAT_MS);
    pollBridgeCommands(!bridgeState.eventsConnected);
    resumePendingBridgeCommandSoon();
    log('bridge da extensão iniciado', {
      bridgeBaseUrl: BRIDGE_BASE_URL,
      clientId: bridgeState.clientId,
      tabId: bridgeState.tabId,
    });
  };

  // Para a bridge nesta aba sem mexer no MCP nem na extensão. O long-poll
  // sai sozinho na próxima iteração do `while (bridgeState.started)`; o MCP
  // limpa o cliente sozinho via timeout de stale.
  const stopExtensionBridge = () => {
    if (chatBridgeClient) {
      chatBridgeClient.stop();
    }
    if (bridgeState.heartbeatTimer) {
      clearInterval(bridgeState.heartbeatTimer);
      bridgeState.heartbeatTimer = 0;
    }
    if (state.tabClaim) {
      releaseCurrentTabClaim({ reason: 'bridge-stopped' }).catch(() => {
        clearLocalTabClaim();
      });
    }
    closeBridgeEvents();
    bridgeState.started = false;
  };

  try {
    const runtime = pageWindow[RUNTIME_GUARD_KEY];
    if (runtime?.buildStamp === BUILD_STAMP) {
      runtime.stop = () => {
        stopExtensionBridge();
      };
    }
  } catch {
    // Guard de runtime é diagnóstico; não deve bloquear a extensão.
  }

  const applyTabIgnoredState = () => {
    if (isTabIgnored()) {
      stopExtensionBridge();
      return;
    }
    if (!bridgeState.started) {
      installExtensionBridge().catch((err) => {
        warn('Falha ao reiniciar bridge após desfazer ignorar aba.', err);
      });
    }
  };

  if (typeof pageWindow.addEventListener === 'function') {
    pageWindow.addEventListener(TAB_IGNORE_CHANGED_EVENT, applyTabIgnoredState);
  }

  // --- UI: botão -------------------------------------------------------

  // Aplica o visual idiomático do top-bar do Gemini no botão. Idempotente
  // (pode ser chamado em re-parenting sem duplicar listeners, porque quem
  // monta o botão só o faz uma vez — re-parenting só reseta estilos).
	  const styleAsTopBarIconButton = (btn) => {
	    applyNativeStyleProfile(btn);
	    // Adiciona classes nativas do Material 3 do Gemini para herdar
	    // hover/focus/ripple do CSS global do host. O fallback fica no tamanho
	    // do botão icon-only da top-bar; o slot externo guarda o respiro.
    for (const cls of [
      'mdc-icon-button',
      'mat-mdc-icon-button',
      'mat-mdc-button-base',
      'mat-unthemed',
    ]) {
      if (!btn.classList.contains(cls)) btn.classList.add(cls);
    }
    Object.assign(btn.style, {
	      display: 'inline-flex',
	      alignItems: 'center',
	      justifyContent: 'center',
	      flex: `0 0 ${nativeStyleVar('--gmn-topbar-button-size', '40px')}`,
	      padding: nativeStyleVar('--gmn-topbar-button-padding', '10px'),
	      width: nativeStyleVar('--gmn-topbar-button-size', '40px'),
	      height: nativeStyleVar('--gmn-topbar-button-size', '40px'),
      borderRadius: nativeStyleVar('--gmn-topbar-radius', '9999px'),
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      outline: 'none',
      boxShadow: 'none',
      lineHeight: '0',
      verticalAlign: 'middle',
      appearance: 'none',
      transition: 'all 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      // limpa resíduo de um eventual render FAB legado
	      position: '',
	      right: '',
	      bottom: '',
	      zIndex: '',
	    });
	  };

	  const installTopBarButtonFallbackStateHandlers = (btn) => {
	    if (btn.dataset.gmTopBarStateHandlers === '1') return;
	    btn.dataset.gmTopBarStateHandlers = '1';
	    const setButtonState = (state = 'normal') => {
	      btn.dataset.gmTopBarState = state;
	      const backgrounds = {
	        normal: 'transparent',
	        hover: nativeStyleVar(
	          '--gmn-topbar-state-hover',
	          'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.08))',
	        ),
	        focus: nativeStyleVar(
	          '--gmn-topbar-state-focus',
	          'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.10))',
	        ),
	        pressed: nativeStyleVar(
	          '--gmn-topbar-state-pressed',
	          'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.14))',
	        ),
	      };
	      btn.style.background = backgrounds[state] || backgrounds.normal;
	    };
	    let pointerInside = false;
	    btn.addEventListener('mouseenter', () => {
	      pointerInside = true;
	      setButtonState('hover');
	    });
	    btn.addEventListener('mouseleave', () => {
	      pointerInside = false;
	      setButtonState('normal');
	    });
	    btn.addEventListener('focus', () => setButtonState('focus'));
	    btn.addEventListener('blur', () => setButtonState('normal'));
	    btn.addEventListener('mousedown', () => setButtonState('pressed'));
	    btn.addEventListener('mouseup', () => setButtonState(pointerInside ? 'hover' : 'normal'));
	  };

  const styleAsTopBarSlot = (slot) => {
    applyNativeStyleProfile(slot);
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
	      flex: `0 0 ${nativeStyleVar('--gmn-topbar-slot-size', '40px')}`,
	      width: nativeStyleVar('--gmn-topbar-slot-size', '40px'),
	      height: nativeStyleVar('--gmn-topbar-slot-size', '40px'),
	      margin: '0',
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
    btn.removeAttribute('title');
  };

  const closeTopBarTooltip = () => {
    document.getElementById(TOPBAR_TOOLTIP_ID)?.remove();
  };

  const positionTopBarTooltip = (tooltip, btn) => {
    const rect = btn.getBoundingClientRect();
    const viewportWidth =
      pageWindow.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight =
      pageWindow.innerHeight || document.documentElement?.clientHeight || 0;
    const tipRect = tooltip.getBoundingClientRect();
    const top = Math.max(8, Math.min(viewportHeight - tipRect.height - 8, rect.top - 2));
    const right = Math.max(8, viewportWidth - rect.left + 10);
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.right = `${Math.round(right)}px`;
  };

  const showTopBarTooltip = (btn) => {
    if (document.getElementById(MENU_ID)) return;
    closeTopBarTooltip();
    const tooltip = document.createElement('div');
    tooltip.id = TOPBAR_TOOLTIP_ID;
    tooltip.textContent = 'Baixar como Markdown';
    tooltip.setAttribute('role', 'tooltip');
    applyNativeStyleProfile(tooltip);
    Object.assign(tooltip.style, {
      position: 'fixed',
      zIndex: String(MENU_ZINDEX + 1),
      background: nativeStyleVar('--gmn-tooltip-bg', 'rgb(241, 243, 244)'),
      color: nativeStyleVar('--gmn-tooltip-text', 'rgb(32, 33, 36)'),
      borderRadius: nativeStyleVar('--gmn-tooltip-radius', '18px'),
      padding: nativeStyleVar('--gmn-tooltip-padding', '12px 28px'),
      minHeight: nativeStyleVar('--gmn-tooltip-min-height', '40px'),
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      fontFamily: 'var(--gm-menu-font, "Google Sans Text","Google Sans",Roboto,Arial,sans-serif)',
      fontSize: nativeStyleVar('--gmn-tooltip-font-size', '14px'),
      lineHeight: nativeStyleVar('--gmn-tooltip-line-height', '20px'),
      fontWeight: nativeStyleVar('--gmn-tooltip-font-weight', '400'),
      letterSpacing: '0',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      boxShadow: 'none',
    });
    const arrow = document.createElement('span');
    Object.assign(arrow.style, {
      position: 'absolute',
      right: '-7px',
      top: '50%',
      width: nativeStyleVar('--gmn-tooltip-arrow-size', '14px'),
      height: nativeStyleVar('--gmn-tooltip-arrow-size', '14px'),
      transform: 'translateY(-50%) rotate(45deg)',
      background: nativeStyleVar('--gmn-tooltip-bg', 'rgb(241, 243, 244)'),
      borderRadius: nativeStyleVar('--gmn-tooltip-arrow-radius', '2px'),
    });
    tooltip.appendChild(arrow);
    document.body.appendChild(tooltip);
    positionTopBarTooltip(tooltip, btn);
  };

  const installTopBarTooltipHandlers = (btn) => {
    if (btn.dataset.gmTopBarTooltipHandlers === '1') return;
    btn.dataset.gmTopBarTooltipHandlers = '1';
    btn.addEventListener('mouseenter', () => showTopBarTooltip(btn));
    btn.addEventListener('mouseleave', closeTopBarTooltip);
    btn.addEventListener('focus', () => showTopBarTooltip(btn));
    btn.addEventListener('blur', closeTopBarTooltip);
    btn.addEventListener('mousedown', closeTopBarTooltip);
    btn.addEventListener('click', closeTopBarTooltip);
  };

  // Menu popover ancorado ao botão. Sem `chrome.action` popup; o menu é DOM
  // próprio com palette `--gm-menu-*` aplicada no próprio elemento (não
  // depende do dock/modal estarem abertos para herdar tema).
  const MENU_ZINDEX = 10004;
  let menuOutsideClickHandler = null;
  let menuKeydownHandler = null;
  let menuRepositionHandler = null;
  let menuScrollHandler = null;

  const buildMenuPalette = () =>
    buildMenuHostPalette({ documentRef: document, isDark: isDarkTheme() });

  const closeTopBarMenu = () => {
    const existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (menuOutsideClickHandler) {
      document.removeEventListener('mousedown', menuOutsideClickHandler, true);
      menuOutsideClickHandler = null;
    }
    if (menuKeydownHandler) {
      document.removeEventListener('keydown', menuKeydownHandler, true);
      menuKeydownHandler = null;
    }
    if (menuRepositionHandler && typeof pageWindow.removeEventListener === 'function') {
      pageWindow.removeEventListener('resize', menuRepositionHandler, true);
      menuRepositionHandler = null;
    }
    if (menuScrollHandler && typeof pageWindow.removeEventListener === 'function') {
      pageWindow.removeEventListener('scroll', menuScrollHandler, true);
      menuScrollHandler = null;
    }
  };

  const positionTopBarMenu = (menu, btn) => {
    const rect = btn.getBoundingClientRect();
    const viewportWidth =
      pageWindow.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight =
      pageWindow.innerHeight || document.documentElement?.clientHeight || 0;
    menu.style.position = 'fixed';
    // Alinha o canto superior direito do menu com o canto inferior direito do
    // botão, com o mesmo respiro vertical observado nos popovers nativos.
    const top = Math.min(
      Math.max(8, Math.round(rect.bottom + 8)),
      Math.max(8, viewportHeight - 8),
    );
    const right = Math.max(8, Math.round(viewportWidth - rect.right));
    menu.style.top = `${top}px`;
    menu.style.right = `${right}px`;
    menu.style.left = 'auto';
    menu.style.maxHeight = `${Math.max(160, viewportHeight - top - 16)}px`;
    menu.style.overflowY = 'auto';
  };

  const setMenuItemVisualState = (el, state = 'normal') => {
    el.dataset.gmMenuState = state;
    const backgrounds = {
      normal: 'transparent',
      hover: 'var(--gm-menu-hover)',
      focus: 'var(--gm-menu-focus)',
      pressed: 'var(--gm-menu-pressed)',
    };
    el.style.background = backgrounds[state] || backgrounds.normal;
  };

  const installMenuItemStateHandlers = (el) => {
    if (el.dataset.gmMenuStateHandlers === '1') return;
    el.dataset.gmMenuStateHandlers = '1';
    let pointerInside = false;
    el.addEventListener('mouseenter', () => {
      pointerInside = true;
      setMenuItemVisualState(el, 'hover');
    });
    el.addEventListener('mouseleave', () => {
      pointerInside = false;
      setMenuItemVisualState(el, 'normal');
    });
    el.addEventListener('focus', () => setMenuItemVisualState(el, 'focus'));
    el.addEventListener('blur', () => setMenuItemVisualState(el, 'normal'));
    el.addEventListener('mousedown', () => setMenuItemVisualState(el, 'pressed'));
    el.addEventListener('mouseup', () =>
      setMenuItemVisualState(el, pointerInside ? 'hover' : 'normal'),
    );
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        setMenuItemVisualState(el, 'pressed');
      }
    });
    el.addEventListener('keyup', () => setMenuItemVisualState(el, 'focus'));
  };

  // Itens usam classes nativas (`mat-mdc-menu-item`) e também carregam um
  // fallback explícito para estados. Como o popover vive fora do overlay CDK,
  // não dá para depender só do CSS global do host para hover/focus/pressed.
  const styleMenuItem = (el, options = {}) => {
    const minHeight =
      options.minHeight || nativeStyleVar('--gmn-menu-item-min-height', '56px');
    Object.assign(el.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      minHeight,
      padding: nativeStyleVar('--gmn-menu-item-padding', '8px 16px'),
      border: '0',
	      background: 'transparent',
	      color: 'inherit',
	      cursor: 'pointer',
	      font: 'inherit',
	      fontFamily: 'inherit',
	      fontSize: nativeStyleVar('--gmn-menu-font-size', '14px'),
	      lineHeight: nativeStyleVar('--gmn-menu-line-height', '20px'),
	      fontWeight: nativeStyleVar('--gmn-menu-font-weight', '400'),
	      boxSizing: 'border-box',
	      borderRadius: nativeStyleVar('--gmn-menu-item-radius', '0'),
	      outline: 'none',
      transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1)',
      WebkitTapHighlightColor: 'transparent',
    });
    installMenuItemStateHandlers(el);
  };

  const createMenuLeadingSlot = ({ checked = false, iconHtml = '' } = {}) => {
    const slot = document.createElement('span');
    Object.assign(slot.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: `0 0 ${nativeStyleVar('--gmn-menu-leading-slot-size', '20px')}`,
      width: nativeStyleVar('--gmn-menu-leading-slot-size', '20px'),
      height: nativeStyleVar('--gmn-menu-leading-slot-size', '20px'),
      color: 'var(--gm-menu-text)',
      visibility: checked || iconHtml ? 'visible' : 'hidden',
      lineHeight: '0',
      pointerEvents: 'none',
    });
    const visualHtml = iconHtml || (checked ? MENU_CHECK_ICON_SVG : '');
    if (visualHtml) {
      const tpl = document.createElement('template');
      tpl.innerHTML = visualHtml;
      const icon = tpl.content.firstElementChild;
      if (icon instanceof SVGElement) {
        icon.setAttribute('width', '20');
        icon.setAttribute('height', '20');
        slot.appendChild(icon);
      }
    }
    return slot;
  };

  const createMenuTextColumn = () => {
    const textColumn = document.createElement('span');
    Object.assign(textColumn.style, {
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minWidth: '0',
    });
    return textColumn;
  };

  const createMenuPrimaryText = (text) => {
    const label = document.createElement('span');
    label.textContent = text;
    Object.assign(label.style, {
	      display: 'block',
	      color: 'var(--gm-menu-text)',
	      fontSize: nativeStyleVar('--gmn-menu-font-size', '14px'),
	      lineHeight: nativeStyleVar('--gmn-menu-line-height', '20px'),
	      fontWeight: nativeStyleVar('--gmn-menu-font-weight', '400'),
	      letterSpacing: '0',
	      whiteSpace: 'normal',
	    });
    return label;
  };

	  const renderIgnoreMenuItem = (item) => {
	    const ignored = isTabIgnored();
	    item.setAttribute('aria-checked', ignored ? 'true' : 'false');
	    item.setAttribute(
	      'aria-label',
	      ignored
	        ? 'Ignorar esta aba. A conexão local está desligada nesta aba.'
	        : 'Ignorar esta aba. Desliga a conexão local só nesta aba.',
	    );
	    item.dataset.checked = ignored ? '1' : '0';
	    item.dataset.gmMenuChecked = ignored ? 'true' : 'false';
	    item.classList.toggle('gm-menu-item-checked', ignored);
	    while (item.firstChild) item.removeChild(item.firstChild);

    const row = document.createElement('span');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: nativeStyleVar('--gmn-menu-leading-gap', '12px'),
    });

    const check = createMenuLeadingSlot({ checked: ignored });
    const textColumn = createMenuTextColumn();
    const label = createMenuPrimaryText('Ignorar esta aba');
    row.appendChild(check);
    row.appendChild(textColumn);

    const sub = document.createElement('span');
    sub.textContent = ignored
      ? 'A conexão local está desligada nesta aba.'
      : 'Desliga a conexão local só nesta aba.';
    Object.assign(sub.style, {
      display: 'block',
      marginTop: '0',
      fontSize: nativeStyleVar('--gmn-menu-font-size', '14px'),
	      lineHeight: nativeStyleVar('--gmn-menu-line-height', '20px'),
	      fontWeight: nativeStyleVar('--gmn-menu-font-weight', '400'),
	      color: 'var(--gm-menu-muted)',
	      letterSpacing: '0',
	      whiteSpace: 'normal',
	    });

    textColumn.appendChild(label);
    textColumn.appendChild(sub);
    item.appendChild(row);
  };

  // Clona um menu/popover nativo do Gemini, se houver algum aberto em outro
  // lugar do DOM (ex.: o usuário acabou de fechar o kebab e o overlay-pane
  // ainda está no DOM). Devolve a casca pra usarmos como menu. Esse caminho
  // garante paridade total com a paleta/elevação/cantos do Gemini lr26 sem
  // depender de hardcode local.
  const findNativeMenuPanelReference = () => {
    const candidates = [
      '.cdk-overlay-container .mat-mdc-menu-panel',
      '.mat-mdc-menu-panel',
      '.cdk-overlay-container gem-popover',
      'gem-popover',
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) return el;
    }
    return null;
  };

  const cloneNativeMenuPanelShell = (reference) => {
    if (!reference) return null;
    const clone = reference.cloneNode(false); // só a casca; sem children
    // Limpa atributos potencialmente bagunçados do Angular
    clone.removeAttribute('id');
    clone.removeAttribute('aria-labelledby');
    clone.removeAttribute('aria-describedby');
    return clone;
  };

  const buildMenuItemNative = (referenceItem) => {
    // Se temos um menu item nativo de exemplo, clone sem children e tira
    // attributes específicos. Senão, cai num <button class="mat-mdc-menu-item">.
    if (referenceItem) {
      const clone = referenceItem.cloneNode(false);
      clone.removeAttribute('id');
      clone.removeAttribute('aria-labelledby');
      clone.removeAttribute('disabled');
      clone.removeAttribute('aria-disabled');
      return clone;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'mat-mdc-menu-item mat-mdc-focus-indicator mat-focus-indicator mdc-list-item mat-mdc-menu-item-text';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    return btn;
  };

  const openTopBarMenu = (btn) => {
    closeTopBarMenu();

    const referenceMenu = findNativeMenuPanelReference();
    const referenceItem =
      referenceMenu?.querySelector('button.mat-mdc-menu-item, [role="menuitem"]') || null;

    const menu = cloneNativeMenuPanelShell(referenceMenu) || document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.dataset.role = 'gm-md-export-menu';
    // Garante classes nativas para puxar CSS de elevação/cantos/cor do host
    // mesmo quando não há nenhum menu nativo aberto no momento.
    const ensureClass = (cls) => {
      if (!menu.classList.contains(cls)) menu.classList.add(cls);
    };
    ensureClass('mat-mdc-menu-panel');
    ensureClass('mdc-menu');
    ensureClass('mdc-menu-surface');
    ensureClass('mat-mdc-elevation-z8');
    ensureClass('mat-elevation-z8');
    ensureClass('mat-mdc-menu-panel-animations-enabled');

    const palette = buildMenuPalette();
    Object.entries(palette).forEach(([k, v]) => menu.style.setProperty(k, v));
    applyNativeStyleProfile(menu);
    Object.assign(menu.style, {
      position: 'fixed',
      width: nativeStyleVar('--gmn-menu-width', '242px'),
      boxSizing: 'border-box',
      padding: '0',
      overflow: 'hidden',
	      background:
	        'var(--gem-sys-color--surface-container, var(--mat-sys-surface-container, var(--gm-menu-bg)))',
	      color: 'var(--mat-sys-on-surface, var(--gm-menu-text))',
	      borderRadius: 'var(--gem-sys-shape--corner-xl, var(--gmn-menu-radius, 20px))',
	      boxShadow: nativeStyleVar(
	        '--gmn-menu-shadow',
	        'rgba(0, 0, 0, 0.28) 0px 0px 20px 0px',
	      ),
	      fontFamily: 'var(--gm-menu-font)',
	      fontSize: nativeStyleVar('--gmn-menu-font-size', '14px'),
	      lineHeight: nativeStyleVar('--gmn-menu-line-height', '20px'),
	      zIndex: String(MENU_ZINDEX),
    });

    const contentWrap = document.createElement('div');
    contentWrap.className = 'mat-mdc-menu-content';
    contentWrap.setAttribute('role', 'none');
    contentWrap.style.padding = '0';
    menu.appendChild(contentWrap);

    const exportItem = buildMenuItemNative(referenceItem);
    exportItem.setAttribute('role', 'menuitem');
    exportItem.dataset.role = 'gm-menu-export';
    // Limpa filhos do clone e adiciona um wrapper de texto nativo.
    exportItem.replaceChildren();
    const exportRow = document.createElement('span');
    exportRow.className = 'mat-mdc-menu-item-text';
    Object.assign(exportRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: nativeStyleVar('--gmn-menu-leading-gap', '12px'),
      width: '100%',
    });
    exportRow.appendChild(createMenuLeadingSlot());
    const exportTextColumn = createMenuTextColumn();
    exportTextColumn.appendChild(createMenuPrimaryText('Baixar como Markdown'));
    exportRow.appendChild(exportTextColumn);
    exportItem.appendChild(exportRow);
	    styleMenuItem(exportItem);
    exportItem.addEventListener('click', () => {
      closeTopBarMenu();
      safeOpenExportModal();
    });

    const divider = document.createElement('div');
    divider.className = 'mat-mdc-menu-divider mat-divider';
    divider.setAttribute('role', 'separator');
    Object.assign(divider.style, {
      height: '1px',
      margin: nativeStyleVar('--gmn-menu-divider-margin', '0 16px'),
      background:
        'var(--gem-sys-color--outline-variant, var(--mat-sys-outline-variant, var(--gm-menu-divider)))',
      border: 'none',
    });

    const ignoreItem = buildMenuItemNative(referenceItem);
    ignoreItem.setAttribute('role', 'menuitemcheckbox');
    ignoreItem.dataset.role = 'gm-menu-ignore-tab';
    ignoreItem.replaceChildren();
	    styleMenuItem(ignoreItem, {
	      minHeight: nativeStyleVar('--gmn-menu-checkbox-item-min-height', '76px'),
	    });
    renderIgnoreMenuItem(ignoreItem);
    ignoreItem.addEventListener('click', () => {
      const next = !isTabIgnored();
      setTabIgnored(next);
      renderIgnoreMenuItem(ignoreItem);
      try {
        showToast(
          next
            ? 'Aba ignorada. A conexão local não vai usar esta aba até você reativar aqui.'
            : 'Aba reativada. A conexão local voltou.',
          'info',
        );
      } catch {
        // toast pode não estar disponível em testes; estado já foi aplicado
      }
    });

    contentWrap.appendChild(exportItem);
    contentWrap.appendChild(divider);
    contentWrap.appendChild(ignoreItem);
    document.body.appendChild(menu);
    positionTopBarMenu(menu, btn);
    btn.setAttribute('aria-expanded', 'true');

    menuOutsideClickHandler = (ev) => {
      if (menu.contains(ev.target) || btn.contains(ev.target)) return;
      closeTopBarMenu();
    };
    menuKeydownHandler = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeTopBarMenu();
        try {
          btn.focus();
        } catch {
          // foco pode falhar em alguns runtimes; ok
        }
      }
    };
    menuRepositionHandler = () => {
      const live = document.getElementById(MENU_ID);
      const btnLive = document.getElementById(BUTTON_ID);
      if (live && btnLive) positionTopBarMenu(live, btnLive);
    };
    menuScrollHandler = () => closeTopBarMenu();

    document.addEventListener('mousedown', menuOutsideClickHandler, true);
    document.addEventListener('keydown', menuKeydownHandler, true);
    if (typeof pageWindow.addEventListener === 'function') {
      pageWindow.addEventListener('resize', menuRepositionHandler, true);
      pageWindow.addEventListener('scroll', menuScrollHandler, true);
    }
  };

  const toggleTopBarMenu = (event) => {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    if (document.getElementById(MENU_ID)) {
      closeTopBarMenu();
      return;
    }
    const btn = document.getElementById(BUTTON_ID);
    if (btn) openTopBarMenu(btn);
  };

  // Procura QUALQUER botão de ícone nativo do Gemini lr26 (mat-mdc-icon-button)
  // visível na página para usar como template visual. Clonar o nativo é o jeito
  // mais robusto de ficar visualmente idêntico aos botões vizinhos — herda
  // todas as regras CSS do host sem reimplementar. Em /app (home) o top-bar
  // pode não ter um exemplo, então procuramos page-wide e preferimos os mais
  // próximos do top-bar.
	  const findNativeIconButtonReference = (topBar = null) => {
	    const selectors = [
	      'top-bar-actions button.mat-mdc-icon-button',
	      'top-bar-actions button[mat-icon-button]',
	      'top-bar-actions conversation-actions-icon button',
	      'top-bar-actions .right-section button[aria-haspopup="menu"]',
	      'top-bar-actions .right-section button',
	      '.top-bar-actions .right-section button[aria-haspopup="menu"]',
	      '.top-bar-actions .right-section button',
	      'temp-chat-button button.mat-mdc-icon-button',
	      'gem-icon-button button.mat-mdc-icon-button',
	      'button.mat-mdc-icon-button',
      'button[mat-icon-button]',
      'button[class*="mat-mdc-icon-button"]',
	    ];
	    const seen = new Set();
	    const candidates = [];
	    const collectCandidate = (el) => {
	      if (!(el instanceof HTMLElement) || seen.has(el)) return;
	      seen.add(el);
	      if (el.id === BUTTON_ID || el.closest?.(`#${BUTTON_SLOT_ID}`)) return;
	      const rect = el.getBoundingClientRect();
	      if (rect.width <= 0 || rect.height <= 0) return;
	      if (rect.width < 32 || rect.height < 32) return;
	      candidates.push({ el, rect });
	    };
	    if (topBar instanceof Element) {
	      const scopedRoot =
	        topBar.querySelector('.right-section') ||
	        topBar.querySelector('.top-bar-actions') ||
	        topBar;
	      for (const el of scopedRoot.querySelectorAll(
	        'button.mat-mdc-icon-button, button[mat-icon-button], conversation-actions-icon button, temp-chat-button button, button[aria-haspopup="menu"], button',
	      )) {
	        collectCandidate(el);
	      }
	    }
	    for (const selector of selectors) {
	      for (const el of document.querySelectorAll(selector)) {
	        collectCandidate(el);
	      }
	    }
	    if (candidates.length === 0) return null;
	    candidates.sort((a, b) => {
	      const topDelta = a.rect.top - b.rect.top;
	      if (Math.abs(topDelta) > 2) return topDelta;
	      return b.rect.left - a.rect.left;
	    });
	    return candidates[0].el;
	  };

  // Limpa state Angular do clone (atributos `_ngcontent`/`_nghost` ficam
  // intactos porque o CSS view-encapsulated do Gemini só pinta filhos do
  // template original. Removemos só listeners residuais via cloneNode profundo.)
  const sanitizeClonedNativeButton = (clone) => {
    clone.id = BUTTON_ID;
    clone.type = 'button';
    clone.removeAttribute('disabled');
    clone.removeAttribute('aria-disabled');
	    clone.removeAttribute('data-test-id');
	    clone.removeAttribute('data-mat-icon-name');
	    clone.removeAttribute('data-mat-icon-namespace');
	    clone.removeAttribute('id-for-mat-menu-trigger');
	    clone.removeAttribute('title');
	    clone.setAttribute('aria-label', BUTTON_LABEL);
	    clone.setAttribute('aria-haspopup', 'menu');
	    clone.setAttribute('aria-expanded', 'false');
	  };

	  const createDownloadIconSvg = () => {
	    const tpl = document.createElement('template');
	    tpl.innerHTML = BUTTON_ICON_SVG.trim();
	    return tpl.content.firstElementChild;
	  };

	  const styleDownloadIconHost = (host) => {
	    host.setAttribute('aria-hidden', 'true');
	    Object.assign(host.style, {
	      display: 'inline-flex',
	      alignItems: 'center',
	      justifyContent: 'center',
      width: nativeStyleVar('--gmn-topbar-icon-size', '20px'),
      height: nativeStyleVar('--gmn-topbar-icon-size', '20px'),
      minWidth: nativeStyleVar('--gmn-topbar-icon-size', '20px'),
      fontSize: nativeStyleVar('--gmn-topbar-icon-size', '20px'),
      lineHeight: nativeStyleVar('--gmn-topbar-icon-size', '20px'),
      color: 'inherit',
      textIndent: '0',
      letterSpacing: 'normal',
	      overflow: 'visible',
	    });
	    const svg = createDownloadIconSvg();
	    if (svg) {
	      svg.setAttribute('width', '20');
	      svg.setAttribute('height', '20');
	      host.replaceChildren(svg);
	    }
	  };

	  const swapClonedButtonIcon = (clone) => {
	    const iconHosts = clone.querySelectorAll(
	      'mat-icon, gem-icon, .material-symbols-outlined, .gds-icon, svg',
    );
	    if (iconHosts.length) {
	      const firstIconHost = iconHosts[0];
	      if (firstIconHost instanceof SVGElement) {
	        const svg = createDownloadIconSvg();
	        if (svg) firstIconHost.replaceWith(svg);
	        clone.dataset.gmMdExportIconMode = 'native-svg-replaced-svg';
	      } else {
	        styleDownloadIconHost(firstIconHost);
	        clone.dataset.gmMdExportIconMode = 'native-svg';
	      }
	      // Remove ícones extras (alguns botões nativos têm badge interno).
	      for (let i = 1; i < iconHosts.length; i += 1) {
	        iconHosts[i].remove();
	      }
	      return true;
	    }
	    setHtml(clone, BUTTON_ICON_SVG);
	    clone.dataset.gmMdExportIconMode = 'native-svg-fallback';
	    return false;
	  };

	  const createExportButton = (topBar = null) => {
	    const reference = findNativeIconButtonReference(topBar);

    // Caminho preferido lr26: clonar o nativo. Herda mdc/mat- classes,
    // spans de ripple, touch-target, estilos de hover/focus/ripple do CSS
    // global do Gemini. Garantia de paridade visual sem hardcodar.
    if (reference) {
      const clone = reference.cloneNode(true);
      sanitizeClonedNativeButton(clone);
	      swapClonedButtonIcon(clone);
	      markButtonAsCurrentBuild(clone);
	      applyNativeStyleProfile(clone);
	      installTopBarTooltipHandlers(clone);
	      clone.addEventListener('click', toggleTopBarMenu);
	      return clone;
	    }

    // Fallback (top-bar sem nativo identificável): cria botão neutro com
    // estilos manuais. Esse caminho não deveria disparar no Gemini lr26.
	    const btn = document.createElement('button');
	    btn.id = BUTTON_ID;
	    btn.type = 'button';
	    btn.setAttribute('aria-label', BUTTON_LABEL);
	    btn.setAttribute('aria-haspopup', 'menu');
	    btn.setAttribute('aria-expanded', 'false');
	    markButtonAsCurrentBuild(btn);
	    btn.dataset.gmMdExportIconMode = 'native-svg-fallback';
	    setHtml(btn, BUTTON_ICON_SVG);
	    styleAsTopBarIconButton(btn);
	    installTopBarTooltipHandlers(btn);
	    installTopBarButtonFallbackStateHandlers(btn);
	    btn.addEventListener('click', toggleTopBarMenu);

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
    pendingTimer: 0,
    lastRunAt: 0,
  };
  const NOT_FOUND_GRACE_MS = TOP_BAR_NOT_FOUND_GRACE_MS;
  const INJECT_THROTTLE_MS = 250;

  const scheduleInjectButton = () => {
    if (injectState.scheduled) return;
    injectState.scheduled = true;
    const run = () => {
      injectState.pendingTimer = 0;
      injectState.scheduled = false;
      injectState.lastRunAt = Date.now();
      injectButton();
    };
    const scheduleFrame = () => {
      const schedule =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (callback) => setTimeout(callback, 16);
      schedule(run);
    };
    const waitMs = Math.max(0, INJECT_THROTTLE_MS - (Date.now() - injectState.lastRunAt));
    if (waitMs > 0) {
      injectState.pendingTimer = setTimeout(scheduleFrame, waitMs);
      return;
    }
    scheduleFrame();
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
        const diagnostics = buildTopBarDiagnostics({ includeCandidates: true });
        warn(
          `top-bar não encontrado após ${Math.round(
            NOT_FOUND_GRACE_MS / 1000,
          )}s numa URL de conversa. Diagnóstico:`,
          diagnostics,
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
	      if (
	        !existing.querySelector('svg[data-role="gm-md-export-download-icon"]') ||
	        existing.textContent.includes('download')
	      ) {
	        swapClonedButtonIcon(existing);
	      }
	      installTopBarTooltipHandlers(existing);
	      placeInTopBar(existing, found);
	      // Reaplica o fallback só quando o botão não veio de clone nativo.
	      // O clone precisa manter dimensões/classes computadas do host.
	      if (existing.dataset.gmMdExportIconMode === 'native-svg-fallback') {
	        styleAsTopBarIconButton(existing);
	      }
	      return;
    }

	    const btn = createExportButton(found.target);
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
        state.listLoadStatus = 'idle';
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
        extensionPing: {
          lastAttemptAt: bridgeState.lastExtensionPingAt || null,
          lastOkAt: bridgeState.lastExtensionPingOkAt || null,
          lastAttempts: bridgeState.lastExtensionPingAttempts,
          lastError: bridgeState.lastExtensionPingError,
        },
        bridgeBaseUrl: BRIDGE_BASE_URL,
        lastHeartbeatAt: bridgeState.lastHeartbeatAt || null,
        lastHeartbeatDurationMs: bridgeState.lastHeartbeatDurationMs,
        eventsConnected: bridgeState.eventsConnected,
        eventsBackoffMs: bridgeState.eventsBackoffMs,
        polling: bridgeState.polling,
        snapshotDirty: state.bridgeSnapshotDirty,
        snapshotHash: state.bridgeSnapshotHash || null,
        lastBridgeSnapshotAt: state.lastBridgeSnapshotAt || null,
        tabIgnored: isTabIgnored(),
        transport: {
          preferred: bridgeTransportState.preferred,
          active: bridgeTransportState.active,
          nativeLastOkAt: bridgeTransportState.nativeLastOkAt || null,
          nativeDisabledUntil: bridgeTransportState.nativeDisabledUntil || null,
          nativeLastError: bridgeTransportState.nativeLastError || null,
        },
      }),
      isTabIgnored: () => isTabIgnored(),
      setTabIgnored: (value) => setTabIgnored(value),
      openTopBarMenu: () => {
        const btn = document.getElementById(BUTTON_ID);
        if (btn) openTopBarMenu(btn);
      },
      closeTopBarMenu: () => closeTopBarMenu(),
      openSidebarForDebug: (options = {}) => ensureSidebarOpen(options),
      showProgressForDebug: (progress) => {
        handleMcpJobProgressBroadcast({
          source: 'mcp',
          ...progress,
        });
        return {
          title: document.getElementById(`${PROGRESS_DOCK_ID}-title`)?.textContent || '',
          count: document.getElementById(`${PROGRESS_DOCK_ID}-count`)?.textContent || '',
          label: document.getElementById(`${PROGRESS_DOCK_ID}-label`)?.textContent || '',
          barWidth: document.getElementById(`${PROGRESS_DOCK_ID}-bar`)?.style.width || '',
        };
      },
      destination: () => ({
        bridgeOutputDir: state.bridgeOutputDir || null,
        browserDirectoryHandle: state.directoryHandle?.name || null,
        fallback: 'Downloads',
      }),
      navigationState: () => {
        const adapter = getGeminiDomAdapter();
        return {
          route: adapter.getRouteState(),
          rows: adapter.listConversationRows(),
          hydration: adapter.getHydrationState(),
        };
      },
      openChatWithNavigationForDebug: async (target = {}) => {
        const item =
          target.item ||
          findConversationForBridgeCommand({
            chatId: target.chatId,
            url: target.url,
            index:
              target.index !== undefined
                ? Number(target.index) + 1
                : target.rowIndex !== undefined
                  ? Number(target.rowIndex) + 1
                  : undefined,
          });
        const navigation = await openChatWithNavigationEngine(item);
        return navigation.navigationEngine || navigation;
      },
      notebookChatUrlCache: () => notebookChatUrlCacheSummary(),
      clearNotebookChatUrlCache: (notebookId) => clearNotebookChatUrlCache(notebookId),
      pendingBatchExport: () => loadBatchExportSession(),
      resumePendingBatchExport: () => resumePendingBatchExport(),
      clearPendingBatchExport: () => clearBatchExportSession(),
      snapshot: debugSnapshot,
      artifacts: (options = {}) => inspectArtifactDom(options),
      hydrateCurrentConversation: (options = {}) => hydrateConversationToTop(document, window, options),
      exportPayload: () => buildExportPayload(document, location.href),
      conversationDomSignature: () => conversationDomSignature(document),
      waitForChatToLoadForDebug: (targetChatId, options = {}) =>
        waitForChatToLoad(targetChatId, options),
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

    log('retomando download em lote pendente', {
      nextIndex: session.nextIndex,
      total: session.items.length,
      failureIds: session.failureIds,
    });
    showToast(
      `Retomando download interrompido — conversa ${session.nextIndex + 1} de ${session.items.length}...`,
      'info',
    );
    try {
      await runBatchExport(session.items, {
        session,
        resume: true,
      });
    } catch (err) {
      warn('Falha ao retomar download em lote.', err);
      showToast(
        'Não consegui retomar o download pendente. Abra o console (F12) para ver o motivo.',
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
    installContentScriptMessageListener();
    installDebugApi();
    restoreMcpProgressSnapshot();
    reportTabBrokerState('bootstrap', { force: true });
    installExtensionBridge().catch((err) => {
      warn('Falha ao iniciar bridge da extensão.', err);
    });

    // O Gemini é uma SPA que re-renderiza o body; precisamos re-injetar o
    // botão quando isso acontece.
    const observer = new MutationObserver(() =>
      scheduleDomWork('body-mutation', { topBar: true }),
    );
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleDomWork('bootstrap', { topBar: true });
    if (loadBatchExportSession()) {
      log('download em lote pendente encontrado; retomada exige ação explícita');
    }
    log(`userscript carregado (v__VERSION__ build __BUILD_STAMP__)`);
    log(`debug API disponível em window.${DEBUG_GLOBAL}`);
  };

  if (document.body) {
    bootstrap();
  } else {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
})();
