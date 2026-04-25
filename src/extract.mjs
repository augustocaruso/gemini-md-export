// Lógica pura de scraping e formatação.
// Este módulo NÃO pode depender de `window`, `document` global, `location`,
// `Blob`, `URL.createObjectURL` etc. Todas as funções recebem o DOM como
// argumento explícito para serem testáveis com jsdom.

// --- constantes ---------------------------------------------------------

const TURN_SELECTOR = 'user-query, model-response';

// Labels de acessibilidade que o Gemini injeta como nós de texto.
// Match case-insensitive, com ou sem ponto final, PT e EN.
const A11Y_LABEL_PATTERNS = [
  /^você disse\.?$/i,
  /^o gemini disse\.?$/i,
  /^gemini disse\.?$/i,
  /^you said\.?$/i,
  /^gemini said\.?$/i,
];

const A11Y_BLOCK_CHILD_SELECTOR = [
  'div',
  'p',
  'ul',
  'ol',
  'pre',
  'blockquote',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
].join(',');

// --- chat id ------------------------------------------------------------

/**
 * Extrai o chat id do pathname da URL do Gemini web.
 * Formato atual: `/app/<hex>` com pelo menos 12 chars hex.
 * Retorna null se não for uma URL de conversa específica.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export const extractChatId = (pathname) => {
  if (typeof pathname !== 'string') return null;
  const m = pathname.match(/\/app\/([a-f0-9]{12,})/i);
  return m ? m[1] : null;
};

// --- frontmatter --------------------------------------------------------

const yamlEscapeDouble = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Monta o bloco de frontmatter YAML do arquivo exportado.
 *
 * @param {object} meta
 * @param {string} meta.chatId
 * @param {string} [meta.title]
 * @param {string} meta.url
 * @param {string} meta.exportedAt   ISO string
 * @param {string} [meta.model]
 * @returns {string}
 */
export const buildFrontmatter = ({ chatId, title, url, exportedAt, model }) => {
  const lines = ['---'];
  lines.push(`chat_id: ${chatId}`);
  if (title) lines.push(`title: "${yamlEscapeDouble(title)}"`);
  lines.push(`url: ${url}`);
  lines.push(`exported_at: ${exportedAt}`);
  if (model) lines.push(`model: "${yamlEscapeDouble(model)}"`);
  lines.push('source: gemini-web');
  lines.push('tags: [gemini-export]');
  lines.push('---', '', '');
  return lines.join('\n');
};

// --- scraping -----------------------------------------------------------

/**
 * Remove nós de texto que correspondem exatamente a labels de acessibilidade
 * conhecidos do Gemini ("Você disse", "O Gemini disse" etc).
 * Modifica o nó in-place.
 *
 * @param {Element} root
 */
export const stripAccessibilityLabels = (root) => {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
  const toRemove = [];
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (A11Y_LABEL_PATTERNS.some((re) => re.test(t))) {
      toRemove.push(n);
    }
  }
  toRemove.forEach((n) => n.remove());

  const matchingElements = Array.from(root.querySelectorAll('*')).filter((el) => {
    const text = normalizeWhitespace(el.textContent || '');
    if (!text || !A11Y_LABEL_PATTERNS.some((re) => re.test(text))) return false;
    return !Array.from(el.children).some((child) => child.matches(A11Y_BLOCK_CHILD_SELECTOR));
  });
  matchingElements.forEach((el) => el.remove());
};

/**
 * Remove elementos puramente de UI (botões, menus, painéis de ação) que
 * não contêm conteúdo da conversa.
 *
 * @param {Element} root
 */
export const stripUIChrome = (root) => {
  const selectors = [
    'button',
    '[role="button"]',
    'mat-icon',
    '.action-wrapper',
    '.response-footer',
    '.thought-panel',
    '[aria-hidden="true"]',
  ];
  root.querySelectorAll(selectors.join(',')).forEach((el) => el.remove());
};

/**
 * Substitui um elemento por um nó de texto puro, envolto em `\n\n` antes
 * e depois para garantir separação de bloco no `innerText` final.
 *
 * @param {Element} el
 * @param {string} text
 */
const replaceAsBlock = (el, text) => {
  const doc = el.ownerDocument;
  el.replaceWith(doc.createTextNode('\n\n' + text + '\n\n'));
};

const removeIfEmpty = (el, text) => {
  if (text) {
    replaceAsBlock(el, text);
  } else {
    el.remove();
  }
};

const DIV_BLOCK_CHILD_SELECTOR = [
  'div',
  'p',
  'ul',
  'ol',
  'pre',
  'blockquote',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
].join(',');

const isTextBlockDiv = (el) => {
  if (el.tagName?.toLowerCase() !== 'div') return false;
  return !Array.from(el.children).some((child) => child.matches(DIV_BLOCK_CHILD_SELECTOR));
};

const normalizePreservingBlankLines = (s) =>
  s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

const extractUserQueryLines = (root) => {
  const queryLines = Array.from(root.querySelectorAll('p.query-text-line'));
  if (queryLines.length > 0) {
    return normalizePreservingBlankLines(
      queryLines.map((p) => normalizeWhitespace(p.textContent || '')).join('\n'),
    );
  }

  const directDivs = Array.from(root.children).filter(
    (child) => child.tagName?.toLowerCase() === 'div',
  );
  if (directDivs.length === 0) return null;

  const hasNonDivElementChildren = Array.from(root.children).some(
    (child) => child.tagName?.toLowerCase() !== 'div',
  );
  if (hasNonDivElementChildren) return null;

  return normalizePreservingBlankLines(
    directDivs
      .map((div) => {
        const text = normalizeWhitespace(div.textContent || '');
        return text;
      })
      .join('\n'),
  );
};

const extractUserLines = (root) => {
  const directDivs = Array.from(root.children).filter(
    (child) => child.tagName?.toLowerCase() === 'div',
  );
  if (directDivs.length === 0) return null;

  const hasNonDivElementChildren = Array.from(root.children).some(
    (child) => child.tagName?.toLowerCase() !== 'div',
  );
  if (hasNonDivElementChildren) return null;

  return directDivs
    .map((div) => {
      const text = normalizeWhitespace(div.textContent || '');
      return text;
    })
    .join('\n');
};

/**
 * Converte o DOM de um turno (user-query ou model-response) em string
 * Markdown preservando headings, code blocks, listas, ênfase e parágrafos.
 *
 * @param {Element} node  o elemento do turno (será clonado, original intacto)
 * @returns {string}
 */
export const extractMarkdown = (node) => {
  const clone = node.cloneNode(true);

  stripUIChrome(clone);
  stripAccessibilityLabels(clone);

  // ORDEM IMPORTA: inline primeiro, depois blocos.
  // Quando um bloco (p, h, li) é transformado usando textContent, ele
  // inclui os text nodes que já substituíram elementos inline filhos.
  // Se processarmos blocos antes de inline, a marcação inline é perdida.

  // --- 1. code blocks ---------------------------------------------------
  // Processados primeiro porque engolem tudo lá dentro (não queremos
  // aplicar ** em texto dentro de code block).
  clone.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const langMatch = code?.className.match(/language-(\w+)/);
    const lang = langMatch ? langMatch[1] : '';
    const raw = (code || pre).textContent;
    const fenced = '```' + lang + '\n' + raw.replace(/\n+$/, '') + '\n```';
    replaceAsBlock(pre, fenced);
  });

  // --- 2. inline code ---------------------------------------------------
  clone.querySelectorAll('code').forEach((c) => {
    const doc = c.ownerDocument;
    c.replaceWith(doc.createTextNode('`' + c.textContent + '`'));
  });

  // --- 3. ênfase inline -------------------------------------------------
  clone.querySelectorAll('strong, b').forEach((el) => {
    const doc = el.ownerDocument;
    el.replaceWith(doc.createTextNode('**' + el.textContent + '**'));
  });
  clone.querySelectorAll('em, i').forEach((el) => {
    const doc = el.ownerDocument;
    el.replaceWith(doc.createTextNode('*' + el.textContent + '*'));
  });

  // --- 4. <br> → quebra -------------------------------------------------
  clone.querySelectorAll('br').forEach((br) => {
    const doc = br.ownerDocument;
    br.replaceWith(doc.createTextNode('\n'));
  });

  // user-query costuma serializar cada linha digitada em um <div>.
  // Antes de tratarmos divs como blocos genéricos, preservamos essas quebras
  // como newline simples para não transformar a pergunta em vários parágrafos.
  if (clone.tagName?.toLowerCase() === 'user-query') {
    const userLines = extractUserQueryLines(clone) ?? extractUserLines(clone);
    if (userLines !== null) {
      return userLines;
    }
  }

  // --- 5. blocos de texto ----------------------------------------------
  // Agora que inline foi aplicado, os textContent dos blocos já incluem
  // as marcações (** * `) como texto literal.

  // headings
  for (let level = 1; level <= 6; level++) {
    clone.querySelectorAll('h' + level).forEach((h) => {
      const hashes = '#'.repeat(level);
      const text = normalizeWhitespace(h.textContent);
      removeIfEmpty(h, text ? `${hashes} ${text}` : '');
    });
  }

  // listas (antes de p, pra não capturar li como parágrafo se houver p dentro)
  clone.querySelectorAll('ul, ol').forEach((list) => {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const items = Array.from(list.querySelectorAll(':scope > li'));
    const md = items
      .map((li, i) =>
        ordered ? `${i + 1}. ${li.textContent.trim()}` : `- ${li.textContent.trim()}`,
      )
      .join('\n');
    replaceAsBlock(list, md);
  });

  // parágrafos
  clone.querySelectorAll('p').forEach((p) => {
    removeIfEmpty(p, normalizeWhitespace(p.textContent));
  });

  // divs usados como blocos de texto simples, comum em turnos do usuário
  clone.querySelectorAll('div').forEach((div) => {
    if (!isTextBlockDiv(div)) return;
    removeIfEmpty(div, normalizeWhitespace(div.textContent));
  });

  // coleta e normaliza
  return normalizeWhitespace(clone.textContent);
};

/**
 * Normaliza espaços em branco: sem CR, sem trailing whitespace por linha,
 * no máximo uma linha em branco entre blocos, sem espaços nas pontas.
 *
 * @param {string} s
 * @returns {string}
 */
export const normalizeWhitespace = (s) =>
  s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Retorna role ('user' | 'assistant') de um elemento de turno pela sua
 * tagName. null se não reconhecer.
 *
 * @param {Element} el
 * @returns {'user' | 'assistant' | null}
 */
export const roleOf = (el) => {
  const tag = el.tagName?.toLowerCase();
  if (tag === 'user-query') return 'user';
  if (tag === 'model-response') return 'assistant';
  return null;
};

/**
 * Varre o documento e retorna uma lista ordenada de turnos com role e
 * conteúdo em Markdown.
 *
 * @param {Document} doc
 * @returns {Array<{role: 'user' | 'assistant', text: string}>}
 */
export const scrapeTurns = (doc) => {
  const nodes = doc.querySelectorAll(TURN_SELECTOR);
  const out = [];
  nodes.forEach((n) => {
    const role = roleOf(n);
    if (!role) return;
    const text = extractMarkdown(n);
    if (text.trim()) out.push({ role, text });
  });
  return out;
};

/**
 * Monta o documento Markdown completo (frontmatter + corpo) a partir dos
 * turnos e metadados.
 *
 * @param {object} params
 * @param {object} params.meta           argumentos de buildFrontmatter
 * @param {Array} params.turns           resultado de scrapeTurns
 * @returns {string}
 */
export const buildDocument = ({ meta, turns }) => {
  const frontmatter = buildFrontmatter(meta);
  const body = turns
    .map((t) => {
      const header = t.role === 'user' ? '## 🧑 Usuário' : '## 🤖 Gemini';
      return `${header}\n\n${t.text}`;
    })
    .join('\n\n---\n\n');
  return frontmatter + body + '\n';
};
