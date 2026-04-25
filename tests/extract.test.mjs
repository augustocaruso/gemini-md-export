// Testes da lógica pura de src/extract.mjs.
//
// Usa `node --test` builtin (Node 20+) e jsdom pra montar o DOM.
// Fixtures reais devem ser colocadas em fixtures/*.html e carregadas via
// loadFixture(). Enquanto não houver fixtures reais, testamos com HTML
// sintético que imita a estrutura conhecida do Gemini web.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

import {
  extractChatId,
  buildFrontmatter,
  stripAccessibilityLabels,
  extractMarkdown,
  scrapeTurns,
  buildDocument,
  normalizeWhitespace,
  roleOf,
} from '../src/extract.mjs';

// --- helpers ------------------------------------------------------------

const makeDoc = (bodyHtml) =>
  new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`).window.document;

const makeEl = (html) => {
  const doc = makeDoc(html);
  return doc.body.firstElementChild;
};

const loadFixture = (name) => {
  const path = resolve('fixtures', name);
  if (!existsSync(path)) return null;
  const html = readFileSync(path, 'utf-8');
  return makeDoc(html);
};

// --- extractChatId ------------------------------------------------------

test('extractChatId: aceita hex de 16 chars no /app/', () => {
  assert.equal(
    extractChatId('/app/b8e7c075effe9457'),
    'b8e7c075effe9457',
  );
});

test('extractChatId: aceita hex longer e uppercase', () => {
  assert.equal(
    extractChatId('/app/ABCDEF0123456789'),
    'ABCDEF0123456789',
  );
});

test('extractChatId: ignora trailing path/query', () => {
  assert.equal(
    extractChatId('/app/b8e7c075effe9457/'),
    'b8e7c075effe9457',
  );
});

test('extractChatId: retorna null quando não há id', () => {
  assert.equal(extractChatId('/app/'), null);
  assert.equal(extractChatId('/'), null);
  assert.equal(extractChatId(''), null);
});

test('extractChatId: retorna null para input inválido', () => {
  assert.equal(extractChatId(null), null);
  assert.equal(extractChatId(undefined), null);
  assert.equal(extractChatId(42), null);
});

// --- buildFrontmatter ---------------------------------------------------

test('buildFrontmatter: campos obrigatórios presentes', () => {
  const fm = buildFrontmatter({
    chatId: 'abc',
    url: 'https://gemini.google.com/app/abc',
    exportedAt: '2026-04-22T18:32:11.245Z',
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\nchat_id: abc\n/);
  assert.match(fm, /\nurl: https:\/\/gemini\.google\.com\/app\/abc\n/);
  assert.match(fm, /\nexported_at: 2026-04-22T18:32:11\.245Z\n/);
  assert.match(fm, /\nsource: gemini-web\n/);
  assert.match(fm, /\ntags: \[gemini-export\]\n/);
  assert.match(fm, /\n---\n\n$/);
});

test('buildFrontmatter: title opcional', () => {
  const withTitle = buildFrontmatter({
    chatId: 'x',
    title: 'Meu título',
    url: 'u',
    exportedAt: 't',
  });
  assert.match(withTitle, /\ntitle: "Meu título"\n/);

  const withoutTitle = buildFrontmatter({
    chatId: 'x',
    url: 'u',
    exportedAt: 't',
  });
  assert.doesNotMatch(withoutTitle, /title:/);
});

test('buildFrontmatter: escape de aspas no title', () => {
  const fm = buildFrontmatter({
    chatId: 'x',
    title: 'Aspas "internas" aqui',
    url: 'u',
    exportedAt: 't',
  });
  assert.match(fm, /\ntitle: "Aspas \\"internas\\" aqui"\n/);
});

test('buildFrontmatter: model opcional', () => {
  const withModel = buildFrontmatter({
    chatId: 'x',
    url: 'u',
    exportedAt: 't',
    model: '2.5 Pro',
  });
  assert.match(withModel, /\nmodel: "2\.5 Pro"\n/);

  const withoutModel = buildFrontmatter({
    chatId: 'x',
    url: 'u',
    exportedAt: 't',
  });
  assert.doesNotMatch(withoutModel, /model:/);
});

// --- normalizeWhitespace ------------------------------------------------

test('normalizeWhitespace: colapsa múltiplas linhas em branco para no máximo uma', () => {
  assert.equal(
    normalizeWhitespace('a\n\n\n\nb'),
    'a\n\nb',
  );
});

test('normalizeWhitespace: tira trailing whitespace por linha', () => {
  assert.equal(
    normalizeWhitespace('a   \nb\t\nc'),
    'a\nb\nc',
  );
});

test('normalizeWhitespace: remove CR', () => {
  assert.equal(
    normalizeWhitespace('a\r\nb'),
    'a\nb',
  );
});

test('normalizeWhitespace: trim nas pontas', () => {
  assert.equal(
    normalizeWhitespace('\n\n  hello  \n\n'),
    'hello',
  );
});

// --- stripAccessibilityLabels -------------------------------------------

test('stripAccessibilityLabels: remove "Você disse" como nó de texto', () => {
  const el = makeEl('<div><span>Você disse</span><p>conteúdo real</p></div>');
  stripAccessibilityLabels(el);
  assert.doesNotMatch(el.textContent, /Você disse/);
  assert.match(el.textContent, /conteúdo real/);
});

test('stripAccessibilityLabels: remove "O Gemini disse"', () => {
  const el = makeEl('<div>O Gemini disse<p>resposta</p></div>');
  stripAccessibilityLabels(el);
  assert.doesNotMatch(el.textContent, /O Gemini disse/);
});

test('stripAccessibilityLabels: remove variantes em inglês', () => {
  const user = makeEl('<div>You said<p>hi</p></div>');
  stripAccessibilityLabels(user);
  assert.doesNotMatch(user.textContent, /You said/);

  const model = makeEl('<div>Gemini said<p>hello</p></div>');
  stripAccessibilityLabels(model);
  assert.doesNotMatch(model.textContent, /Gemini said/);
});

test('stripAccessibilityLabels: remove label embrulhado em heading/elemento', () => {
  const el = makeEl('<div><h2>Gemini disse</h2><p>resposta real</p></div>');
  stripAccessibilityLabels(el);
  assert.doesNotMatch(el.textContent, /Gemini disse/);
  assert.match(el.textContent, /resposta real/);
});

test('stripAccessibilityLabels: NÃO remove texto que só contém palavras similares', () => {
  const el = makeEl('<div><p>Você disse que ele foi embora.</p></div>');
  stripAccessibilityLabels(el);
  // O match é exato (a regex exige ^...$), então frase maior permanece.
  assert.match(el.textContent, /Você disse que ele foi embora\./);
});

// --- roleOf -------------------------------------------------------------

test('roleOf: user-query → user', () => {
  const el = makeEl('<user-query>oi</user-query>');
  assert.equal(roleOf(el), 'user');
});

test('roleOf: model-response → assistant', () => {
  const el = makeEl('<model-response>oi</model-response>');
  assert.equal(roleOf(el), 'assistant');
});

test('roleOf: desconhecido → null', () => {
  const el = makeEl('<div>x</div>');
  assert.equal(roleOf(el), null);
});

// --- extractMarkdown ----------------------------------------------------

test('extractMarkdown: texto simples preserva conteúdo', () => {
  const el = makeEl('<model-response><p>olá mundo</p></model-response>');
  const md = extractMarkdown(el);
  assert.equal(md, 'olá mundo');
});

test('extractMarkdown: headings ganham # correspondente', () => {
  const el = makeEl(
    '<model-response><h2>Seção</h2><p>texto</p></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /## Seção/);
  assert.match(md, /texto/);
});

test('extractMarkdown: headings têm linha em branco antes e depois', () => {
  const el = makeEl(
    '<model-response><p>antes</p><h2>meio</h2><p>depois</p></model-response>',
  );
  const md = extractMarkdown(el);
  // padrão que detectava o bug: heading colado com texto anterior/posterior
  assert.doesNotMatch(md, /[^\n]## meio/);
  assert.doesNotMatch(md, /## meio[^\n]/);
});

test('extractMarkdown: ignora heading que só contém label do Gemini', () => {
  const el = makeEl(
    '<model-response><h2>Gemini disse</h2><p>conteúdo real</p></model-response>',
  );
  const md = extractMarkdown(el);
  assert.equal(md, 'conteúdo real');
});

test('extractMarkdown: code blocks ganham fences com linguagem', () => {
  const el = makeEl(
    '<model-response><pre><code class="language-python">print(1)</code></pre></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /```python\nprint\(1\)\n```/);
});

test('extractMarkdown: code block sem language → fence simples', () => {
  const el = makeEl(
    '<model-response><pre><code>plain text</code></pre></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /```\nplain text\n```/);
});

test('extractMarkdown: strong e em viram ** e *', () => {
  const el = makeEl(
    '<model-response><p>isso é <strong>forte</strong> e <em>suave</em></p></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /\*\*forte\*\*/);
  assert.match(md, /\*suave\*/);
});

test('extractMarkdown: listas unordered viram -', () => {
  const el = makeEl(
    '<model-response><ul><li>um</li><li>dois</li></ul></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /- um/);
  assert.match(md, /- dois/);
});

test('extractMarkdown: listas ordered viram 1. 2. 3.', () => {
  const el = makeEl(
    '<model-response><ol><li>um</li><li>dois</li><li>três</li></ol></model-response>',
  );
  const md = extractMarkdown(el);
  assert.match(md, /1\. um/);
  assert.match(md, /2\. dois/);
  assert.match(md, /3\. três/);
});

test('extractMarkdown: remove botões e ícones de UI', () => {
  const el = makeEl(
    '<model-response><button>Copy</button><p>resposta real</p><mat-icon>more_vert</mat-icon></model-response>',
  );
  const md = extractMarkdown(el);
  assert.doesNotMatch(md, /Copy/);
  assert.doesNotMatch(md, /more_vert/);
  assert.match(md, /resposta real/);
});

test('extractMarkdown: remove label "Você disse" do turno do usuário', () => {
  const el = makeEl(
    '<user-query>Você disse<p>qual a dose de sertralina?</p></user-query>',
  );
  const md = extractMarkdown(el);
  assert.doesNotMatch(md, /Você disse/);
  assert.match(md, /qual a dose de sertralina/);
});

test('extractMarkdown: preserva quebras de linha em blocos div do usuário', () => {
  const el = makeEl(`
    <user-query>
      <div>linha 1</div>
      <div>linha 2</div>
    </user-query>
  `);
  const md = extractMarkdown(el);
  assert.equal(md, 'linha 1\nlinha 2');
});

test('extractMarkdown: preserva linha em branco do usuário via div vazio', () => {
  const el = makeEl(`
    <user-query>
      <div>linha 1</div>
      <div><br></div>
      <div>linha 3</div>
    </user-query>
  `);
  const md = extractMarkdown(el);
  assert.equal(md, 'linha 1\n\nlinha 3');
});

test('extractMarkdown: preserva linhas do usuário no DOM real com query-text-line', () => {
  const el = makeEl(`
    <user-query>
      <span class="user-query-bubble-with-background enable-2026q1-formatting-improvements">
        <span class="horizontal-container">
          <div role="heading" aria-level="2" class="query-text gds-body-l" dir="ltr">
            <span class="cdk-visually-hidden screen-reader-user-query-label">You said</span>
            <p class="query-text-line">texto</p>
            <p class="query-text-line">texto</p>
            <p class="query-text-line"><br></p>
            <p class="query-text-line"><br></p>
            <p class="query-text-line">texto</p>
          </div>
        </span>
      </span>
    </user-query>
  `);
  const md = extractMarkdown(el);
  assert.equal(md, 'texto\ntexto\n\n\ntexto');
});

test('extractMarkdown: remove label "O Gemini disse" da resposta', () => {
  const el = makeEl(
    '<model-response>O Gemini disse<p>a dose usual é 50mg</p></model-response>',
  );
  const md = extractMarkdown(el);
  assert.doesNotMatch(md, /O Gemini disse/);
  assert.match(md, /a dose usual é 50mg/);
});

test('extractMarkdown: não cola heading com parágrafo seguinte (regressão real)', () => {
  // Baseado no bug reportado: "### Mini-Aula: ...\n" colado com o próximo
  // parágrafo sem linha em branco.
  const el = makeEl(`
    <model-response>
      <p>Contexto inicial.</p>
      <h3>Mini-Aula: Acidose Metabólica</h3>
      <p>Primeira frase da aula.</p>
    </model-response>
  `);
  const md = extractMarkdown(el);
  const lines = md.split('\n');
  // encontra o índice do heading
  const idx = lines.findIndex((l) => l.startsWith('### '));
  assert.notEqual(idx, -1, 'heading deve aparecer');
  assert.equal(lines[idx - 1], '', 'linha antes do heading deve ser vazia');
  assert.equal(lines[idx + 1], '', 'linha depois do heading deve ser vazia');
});

// --- scrapeTurns --------------------------------------------------------

test('scrapeTurns: extrai user e assistant em ordem', () => {
  const doc = makeDoc(`
    <user-query><p>pergunta 1</p></user-query>
    <model-response><p>resposta 1</p></model-response>
    <user-query><p>pergunta 2</p></user-query>
    <model-response><p>resposta 2</p></model-response>
  `);
  const turns = scrapeTurns(doc);
  assert.equal(turns.length, 4);
  assert.deepEqual(
    turns.map((t) => t.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.match(turns[0].text, /pergunta 1/);
  assert.match(turns[3].text, /resposta 2/);
});

test('scrapeTurns: ignora turnos vazios', () => {
  const doc = makeDoc(`
    <user-query></user-query>
    <model-response><p>conteúdo</p></model-response>
  `);
  const turns = scrapeTurns(doc);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, 'assistant');
});

test('scrapeTurns: documento sem turnos retorna array vazio', () => {
  const doc = makeDoc('<div>nada aqui</div>');
  assert.deepEqual(scrapeTurns(doc), []);
});

// --- buildDocument ------------------------------------------------------

test('buildDocument: separador --- entre turnos', () => {
  const doc = buildDocument({
    meta: {
      chatId: 'x',
      url: 'u',
      exportedAt: 't',
    },
    turns: [
      { role: 'user', text: 'oi' },
      { role: 'assistant', text: 'olá' },
    ],
  });
  assert.match(doc, /## 🧑 Usuário\n\noi\n\n---\n\n## 🤖 Gemini\n\nolá\n$/);
});

test('buildDocument: frontmatter seguido de corpo', () => {
  const doc = buildDocument({
    meta: {
      chatId: 'abc',
      url: 'https://g.co/abc',
      exportedAt: '2026-01-01T00:00:00.000Z',
    },
    turns: [{ role: 'user', text: 'q' }],
  });
  assert.match(doc, /^---\n/);
  assert.match(doc, /chat_id: abc/);
  assert.match(doc, /## 🧑 Usuário\n\nq\n$/);
});

// --- fixture-based tests (opcionais, rodam se houver fixtures) ----------

test('fixture: turno do usuário real (pula se não existir)', (t) => {
  const doc = loadFixture('sample-turn-user.html');
  if (!doc) {
    t.skip('fixtures/sample-turn-user.html não existe');
    return;
  }
  const el = doc.body.firstElementChild;
  const md = extractMarkdown(el);
  // asserts genéricos que devem valer pra qualquer turno do usuário
  assert.doesNotMatch(md, /Você disse/);
  assert.doesNotMatch(md, /You said/);
  assert.ok(md.length > 0, 'markdown não deve ser vazio');
});

test('fixture: resposta do modelo real (pula se não existir)', (t) => {
  const doc = loadFixture('sample-turn-model.html');
  if (!doc) {
    t.skip('fixtures/sample-turn-model.html não existe');
    return;
  }
  const el = doc.body.firstElementChild;
  const md = extractMarkdown(el);
  assert.doesNotMatch(md, /O Gemini disse/);
  assert.doesNotMatch(md, /Gemini said/);
  assert.ok(md.length > 0);
});
