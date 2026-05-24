import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const inlineForHarness = (source) => {
  const hostPaletteSource = readFileSync(
    resolve('build', 'ts', 'browser', 'shared', 'host-palette.js'),
    'utf-8',
  )
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const progressDockSource = readFileSync(
    resolve('build', 'ts', 'browser', 'shared', 'progress-dock-ui.js'),
    'utf-8',
  )
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const progressPortSource = readFileSync(
    resolve('build', 'ts', 'browser', 'shared', 'progress-port.js'),
    'utf-8',
  )
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const tabCommandsSource = readFileSync(
    resolve('build', 'ts', 'browser', 'shared', 'tab-commands.js'),
    'utf-8',
  )
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const bridgeClientSource = readFileSync(
    resolve('build', 'ts', 'browser', 'shared', 'bridge-client.js'),
    'utf-8',
  )
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  return source
    .replace('/* __INLINE_PROGRESS_DOCK_UI__ */', `${hostPaletteSource}\n${progressDockSource}`)
    .replace('/* __INLINE_PROGRESS_PORT__ */', progressPortSource)
    .replace('/* __INLINE_TAB_COMMANDS__ */', tabCommandsSource)
    .replace('/* __INLINE_BRIDGE_CLIENT__ */', bridgeClientSource);
};

const loadHarness = (html, options = {}) => {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://myactivity.google.com/product/gemini',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, commandPollRequired: false }),
  });
  dom.window.EventSource = class {
    close() {}
  };
  dom.window.scrollTo = () => {};
  if (options.chrome) {
    dom.window.chrome = options.chrome;
  }
  dom.window.__GEMINI_MD_ACTIVITY_DISABLE_AUTO_START__ = true;
  dom.window.eval(inlineForHarness(readFileSync(resolve('src', 'activity-content-script.ts'), 'utf-8')));
  dom.window.__geminiMdActivityDebug._window = dom.window;
  return dom.window.__geminiMdActivityDebug;
};

test('activity content script resolve candidatos sem vazar texto sensível', async () => {
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026" data-timestamp="1778395569000">
      <div>Gemini Apps</div>
      <button aria-label="Item details">Item details</button>
      <section data-gm-activity-details>
        <p>Prompted Gemini</p>
        <p>Explique mecanismo dos ISRS</p>
        <p>Os ISRS inibem o transportador de serotonina.</p>
      </section>
    </div>
  `);

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        firstPrompt: 'Explique mecanismo dos ISRS',
        assistantSamples: ['Os ISRS inibem o transportador de serotonina'],
      },
    ],
    maxCards: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matches[0].chatId, 'b8e7c075effe9457');
  assert.equal(result.matches[0].date, '2026-05-10T06:46:09Z');
  assert.equal(result.checkpoint.loadedCardCount, 1);
  assert.deepEqual(Array.from(result.checkpoint.resolvedChatIds), ['b8e7c075effe9457']);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Explique mecanismo dos ISRS/);
  assert.doesNotMatch(serialized, /transportador de serotonina/);
});

test('activity content script converte data textual local para UTC sem milissegundos', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const debug = loadHarness(`
      <div class="activity-card" data-date="May 10, 2026">
        <div>Gemini Apps</div>
        <div>3:46 AM</div>
        <section data-gm-activity-details>
          <p>Prompted Gemini</p>
          <p>Resumo sobre pneumotórax</p>
        </section>
      </div>
    `);

    const result = await debug.scanActivityPage({
      candidates: [
        {
          chatId: 'aaaaaaaaaaaa',
          firstPrompt: 'Resumo sobre pneumotórax',
        },
      ],
      maxCards: 20,
    });

    assert.equal(result.matches[0].date, '2026-05-10T06:46:00Z');
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('activity content script reaproveita claim visual da extensao', async () => {
  const messages = [];
  const debug = loadHarness('<div>Gemini Apps</div>', {
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          if (message.type === 'GET_EXTENSION_INFO') {
            callback({
              ok: true,
              extensionVersion: '0.8.49',
              protocolVersion: 2,
              buildStamp: '20260518-0058',
              tabId: 42,
              windowId: 7,
              isActiveTab: true,
            });
            return;
          }
          if (message.type === 'gemini-md-export/claim-tab') {
            callback({
              ok: true,
              visual: { mode: 'tab-group', tabId: 42, groupId: 99 },
            });
            return;
          }
          if (message.type === 'gemini-md-export/release-tab-claim') {
            callback({ ok: true, released: { tabId: 42 } });
            return;
          }
          callback({ ok: false, reason: 'unexpected-message' });
        },
      },
    },
  });

  const info = await debug.executeCommand({ type: 'get-extension-info' });
  const claim = await debug.executeCommand({
    type: 'claim-tab',
    args: {
      claimId: 'claim-activity-test',
      sessionId: 'test-session',
      label: '🔎 Conferindo',
      color: 'blue',
      expiresAt: '2026-05-18T01:10:00Z',
      explicit: true,
    },
  });
  const release = await debug.executeCommand({
    type: 'release-tab-claim',
    args: { claimId: 'claim-activity-test', reason: 'test', explicit: true },
  });

  assert.equal(info.tabId, 42);
  assert.equal(claim.ok, true);
  assert.equal(release.ok, true);
  assert.equal(messages.some((message) => message.type === 'gemini-md-export/claim-tab'), true);
  assert.equal(messages.some((message) => message.type === 'gemini-md-export/release-tab-claim'), true);
});

test('activity content script aceita reload-extension-self para self-heal do runtime', async () => {
  const messages = [];
  const debug = loadHarness('<div>Gemini Apps</div>', {
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          if (message.type === 'RELOAD_SELF') {
            callback({ ok: true, reloading: true });
            return;
          }
          callback({ ok: true });
        },
      },
    },
  });

  const result = await debug.executeCommand({
    type: 'reload-extension-self',
    args: {
      reason: 'activity-self-heal-test',
      expectedExtensionVersion: '0.8.50',
      expectedProtocolVersion: 2,
      expectedBuildStamp: 'build-test',
      explicit: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reloading, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'RELOAD_SELF',
    reason: 'activity-self-heal-test',
    expectedExtensionVersion: '0.8.50',
    expectedProtocolVersion: 2,
    expectedBuildStamp: 'build-test',
  });
});

test('activity content script pode ativar outra aba gerenciada como broker leve', async () => {
  const messages = [];
  const debug = loadHarness('<div>Gemini Apps</div>', {
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          messages.push(message);
          if (message.type === 'gemini-md-export/activate-tab') {
            callback({
              ok: true,
              tabId: message.tabId,
              windowId: 7,
              wasActive: false,
              isActiveTab: true,
            });
            return;
          }
          callback({ ok: true });
        },
      },
    },
  });

  const result = await debug.executeCommand({
    type: 'activate-browser-tab',
    args: {
      tabId: 713798763,
      reason: 'test-broker-activation',
      focusWindow: true,
      explicit: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 713798763);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'gemini-md-export/activate-tab',
    tabId: 713798763,
    reason: 'test-broker-activation',
    focusWindow: true,
  });
});

test('activity content script usa dock de progresso existente para o scan', async () => {
  const debug = loadHarness('<div>Gemini Apps</div>');

  debug._private.beginActivityProgress({
    candidateTotal: 3,
    maxCards: 100,
  });
  debug._private.updateActivityProgress({
    scannedCardCount: 12,
    loadedCardCount: 40,
    resolvedCount: 1,
    phase: 'scanning',
  });

  const dock = debug._window.document.getElementById('gm-md-export-progress-dock');
  assert.ok(dock);
  assert.equal(dock.hidden, false);
  assert.match(dock.textContent, /Identificando chats/);
  assert.match(dock.textContent, /1 de 3/);
  assert.match(dock.textContent, /12 itens lidos/);
  assert.match(dock.querySelector('.gm-dock-bar')?.getAttribute('style') || '', /width:\s*33%/);

  debug._private.finishActivityProgress({ status: 'completed' });
  assert.match(dock.textContent, /2 pendente/);
  assert.match(dock.querySelector('.gm-dock-bar')?.getAttribute('style') || '', /width:\s*33%/);
});

test('activity content script não abre Item details no scan padrão', async () => {
  let detailClicks = 0;
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026">
      <div>Gemini Apps</div>
      <div>3:46 AM</div>
      <div>Explique bloqueadores beta</div>
      <button aria-label="Item details">Item details</button>
    </div>
  `);
  const button = debug._window.document.querySelector('button[aria-label="Item details"]');
  button.addEventListener('click', () => {
    detailClicks += 1;
  });

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'cccccccccccc',
        firstPrompt: 'Explique bloqueadores beta',
      },
    ],
    maxCards: 10,
    maxScrollRounds: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(detailClicks, 0);
});

test('activity content script compartilha infraestrutura grafica e claim com o export', () => {
  const activitySource = readFileSync(resolve('src', 'activity-content-script.ts'), 'utf-8');
  const shellSource = readFileSync(resolve('src', 'userscript-shell.ts'), 'utf-8');
  const buildSource = readFileSync(resolve('scripts', 'build.mjs'), 'utf-8');

  assert.match(shellSource, /__INLINE_PROGRESS_DOCK_UI__/);
  assert.match(shellSource, /__INLINE_PROGRESS_PORT__/);
  assert.match(shellSource, /__INLINE_TAB_COMMANDS__/);
  assert.match(shellSource, /__INLINE_BRIDGE_CLIENT__/);
  assert.match(activitySource, /__INLINE_PROGRESS_DOCK_UI__/);
  assert.match(activitySource, /__INLINE_PROGRESS_PORT__/);
  assert.match(activitySource, /__INLINE_TAB_COMMANDS__/);
  assert.match(activitySource, /__INLINE_BRIDGE_CLIENT__/);
  assert.match(buildSource, /host-palette\.js/);
  assert.match(buildSource, /progress-dock-ui\.js/);
  assert.match(buildSource, /progress-port\.js/);
  assert.match(buildSource, /tab-commands\.js/);
  assert.match(buildSource, /bridge-client\.js/);
  assert.match(activitySource, /ensureSharedProgressDock/);
  assert.match(activitySource, /createSharedProgressPort/);
  assert.match(activitySource, /createSharedTabCommandHandlers/);
  assert.match(activitySource, /createBrowserBridgeClient/);
  assert.match(activitySource, /getOrCreateBridgeClientId/);
  assert.match(activitySource, /getOrCreateActivityClientId/);
  assert.match(shellSource, /createSharedTabCommandHandlers/);
  assert.match(shellSource, /createBrowserBridgeClient/);
  assert.match(shellSource, /getOrCreateBridgeClientId/);
  assert.match(shellSource, /getOrCreateChatClientId/);
  assert.match(activitySource, /getSharedProgressDockElements/);
  assert.match(activitySource, /setSharedProgressDockVisible/);
  assert.doesNotMatch(activitySource, /gm-dock-card\s*\{/);
  assert.doesNotMatch(activitySource, /dock\.innerHTML\s*=/);
  assert.match(activitySource, /type: 'gemini-md-export\/claim-tab'/);
  assert.match(activitySource, /type: 'gemini-md-export\/release-tab-claim'/);
  assert.doesNotMatch(activitySource, /chrome\.tabs\.(?:group|update|ungroup)|document\.title\s*=/);
});

test('activity content script fecha Item details antes de concluir o scan', async () => {
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026">
      <div>Gemini Apps</div>
      <button aria-label="Item details">Item details</button>
    </div>
    <div class="activity-card" data-date="May 11, 2026">
      <div>Gemini Apps</div>
      <button aria-label="Item details">Item details</button>
    </div>
  `);
  const win = debug._window;

  for (const button of win.document.querySelectorAll('button[aria-label="Item details"]')) {
    button.addEventListener('click', () => {
      const dialog = win.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Gemini Apps synthetic detail text';
      const close = win.document.createElement('button');
      close.setAttribute('aria-label', 'Close this dialog');
      close.addEventListener('click', () => {
        win.setTimeout(() => dialog.remove(), 25);
      });
      dialog.append(close);
      win.document.body.append(dialog);
    });
  }

  await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'aaaaaaaaaaaa',
        firstPrompt: 'texto ausente',
      },
    ],
    maxCards: 10,
    maxScrollRounds: 0,
  });

  assert.equal(win.document.querySelectorAll('[role="dialog"]').length, 0);
});
