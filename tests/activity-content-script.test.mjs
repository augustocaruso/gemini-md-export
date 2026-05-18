import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

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
  dom.window.eval(readFileSync(resolve('src', 'activity-content-script.js'), 'utf-8'));
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
    },
  });
  const release = await debug.executeCommand({
    type: 'release-tab-claim',
    args: { claimId: 'claim-activity-test', reason: 'test' },
  });

  assert.equal(info.tabId, 42);
  assert.equal(claim.ok, true);
  assert.equal(release.ok, true);
  assert.equal(messages.some((message) => message.type === 'gemini-md-export/claim-tab'), true);
  assert.equal(messages.some((message) => message.type === 'gemini-md-export/release-tab-claim'), true);
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
  assert.match(dock.textContent, /Buscando datas/);
  assert.match(dock.textContent, /1 de 3/);
  assert.match(dock.textContent, /12 itens lidos/);
  assert.match(dock.querySelector('.gm-dock-bar')?.getAttribute('style') || '', /width:\s*12%/);

  debug._private.finishActivityProgress({ status: 'completed' });
  assert.match(dock.textContent, /Conclu/);
  assert.match(dock.querySelector('.gm-dock-bar')?.getAttribute('style') || '', /width:\s*100%/);
});
