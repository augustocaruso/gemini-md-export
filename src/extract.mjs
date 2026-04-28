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

const MEDIA_LINK_EXTENSIONS =
  /\.(?:avif|bmp|gif|heic|heif|jpe?g|m4a|mov|mp3|mp4|ogg|pdf|png|tiff?|wav|webm|webp)(?:[?#].*)?$/i;
const MAX_MEDIA_SOURCE_LENGTH = 500;

const MEDIA_SELECTOR = [
  'img',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
  'embed',
  'a[href]',
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

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = normalizeWhitespace(value || '');
    if (text) return text;
  }
  return '';
};

const humanMediaKind = (kind) => {
  if (kind === 'image') return 'Imagem';
  if (kind === 'video') return 'Vídeo';
  if (kind === 'audio') return 'Áudio';
  if (kind === 'canvas') return 'Imagem/canvas';
  if (kind === 'embed') return 'Mídia incorporada';
  if (kind === 'attachment') return 'Anexo';
  return 'Mídia';
};

const attachmentLabelOf = (el) => {
  const description = describeMedia(el);
  const source = mediaSourceOf(el);
  const sourceMatch = source.match(/\/type\/application\/([^/?#]+)/i);
  if (sourceMatch?.[1]) return sourceMatch[1].toUpperCase();
  if (/pdf/i.test(description)) return 'PDF';
  if (/spreadsheet/i.test(description)) return 'Planilha';
  if (/presentation/i.test(description)) return 'Apresentação';
  if (/document/i.test(description)) return 'Documento';
  return 'Arquivo';
};

const mediaKindOf = (el) => {
  const tag = el.tagName?.toLowerCase();
  if (tag === 'img') {
    const source = mediaSourceOf(el);
    const description = describeMedia(el);
    if (
      /drive-thirdparty\.googleusercontent\.com\/\d+\/type\/application\//i.test(source) ||
      /\b(?:pdf|document|spreadsheet|presentation)\s+icon\b/i.test(description)
    ) {
      return 'attachment';
    }
    return 'image';
  }
  if (tag === 'video') return 'video';
  if (tag === 'audio') return 'audio';
  if (tag === 'canvas') return 'canvas';
  if (tag === 'iframe' || tag === 'object' || tag === 'embed') return 'embed';
  if (tag === 'a' && MEDIA_LINK_EXTENSIONS.test(el.getAttribute('href') || '')) {
    return 'attachment';
  }
  return null;
};

const mediaSourceOf = (el) =>
  firstNonEmpty(
    el.currentSrc,
    el.getAttribute('currentSrc'),
    el.src,
    el.getAttribute('src'),
    el.getAttribute('srcset'),
    el.getAttribute('data-src'),
    el.data,
    el.getAttribute('data'),
    el.href,
    el.getAttribute('href'),
    el.getAttribute('data-download-url'),
    el.querySelector?.('source[src]')?.getAttribute('src'),
    el.querySelector?.('source[srcset]')?.getAttribute('srcset'),
  );

const shouldPrintMediaSource = (source) => {
  if (!source) return false;
  return !/^(?:blob|data|javascript):/i.test(source);
};

const formatMediaSource = (source) =>
  source.length > MAX_MEDIA_SOURCE_LENGTH
    ? `${source.slice(0, MAX_MEDIA_SOURCE_LENGTH - 3)}...`
    : source;

const describeMedia = (el) =>
  firstNonEmpty(
    el.getAttribute('alt'),
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.textContent,
  );

const mediaPlaceholderFor = (el) => {
  const kind = mediaKindOf(el);
  if (!kind) return '';

  const description = describeMedia(el);
  const source = mediaSourceOf(el);
  if (kind === 'attachment') {
    const attachmentLabel = attachmentLabelOf(el);
    const lines = [
      '> [!info] Anexo não importado',
      `> ${attachmentLabel} detectado neste ponto da conversa.`,
      '> O Gemini expõe apenas um preview/ícone no DOM exportável; o arquivo original precisa ser salvo manualmente.',
    ];
    if (description && !/\b(?:pdf|document|spreadsheet|presentation)\s+icon\b/i.test(description)) {
      lines.push(`> Descrição: ${description}`);
    }
    if (
      shouldPrintMediaSource(source) &&
      !/drive-thirdparty\.googleusercontent\.com\/\d+\/type\/application\//i.test(source)
    ) {
      lines.push(`> Origem detectada: ${formatMediaSource(source)}`);
    }
    return lines.join('\n');
  }

  const label = humanMediaKind(kind);
  const lines = [
    '> [!warning] Mídia não importada',
    `> Tipo: ${label}`,
    '> Arquivo detectado neste ponto da conversa, mas não salvo automaticamente.',
  ];
  if (description) lines.push(`> Descrição: ${description}`);
  if (shouldPrintMediaSource(source)) {
    lines.push(`> Origem detectada: ${formatMediaSource(source)}`);
  }
  return lines.join('\n');
};

const mediaReplacementTarget = (el, root) => {
  const interactive = el.closest?.('button, [role="button"]');
  if (interactive && interactive !== root && root.contains(interactive)) {
    return interactive;
  }
  return el;
};

const replaceMediaWithPlaceholders = (root) => {
  const placeholders = [];
  const replaced = new Set();
  const elements = Array.from(root.querySelectorAll(MEDIA_SELECTOR));
  elements.forEach((el) => {
    const target = mediaReplacementTarget(el, root);
    if (replaced.has(target) || !root.contains(target)) return;
    const placeholder = mediaPlaceholderFor(el);
    if (!placeholder) return;
    replaced.add(target);
    placeholders.push(placeholder);
    replaceAsBlock(target, placeholder);
  });
  return placeholders;
};

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

  const mediaPlaceholders = replaceMediaWithPlaceholders(clone);
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
    const hasQueryTextLines = clone.querySelectorAll('p.query-text-line').length > 0;
    const userLines = extractUserQueryLines(clone) ?? extractUserLines(clone);
    if (userLines !== null) {
      if (hasQueryTextLines) {
        return [userLines, ...mediaPlaceholders].filter(Boolean).join('\n\n');
      }
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
