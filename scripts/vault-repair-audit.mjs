#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const includeNotes = args.includes('--include-notes');
const reportPathArg = valueAfter('--report');
const rootArg = args.find((arg, index) => {
  if (arg.startsWith('--')) return false;
  if (index > 0 && args[index - 1] === '--report') return false;
  return true;
});
const root = rootArg ? resolve(rootArg.replace(/^~(?=\/|$)/, process.env.HOME || '')) : null;
const reportPath = reportPathArg
  ? resolve(reportPathArg.replace(/^~(?=\/|$)/, process.env.HOME || ''))
  : null;

const usage = () => {
  process.stderr.write(
    'Usage: node vault-repair-audit.mjs [--include-notes] [--report <file.json>] <vault-or-folder>\n',
  );
  process.exit(2);
};

if (!root) usage();
if (!existsSync(root) || !statSync(root).isDirectory()) {
  process.stderr.write(`Folder not found: ${root}\n`);
  process.exit(2);
}

const ignoredDirs = new Set([
  '.git',
  '.obsidian',
  '.trash',
  '.gemini-md-export-repair',
  'node_modules',
]);

const normalizeText = (value) =>
  String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const hashText = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

const walkMarkdown = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name.toLowerCase())) continue;
      walkMarkdown(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

const parseFrontmatter = (text) => {
  if (!text.startsWith('---\n')) return { frontmatter: '', body: text, fields: {} };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: '', body: text, fields: {} };
  const frontmatter = text.slice(4, end).trim();
  const body = text.slice(text.indexOf('\n', end + 4) + 1);
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return { frontmatter, body, fields };
};

const chatIdFromValue = (value) => {
  const text = String(value || '');
  const prefixed = text.match(/\bc_([a-f0-9]{12,})\b/i);
  if (prefixed) return prefixed[1];
  const app = text.match(/\/app\/([a-f0-9]{12,})/i);
  if (app) return app[1];
  const bare = text.match(/\b([a-f0-9]{12,})\b/i);
  return bare?.[1] || '';
};

const GEMINI_APP_LINK_RE = /https:\/\/gemini\.google\.com\/app\/([a-f0-9]{12,})/gi;
const GEMINI_PREFIXED_CHAT_RE = /\bc_([a-f0-9]{12,})\b/gi;

const canonicalGeminiLink = (chatId) =>
  `https://gemini.google.com/app/${String(chatId || '').toLowerCase()}`;

const collectGeminiSourceLinks = (...values) => {
  const byChatId = new Map();
  const add = (chatId, source) => {
    const normalized = String(chatId || '').toLowerCase();
    if (!/^[a-f0-9]{12,}$/.test(normalized) || byChatId.has(normalized)) return;
    byChatId.set(normalized, {
      chatId: normalized,
      url: canonicalGeminiLink(normalized),
      source,
    });
  };

  for (const { value, source = 'unknown', allowBare = false } of values.filter(Boolean)) {
    const text = String(value || '');
    for (const match of text.matchAll(GEMINI_APP_LINK_RE)) add(match[1], source);
    for (const match of text.matchAll(GEMINI_PREFIXED_CHAT_RE)) add(match[1], source);
    if (allowBare) add(chatIdFromValue(text), source);
  }

  return Array.from(byChatId.values());
};

const finalSourceSection = (body) => {
  const text = String(body || '');
  const sourceHeadingRe =
    /^#{1,6}\s+.*(?:Gemini|Fonte|Fontes|Refer[eê]ncias|Origem|Origens|Inspira|Chats?).*$/gim;
  let lastSourceHeading = -1;
  for (const match of text.matchAll(sourceHeadingRe)) {
    lastSourceHeading = match.index;
  }

  if (lastSourceHeading >= 0 && lastSourceHeading >= text.length * 0.45) {
    return text.slice(lastSourceHeading);
  }

  return text.slice(Math.max(0, text.length - 4000));
};

const tagsBeyondGeminiExport = (frontmatter) => {
  const match = frontmatter.match(/^tags:\s*(.+)$/im);
  if (!match) return [];
  const raw = match[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return raw.filter((tag) => !['gemini-export', 'gemini', 'gemini-web'].includes(tag));
};

const collectWikiSignals = ({ frontmatter, body, fields, relPath }) => {
  const signals = [];
  if (/\[\[[^\]]+\]\]/.test(body)) signals.push('obsidian_links');
  if (/(^|\n)\s*\[\[_?[ÍI]ndice_Medicina\]\]/i.test(body)) signals.push('medicine_index_link');
  if (/Wiki_Medicina|Knowledge|Caderno|Atlas/i.test(relPath)) signals.push('wiki_path');

  for (const field of [
    'aliases',
    'status',
    'tipo',
    'sistema',
    'area',
    'especialidade',
    'created',
    'updated',
    'revisado',
  ]) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) signals.push(`frontmatter_${field}`);
  }

  const extraTags = tagsBeyondGeminiExport(frontmatter);
  if (extraTags.length > 0) signals.push(`extra_tags:${extraTags.join(',')}`);

  if (
    /(^|\n)##\s+(Resumo|Conceito|Fisiopatologia|Quadro clínico|Diagnóstico|Tratamento|Referências)\b/i.test(
      body,
    )
  ) {
    signals.push('knowledge_headings');
  }

  return signals;
};

const turnCountFor = (body) => {
  const matches = body.match(/^##\s+(?:🧑\s*)?(?:Usuário|Usuario)|^##\s+(?:🤖\s*)?Gemini/gim);
  return matches?.length || 0;
};

const analyzeFile = (filePath) => {
  const raw = readFileSync(filePath, 'utf-8');
  const relPath = relative(root, filePath);
  const { frontmatter, body, fields } = parseFrontmatter(raw);
  const filenameChatId = chatIdFromValue(basename(filePath, '.md'));
  const frontmatterChatId = chatIdFromValue(fields.chat_id);
  const urlChatId = chatIdFromValue(fields.url);
  const chatId = frontmatterChatId || urlChatId || filenameChatId;
  const sourceLinks = collectGeminiSourceLinks(
    { value: fields.chat_id, source: 'frontmatter.chat_id', allowBare: true },
    { value: fields.url, source: 'frontmatter.url' },
    { value: basename(filePath, '.md'), source: 'filename', allowBare: true },
    { value: frontmatter, source: 'frontmatter' },
    { value: body, source: 'body' },
  );
  const footerSourceLinks = collectGeminiSourceLinks({
    value: finalSourceSection(body),
    source: 'footer',
  });
  const footerSourceUrlSet = new Set(footerSourceLinks.map((link) => link.url));
  const wikiFooterMissingSourceLinks = sourceLinks
    .map((link) => link.url)
    .filter((url) => !footerSourceUrlSet.has(url));
  const source = fields.source || '';
  const looksLikeGeminiExport =
    source === 'gemini-web' ||
    !!frontmatterChatId ||
    /gemini\.google\.com\/app\//i.test(frontmatter) ||
    /gemini\.google\.com\/app\//i.test(body) ||
    /(^|\n)##\s+(?:🧑\s*)?(?:Usuário|Usuario)\b/i.test(body);

  if (!looksLikeGeminiExport) return null;

  const normalizedBody = normalizeText(body);
  const turnCount = turnCountFor(body);
  const wikiSignals = collectWikiSignals({ frontmatter, body, fields, relPath });
  const reasons = [];

  if (!chatId) reasons.push('missing_chat_id');
  if (frontmatterChatId && filenameChatId && frontmatterChatId !== filenameChatId) {
    reasons.push('filename_chat_id_mismatch');
  }
  if (frontmatterChatId && urlChatId && frontmatterChatId !== urlChatId) {
    reasons.push('url_chat_id_mismatch');
  }
  if (wikiSignals.length > 0 && wikiFooterMissingSourceLinks.length > 0) {
    reasons.push('wiki_footer_missing_gemini_source_links');
  }
  if (turnCount === 0) reasons.push('no_gemini_turns');
  if (normalizedBody.length === 0) reasons.push('empty_body');

  return {
    path: filePath,
    relativePath: relPath,
    chatId,
    title: fields.title || '',
    filenameChatId,
    frontmatterChatId,
    urlChatId,
    source,
    sourceChatIds: sourceLinks.map((link) => link.chatId),
    geminiSourceLinks: sourceLinks.map((link) => link.url),
    geminiSourceLinkDetails: sourceLinks,
    wikiFooterGeminiSourceLinks: footerSourceLinks.map((link) => link.url),
    wikiFooterMissingSourceLinks,
    turnCount,
    bytes: Buffer.byteLength(raw, 'utf-8'),
    bodyBytes: Buffer.byteLength(body, 'utf-8'),
    bodyFingerprint: hashText(normalizedBody),
    wikiCandidate: wikiSignals.length > 0,
    wikiSignals,
    reasons,
  };
};

const files = walkMarkdown(root);
const notes = files.map(analyzeFile).filter(Boolean);
const groups = new Map();
for (const note of notes) {
  if (!note.bodyFingerprint || !note.chatId) continue;
  const existing = groups.get(note.bodyFingerprint) || [];
  existing.push(note);
  groups.set(note.bodyFingerprint, existing);
}

const duplicateGroups = [...groups.entries()]
  .map(([fingerprint, members]) => ({
    fingerprint,
    chatIds: [...new Set(members.map((member) => member.chatId).filter(Boolean))],
    paths: members.map((member) => member.relativePath),
  }))
  .filter((group) => group.chatIds.length > 1);

const duplicateFingerprints = new Map(
  duplicateGroups.map((group) => [group.fingerprint, group]),
);

const candidates = notes
  .map((note) => {
    const duplicateGroup = duplicateFingerprints.get(note.bodyFingerprint) || null;
    const reasons = [...note.reasons];
    if (duplicateGroup) reasons.push('duplicate_body_different_chat_ids');
    return {
      ...note,
      duplicateGroup,
      suspect: reasons.length > 0,
      reasons,
    };
  })
  .filter((note) => note.suspect || note.wikiCandidate);

const summary = {
  root,
  scannedMarkdownFiles: files.length,
  geminiExportNotes: notes.length,
  suspectNotes: candidates.filter((note) => note.suspect).length,
  wikiCandidates: candidates.filter((note) => note.wikiCandidate).length,
  duplicateGroups: duplicateGroups.length,
};

const result = {
  ok: true,
  summary,
  duplicateGroups,
  candidates,
  ...(includeNotes ? { notes } : {}),
};

if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        summary,
        reportPath,
        candidatesReturned: candidates.length,
        notesInReport: includeNotes ? notes.length : 0,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
