import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createActivityDomAdapter } from '../build/ts/activity/activity-adapter.js';
import { createGeminiWebDomAdapter } from '../build/ts/browser/dom-adapter/gemini-web-current.js';

test('Gemini DOM adapter nao fabrica chatId para linha sem URL real', () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <a data-gm-conversation-row href="/app/b8e7c075effe9457">Conversa exportavel</a>
      <div data-gm-conversation-row>
        <span>b8e7c075effe9457 escrito como titulo nao prova identidade</span>
      </div>
    </body></html>`,
    { url: 'https://gemini.google.com/app/b8e7c075effe9457' },
  );

  const adapter = createGeminiWebDomAdapter({
    documentRef: dom.window.document,
    locationHref: dom.window.location.href,
  });
  const rows = adapter.listConversationRows();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].exportable, true);
  assert.equal(rows[0].chatId, 'b8e7c075effe9457');
  assert.equal(rows[0].url, 'https://gemini.google.com/app/b8e7c075effe9457');
  assert.equal(rows[1].exportable, false);
  assert.equal(rows[1].chatId, null);
  assert.equal(rows[1].url, null);
  assert.match(rows[1].warnings.join(' '), /missing_chat_id/);
  assert.equal(rows[1].evidence[0].confidence, 'missing');
});

test('Gemini DOM adapter expõe rota atual sem inventar identidade fora de /app/<id>', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://gemini.google.com/app',
  });

  const route = createGeminiWebDomAdapter({
    documentRef: dom.window.document,
    locationHref: dom.window.location.href,
  }).getRouteState();

  assert.equal(route.kind, 'home');
  assert.equal(route.chatId, null);
  assert.match(route.warnings.join(' '), /missing_chat_id/);
});

test('My Activity adapter retorna evidencia sanitizada usando o contrato do core', () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="activity-card" data-date="May 10, 2026">
        <div>Gemini Apps</div>
        <div>3:46 AM</div>
        <section data-gm-activity-details>
          <p>Prompted Gemini</p>
          <p>Explique mecanismo dos ISRS com detalhes</p>
          <p>Os ISRS inibem o transportador de serotonina na fenda sinaptica.</p>
        </section>
      </div>
    </body></html>`,
    { url: 'https://myactivity.google.com/product/gemini' },
  );

  const adapter = createActivityDomAdapter({ documentRef: dom.window.document });
  const result = adapter.scanLoadedEvidence({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: {
          firstPrompt: 'Explique mecanismo dos ISRS com detalhes',
          assistantSamples: ['transportador de serotonina na fenda sinaptica'],
        },
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].chatId, 'b8e7c075effe9457');
  assert.equal(result.evidence[0].source, 'my-activity-web');
  assert.equal(result.evidence[0].date, '2026-05-10T06:46:00Z');
  assert.equal(result.scannedCardCount, 1);
  assert.equal(result.loadedCardCount, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Explique mecanismo dos ISRS/);
  assert.doesNotMatch(serialized, /transportador de serotonina/);
});
