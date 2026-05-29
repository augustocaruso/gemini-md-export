import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
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
                <button class="mat-mdc-icon-button mdc-icon-button mat-mdc-button-base mat-unthemed"
                  data-test-id="conversation-actions-menu-icon-button"
                  aria-haspopup="menu"
                  aria-label="Open menu for conversation actions."
                  data-rect="1790,8,40,40">
                  <span class="mat-mdc-button-persistent-ripple mdc-icon-button__ripple"></span>
                  <mat-icon class="notranslate material-symbols-outlined mat-icon material-icons" aria-hidden="true">more_vert</mat-icon>
                  <span class="mat-mdc-focus-indicator"></span>
                  <span class="mat-mdc-button-touch-target"></span>
                </button>
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

const createGeminiDelayedSidebarDom = (ids) => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Histórico atrasado - Gemini</title></head>
      <body>
        <button id="side-menu" aria-label="Show menu" data-rect="16,8,40,40">menu</button>
        <mat-sidenav aria-hidden="true" class="mat-drawer-closed" data-rect="0,0,320,900">
          <conversations-list></conversations-list>
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
  dom.window.document
    .querySelector('#side-menu')
    .addEventListener('click', () => {
      dom.window.setTimeout(() => {
        const sideNav = dom.window.document.querySelector('mat-sidenav');
        sideNav.removeAttribute('aria-hidden');
        sideNav.classList.remove('mat-drawer-closed');
        dom.window.document.querySelector('conversations-list').innerHTML = sidebarRows(ids);
      }, 90);
    });

  return { dom, runtimeErrors };
};

const createGeminiSidebarDomWithoutChatIds = ({ url = 'https://gemini.google.com/app' } = {}) => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Histórico novo - Gemini</title></head>
      <body>
        <mat-sidenav data-rect="0,0,320,900">
          <conversations-list>
            <div data-test-id="conversation"><span class="conversation-title">Conversa sem href 1</span></div>
            <div data-test-id="conversation"><span class="conversation-title">Conversa sem href 2</span></div>
          </conversations-list>
        </mat-sidenav>
      </body>
    </html>`,
    {
      url,
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

const createGeminiModernSidebarDom = (ids) => {
  const virtualConsole = new VirtualConsole();
  const runtimeErrors = [];
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error));

  const dom = new JSDOM(
    `<!doctype html>
    <html>
      <head><title>Histórico moderno - Gemini</title></head>
      <body>
        <div role="navigation" data-rect="0,0,320,900">
          <mat-nav-list data-rect="0,120,320,720">
            <infinite-scroller data-rect="0,120,320,720">
              ${ids
                .map(
                  (id, index) => `
                    <gem-nav-list-item role="listitem" data-conversation-id="c_${id}">
                      <span class="conversation-title">Chat moderno ${index + 1}</span>
                    </gem-nav-list-item>
                  `,
                )
                .join('')}
            </infinite-scroller>
          </mat-nav-list>
        </div>
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

const waitForElementById = async (window, id, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const element = window.document.getElementById(id);
    if (element) return element;
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  return window.document.getElementById(id);
};

test('content script injeta botão moderno sem loop de MutationObserver', { timeout: 2000 }, async () => {
  const script = await readFile(contentScriptUrl, 'utf8');
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const { dom, runtimeErrors } = createGeminiTopBarDom();
  const { window } = dom;

  window.eval(script);
  const button = await waitForElementById(window, 'gm-md-export-modern-btn');

  const slot = window.document.getElementById('gm-md-export-modern-btn-slot');
  const rightSection = window.document.querySelector('.right-section');

  assert.ok(button, 'botão moderno deve existir');
  assert.ok(slot, 'slot moderno deve existir');
  assert.equal(slot.parentElement, rightSection, 'slot deve ficar na right-section do top-bar');
  assert.equal(slot.dataset.gmNativeStyleProfile, 'gemini-lr26-dia-native');
  assert.equal(slot.style.getPropertyValue('--gmn-topbar-slot-size'), '40px');
  assert.equal(slot.style.width, 'var(--gmn-topbar-slot-size, 40px)');
  assert.equal(slot.style.height, 'var(--gmn-topbar-slot-size, 40px)');
  assert.equal(slot.style.flex, '0 0 var(--gmn-topbar-slot-size, 40px)');
  assert.equal(button.dataset.gmMdExportVersion, pkg.version);
  assert.equal(button.dataset.gmNativeStyleProfile, 'gemini-lr26-dia-native');
  assert.equal(button.dataset.gmMdExportIconMode, 'native-svg');
  assert.ok(
    button.classList.contains('mat-mdc-icon-button'),
    'botão deve preservar classes do botão nativo clonado',
  );
  assert.equal(button.hasAttribute('title'), false, 'botão não deve disparar tooltip nativo');
  const icon = button.querySelector('svg[data-role="gm-md-export-download-icon"]');
  assert.ok(icon, 'ícone deve ser SVG, sem depender de fonte/ligature');
  assert.equal(icon.getAttribute('width'), '20');
  assert.equal(icon.getAttribute('height'), '20');
  assert.equal(
    button.textContent.includes('download'),
    false,
    'texto literal "download" nunca pode vazar no botão',
  );
  button.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
  const tooltip = window.document.getElementById('gm-md-export-modern-tooltip');
  assert.ok(tooltip, 'botão deve usar tooltip próprio no estilo nativo');
  assert.equal(tooltip.textContent, 'Baixar como Markdown');
  assert.equal(tooltip.dataset.gmNativeStyleProfile, 'gemini-lr26-dia-native');
  assert.equal(tooltip.style.getPropertyValue('--gmn-tooltip-bg'), 'rgb(241, 243, 244)');
  assert.equal(tooltip.style.background, 'var(--gmn-tooltip-bg, rgb(241, 243, 244))');
  assert.equal(tooltip.style.borderRadius, 'var(--gmn-tooltip-radius, 18px)');
  button.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
  assert.equal(window.document.getElementById('gm-md-export-modern-tooltip'), null);
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
  assert.ok(button.querySelector('svg[data-role="gm-md-export-download-icon"]'));
  assert.equal(button.textContent.includes('download'), false);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('botão do top-bar abre menu com toggle de ignorar aba', { timeout: 2000 }, async () => {
  const script = await readFile(contentScriptUrl, 'utf8');
  const { dom, runtimeErrors } = createGeminiTopBarDom();
  const { window } = dom;

  window.eval(script);
  const button = await waitForElementById(window, 'gm-md-export-modern-btn');

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
  assert.equal(menu.dataset.gmNativeStyleProfile, 'gemini-lr26-dia-native');
  assert.equal(menu.style.getPropertyValue('--gmn-menu-width'), '242px');

  const exportItem = menu.querySelector('[data-role="gm-menu-export"]');
  const ignoreItem = menu.querySelector('[data-role="gm-menu-ignore-tab"]');
  assert.ok(exportItem, 'menu deve ter item de baixar');
  assert.ok(ignoreItem, 'menu deve ter item de ignorar aba');
  assert.equal(menu.style.width, 'var(--gmn-menu-width, 242px)');
  assert.equal(menu.style.padding, '0px');
  assert.match(menu.style.borderRadius, /gmn-menu-radius/);
  assert.match(menu.style.boxShadow, /gmn-menu-shadow/);
  assert.equal(menu.style.fontFamily, 'var(--gm-menu-font)');
  assert.equal(exportItem.style.minHeight, 'var(--gmn-menu-item-min-height, 56px)');
  assert.equal(exportItem.style.fontFamily, 'inherit');
  assert.equal(exportItem.style.fontSize, 'var(--gmn-menu-font-size, 14px)');
  assert.equal(exportItem.style.lineHeight, 'var(--gmn-menu-line-height, 20px)');
  assert.equal(exportItem.style.fontWeight, 'var(--gmn-menu-font-weight, 400)');
  assert.equal(exportItem.querySelectorAll('svg').length, 0);
  exportItem.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
  assert.equal(exportItem.style.background, 'var(--gm-menu-hover)');
  exportItem.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(exportItem.style.background, 'var(--gm-menu-pressed)');
  exportItem.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(exportItem.style.background, 'var(--gm-menu-hover)');
  exportItem.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
  assert.equal(exportItem.style.background, 'transparent');
  exportItem.dispatchEvent(new window.FocusEvent('focus', { bubbles: true }));
  assert.equal(exportItem.style.background, 'var(--gm-menu-focus)');
  exportItem.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }));
  assert.equal(exportItem.style.background, 'transparent');
  assert.equal(ignoreItem.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(ignoreItem.getAttribute('aria-checked'), 'false');
  const ignoreSubtitle = Array.from(ignoreItem.querySelectorAll('span')).find(
    (el) => el.textContent.trim() === 'Desliga a conexão local só nesta aba.',
  );
  assert.ok(ignoreSubtitle, 'item de ignorar deve ter subtitulo');
  assert.equal(ignoreSubtitle.style.fontSize, 'var(--gmn-menu-font-size, 14px)');
  assert.equal(ignoreSubtitle.style.lineHeight, 'var(--gmn-menu-line-height, 20px)');
  assert.equal(
    ignoreItem.querySelector('svg[data-role="gm-menu-check-icon"]'),
    null,
    'check não deve existir visualmente quando o item está desmarcado',
  );
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
  const checkIcon = ignoreItem.querySelector('svg[data-role="gm-menu-check-icon"]');
  assert.ok(checkIcon, 'estado marcado deve usar SVG Material no slot de seleção');
  assert.equal(checkIcon.getAttribute('width'), '20');
  assert.equal(checkIcon.getAttribute('height'), '20');
  assert.equal(checkIcon.getAttribute('aria-hidden'), 'true');
  assert.equal(ignoreItem.textContent.includes('✓'), false);
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
  const button = await waitForElementById(window, 'gm-md-export-modern-btn');

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

test('content script aguarda sidebar atrasado antes de falhar listagem', { timeout: 2000 }, async () => {
  const ids = ['b111111111111111', 'b222222222222222'];
  const { dom, runtimeErrors } = createGeminiDelayedSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  assert.equal(debug.snapshot({}).sidebarOpen, false);

  const opened = await debug.openSidebarForDebug({ timeoutMs: 1000, pollMs: 20 });

  assert.equal(opened, true);
  assert.equal(debug.snapshot({}).sidebarOpen, true);
  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    ids,
  );
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('bridge nao fabrica chatIds quando sidebar novo omite URL real', async () => {
  const { dom, runtimeErrors } = createGeminiSidebarDomWithoutChatIds();
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    [],
    'linhas sem /app/<chatId> real nao podem virar chat-0/chat-1',
  );
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('bridge preserva chat atual, mas ignora linhas de sidebar sem chatId real', async () => {
  const currentChatId = 'b8e7c075effe9457';
  const { dom, runtimeErrors } = createGeminiSidebarDomWithoutChatIds({
    url: `https://gemini.google.com/app/${currentChatId}`,
  });
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    [currentChatId],
  );
  assert.doesNotMatch(
    JSON.stringify(debug.listBridgeConversations()),
    /chat-\d+/,
    'fallback sintetico nao deve vazar para bridge/list/export',
  );
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('bridge reconhece sidebar moderno baseado em gem-nav-list-item', async () => {
  const ids = [
    'c111111111111111',
    'c222222222222222',
    'c333333333333333',
  ];
  const { dom, runtimeErrors } = createGeminiModernSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  assert.deepEqual(
    Array.from(debug.listBridgeConversations().map((item) => item.chatId)),
    ids,
  );
  assert.equal(debug.snapshot({}).sidebarOpen, true);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('snapshot de debug inclui amostras diagnosticas do sidebar moderno', async () => {
  const ids = ['c111111111111111'];
  const { dom, runtimeErrors } = createGeminiModernSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const snapshot = debug.snapshot({ includeDomDiagnostics: true });

  assert.equal(snapshot.sidebarDiagnostics.candidateConversationItemCount, 1);
  assert.equal(snapshot.sidebarDiagnostics.extractableConversationItemCount, 1);
  assert.equal(snapshot.sidebarDiagnostics.samples[0].tag, 'gem-nav-list-item');
  assert.equal(snapshot.sidebarDiagnostics.samples[0].chatId, ids[0]);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('content script expõe DOM adapter e Navigation Engine compartilhados no runtime', async () => {
  const currentChatId = 'b8e7c075effe9457';
  const { dom, runtimeErrors } = createGeminiSidebarDom([currentChatId, 'aaaaaaaaaaaa']);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  const state = debug.navigationState();
  assert.equal(state.route.chatId, currentChatId);
  assert.equal(state.rows[0].chatId, currentChatId);
  assert.equal(state.rows[0].exportable, true);

  const result = await debug.openChatWithNavigationForDebug({ chatId: currentChatId });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-current');
  assert.equal(result.opened, false);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('Navigation Engine no content script aguarda turnos quando URL atual ainda esta vazia', { timeout: 5000 }, async () => {
  const currentChatId = 'b8e7c075effe9457';
  const { dom, runtimeErrors } = createGeminiMediaDom('');
  const { window } = dom;
  window.history.replaceState({}, '', `/app/${currentChatId}`);
  const debug = await evaluateContentScript(window);

  let resolved = false;
  const navigationPromise = debug
    .openChatWithNavigationForDebug({ chatId: currentChatId })
    .then((result) => {
      resolved = true;
      return result;
    });

  await new Promise((resolve) => window.setTimeout(resolve, 350));
  assert.equal(resolved, false, 'URL atual vazia nao deve liberar navegação para export');

  window.document.querySelector('main').innerHTML = `
    <user-query><div>pergunta hidratada</div></user-query>
    <model-response><div>resposta hidratada</div></model-response>
  `;

  const result = await navigationPromise;
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-current');
  assert.equal(result.turnCount, 2);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('Navigation Engine usa linha do sidebar por chatId quando item selecionado nao tem id', async () => {
  const ids = ['b8e7c075effe9457', 'aaaaaaaaaaaa'];
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;
  const targetChatId = ids[1];
  let sidebarClicks = 0;
  let directClicks = 0;
  const originalClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function clickSpy() {
    const href = this.getAttribute('href') || this.href || '';
    if (href.includes(`/app/${targetChatId}`)) {
      if (this.closest('conversations-list')) sidebarClicks += 1;
      else directClicks += 1;
      window.history.pushState({}, '', `/app/${targetChatId}`);
      window.document.querySelector('main').innerHTML = `
        <user-query><div>pergunta do alvo</div></user-query>
        <model-response><div>resposta do alvo</div></model-response>
      `;
      return;
    }
    return originalClick.call(this);
  };

  const debug = await evaluateContentScript(window);
  const result = await debug.openChatWithNavigationForDebug({
    item: {
      chatId: targetChatId,
      title: 'Chat selecionado',
      url: `https://gemini.google.com/app/${targetChatId}`,
      source: 'sidebar',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sidebarClicks, 1);
  assert.equal(directClicks, 0, 'item selecionado do sidebar nao deve cair em link sintetico');
  assert.deepEqual(runtimeErrors, []);
  window.HTMLAnchorElement.prototype.click = originalClick;
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

  const modal = window.document.getElementById('gm-md-export-modern-modal');
  const list = window.document.getElementById('gm-md-export-modern-list');
  const panel = modal?.querySelector('.gm-modal-panel');
  assert.ok(modal, 'modal deve existir');
  assert.ok(panel, 'painel do modal deve existir');
  assert.equal(modal.dataset.gmNativeStyleProfile, 'gemini-lr26-dia-native');
  assert.equal(modal.style.getPropertyValue('--gmn-modal-list-flex'), '1 1 0');
  assert.match(panel.outerHTML, /gm-modal-panel/);
  assert.ok(list, 'lista do modal deve existir');
  assert.equal(list.classList.contains('is-virtual'), true);
  assert.ok(
    list.querySelectorAll('.gm-conversation-item').length < ids.length,
    'lista virtualizada não deve criar um nó por conversa',
  );

  // Casa com `MODAL_VIRTUAL_ITEM_HEIGHT` no script (78 na UI lr26 atual).
  // Buffer 10 atrás. floor(58*120 / 78) - 10 = 79, então a janela renderizada
  // começa em Chat 80.
  list.scrollTop = 58 * 120;
  list.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.match(list.textContent, /Chat 8\d|Chat 9\d|Chat 10[0-4]/, 'janela virtual deve acompanhar o scroll');
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('lista virtualizada do modal rola com wheel dentro da propria lista', { timeout: 3000 }, async () => {
  const ids = Array.from({ length: 292 }, (_, index) =>
    `b${String(index + 1).padStart(15, '0')}`,
  );
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  await debug.openExportModal();
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const list = window.document.getElementById('gm-md-export-modern-list');
  assert.ok(list, 'lista do modal deve existir');
  assert.equal(list.classList.contains('is-virtual'), true);
  assert.equal(debug.snapshot({}).modalVirtual.total, ids.length);

  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 390 });
  Object.defineProperty(list, 'scrollHeight', {
    configurable: true,
    value: ids.length * 78,
  });

  list.dispatchEvent(
    new window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 78 * 90,
    }),
  );
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.ok(list.scrollTop > 0, 'wheel dentro da lista deve mover scrollTop');
  assert.match(list.textContent, /Chat 8\d|Chat 9\d|Chat 10\d/, 'janela virtual deve trocar os itens visiveis');
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('lista virtualizada usa altura estimada quando o DOM subestima scrollHeight', { timeout: 3000 }, async () => {
  const ids = Array.from({ length: 292 }, (_, index) =>
    `c${String(index + 1).padStart(15, '0')}`,
  );
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  await debug.openExportModal();
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const list = window.document.getElementById('gm-md-export-modern-list');
  assert.ok(list, 'lista do modal deve existir');
  assert.equal(list.classList.contains('is-virtual'), true);

  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 390 });
  Object.defineProperty(list, 'scrollHeight', {
    configurable: true,
    value: 390,
  });

  list.dispatchEvent(
    new window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 78 * 90,
    }),
  );
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.ok(
    list.scrollTop > 0,
    'wheel deve usar total virtual mesmo quando scrollHeight real ainda nao cresceu',
  );
  assert.match(list.textContent, /Chat 8\d|Chat 9\d|Chat 10\d/);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('wheel no corpo do modal roteia para a lista virtualizada', { timeout: 3000 }, async () => {
  const ids = Array.from({ length: 292 }, (_, index) =>
    `d${String(index + 1).padStart(15, '0')}`,
  );
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  await debug.openExportModal();
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const modal = window.document.getElementById('gm-md-export-modern-modal');
  const panel = modal?.querySelector('.gm-modal-panel');
  const list = window.document.getElementById('gm-md-export-modern-list');
  assert.ok(panel, 'painel do modal deve existir');
  assert.ok(list, 'lista do modal deve existir');
  assert.equal(debug.snapshot({}).modalVirtual.total, ids.length);

  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 390 });
  Object.defineProperty(list, 'scrollHeight', {
    configurable: true,
    value: 390,
  });

  panel.dispatchEvent(
    new window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 78 * 80,
    }),
  );
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.ok(list.scrollTop > 0, 'wheel no painel deve mover a lista principal');
  assert.match(list.textContent, /Chat 7\d|Chat 8\d|Chat 9\d/);
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('openExportModal recria modal antigo de build anterior antes de anexar scroll handlers', { timeout: 3000 }, async () => {
  const ids = Array.from({ length: 160 }, (_, index) =>
    `e${String(index + 1).padStart(15, '0')}`,
  );
  const { dom, runtimeErrors } = createGeminiSidebarDom(ids);
  const { window } = dom;

  const staleModal = window.document.createElement('div');
  staleModal.id = 'gm-md-export-modern-modal';
  staleModal.dataset.gmMdExportBuildStamp = 'old-build';
  staleModal.innerHTML = '<div data-role="panel">stale modal</div>';
  window.document.body.appendChild(staleModal);

  const debug = await evaluateContentScript(window);
  await debug.openExportModal();
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const modal = window.document.getElementById('gm-md-export-modern-modal');
  const panel = modal?.querySelector('.gm-modal-panel');
  const list = window.document.getElementById('gm-md-export-modern-list');
  assert.ok(modal, 'modal deve existir');
  assert.notEqual(modal, staleModal, 'modal antigo deve ser substituido');
  assert.notEqual(modal.dataset.gmMdExportBuildStamp, 'old-build');
  assert.ok(panel, 'painel novo deve existir');
  assert.ok(list, 'lista nova deve existir');

  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 390 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 390 });

  panel.dispatchEvent(
    new window.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 78 * 40,
    }),
  );
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  assert.ok(list.scrollTop > 0, 'modal recriado deve receber handler de wheel no painel');
  assert.deepEqual(runtimeErrors, []);
  window.close();
});

test('content script usa captura renderizada sem captureVisibleTab', async () => {
  const [contentScript, backgroundScript, debuggerController] = await Promise.all([
    readFile(contentScriptUrl, 'utf8'),
    readFile(new URL('../dist/extension/background.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../dist/extension/browser/background/chrome-debugger-controller.js', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(contentScript, /capture-rendered-media/);
  assert.match(backgroundScript, /captureTabClipWithDebugger/);
  assert.match(debuggerController, /Page\.captureScreenshot/);
  assert.doesNotMatch(backgroundScript, /capture-visible-tab|captureVisibleTab/);
});

test('content script mantém caminhos frequentes leves', async () => {
  const [source, backgroundScript] = await Promise.all([
    readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/extension-background.ts', import.meta.url), 'utf8'),
  ]);
  const heartbeatPayload = source.match(
    /const buildBridgeHeartbeatPayload = \(\) => \([\s\S]*?\n  \}\);\n\n  const buildBridgeSnapshotPayload/,
  )?.[0];
  const snapshotPayload = source.match(
    /const buildBridgeSnapshotPayload = \(\) => \{[\s\S]*?\n  \};\n\n  \/\/ --- ação de baixar/,
  )?.[0];
  const pageSummary = source.match(
    /const buildBridgePageSummary = \(\) => \(\{[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(heartbeatPayload, 'buildBridgeHeartbeatPayload deve existir no shell');
  assert.ok(snapshotPayload, 'buildBridgeSnapshotPayload deve existir no shell');
  assert.ok(pageSummary, 'buildBridgePageSummary deve existir no shell');
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
  assert.doesNotMatch(
    pageSummary,
    /document\.body\?\.innerText/,
    'heartbeat/page summary não deve forçar innerText do app Gemini inteiro',
  );
  assert.match(source, /const buildBridgePageSummary = \(\) => \(\{[\s\S]*conversationDomTurnCount\(document\)/);
  assert.match(source, /topBar:\s*buildTopBarDiagnostics\(\)/);
  assert.match(source, /const collectTopBarDiagnosticCandidates = \(\{/);
  assert.match(source, /missing_on_conversation/);
  assert.match(source, /extensionSendMessageWithRetry/);
  assert.match(source, /lastExtensionPingAttempts/);
  assert.match(source, /content-script-fallback/);
  assert.doesNotMatch(source, /extensionId:\s*null,/);
  assert.match(source, /extensionId:\s*chrome\.runtime\?\.id \|\| null/);
  assert.match(source, /service-worker-info-unavailable/);
  assert.match(source, /\{ timeoutMs: 1200, attempts: 1, retryDelayMs: 0 \}/);
  assert.match(source, /CHAT_CLIENT_ID_STORAGE_KEY = 'gemini-md-export\.chatClientId\.v1'/);
  assert.match(source, /const getOrCreateChatClientId = \(\) =>/);
  assert.match(source, /bridgeState\.clientId = getOrCreateChatClientId\(\)/);
  assert.match(source, /const scheduleDomWork = \(reason = 'changed'/);
  assert.match(source, /tab-backpressure-v1/);
  assert.match(source, /TAB_OPERATION_COMMAND_TYPES/);
  assert.match(source, /runWithTabOperationBackpressure/);
  assert.match(source, /MODAL_VIRTUALIZATION_THRESHOLD/);
  assert.match(source, /gm-list\.is-virtual/);
  assert.match(source, /modalVirtual/);
  assert.match(backgroundScript, /source:\s*'service-worker'/);
  assert.match(snapshotPayload, /collectConversationLinkSnapshot\(\)/);
  assert.match(source, /const buildBridgeEventsSearchParams = \(\) =>/);
  assert.match(source, /params\.set\('tabId', String\(bridgeState\.tabId\)\)/);
  assert.match(source, /params\.set\('buildStamp', String\(bridgeState\.buildStamp\)\)/);
  assert.match(source, /\/bridge\/events\?\$\{buildBridgeEventsSearchParams\(\)\}/);
  assert.match(source, /new EventSource\(url\)/);
  assert.match(source, /savePendingBridgeCommand\(pageWindow\.sessionStorage, command\)/);
  assert.match(source, /readPendingBridgeCommand\(pageWindow\.sessionStorage\)/);
  assert.match(source, /resumePendingBridgeCommandSoon\(\)/);
  assert.match(source, /clearPendingBridgeCommand\(pageWindow\.sessionStorage, command\.id\)/);
  assert.match(source, /\/bridge\/snapshot/);
  const heartbeatBlock = source.match(
    /const sendBridgeHeartbeat = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0] || '';
  assert.doesNotMatch(heartbeatBlock, /RELOAD_SELF/);
  assert.doesNotMatch(heartbeatBlock, /response\?\.extensionReload/);
  assert.match(source, /response\?\.commandPollRequired === true/);
  assert.match(source, /closeBridgeEvents\(\);[\s\S]*pollBridgeCommands\(true\)/);
  assert.match(source, /const MIN_FAST_POLL_BACKOFF_MS = 250/);
  assert.match(source, /const INJECT_THROTTLE_MS = 250/);
});

test('content script não bloqueia heartbeat esperando service worker', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const beforeHeartbeatBlock = source.match(
    /beforeHeartbeat: \(\) => \{[\s\S]*?\n      \},/,
  )?.[0] || '';
  const installBlock = source.match(
    /const installExtensionBridge = async \(\) => \{[\s\S]*?log\('bridge da extensão iniciado'[\s\S]*?\n  \};/,
  )?.[0] || '';

  assert.match(source, /const refreshExtensionContextSoon = \(\{ force = false, reason = 'background' \} = \{\}\) =>/);
  assert.match(source, /const reportTabBrokerStateSoon = \(reason = 'heartbeat'/);
  assert.match(beforeHeartbeatBlock, /refreshExtensionContextSoon\(\{ reason: 'heartbeat' \}\)/);
  assert.match(beforeHeartbeatBlock, /reportTabBrokerStateSoon\('heartbeat'\)/);
  assert.doesNotMatch(beforeHeartbeatBlock, /await\s+refreshExtensionContext/);
  assert.doesNotMatch(beforeHeartbeatBlock, /await\s+reportTabBrokerState/);
  assert.match(installBlock, /refreshExtensionContextSoon\(\{ force: true, reason: 'install' \}\)/);
  assert.doesNotMatch(installBlock, /await\s+extensionSendMessageWithRetry/);
});

test('content script não retoma export em lote automaticamente no bootstrap', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const bootstrapBlock = source.match(/const bootstrap = \(\) => \{[\s\S]*?\n  \};/)?.[0] || '';
  const debugApiBlock = source.match(/pageWindow\[DEBUG_GLOBAL\] = \{[\s\S]*?\n    \};/)?.[0] || '';

  assert.match(source, /const resumePendingBatchExport = async \(\) =>/);
  assert.match(debugApiBlock, /resumePendingBatchExport/);
  assert.match(bootstrapBlock, /retomada exige ação explícita/);
  assert.doesNotMatch(bootstrapBlock, /resumePendingBatchExport\(\)/);
});

test('content script não deixa progresso local sobrescrever progress dock do MCP', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const hydrationBlock = source.match(
    /onProgress: \(\{ state: hydrationState, elapsedMs \}\) => \{[\s\S]*?options\.hydration\?\.onProgress/,
  )?.[0] || '';
  const mediaBlock = source.match(
    /timings\.buildFallbackMarkdownMs = Date\.now\(\) - fallbackStartedAt;[\s\S]*?const mediaStartedAt = Date\.now\(\);/,
  )?.[0] || '';

  assert.match(hydrationBlock, /state\.exportSource === 'gui'/);
  assert.match(hydrationBlock, /updateExportProgress\(\{[\s\S]*current: 0/);
  assert.match(mediaBlock, /state\.exportSource === 'gui'/);
  assert.match(mediaBlock, /Baixando mídias da conversa/);
});

test('content script reporta diagnóstico de scroll ao puxar histórico', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  assert.match(source, /lastLoadMoreTrace:\s*\[\]/);
  assert.match(source, /const describeScrollContainer = \(el, matchedBy = null\) =>/);
  assert.match(source, /describeScrollContainer\(scrollContainer, scrollContainerMatchedBy\)/);
  assert.match(source, /beforeKnown/);
  assert.match(source, /afterKnown/);
  assert.match(source, /scrollBefore/);
  assert.match(source, /scrollAfter/);
  assert.match(source, /scrollInfoIsNearBottom/);
  assert.match(source, /traceConfirmsStableBottom/);
  assert.match(source, /conversationTailSignature/);
  assert.match(source, /traceConfirmsStableTail/);
  assert.match(source, /beforeTail/);
  assert.match(source, /afterTail/);
  assert.match(source, /confirmedStableTail/);
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

test('content script falha comandos de lista quando nao consegue expor o sidebar', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  assert.match(source, /const ensureSidebarOpenForCommand = async/);
  assert.match(source, /code:\s*'sidebar_not_open'/);
  assert.match(source, /Não consegui abrir o sidebar do Gemini/);
  assert.match(source, /sidebarDiagnostics\(\)/);
  assert.match(source, /const sidebarReady = await ensureSidebarOpenForCommand\(command, DEFAULT_LOAD_MORE_OPTIONS\.ensureSidebarDelayMs\)/);
  assert.match(source, /const sidebarReady = await ensureSidebarOpenForCommand\(command, loadOptions\.ensureSidebarDelayMs\)/);
  assert.match(source, /if \(!sidebarReady\.ok\) return sidebarReady/);
  assert.doesNotMatch(source, /await ensureSidebarOpen\(\);\n\s*await sleep\(DEFAULT_LOAD_MORE_OPTIONS\.ensureSidebarDelayMs\);\n\s*\}\n\s*return \{\n\s*ok: true,\n\s*conversations:/);
});

test('content script expõe comando leve para acordar o native broker', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const commandBlock = source.match(
    /if \(command\.type === 'ensure-native-broker'\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(commandBlock, /gemini-md-export\/native-host-health/);
  assert.match(source, /native-broker-wake-v1/);
  assert.match(commandBlock, /reason:\s*command\.args\?\.reason \|\| 'mcp-native-broker-wake'/);
  assert.match(commandBlock, /timeoutMs:\s*command\.args\?\.timeoutMs \|\| NATIVE_BROKER_WAKE_TIMEOUT_MS/);
  assert.match(commandBlock, /extensionSendMessageWithRetry/);
});

test('content script mantém dock MCP durante navegação e sem prefixo de fase', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  assert.match(source, /MCP_PROGRESS_SESSION_STORAGE_KEY/);
  assert.match(source, /MCP_PROGRESS_STALE_GRACE_MS/);
  assert.match(source, /MCP_PROGRESS_CANCEL_STALE_MS/);
  assert.match(source, /startMcpProgressWatchdog/);
  assert.match(source, /clearStaleMcpProgressIfNeeded/);
  assert.match(source, /status === 'cancel_requested'/);
  assert.match(source, /state\.progress\.status = 'cancelled'/);
  assert.match(source, /if \(!jobProgress\)[\s\S]*?clearStaleMcpProgressIfNeeded\(\)/);
  assert.match(source, /status === 'cancel_requested' \? MCP_PROGRESS_CANCEL_STALE_MS : MCP_PROGRESS_STALE_GRACE_MS/);
  assert.match(source, /saveMcpProgressSnapshot/);
  assert.match(source, /loadMcpProgressSnapshot/);
  assert.match(source, /restoreMcpProgressSnapshot\(\)/);
  assert.match(source, /ageMs < limitMs/);
  assert.match(source, /humanProgressLabelFor/);
  assert.match(source, /UI_TECHNICAL_COPY_RE/);
  assert.match(source, /Baixando conversa selecionada/);
  assert.match(source, /\$\{current\} de \$\{total\}/);
  assert.doesNotMatch(source, /Baixando conversa\$\{count\}/);
  assert.doesNotMatch(source, /Exportando conversa do caderno\$\{count\}/);
  assert.doesNotMatch(source, /phasePrefix/);
  assert.doesNotMatch(source, /labelEl\.textContent = `\$\{.*phase.*:/);
  assert.doesNotMatch(source, /MCP exportando conversas/);
  assert.doesNotMatch(source, /MCP reexportando/);
});

test('MCP terminal progress clears snapshot before finishing dock', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const terminalBlock = source.match(
    /if \(isTerminalMcpProgress\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(source, /mcpTerminalProgressSeenAt/);
  assert.match(source, /mcpTerminalProgressJobId/);
  assert.match(source, /mcpTerminalProgressSignature/);
  assert.match(source, /buildMcpTerminalProgressSignature/);
  assert.match(source, /const isTerminalMcpProgress = Boolean/);
  assert.match(source, /state\.mcpTerminalProgressSignature === terminalProgressSignature/);
  assert.match(terminalBlock, /state\.mcpTerminalProgressSeenAt/);
  assert.match(terminalBlock, /state\.mcpTerminalProgressJobId = terminalJobId/);
  assert.match(terminalBlock, /state\.mcpTerminalProgressSignature = terminalProgressSignature/);
  assert.match(terminalBlock, /clearMcpProgressSnapshot\(\)/);
  assert.match(terminalBlock, /stopProgressCreep\(\)/);
  assert.match(terminalBlock, /finishExportProgress/);
});

test('MCP terminal progress clears active operation for the finished job before hiding dock', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  const terminalBlock = source.match(
    /if \(isTerminalMcpProgress\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(source, /const clearActiveTabOperationForTerminalMcpJob = \(jobId\) =>/);
  assert.match(source, /active\.jobId !== jobId/);
  assert.match(source, /state\.activeTabOperation = null/);
  assert.match(source, /operation-terminal-job-cleared/);
  assert.match(terminalBlock, /clearActiveTabOperationForTerminalMcpJob\(terminalJobId\)/);
  assert.ok(
    terminalBlock.indexOf('clearActiveTabOperationForTerminalMcpJob(terminalJobId)') <
      terminalBlock.indexOf('finishExportProgress'),
    'o lock precisa sumir antes do fade do dock terminal',
  );
});

test('content script acompanha redesign lr26 sem voltar para fonte JS', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  assert.match(source, /width="20" height="20"/);
  assert.match(source, /top-bar-actions single visible candidate/);
  assert.match(source, /:scope > \.buttons-container/);
  assert.match(source, /buildHostPalette\(\{ documentRef: document, isDark: isDarkTheme\(\) \}\)/);
  assert.match(source, /buildMenuHostPalette\(\{ documentRef: document, isDark: isDarkTheme\(\) \}\)/);
  // O caminho preferido lr26 é clonar o botão de ícone nativo do Gemini
  // (mat-mdc-icon-button) em vez de hardcodar hover via color-mix. Isso herda
  // ripple/hover/focus do host. Mantemos o fallback color-mix só pro caso
  // raro de não achar referência nativa.
  assert.match(source, /findNativeIconButtonReference\b/);
  assert.match(source, /sanitizeClonedNativeButton\b/);
  assert.match(source, /BUTTON_ICON_SVG/);
  assert.match(source, /MENU_CHECK_ICON_SVG/);
  assert.match(source, /gm-menu-pressed/);
  assert.doesNotMatch(source, /BUTTON_ICON_LIGATURE/);
  assert.doesNotMatch(source, /MATERIAL_SYMBOL_DOWNLOAD/);
  assert.match(source, /existing\.textContent\.includes\('download'\)/);
  // O menu popover agora aplica classes nativas mat-mdc-menu-panel/mat-mdc-menu-item
  // para herdar elevação, radius e tipografia do tema Material 3 do host.
  assert.match(source, /mat-mdc-menu-panel/);
  assert.match(source, /mat-mdc-menu-item/);
  assert.match(source, /gm-conversation-item:has\(\.gm-checkbox:checked\)/);
  assert.doesNotMatch(source, /const hoverIn = 'rgba\(138,180,248,0\.12\)'/);
});

test('content script renderiza progresso selecionado sem jargão tecnico', { timeout: 2000 }, async () => {
  const { dom, runtimeErrors } = createGeminiSidebarDom(['f4b75e8dfa21cdc8']);
  const { window } = dom;
  const debug = await evaluateContentScript(window);

  const first = debug.showProgressForDebug({
    jobId: 'job-ux-progress',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'running',
    phase: 'exporting',
    total: 10,
    current: 0,
    position: 1,
    completed: 0,
    currentChatId: 'f4b75e8dfa21cdc8',
    label: 'MCP reexportando (1/10): f4b75e8dfa21cdc8',
  });

  assert.equal(first.title, 'Baixando conversas');
  assert.equal(first.count, '1 de 10');
  assert.equal(first.label, 'Baixando conversa selecionada: f4b75e8dfa21cdc8');
  assert.equal(first.barWidth, '0%');
  assert.doesNotMatch(first.label, /MCP|reexportando/);
  assert.doesNotMatch(first.label, /\b1 de 10\b/);

  const second = debug.showProgressForDebug({
    jobId: 'job-ux-progress',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'running',
    phase: 'exporting',
    total: 10,
    current: 1,
    position: 2,
    completed: 1,
    currentChatId: 'e0526fad9838e81f',
    title: 'Usando OpenCode com ChatGPT Plus',
    errorCount: 1,
    label: 'MCP reexportando (2/10): Usando OpenCode com ChatGPT Plus',
  });

  assert.equal(second.count, '2 de 10 · 1 erro');
  assert.equal(
    second.label,
    'Baixando conversa selecionada: Usando OpenCode com ChatGPT Plus',
  );
  assert.equal(second.barWidth, '10%');
  assert.doesNotMatch(second.label, /MCP|reexportando/);
  assert.doesNotMatch(second.label, /\b2 de 10\b/);

  const stale = debug.showProgressForDebug({
    jobId: 'job-ux-progress',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'running',
    phase: 'exporting',
    total: 10,
    current: 0,
    position: 0,
    completed: 0,
    currentChatId: 'f4b75e8dfa21cdc8',
    label: 'MCP reexportando (0/10): f4b75e8dfa21cdc8',
  });

  assert.equal(stale.count, '2 de 10 · 1 erro');
  assert.equal(
    stale.label,
    'Baixando conversa selecionada: Usando OpenCode com ChatGPT Plus',
  );
  assert.equal(stale.barWidth, '10%');

  const third = debug.showProgressForDebug({
    jobId: 'job-ux-progress',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'running',
    phase: 'exporting',
    total: 10,
    current: 2,
    position: 3,
    completed: 2,
    currentChatId: '7aeb5c21b12a2137',
    title: 'Configuração conjunta',
  });

  assert.equal(third.count, '3 de 10 · 1 erro');
  assert.equal(third.label, 'Baixando conversa selecionada: Configuração conjunta');
  assert.equal(third.barWidth, '20%');

  const lastStarted = debug.showProgressForDebug({
    jobId: 'job-ux-progress-last',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'running',
    phase: 'exporting',
    total: 10,
    current: 9,
    position: 10,
    completed: 9,
    currentChatId: 'cc95230567196da7',
    title: 'Novas Funções Multimodais do Gemini',
  });

  assert.equal(lastStarted.count, '10 de 10');
  assert.equal(
    lastStarted.label,
    'Baixando conversa selecionada: Novas Funções Multimodais do Gemini',
  );
  assert.equal(lastStarted.barWidth, '90%');

  const done = debug.showProgressForDebug({
    jobId: 'job-ux-progress-last',
    kind: 'direct-chats-export',
    workflow: 'direct-reexport',
    status: 'completed',
    phase: 'done',
    total: 10,
    current: 10,
    position: 10,
    completed: 10,
  });

  assert.equal(done.count, '10 de 10');
  assert.equal(done.label, 'Concluído');
  assert.equal(done.barWidth, '100%');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('content script nao reabre dock para replay terminal do mesmo job MCP', { timeout: 6000 }, async () => {
  const { dom, runtimeErrors } = createGeminiSidebarDom(['f4b75e8dfa21cdc8']);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const dockId = 'gm-md-export-modern-progress-dock';
  const terminalProgress = {
    jobId: 'job-terminal-replay',
    kind: 'recent-export',
    workflow: 'recent-export',
    status: 'completed',
    phase: 'done',
    total: 30,
    current: 30,
    completed: 30,
    label: 'Concluido',
    updatedAt: 1700000000000,
  };

  debug.showProgressForDebug({
    ...terminalProgress,
    status: 'running',
    phase: 'exporting',
    current: 29,
    completed: 29,
    position: 30,
    label: 'Baixando conversa selecionada',
  });
  debug.showProgressForDebug(terminalProgress);

  const dock = window.document.getElementById(dockId);
  assert.ok(dock);
  assert.equal(dock.hidden, false);

  await new Promise((resolve) => window.setTimeout(resolve, 2700));
  assert.equal(dock.hidden, true);
  assert.equal(dock.style.display, 'none');

  debug.showProgressForDebug(terminalProgress);
  assert.equal(dock.hidden, true);
  assert.equal(dock.style.display, 'none');
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('content script hidrata conversa gigante com orçamento adaptativo', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');

  assert.match(source, /HYDRATION_MAX_TOTAL_MS = 10 \* 60 \* 1000/);
  assert.match(source, /HYDRATION_STALL_TIMEOUT_MS = 45000/);
  assert.match(source, /HYDRATION_LOAD_WAIT_MS = 900/);
  assert.match(source, /HYDRATION_SMALL_TOP_SETTLE_MS = 900/);
  assert.match(source, /hydrationConfirmationWaitMs/);
  assert.match(source, /topHydrationConfirmationMs/);
  assert.match(source, /lastProgressAt/);
  assert.match(source, /hydrationMaxTotalMs/);
  assert.match(source, /hydrationStallTimeoutMs/);
  assert.doesNotMatch(
    source,
    /after\.domSignature !== before\.domSignature/,
    'assinatura total do DOM muda em páginas dinâmicas e não pode renovar hidratação para sempre',
  );
});

test('content script explica fallback para Downloads e warnings de mídia', async () => {
  const source = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');
  assert.match(source, /Vou cair em Downloads/);
  assert.match(source, /mídias que não baixarem ficam avisadas no Markdown/);
  assert.match(source, /Para salvar direto no vault, reabra o Gemini CLI e clique em Alterar/);
  assert.match(source, /Sem conexão local, cai em Downloads; mídias que falharem ficam como aviso no Markdown/);
  assert.doesNotMatch(source, /MCP local fora do ar/);
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

test('exportPayload captura imagem protegida já renderizada antes de fetch', { timeout: 5000 }, async () => {
  const protectedUrl = 'https://lh3.googleusercontent.com/gg/protected-rendered=s1024-rj';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <model-response>
      <button class="image-button">
        <img src="${protectedUrl}" alt="Rendered protected image" data-rect="40,80,320,180">
      </button>
    </model-response>
  `);
  const { window } = dom;
  installReadyImageMock(window);

  const messages = [];
  let fetchCount = 0;
  window.fetch = async () => {
    fetchCount += 1;
    throw new Error('HTTP 403');
  };
  window.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message?.type === 'gemini-md-export/capture-rendered-media') {
          callback({
            ok: true,
            mimeType: 'image/png',
            contentBase64: 'CQgHBg==',
          });
          return;
        }
        callback({ ok: true });
      },
    },
  };

  const debug = await evaluateContentScript(window);
  const payload = await debug.exportPayload();
  const captureMessage = messages.find(
    (message) => message?.type === 'gemini-md-export/capture-rendered-media',
  );

  assert.equal(fetchCount, 0);
  assert.ok(captureMessage, 'deve pedir captura renderizada da mídia protegida');
  assert.equal(captureMessage.source, protectedUrl);
  assert.equal(captureMessage.rect.pageX, 40);
  assert.equal(captureMessage.rect.pageY, 80);
  assert.equal(captureMessage.rect.width, 320);
  assert.equal(captureMessage.rect.height, 180);
  assert.equal(payload.mediaFiles.length, 1);
  assert.equal(payload.mediaFailures.length, 0);
  assert.equal(payload.mediaFiles[0].contentBase64, 'CQgHBg==');
  assert.match(
    payload.content,
    /!\[Rendered protected image\]\(assets\/b8e7c075effe9457\/gemini-01-image-01\.png\)/,
  );
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

test('waitForChatToLoad emite progresso enquanto aguarda DOM novo', { timeout: 5000 }, async () => {
  const oldChatId = 'aaaaaaaaaaaa';
  const newChatId = 'bbbbbbbbbbbb';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>pergunta antiga</div></user-query>
    <model-response><div>resposta antiga</div></model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const previousSignature = debug.conversationDomSignature();
  const progress = [];

  window.history.replaceState({}, '', `/app/${oldChatId}`);
  window.history.pushState({}, '', `/app/${newChatId}`);

  const waitPromise = debug.waitForChatToLoadForDebug(newChatId, {
    previousChatId: oldChatId,
    previousSignature,
    onProgress: (state) => progress.push(state),
  });

  await new Promise((resolve) => window.setTimeout(resolve, 450));
  assert.ok(
    progress.length >= 2,
    'espera de navegacao precisa pulsar progresso para nao acionar watchdog',
  );
  assert.equal(progress.at(-1).chatId, newChatId);
  assert.equal(progress.at(-1).changedFromPrevious, false);

  window.document.querySelector('user-query div').textContent = 'pergunta nova';
  window.document.querySelector('model-response div').textContent = 'resposta nova';

  const state = await waitPromise;
  assert.equal(state.chatId, newChatId);
  assert.equal(state.changedFromPrevious, true);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('waitForChatToLoad aceita duplicata com mesma assinatura depois de uma graça curta', { timeout: 5000 }, async () => {
  const oldChatId = 'aaaaaaaaaaaa';
  const newChatId = 'bbbbbbbbbbbb';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>pergunta importada</div></user-query>
    <model-response><div>resposta importada</div></model-response>
  `);
  const { window } = dom;
  const debug = await evaluateContentScript(window);
  const previousSignature = debug.conversationDomSignature();

  window.history.replaceState({}, '', `/app/${oldChatId}`);
  window.history.pushState({}, '', `/app/${newChatId}`);

  const startedAt = Date.now();
  const state = await debug.waitForChatToLoadForDebug(newChatId, {
    previousChatId: oldChatId,
    previousSignature,
    sameSignatureGraceMs: 120,
  });

  assert.equal(state.chatId, newChatId);
  assert.equal(state.changedFromPrevious, false);
  assert.equal(state.acceptedSameSignature, true);
  assert.ok(Date.now() - startedAt >= 100);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('export atual aceita conversa duplicada quando a navegacao aceitou assinatura igual', { timeout: 5000 }, async () => {
  const oldChatId = 'aaaaaaaaaaaa';
  const newChatId = 'bbbbbbbbbbbb';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>pergunta duplicada</div></user-query>
    <model-response><div>resposta duplicada</div></model-response>
  `);
  const { window } = dom;
  window.history.replaceState({}, '', `/app/${oldChatId}`);
  const debug = await evaluateContentScript(window);
  const previousSignature = debug.conversationDomSignature();

  window.history.pushState({}, '', `/app/${newChatId}`);
  const navigation = await debug.waitForChatToLoadForDebug(newChatId, {
    previousChatId: oldChatId,
    previousSignature,
    sameSignatureGraceMs: 10,
  });

  assert.equal(navigation.chatId, newChatId);
  assert.equal(navigation.changedFromPrevious, false);
  assert.equal(navigation.acceptedSameSignature, true);

  const payload = await debug.collectCurrentConversationForDebug({
    expectedChatId: newChatId,
    previousChatId: oldChatId,
    previousSignature,
    navigation,
    hydration: {
      loadWaitMs: 10,
      topSettleMs: 10,
      stallTimeoutMs: 500,
      maxTotalMs: 1000,
    },
  });

  assert.equal(payload.chatId, newChatId);
  assert.match(payload.content, /pergunta duplicada/);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('export atual aceita conversa duplicada quando a engine confirmou o chat alvo', { timeout: 5000 }, async () => {
  const oldChatId = 'aaaaaaaaaaaa';
  const newChatId = 'bbbbbbbbbbbb';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <user-query><div>pergunta duplicada importada</div></user-query>
    <model-response><div>resposta duplicada importada</div></model-response>
  `);
  const { window } = dom;
  window.history.replaceState({}, '', `/app/${oldChatId}`);
  const debug = await evaluateContentScript(window);
  const previousSignature = debug.conversationDomSignature();

  window.history.pushState({}, '', `/app/${newChatId}`);
  const payload = await debug.collectCurrentConversationForDebug({
    expectedChatId: newChatId,
    previousChatId: oldChatId,
    previousSignature,
    navigation: {
      ok: true,
      chatId: newChatId,
      opened: true,
      reason: 'opened-url',
      navigationEngine: {
        ok: true,
        chatId: newChatId,
        opened: true,
        reason: 'opened-url',
      },
    },
    hydration: {
      loadWaitMs: 10,
      topSettleMs: 10,
      stallTimeoutMs: 500,
      maxTotalMs: 1000,
    },
  });

  assert.equal(payload.chatId, newChatId);
  assert.match(payload.content, /pergunta duplicada importada/);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('hidratação não trata crescimento de layout como progresso real', async () => {
  const source = await readFile(
    new URL('../src/browser/navigation/hydration-progress.ts', import.meta.url),
    'utf8',
  );
  const contentSource = await readFile(new URL('../src/userscript-shell.ts', import.meta.url), 'utf8');

  assert.match(source, /hydrationDomProgressChanged/);
  assert.match(source, /containerCount/);
  assert.match(source, /turnDomCount/);
  assert.match(source, /firstSignature/);
  assert.match(source, /hydrationLayoutOnlyChanged/);
  assert.doesNotMatch(
    source.match(/export const hydrationDomProgressChanged[\s\S]*?;\n\nexport const hydrationLayoutOnlyChanged/)?.[0] || '',
    /scrollHeight/,
    'scrollHeight sozinho e layout, nao progresso real de DOM da conversa',
  );
  assert.match(contentSource, /conversationHydrationChanged = \(before, after\) =>\s*\n\s*hydrationDomProgressChanged\(before, after\)/);
  assert.match(contentSource, /isCancelled:\s*activeTabOperationCancelRequested/);
});

test('content script passes operation abort signal into hydration and export collection', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const hydrateBlock =
    source.match(
      /const hydrateConversationToTop = async[\s\S]*?\n  \};\n\n  const waitForChatToLoad/,
    )?.[0] || '';
  const collectBlock =
    source.match(
      /const collectExportForCurrentConversation = async[\s\S]*?\n  \};\n\n  const collectExportForConversation/,
    )?.[0] || '';
  const conversationBlock =
    source.match(
      /const collectExportForConversation = async[\s\S]*?\n  \};\n\n  const downloadBlob/,
    )?.[0] || '';
  const getCurrentChatBlock =
    source.match(
      /if \(command\.type === 'get-current-chat'\) \{[\s\S]*?\n    \}\n\n    if \(command\.type === 'open-chat'\)/,
    )?.[0] || '';
  const getChatByIdBlock =
    source.match(
      /if \(command\.type === 'get-chat-by-id'\) \{[\s\S]*?\n    \}\n\n    return \{\n      ok: false,\n      error: `Comando desconhecido:/,
    )?.[0] || '';

  assert.match(source, /const executeBridgeCommand = async \(command, operationContext = \{\}\) =>/);
  assert.match(hydrateBlock, /options\.abortSignal\?\.aborted/);
  assert.match(hydrateBlock, /options\.onProgress/);
  assert.match(hydrateBlock, /throwIfOperationAborted/);
  assert.match(collectBlock, /abortSignal:\s*options\.abortSignal/);
  assert.match(collectBlock, /setOperationPhase/);
  assert.match(getCurrentChatBlock, /abortSignal:\s*operationContext\.abortSignal/);
  assert.match(getCurrentChatBlock, /setOperationPhase:\s*operationContext\.setOperationPhase/);
  assert.match(getCurrentChatBlock, /operationId:\s*operationContext\.operationId/);
  assert.match(getChatByIdBlock, /collectExportForConversation\(targetItem,\s*\{/);
  assert.match(getChatByIdBlock, /abortSignal:\s*operationContext\.abortSignal/);
  assert.match(getChatByIdBlock, /setOperationPhase:\s*operationContext\.setOperationPhase/);
  assert.match(getChatByIdBlock, /operationId:\s*operationContext\.operationId/);
  assert.match(conversationBlock, /setOperationPhase\?\.\('navigating'\)/);
  assert.match(getChatByIdBlock, /code:\s*err\?\.code \|\| null/);
  assert.match(collectBlock, /navigationAllowsSameSignatureExport/);
  assert.match(source, /const navigationChatIdMatchesPayload =/);
});

test('exportPayload ignora chat antigo escondido no DOM da rota anterior', async () => {
  const currentChatId = 'b8e7c075effe9457';
  const { dom, runtimeErrors } = createGeminiMediaDom(`
    <section style="display: none">
      <user-query><div>pergunta do chat antigo</div></user-query>
      <model-response><div>resposta do chat antigo</div></model-response>
    </section>
    <main>
      <user-query><div>pergunta atual</div></user-query>
      <model-response><div>resposta atual</div></model-response>
    </main>
  `);
  const { window } = dom;
  window.history.replaceState({}, '', `/app/${currentChatId}`);
  const debug = await evaluateContentScript(window);

  const payload = await debug.exportPayload();
  assert.equal(payload.turns.length, 2);
  assert.match(payload.content, /pergunta atual/);
  assert.match(payload.content, /resposta atual/);
  assert.doesNotMatch(payload.content, /chat antigo/);
  assert.deepEqual(runtimeErrors, []);

  window.close();
});

test('content script active tab operation owns an AbortController', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const operationBlock = source.match(
    /const runWithTabOperationBackpressure = async[\s\S]*?\n  \};\n\n  const findConversationForBridgeCommand/,
  )?.[0] || '';
  const cancelBlock = source.match(
    /if \(command\.type === 'cancel-active-operation'\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(operationBlock, /new AbortController\(\)/);
  assert.match(operationBlock, /abortController/);
  assert.match(operationBlock, /abortSignal/);
  assert.match(cancelBlock, /abortController\.abort/);
  assert.match(cancelBlock, /operationId/);
});

test('content script cancel-active-operation treats supplied operationId as exact filter', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const cancelBlock = source.match(
    /if \(command\.type === 'cancel-active-operation'\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(cancelBlock, /hasRequestedOperationId/);
  assert.match(cancelBlock, /Object\.prototype\.hasOwnProperty\.call/);
  assert.match(cancelBlock, /command\.args\.operationId/);
  assert.match(cancelBlock, /typeof state\.activeTabOperation\.operationId !== 'string'/);
  assert.match(cancelBlock, /operation-id-mismatch/);
  assert.doesNotMatch(cancelBlock, /String\(state\.activeTabOperation\.operationId \|\| ''\)/);

  const mismatchIndex = cancelBlock.indexOf('operation-id-mismatch');
  const abortIndex = cancelBlock.indexOf('abortController.abort');
  assert.ok(mismatchIndex >= 0, 'mismatch branch must be present');
  assert.ok(abortIndex >= 0, 'abort call must be present');
  assert.ok(mismatchIndex < abortIndex, 'operationId mismatch must return before aborting');
});
