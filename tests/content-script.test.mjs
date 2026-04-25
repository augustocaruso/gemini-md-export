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
