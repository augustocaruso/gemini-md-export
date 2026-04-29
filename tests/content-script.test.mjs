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

test('content script não contém fallback de captura visual', async () => {
  const [contentScript, backgroundScript] = await Promise.all([
    readFile(contentScriptUrl, 'utf8'),
    readFile(new URL('../dist/extension/background.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(contentScript, /capture-visible-tab|captureVisibleTab|ScreenshotToAsset/);
  assert.doesNotMatch(backgroundScript, /capture-visible-tab|captureVisibleTab/);
});

test('content script mantém caminhos frequentes leves', async () => {
  const source = await readFile(new URL('../src/userscript-shell.js', import.meta.url), 'utf8');
  const bridgeSummary = source.match(
    /const buildBridgeSummary = \(\) => \{[\s\S]*?\n  \};\n\n  \/\/ --- ação de exportar/,
  )?.[0];

  assert.ok(bridgeSummary, 'buildBridgeSummary deve existir no shell');
  assert.doesNotMatch(
    bridgeSummary,
    /scrapeTurns\(document\)/,
    'heartbeat não deve serializar Markdown da conversa inteira',
  );
  assert.match(bridgeSummary, /conversationDomTurnCount\(document\)/);
  assert.match(source, /const MIN_FAST_POLL_BACKOFF_MS = 250/);
  assert.match(source, /const INJECT_THROTTLE_MS = 250/);
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
