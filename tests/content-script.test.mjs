import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const contentScriptUrl = new URL('../dist/extension/content.js', import.meta.url);

const rectFromAttribute = (value) => {
  const [left = 0, top = 0, width = 0, height = 0] = String(value || '')
    .split(',')
    .map((part) => Number(part.trim()) || 0);
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  };
};

const installLayoutMocks = (window) => {
  window.innerWidth = 2048;
  window.innerHeight = 900;
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(Date.now()), 0);
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return rectFromAttribute(this.getAttribute('data-rect'));
  };
};

const createGeminiTopBarDom = () => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Conversa de teste - Gemini</title></head>
      <body>
        <div id="gb" data-rect="1960,0,80,56"></div>
        <button id="gm-md-export-btn" data-rect="1200,8,40,40">MD</button>
        <div id="gm-md-export-modal">modal legado</div>
        <top-bar-actions data-rect="1500,0,390,64">
          <div class="top-bar-actions" data-rect="1500,0,390,64">
            <div class="left-section" data-rect="1500,8,40,48"></div>
            <div class="center-section" data-rect="1540,8,120,48"></div>
            <div class="right-section" data-rect="1700,8,180,48">
              <div class="buttons-container share" data-rect="1740,8,48,48">
                <button data-test-id="share-button" aria-label="Share conversation" data-rect="1740,8,40,40">Share</button>
              </div>
              <conversation-actions-icon data-rect="1790,8,48,48">
                <button data-test-id="conversation-actions-menu-icon-button" aria-haspopup="menu" aria-label="Open menu for conversation actions." data-rect="1790,8,40,40">More</button>
              </conversation-actions-icon>
            </div>
          </div>
        </top-bar-actions>
        <main>
          <user-query><div>pergunta</div></user-query>
          <model-response><div>resposta</div></model-response>
        </main>
      </body>
    </html>`,
    {
      url: 'https://gemini.google.com/app/b8e7c075effe9457',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    },
  );

  installLayoutMocks(dom.window);
  dom.window.console.log = () => {};
  dom.window.console.warn = () => {};
  dom.window.console.error = (...args) => runtimeErrors.push(args);

  return { dom, runtimeErrors };
};

const createGeminiMediaDom = (bodyHtml) => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Conversa de mídia - Gemini</title></head>
      <body>
        <main>${bodyHtml}</main>
      </body>
    </html>`,
    {
      url: 'https://gemini.google.com/app/b8e7c075effe9457',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    },
  );

  installLayoutMocks(dom.window);
  dom.window.console.log = () => {};
  dom.window.console.warn = () => {};
  dom.window.console.error = (...args) => runtimeErrors.push(args);
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.scrollTo = () => {};

  return { dom, runtimeErrors };
};

const sidebarRows = (ids) =>
  ids
    .map(
      (id, index) => `
        <div data-test-id="conversation">
          <a href="/app/${id}">
            <span class="conversation-title">Chat ${index + 1} ${id.slice(0, 4)}</span>
          </a>
        </div>
      `,
    )
    .join('');

const createGeminiSidebarDom = (ids) => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Histórico - Gemini</title></head>
      <body>
        <mat-sidenav data-rect="0,0,320,900">
          <conversations-list>
            ${sidebarRows(ids)}
          </conversations-list>
        </mat-sidenav>
        <main>
          <user-query><div>pergunta</div></user-query>
          <model-response><div>resposta</div></model-response>
        </main>
      </body>
    </html>`,
    {
      url: `https://gemini.google.com/app/${ids[0]}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    },
  );

  installLayoutMocks(dom.window);
  dom.window.console.log = () => {};
  dom.window.console.warn = () => {};
  dom.window.console.error = (...args) => runtimeErrors.push(args);

  return { dom, runtimeErrors };
};

const installReadyImageMock = (window, selector = 'img') => {
  window.document.querySelectorAll(selector).forEach((img) => {
    Object.defineProperty(img, 'complete', { configurable: true, value: true });
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 320 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 180 });
    img.decode = () => Promise.resolve();
  });
};

const evaluateContentScript = async (window) => {
  const script = await readFile(contentScriptUrl, 'utf8');
  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 25));
  return window.__geminiMdExportDebug;
};

const fakeBlobResponse = (window, bytes, type = 'image/png') => ({
  ok: true,
  blob: async () => new Blob([new Uint8Array(bytes)], { type }),
});

test('content script injeta botão moderno sem loop de MutationObserver', { timeout: 2000 }, async () => {
  const script = await readFile(contentScriptUrl, 'utf8');
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const { dom, runtimeErrors } = createGeminiTopBarDom();
  const { window } = dom;

  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 25));

  const button = window.document.getElementById('gm-md-export-modern-btn');
  const slot = window.document.getElementById('gm-md-export-modern-btn-slot');
  const rightSection = window.document.querySelector('.right-section');

  assert.ok(button, 'botão moderno deve existir');
  assert.ok(slot, 'slot moderno deve existir');
  assert.equal(slot.parentElement, rightSection, 'slot deve ficar na right-section do top-bar');
  assert.equal(button.dataset.gmMdExportVersion, pkg.version);
  assert.equal(button.querySelectorAll('svg').length, 1);
  assert.equal(
    window.document.getElementById('gm-md-export-btn')?.textContent,
    'MD',
    'UI legada deve ser preservada, nao disputada pelo content script atual',
  );

  let mutationCount = 0;
  const observer = new window.MutationObserver((mutations) => {
    mutationCount += mutations.length;
  });
  observer.observe(window.document.body, { childList: true, subtree: true });

  for (let i = 0; i < 5; i += 1) {
    const node = window.document.createElement('div');
    node.textContent = `Gemini render ${i}`;
    window.document.body.appendChild(node);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 100));
  observer.disconnect();

  assert.ok(
    mutationCount < 25,
    `injeção não deve criar tempestade de mutações; observadas ${mutationCount}`,
  );
  assert.equal(button.querySelectorAll('svg').length, 1);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('botão do top-bar abre menu com toggle de ignorar aba', { timeout: 2000 }, async () => {
  const script = await readFile(contentScriptUrl, 'utf8');
  const { dom, runtimeErrors } = createGeminiTopBarDom();
  const { window } = dom;

  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 25));

  const button = window.document.getElementById('gm-md-export-modern-btn');
  assert.ok(button, 'botão moderno deve existir');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  // Sem menu antes do clique.
  assert.equal(window.document.getElementById('gm-md-export-modern-menu'), null);

  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const menu = window.document.getElementById('gm-md-export-modern-menu');
  assert.ok(menu, 'clique no botão deve abrir o menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.getAttribute('role'), 'menu');

  const exportItem = menu.querySelector('[data-role="gm-menu-export"]');
  const ignoreItem = menu.querySelector('[data-role="gm-menu-ignore-tab"]');
  assert.ok(exportItem, 'menu deve ter item de exportar');
  assert.ok(ignoreItem, 'menu deve ter item de ignorar aba');
  assert.equal(ignoreItem.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(ignoreItem.getAttribute('aria-checked'), 'false');
  assert.equal(
    window.sessionStorage.getItem('gemini-md-export.ignoreThisTab.v1'),
    null,
    'sessionStorage deve começar limpo',
  );

  // Toggle ON
  let eventDetail = null;
  window.addEventListener('gm-md-export:tab-ignored-changed', (ev) => {
    eventDetail = ev.detail;
  });
  ignoreItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(ignoreItem.getAttribute('aria-checked'), 'true');
  assert.equal(
    window.sessionStorage.getItem('gemini-md-export.ignoreThisTab.v1'),
    '1',
    'toggle deve persistir flag em sessionStorage',
  );
  assert.equal(eventDetail.ignored, true);
  assert.ok(
    window.__geminiMdExportDebug.isTabIgnored(),
    'debug API deve refletir aba ignorada',
  );

  // Toggle OFF
  ignoreItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(ignoreItem.getAttribute('aria-checked'), 'false');
  assert.equal(
    window.sessionStorage.getItem('gemini-md-export.ignoreThisTab.v1'),
    null,
    'toggle off deve remover a flag',
  );
  assert.equal(eventDetail.ignored, false);

  // Click fora fecha o menu
  window.document.body.dispatchEvent(
    new window.MouseEvent('mousedown', { bubbles: true }),
  );
  assert.equal(window.document.getElementById('gm-md-export-modern-menu'), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('isTabIgnored persiste entre aberturas do menu e zera bridge', { timeout: 2000 }, async () => {
  const script = await readFile(contentScriptUrl, 'utf8');
  const { dom } = createGeminiTopBarDom();
  const { window } = dom;
  // Pré-popula a flag antes de carregar o content script para simular reload
  // de aba já marcada como ignorada.
  window.sessionStorage.setItem('gemini-md-export.ignoreThisTab.v1', '1');

  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 25));

  const button = window.document.getElementById('gm-md-export-modern-btn');
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const ignoreItem = window.document.querySelector(
    '[data-role="gm-menu-ignore-tab"]',
  );
  assert.equal(
    ignoreItem.getAttribute('aria-checked'),
    'true',
    'toggle deve refletir flag pré-existente',
  );

  const snapshot = window.__geminiMdExportDebug.snapshot({});
  assert.equal(snapshot.tabIgnored, true);
  assert.equal(snapshot.menuPresent, true);

  window.close();
});

test('bridge acumula conversas vistas quando sidebar virtualiza lista', { timeout: 2000 }, async () => {
  const firstWindowIds = [
    'a111111111111111',
    'a222222222222222',
    'a333333333333333',
  ];
  const secondWindowIds = [
    'a333333333333333',
    'a444444444444444',
    'a555555555555555',
  ];
  const { dom, runtimeErrors } = createGeminiSidebarDom(firstWindowIds);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    firstWindowIds,
  );

  window.document.querySelector('conversations-list').innerHTML =
    sidebarRows(secondWindowIds);

  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    [
      'a111111111111111',
      'a222222222222222',
      'a333333333333333',
      'a444444444444444',
      'a555555555555555',
    ],
  );
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('modal virtualiza lista grande sem renderizar todas as conversas', { timeout: 3000 }, async () => {
  const ids = Array.from({ length: 160 }, (_, index) =>
    `a${String(index + 1).padStart(15, '0')}`,
  );
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  await debug.openExportModal();
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const list = window.document.getElementById('gm-md-export-modern-list');
  assert.ok(list, 'lista do modal deve existir');
  assert.equal(list.classList.contains('is-virtual'), true);
  assert.ok(
    list.querySelectorAll('.gm-conversation-item').length < ids.length,
    'lista virtualizada não deve criar um nó por conversa',
  );

  list.scrollTop = 78 * 120;
  list.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.match(list.textContent, /Chat 1(1|2|3)/, 'janela virtual deve acompanhar o scroll');
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('content script não contém fallback de captura visual', async () => {
  const [contentScript, backgroundScript] = await Promise.all([
    readFile(contentScriptUrl, 'utf8'),
    readFile(new URL('../dist/extension/background.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(contentScript, /capture-visible-tab|captureVisibleTab|ScreenshotToAsset/);
  assert.doesNotMatch(backgroundScript, /capture-visible-tab|captureVisibleTab/);
});

test('content script mantém caminhos frequentes leves', async () => {
  const [source, backgroundScript] = await Promise.all([
    readFile(new URL('../src/userscript-shell.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/extension-background.js', import.meta.url), 'utf8'),
  ]);
  const heartbeatPayload = source.match(
    /const buildBridgeHeartbeatPayload = \(\) => \([\s\S]*?\n  \}\);\n\n  const buildBridgeSnapshotPayload/,
  )?.[0];
  const snapshotPayload = source.match(
    /const buildBridgeSnapshotPayload = \(\) => \{[\s\S]*?\n  \};\n\n  \/\/ --- ação de exportar/,
  )?.[0];

  assert.ok(heartbeatPayload, 'buildBridgeHeartbeatPayload deve existir no shell');
  assert.ok(snapshotPayload, 'buildBridgeSnapshotPayload deve existir no shell');
  assert.doesNotMatch(
    heartbeatPayload,
    /scrapeTurns\(document\)/,
    'heartbeat não deve serializar Markdown da conversa inteira',
  );
  assert.doesNotMatch(
    heartbeatPayload,
    /collectConversationLinkSnapshot\(\)/,
    'heartbeat não deve coletar inventário completo de conversas',
  );
  assert.match(source, /const buildBridgePageSummary = \(\) => \(\{[\s\S]*conversationDomTurnCount\(document\)/);
  assert.match(source, /topBar:\s*buildTopBarDiagnostics\(\)/);
  assert.match(source, /const collectTopBarDiagnosticCandidates = \(\{/);
  assert.match(source, /missing_on_conversation/);
  assert.match(source, /extensionSendMessageWithRetry/);
  assert.match(source, /lastExtensionPingAttempts/);
  assert.match(source, /const scheduleDomWork = \(reason = 'changed'/);
  assert.match(source, /tab-backpressure-v1/);
  assert.match(source, /TAB_OPERATION_COMMAND_TYPES/);
  assert.match(source, /runWithTabOperationBackpressure/);
  assert.match(source, /MODAL_VIRTUALIZATION_THRESHOLD/);
  assert.match(source, /gm-list\.is-virtual/);
  assert.match(source, /modalVirtual/);
  assert.match(backgroundScript, /source:\s*'service-worker'/);
  assert.match(snapshotPayload, /collectConversationLinkSnapshot\(\)/);
  assert.match(source, /new EventSource\(url\)/);
  assert.match(source, /\/bridge\/snapshot/);
  assert.match(source, /const MIN_FAST_POLL_BACKOFF_MS = 250/);
  assert.match(source, /const INJECT_THROTTLE_MS = 250/);
});

test('content script reporta diagnóstico de scroll ao puxar histórico', async () => {
  const source = await readFile(new URL('../src/userscript-shell.js', import.meta.url), 'utf8');
  assert.match(source, /lastLoadMoreTrace:\s*\[\]/);
  assert.match(source, /const describeScrollContainer = \(el, matchedBy = null\) =>/);
  assert.match(source, /describeScrollContainer\(scrollContainer, scrollContainerMatchedBy\)/);
  assert.match(source, /beforeKnown/);
  assert.match(source, /afterKnown/);
  assert.match(source, /scrollBefore/);
  assert.match(source, /scrollAfter/);
  assert.match(source, /scrollInfoIsNearBottom/);
  assert.match(source, /traceConfirmsStableBottom/);
  assert.match(source, /confirmedStableBottom/);
  assert.doesNotMatch(source, /loadOptions\.fastMode\s*&&\s*scrolledToBottom/);
  assert.match(source, /requiredEndFailures/);
  assert.match(source, /state\.sidebarConversationCache\.size/);
  assert.match(source, /loadTrace:\s*command\.args\?\.includeLoadTrace === false/);
  assert.match(source, /timedOut:\s*roundTimedOut/);
  assert.match(source, /ignoreFailureCap:\s*command\.args\?\.ignoreFailureCap === true/);
  assert.match(source, /endFailureThreshold:\s*command\.args\?\.endFailureThreshold/);
  assert.match(source, /command\.args\?\.resetReachedEnd === true/);
  assert.match(source, /state\.reachedSidebarEnd = false/);
  assert.match(source, /listLoadStatus:\s*'idle'/);
  assert.match(source, /ainda não confirmei o fim do histórico/);
  assert.match(source, /Fim do histórico confirmado no sidebar/);
  assert.match(source, /noGrowthRounds/);
  assert.match(source, /state\.listLoadStatus === 'inconclusive'/);
});

test('content script mantém dock MCP durante navegação e sem prefixo de fase', async () => {
  const source = await readFile(new URL('../src/userscript-shell.js', import.meta.url), 'utf8');
  assert.match(source, /MCP_PROGRESS_SESSION_STORAGE_KEY/);
  assert.match(source, /MCP_PROGRESS_STALE_GRACE_MS/);
  assert.match(source, /saveMcpProgressSnapshot/);
  assert.match(source, /loadMcpProgressSnapshot/);
  assert.match(source, /restoreMcpProgressSnapshot\(\)/);
  assert.match(source, /ageMs < MCP_PROGRESS_STALE_GRACE_MS/);
  assert.doesNotMatch(source, /phasePrefix/);
  assert.doesNotMatch(source, /labelEl\.textContent = `\$\{.*phase.*:/);
});

test('content script explica fallback para Downloads e warnings de mídia', async () => {
  const source = await readFile(new URL('../src/userscript-shell.js', import.meta.url), 'utf8');
  assert.match(source, /Vou cair em Downloads/);
  assert.match(source, /mídias que não baixarem ficam avisadas no Markdown/);
  assert.match(source, /Para salvar direto no vault, reabra o Gemini CLI\/MCP e clique em Alterar/);
  assert.match(source, /Sem MCP, cai em Downloads; mídias que falharem ficam como aviso no Markdown/);
});

test('exportPayload baixa blob sem preparar a imagem antes', { timeout: 5000 }, async () => {
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <model-response>
      <button class="image-button">
        <img src="blob:https://gemini.google.com/blob-1" alt="Blob image">
      </button>
    </model-response>
  `);
  const { window } = dom;
  installReadyImageMock(window);

  let fetchCalledWith = null;
  window.fetch = async (source) => {
    fetchCalledWith = String(source);
    return fakeBlobResponse(window, [1, 2, 3, 4], 'image/png');
  };
  let scrolled = false;
  window.Element.prototype.scrollIntoView = () => {
    scrolled = true;
  };

  const debug = await evaluateContentScript(window);
  const payload = await debug.exportPayload();

  assert.equal(fetchCalledWith, 'blob:https://gemini.google.com/blob-1');
  assert.equal(scrolled, false);
  assert.equal(payload.mediaFiles.length, 1);
  assert.equal(payload.mediaFailures.length, 0);
  assert.match(payload.content, /!\[Blob image\]\(assets\/b8e7c075effe9457\/gemini-01-image-01\.png\)/);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('exportPayload usa fonte byte-legível revelada no lightbox', { timeout: 4000 }, async () => {
  const lightboxDataUrl = 'data:image/png;base64,AQIDBA==';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <model-response>
      <button class="image-button" id="open-lightbox">
        <img src="https://lh3.googleusercontent.com/gg/protected=s1024-rj" alt="Generated image">
      </button>
    </model-response>
  `);
  const { window } = dom;
  installReadyImageMock(window);

  window.fetch = async () => {
    throw new Error('HTTP 403');
  };
  window.document.getElementById('open-lightbox').addEventListener('click', () => {
    const dialog = window.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-rect', '10,10,400,300');
    dialog.innerHTML = `
      <button aria-label="Close">Close</button>
      <img src="${lightboxDataUrl}" alt="Generated image full">
    `;
    dialog.querySelector('button').addEventListener('click', () => dialog.remove());
    window.document.body.appendChild(dialog);
  });

  const debug = await evaluateContentScript(window);
  const payload = await debug.exportPayload();

  assert.equal(payload.mediaFiles.length, 1);
  assert.equal(payload.mediaFailures.length, 0);
  assert.equal(payload.mediaFiles[0].contentBase64, 'AQIDBA==');
  assert.match(payload.content, /!\[Generated image\]\(assets\/b8e7c075effe9457\/gemini-01-image-01\.png\)/);
  assert.equal(window.document.querySelector('[role="dialog"]'), null);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('exportPayload mantém warning quando lightbox não revela fonte legível', { timeout: 4000 }, async () => {
  const protectedUrl = 'https://lh3.googleusercontent.com/gg/protected=s1024-rj';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <model-response>
      <button class="image-button" id="open-lightbox">
        <img src="${protectedUrl}" alt="Protected image">
      </button>
    </model-response>
  `);
  const { window } = dom;
  installReadyImageMock(window);

  window.fetch = async () => {
    throw new Error('HTTP 403');
  };
  window.document.getElementById('open-lightbox').addEventListener('click', () => {
    const dialog = window.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-rect', '10,10,400,300');
    dialog.innerHTML = `
      <button aria-label="Close">Close</button>
      <img src="${protectedUrl}" alt="Protected image full">
    `;
    dialog.querySelector('button').addEventListener('click', () => dialog.remove());
    window.document.body.appendChild(dialog);
  });

  const debug = await evaluateContentScript(window);
  const payload = await debug.exportPayload();

  assert.equal(payload.mediaFiles.length, 0);
  assert.equal(payload.mediaFailures.length, 1);
  assert.match(payload.content, /\[!warning\] Mídia não importada/);
  assert.match(payload.content, /> Descrição: Protected image/);
  assert.equal(window.document.querySelector('[role="dialog"]'), null);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('diagnóstico de artefatos reconhece iframe gemini-code-immersive', { timeout: 4000 }, async () => {
  const artifactUrl =
    'https://0wcgetkp1eahjwzmi88js74uet1lmjex7g07o0e20idk5c0tdx-h903225159.scf.usercontent.goog/gemini-code-immersive/shim.html?origin=https%3A%2F%2Fgemini.google.com&cache=1';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>crie um app pequeno</div></user-query>
    <model-response>
      <div>
        <iframe
          data-rect="10,20,640,480"
          allow="xr-spatial-tracking; web-share"
          sandbox="allow-pointer-lock allow-popups allow-forms allow-popups-to-escape-sandbox allow-downloads allow-scripts allow-same-origin"
          src="${artifactUrl}">
        </iframe>
      </div>
    </model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const result = await debug.artifacts({ includeFrameProbe: false });
  const item = result.items[0];

  assert.equal(result.summary.total, 1);
  assert.equal(item.kind, 'gemini_code_immersive');
  assert.equal(item.srcKind, 'remote_usercontent_goog');
  assert.equal(item.host, '0wcgetkp1eahjwzmi88js74uet1lmjex7g07o0e20idk5c0tdx-h903225159.scf.usercontent.goog');
  assert.equal(item.pathname, '/gemini-code-immersive/shim.html');
  assert.equal(item.role, 'assistant');
  assert.equal(item.turnIndex, 2);
  assert.equal(item.extensionFrameProbePossible, true);
  assert.equal(item.sandboxTokens.includes('allow-same-origin'), true);
  assert.equal(result.frameProbe.reason, 'extension-context-unavailable');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('diagnóstico de artefatos abre botão candidato antes de procurar iframe', { timeout: 5000 }, async () => {
  const artifactUrl =
    'https://0wcgetkp1eahjwzmi88js74uet1lmjex7g07o0e20idk5c0tdx-h903225159.scf.usercontent.goog/gemini-code-immersive/shim.html?origin=https%3A%2F%2Fgemini.google.com&cache=1';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>crie um app pequeno</div></user-query>
    <model-response id="answer">
      <button
        id="open-artifact"
        aria-label="Abrir artefato interativo"
        data-test-id="artifact-open-button"
        data-rect="10,20,180,44">Abrir</button>
    </model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  window.document.getElementById('open-artifact').addEventListener('click', () => {
    const iframe = window.document.createElement('iframe');
    iframe.setAttribute('data-rect', '10,80,640,480');
    iframe.setAttribute('allow', 'xr-spatial-tracking; web-share');
    iframe.setAttribute(
      'sandbox',
      'allow-pointer-lock allow-popups allow-forms allow-popups-to-escape-sandbox allow-downloads allow-scripts allow-same-origin',
    );
    iframe.setAttribute('src', artifactUrl);
    window.document.getElementById('answer').appendChild(iframe);
  });

  const result = await debug.artifacts({
    includeFrameProbe: false,
    openArtifactLaunchers: true,
    closeOpenedLaunchers: false,
    artifactOpenWaitMs: 1200,
  });
  const item = result.items[0];

  assert.equal(result.summary.launcherCount, 1);
  assert.equal(result.summary.clickedLauncherCount, 1);
  assert.equal(result.summary.openedFrameCount, 1);
  assert.equal(result.launcherOpen.clicked[0].ok, true);
  assert.equal(result.summary.total, 1);
  assert.equal(item.kind, 'gemini_code_immersive');
  assert.equal(item.srcKind, 'remote_usercontent_goog');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('diagnóstico de artefatos ignora iframes técnicos escondidos', { timeout: 5000 }, async () => {
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <iframe src="/_/bscframe" data-rect="0,0,0,0"></iframe>
    <iframe src="https://accounts.google.com/RotateCookiesPage?origin=https%3A%2F%2Fgemini.google.com" data-rect="0,0,0,0"></iframe>
    <user-query><div>crie um app pequeno</div></user-query>
    <model-response>
      <button
        aria-label="Open visualization"
        data-test-id="mini-app-opt-in-button"
        data-rect="10,20,240,44">Show me the visualization</button>
    </model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  const result = await debug.artifacts({
    includeFrameProbe: false,
    openArtifactLaunchers: false,
  });

  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.htmlExtractable, 0);
  assert.equal(result.summary.launcherCount, 1);
  assert.equal(result.nextAction.code, 'fallback_only');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('diagnóstico de artefatos prioriza botão próximo da viewport', { timeout: 5000 }, async () => {
  const artifactUrl =
    'https://0wcgetkp1eahjwzmi88js74uet1lmjex7g07o0e20idk5c0tdx-h903225159.scf.usercontent.goog/gemini-code-immersive/shim.html?origin=https%3A%2F%2Fgemini.google.com&cache=1';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>crie um app pequeno</div></user-query>
    <model-response id="answer">
      <button
        id="old-open-artifact"
        aria-label="Open visualization"
        data-test-id="mini-app-opt-in-button"
        data-rect="10,-3000,260,44">Show me the visualization old</button>
      <button
        id="near-open-artifact"
        aria-label="Open visualization"
        data-test-id="mini-app-opt-in-button"
        data-rect="10,120,260,44">Show me the visualization nearby</button>
    </model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  window.document.getElementById('near-open-artifact').addEventListener('click', () => {
    const iframe = window.document.createElement('iframe');
    iframe.setAttribute('data-rect', '10,180,640,480');
    iframe.setAttribute('src', artifactUrl);
    window.document.getElementById('answer').appendChild(iframe);
  });

  const result = await debug.artifacts({
    includeFrameProbe: false,
    openArtifactLaunchers: true,
    closeOpenedLaunchers: false,
    artifactOpenWaitMs: 1200,
  });

  assert.equal(result.launcherOpen.clicked[0].text, 'Show me the visualization nearby');
  assert.equal(result.launcherOpen.clicked[0].ok, true);
  assert.equal(result.summary.openedFrameCount, 1);
  assert.equal(result.items[0].kind, 'gemini_code_immersive');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('waitForChatToLoad aguarda DOM novo antes de liberar export', { timeout: 5000 }, async () => {
  const oldChatId = 'aaaaaaaaaaaa';
  const newChatId = 'bbbbbbbbbbbb';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>pergunta antiga</div></user-query>
    <model-response><div>resposta antiga</div></model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const previousSignature = debug.conversationDomSignature();

  window.history.replaceState({}, '', `/app/${oldChatId}`);
  window.history.pushState({}, '', `/app/${newChatId}`);

  let resolved = false;
  const waitPromise = debug
    .waitForChatToLoadForDebug(newChatId, {
      previousChatId: oldChatId,
      previousSignature,
    })
    .then((state) => {
      resolved = true;
      return state;
    });

  await new Promise((resolve) => window.setTimeout(resolve, 350));
  assert.equal(
    resolved,
    false,
    'URL nova com turns antigos nao deve liberar export imediatamente',
  );

  window.document.title = 'Conversa nova - Gemini';
  window.document.querySelector('user-query div').textContent = 'pergunta nova';
  window.document.querySelector('model-response div').textContent = 'resposta nova';

  const state = await waitPromise;
  assert.equal(state.chatId, newChatId);
  assert.equal(state.changedFromPrevious, true);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});
