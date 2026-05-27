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
  const progressViewModelSource = readFileSync(
    resolve('build', 'ts', 'core', 'progress-view-model.js'),
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
    .replace(
      '/* __INLINE_PROGRESS_DOCK_UI__ */',
      `${hostPaletteSource}\n${progressViewModelSource}\n${progressDockSource}`,
    )
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

test('activity content script aceita candidatos com scoring do MCP', async () => {
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026" data-timestamp="1778395569000">
      <div>Gemini Apps</div>
      <section data-gm-activity-details>
        <p>Prompted Gemini</p>
        <p>Primeiro prompt sensível de fixture HTML</p>
        <p>Primeira resposta sensível de fixture HTML</p>
      </section>
    </div>
  `);

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: {
          firstPrompt: 'Primeiro prompt sensível de fixture HTML',
          assistantSamples: ['Primeira resposta sensível de fixture HTML'],
        },
      },
    ],
    maxCards: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matches[0].chatId, 'b8e7c075effe9457');
  assert.equal(result.matches[0].date, '2026-05-10T06:46:09Z');
});

test('activity content script abre detalhes quando scan pede openDetails', async () => {
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026" data-timestamp="1778395569000">
      <div>Gemini Apps</div>
      <div>Consulta com título visível do My Activity</div>
      <button aria-label="Item details">Item details</button>
    </div>
  `);
  const { document } = debug._window;
  document.querySelector('button').addEventListener('click', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<p>Prompt oculto em detalhes do My Activity</p>';
    document.body.appendChild(dialog);
  });

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: {
          title: 'Consulta com título visível do My Activity',
          firstPrompt: 'Prompt oculto em detalhes do My Activity',
        },
      },
    ],
    maxCards: 20,
    openDetails: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matches[0].chatId, 'b8e7c075effe9457');
  assert.equal(result.matches[0].date, '2026-05-10T06:46:09Z');
});

test('activity content script nao abre detalhes sem match preliminar no card fechado', async () => {
  let detailClicks = 0;
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026" data-timestamp="1778395569000">
      <div>Gemini Apps</div>
      <div>Texto de outro chat qualquer</div>
      <button aria-label="Item details">Item details</button>
    </div>
  `);
  const { document } = debug._window;
  document.querySelector('button').addEventListener('click', () => {
    detailClicks += 1;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.textContent = 'Prompt oculto que nao deveria ser lido sem candidato preliminar';
    document.body.appendChild(dialog);
  });

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: {
          title: 'Consulta com título visível do My Activity',
          firstPrompt: 'Prompt oculto que nao deveria ser lido sem candidato preliminar',
        },
      },
    ],
    maxCards: 20,
    openDetails: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 0);
  assert.equal(detailClicks, 0);
});

test('activity content script diagnostica cards sem retornar texto bruto por padrao', async () => {
  const debug = loadHarness(`
    <div class="activity-card" data-date="May 10, 2026" data-timestamp="1778395569000">
      <div>Gemini Apps</div>
      <div>Consulta com título visível do My Activity</div>
      <button aria-label="Item details">Item details</button>
    </div>
  `);

  const result = await debug.scanActivityPage({
    diagnoseCards: true,
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: {
          title: 'Consulta com título visível do My Activity',
          firstPrompt: 'Prompt oculto em detalhes do My Activity',
        },
      },
    ],
    maxCards: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.cardCount, 1);
  assert.equal(result.diagnostics.cards[0].hasDetailsButton, true);
  assert.equal(result.diagnostics.cards[0].topPreliminary[0].chatId, 'b8e7c075effe9457');
  assert.equal(result.diagnostics.cards[0].topPreliminary[0].score, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Consulta com título visível/);
  assert.doesNotMatch(serialized, /Prompt oculto/);
});

test('activity content script ignora container agregador com varios cards', async () => {
  const debug = loadHarness(`
    <div data-timestamp="1778390000000">
      <div class="activity-card" data-timestamp="1778395569000">
        <div>Gemini Apps</div>
        <section data-gm-activity-details>
          <p>Primeiro prompt sensível de fixture HTML</p>
        </section>
      </div>
      <div class="activity-card" data-timestamp="1778399551000">
        <div>Gemini Apps</div>
        <section data-gm-activity-details>
          <p>Último prompt sensível de fixture HTML</p>
        </section>
      </div>
    </div>
  `);

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: 'b8e7c075effe9457',
        scoring: { firstPrompt: 'Primeiro prompt sensível de fixture HTML' },
      },
      {
        chatId: 'c8e7c075effe9457',
        scoring: { firstPrompt: 'Último prompt sensível de fixture HTML' },
      },
    ],
    maxCards: 20,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.matches.map((match) => [match.chatId, match.date]))),
    [
      ['b8e7c075effe9457', '2026-05-10T06:46:09Z'],
      ['c8e7c075effe9457', '2026-05-10T07:52:31Z'],
    ],
  );
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

test('activity content script usa cabecalho de data anterior ao card', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const debug = loadHarness(`
      <section>
        <h2>May 10, 2026</h2>
        <div class="activity-card">
          <div>Gemini Apps</div>
          <span data-date="metadado interno sem data parseavel"></span>
          <div>Prompted Resumo sobre pneumotórax3:46 AM • Details</div>
        </div>
      </section>
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

test('activity content script parseia cabecalho relativo concatenado com texto auxiliar', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const debug = loadHarness(`
      <section>
        <div>Today<span>Some activity may not appear yet</span></div>
        <div class="activity-card">
          <div>Gemini Apps</div>
          <div>Prompted can i use python libraries in my ios app8:17 PM • Details</div>
        </div>
      </section>
    `);

    const result = await debug.scanActivityPage({
      candidates: [
        {
          chatId: 'dbe5dd4b50b09c74',
          firstPrompt: 'can i use python libraries in my ios app',
        },
      ],
      maxCards: 20,
    });

    const today = new Date();
    const expected = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      20,
      17,
      0,
    ).toISOString().replace(/\.\d{3}Z$/, 'Z');
    assert.equal(result.matches[0].date, expected);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('activity content script carrega cabecalho de data distante no mesmo grupo', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const previousCards = Array.from(
      { length: 16 },
      (_, index) => `
        <div class="activity-card">
          <div>Gemini Apps</div>
          <div>Prompted Outro item ${index}2:${String(index).padStart(2, '0')} AM • Details</div>
        </div>
      `,
    ).join('');
    const debug = loadHarness(`
      <section>
        <h2>May 10, 2026</h2>
        ${previousCards}
        <div class="activity-card">
          <div>Gemini Apps</div>
          <span data-date="metadado interno sem data parseavel"></span>
          <div>Prompted Caso real com cabecalho distante e texto suficiente para evidencia3:46 AM • Details</div>
        </div>
      </section>
    `);

    const result = await debug.scanActivityPage({
      candidates: [
        {
          chatId: 'bbbbbbbbbbbb',
          firstPrompt: 'Caso real com cabecalho distante e texto suficiente para evidencia',
        },
      ],
      maxCards: 30,
    });

    const match = result.matches.find((item) => item.chatId === 'bbbbbbbbbbbb');
    assert.equal(match?.date, '2026-05-10T06:46:00Z');
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('activity content script continua rolando ate encontrar todas as bordas de data', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const debug = loadHarness(`
      <section id="activity-feed">
        <h2>May 2</h2>
        <div class="activity-card">
          <div>Gemini Apps</div>
          <div>Prompted Quinidina fale sobre o uso na doença de brugada10:52 PM • Details</div>
        </div>
      </section>
    `);
    const { document } = debug._window;
    let appended = false;
    debug._window.scrollTo = () => {
      if (appended) return;
      appended = true;
      document.getElementById('activity-feed').insertAdjacentHTML(
        'beforeend',
        `
          <h2>May 2</h2>
          <div class="activity-card">
            <div>Gemini Apps</div>
            <div>Prompted No contexto de anemia falciforme e sd vaso oclusiva, comente Sequestro isquêmico Sequestro esplênico5:34 PM • Details</div>
          </div>
        `,
      );
    };

    const result = await debug.scanActivityPage({
      candidates: [
        {
          chatId: '72f49fe17ca031d3',
          firstPrompt:
            'No contexto de anemia falciforme e sd vaso oclusiva, comente Sequestro isquêmico Sequestro esplênico',
          lastPrompt: 'Quinidina fale sobre o uso na doença de brugada',
        },
      ],
      maxCards: 20,
      maxScrollRounds: 2,
    });

    assert.equal(appended, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.matches.map((match) => [match.kind, match.date]).sort())),
      [
        ['created', '2026-05-02T20:34:00Z'],
        ['last_message', '2026-05-03T01:52:00Z'],
      ],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.checkpoint.resolvedChatIds)), ['72f49fe17ca031d3']);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('activity content script usa card generico unico para chat de um turno sem prompt', async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    const debug = loadHarness(`
      <section>
        <h2>April 25</h2>
        <div class="activity-card">
          <div>Gemini Apps</div>
          <div>Used Gemini Apps9:30 PM • Details</div>
        </div>
      </section>
    `);

    const result = await debug.scanActivityPage({
      candidates: [
        {
          chatId: '2c52369234b6f57a',
          turnCount: 1,
          scoring: {
            title: 'Personalizado Ecossistema Produtividade: Próximos Passos',
            firstPrompt: '',
            lastPrompt: '',
            assistantSamples: [
              'Olá! Que satisfação finalmente abrir as portas e me conectar ao seu ecossistema',
            ],
          },
        },
      ],
      maxCards: 20,
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].kind, 'unknown');
    assert.equal(result.matches[0].date, '2026-04-26T00:30:00Z');
    assert.match(result.matches[0].warnings.join(','), /generic_usage_card/);
    assert.deepEqual(JSON.parse(JSON.stringify(result.checkpoint.resolvedChatIds)), ['2c52369234b6f57a']);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('activity content script nao usa card generico ambiguo para chat sem prompt', async () => {
  const debug = loadHarness(`
    <section>
      <h2>April 25</h2>
      <div class="activity-card">
        <div>Gemini Apps</div>
        <div>Used Gemini Apps9:30 PM • Details</div>
      </div>
      <div class="activity-card">
        <div>Gemini Apps</div>
        <div>Used Gemini Apps8:30 PM • Details</div>
      </div>
    </section>
  `);

  const result = await debug.scanActivityPage({
    candidates: [
      {
        chatId: '2c52369234b6f57a',
        turnCount: 1,
        scoring: {
          title: 'Personalizado Ecossistema Produtividade: Próximos Passos',
          firstPrompt: '',
          lastPrompt: '',
          assistantSamples: ['Olá! Que satisfação finalmente abrir as portas'],
        },
      },
    ],
    maxCards: 20,
    maxScrollRounds: 0,
  });

  assert.equal(result.matches.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.checkpoint.resolvedChatIds)), []);
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

test('activity content script renderiza jobProgress do MCP no mesmo dock do export', () => {
  const debug = loadHarness('<div>Gemini Apps</div>');

  debug._private.handleMcpJobProgressBroadcast({
    source: 'mcp',
    kind: 'recent-chats-export',
    workflow: 'partial-history-export',
    status: 'running',
    phase: 'exporting',
    total: 30,
    current: 11,
    completed: 10,
    position: 11,
    label: 'Baixando conversas do Gemini: Anemia Falciforme',
    title: 'Anemia Falciforme',
    chatId: 'aaaaaaaaaaaa',
  });

  const dock = debug._window.document.getElementById('gm-md-export-progress-dock');
  assert.ok(dock);
  assert.equal(dock.hidden, false);
  assert.match(dock.textContent, /Gemini Markdown Export/);
  assert.match(dock.textContent, /Baixando conversas do Gemini/);
  assert.match(dock.textContent, /30/);
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
  assert.match(activitySource, /onJobProgress:\s*handleMcpJobProgressBroadcast/);
  assert.match(activitySource, /buildExportJobProgressViewModel/);
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
