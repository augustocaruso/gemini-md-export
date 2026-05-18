import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const loadHarness = (html) => {
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
  dom.window.__GEMINI_MD_ACTIVITY_DISABLE_AUTO_START__ = true;
  dom.window.eval(readFileSync(resolve('src', 'activity-content-script.js'), 'utf-8'));
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
