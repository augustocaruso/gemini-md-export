#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47283';
const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const URL_CHAT_ID_RE = /\/app\/([a-f0-9]{12,})/i;

const usage = () => `Uso:
  gemini-md-export metadata backfill <vaultDir> --use-my-activity --report <report.json>
  gemini-md-export metadata backfill <vaultDir> --takeout <Minhaatividade.html|MyActivity.json> --report <report.json>

Opções:
  --use-my-activity        usa uma aba My Activity conectada pela extensão
  --takeout <arquivo>      usa arquivo offline do Google Takeout/My Activity
  --bridge-url <url>       bridge local (default: ${DEFAULT_BRIDGE_URL})
  --report <json>          caminho do relatório/checkpoint
  --limit <n>              limita quantidade de chats processados
  --no-open-if-missing     não abre/recarrega My Activity automaticamente
`;

const expandUserPath = (value) => {
  const text = String(value || '');
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return text;
};

const parseArgs = (argv) => {
  const args = {
    vaultDir: '',
    useMyActivity: false,
    takeout: '',
    report: '',
    bridgeUrl: DEFAULT_BRIDGE_URL,
    limit: 0,
    openIfMissing: true,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Valor ausente para ${arg}`);
      return argv[index];
    };
    if (arg === '--use-my-activity') args.useMyActivity = true;
    else if (arg === '--takeout') args.takeout = value();
    else if (arg === '--report') args.report = value();
    else if (arg === '--bridge-url') args.bridgeUrl = value().replace(/\/+$/, '');
    else if (arg === '--limit') args.limit = Math.max(0, Number(value()) || 0);
    else if (arg === '--open-if-missing') args.openIfMissing = true;
    else if (arg === '--no-open-if-missing') args.openIfMissing = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Opção desconhecida: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  args.vaultDir = positionals[0] || '';
  if (!args.vaultDir) throw new Error('Informe <vaultDir>.');
  return args;
};

const hashText = (value) =>
  createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);

const portableIsoSeconds = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const yamlEscape = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const parseScalar = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
};

const parseFrontmatter = (content) => {
  if (!content.startsWith('---\n')) return { data: {}, body: content, raw: '' };
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: content, raw: '' };
  const raw = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  const data = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = parseScalar(match[2]);
  }
  return { data, body, raw };
};

const extractChatId = (frontmatter, filePath) => {
  const fromYaml = String(frontmatter.chat_id || '').trim();
  if (CHAT_ID_RE.test(fromYaml)) return fromYaml.toLowerCase();
  const fromUrl = String(frontmatter.url || '').match(URL_CHAT_ID_RE)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  const fromFile = basename(filePath, '.md');
  return CHAT_ID_RE.test(fromFile) ? fromFile.toLowerCase() : null;
};

const assistantTurnCount = (body) => (String(body || '').match(/^##\s*🤖\s*Gemini\b/gm) || []).length;

const sectionsForRole = (body, role) => {
  const emoji = role === 'user' ? '🧑' : '🤖';
  const otherEmoji = role === 'user' ? '🤖' : '🧑';
  const re = new RegExp(
    `^##\\s*${emoji}\\s*[^\\n]*\\n\\n([\\s\\S]*?)(?=\\n\\n---\\n\\n##\\s*${otherEmoji}|\\n\\n---\\n\\n##\\s*${emoji}|$)`,
    'gm',
  );
  return Array.from(String(body || '').matchAll(re), (match) => match[1].trim()).filter(Boolean);
};

const sampleText = (value, max = 1200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const normalizeComparableText = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const collectMarkdownFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const path = resolve(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (entry.toLowerCase().endsWith('.md')) files.push(path);
    }
  };
  visit(root);
  return files.sort();
};

const buildCandidate = (filePath, vaultDir) => {
  const original = readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(original);
  const chatId = extractChatId(parsed.data, filePath);
  if (!chatId) return null;
  const userTurns = sectionsForRole(parsed.body, 'user');
  const assistantTurns = sectionsForRole(parsed.body, 'assistant');
  const firstPrompt = sampleText(userTurns[0] || '');
  const lastPrompt = sampleText(userTurns.at(-1) || '');
  const assistantSamples = [assistantTurns.at(-1), assistantTurns[0]]
    .filter(Boolean)
    .map((text) => sampleText(text));
  return {
    filePath,
    relativePath: relative(vaultDir, filePath),
    original,
    frontmatter: parsed.data,
    body: parsed.body,
    chatId,
    title: parsed.data.title || '',
    url: parsed.data.url || `https://gemini.google.com/app/${chatId}`,
    dateCreated: portableIsoSeconds(parsed.data.date_created),
    dateLastMessage: portableIsoSeconds(parsed.data.date_last_message),
    dateExported: portableIsoSeconds(parsed.data.date_exported || parsed.data.exported_at),
    model: parsed.data.model || '',
    tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : ['gemini-export'],
    turnCount: assistantTurnCount(parsed.body),
    scoring: {
      firstPrompt,
      lastPrompt,
      assistantSamples,
    },
  };
};

const tagsLine = (tags = []) => {
  const unique = Array.from(new Set([...tags.map(String), 'gemini-export'].filter(Boolean)));
  return `[${unique.join(', ')}]`;
};

const buildCanonicalFrontmatter = (candidate, dates = {}) => {
  const lines = ['---'];
  lines.push('type: gemini_chat');
  lines.push(`chat_id: ${candidate.chatId}`);
  if (candidate.title) lines.push(`title: "${yamlEscape(candidate.title)}"`);
  lines.push(`url: ${candidate.url}`);
  const dateCreated = portableIsoSeconds(dates.dateCreated || candidate.dateCreated);
  const dateLastMessage = portableIsoSeconds(dates.dateLastMessage || candidate.dateLastMessage);
  const dateExported = portableIsoSeconds(candidate.dateExported);
  if (dateCreated) lines.push(`date_created: ${dateCreated}`);
  if (dateLastMessage) lines.push(`date_last_message: ${dateLastMessage}`);
  if (dateExported) lines.push(`date_exported: ${dateExported}`);
  lines.push(`turn_count: ${Math.max(0, Number(candidate.turnCount) || 0)}`);
  if (candidate.model) lines.push(`model: "${yamlEscape(candidate.model)}"`);
  lines.push(`tags: ${tagsLine(candidate.tags)}`);
  lines.push('---', '', '');
  return lines.join('\n');
};

const writeCandidate = (candidate, dates) => {
  const updated = buildCanonicalFrontmatter(candidate, dates) + candidate.body.replace(/^\n+/, '');
  writeFileSync(candidate.filePath, updated, 'utf-8');
};

const dateFromMatch = (match) => portableIsoSeconds(match?.date || match?.timestamp || match?.time);

const groupActivityMatches = (matches = []) => {
  const grouped = new Map();
  for (const match of matches) {
    const chatId = String(match.chatId || '').toLowerCase();
    const date = dateFromMatch(match);
    if (!chatId || !date) continue;
    const current = grouped.get(chatId) || {
      created: [],
      last: [],
      evidence: [],
    };
    const evidence = {
      kind: match.kind || 'unknown',
      date,
      score: Number(match.score || 0),
      source: match.source || null,
      textHash: match.textHash || null,
      sampleHash: match.sampleHash || null,
      sampleLength: match.sampleLength || null,
    };
    current.evidence.push(evidence);
    if (match.kind === 'created') current.created.push(date);
    else if (match.kind === 'last_message') current.last.push(date);
    else {
      current.created.push(date);
      current.last.push(date);
    }
    grouped.set(chatId, current);
  }
  const result = new Map();
  for (const [chatId, value] of grouped.entries()) {
    const allDates = [...value.created, ...value.last].sort();
    result.set(chatId, {
      dateCreated: (value.created.length ? value.created : allDates).sort()[0] || null,
      dateLastMessage: (value.last.length ? value.last : allDates).sort().at(-1) || null,
      evidence: value.evidence,
    });
  }
  return result;
};

const collectTakeoutObjects = (value, out = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectTakeoutObjects(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  out.push(value);
  for (const item of Object.values(value)) collectTakeoutObjects(item, out);
  return out;
};

const decodeHtmlEntities = (value) =>
  String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));

const htmlToPlainText = (html) =>
  decodeHtmlEntities(
    String(html || '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|table|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const TAKEOUT_MONTHS_PT = new Map([
  ['jan', 1],
  ['jan.', 1],
  ['janeiro', 1],
  ['fev', 2],
  ['fev.', 2],
  ['fevereiro', 2],
  ['mar', 3],
  ['mar.', 3],
  ['março', 3],
  ['marco', 3],
  ['abr', 4],
  ['abr.', 4],
  ['abril', 4],
  ['mai', 5],
  ['mai.', 5],
  ['maio', 5],
  ['jun', 6],
  ['jun.', 6],
  ['junho', 6],
  ['jul', 7],
  ['jul.', 7],
  ['julho', 7],
  ['ago', 8],
  ['ago.', 8],
  ['agosto', 8],
  ['set', 9],
  ['set.', 9],
  ['setembro', 9],
  ['out', 10],
  ['out.', 10],
  ['outubro', 10],
  ['nov', 11],
  ['nov.', 11],
  ['novembro', 11],
  ['dez', 12],
  ['dez.', 12],
  ['dezembro', 12],
]);

const parseTakeoutDate = (text) => {
  const match = String(text || '').match(
    /(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ.]+)\s+de\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{2,5})/i,
  );
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = match;
  const month = TAKEOUT_MONTHS_PT.get(monthText.toLowerCase());
  if (!month) return null;
  const zone = zoneText.toUpperCase();
  const offsetHours = zone === 'BRT' ? -3 : zone === 'UTC' || zone === 'GMT' ? 0 : null;
  if (offsetHours === null) return null;
  const date = new Date(
    Date.UTC(
      Number(yearText),
      month - 1,
      Number(dayText),
      Number(hourText) - offsetHours,
      Number(minuteText),
      Number(secondText),
    ),
  );
  return portableIsoSeconds(date);
};

const parseTakeoutHtmlItems = (html) => {
  const cards = String(html || '').match(/<div class="outer-cell\b[\s\S]*?(?=<div class="outer-cell\b|<\/body>|<\/html>|$)/g) || [];
  return cards
    .map((card) => {
      const text = htmlToPlainText(card);
      const date = parseTakeoutDate(text);
      if (!date || !/Gemini Apps/i.test(text)) return null;
      return {
        date,
        text,
        comparableText: normalizeComparableText(text),
        textHash: hashText(text),
        sampleLength: text.length,
      };
    })
    .filter(Boolean);
};

const candidateNeedles = (candidate) => {
  const needles = [];
  const add = (kind, value, weight) => {
    const text = sampleText(value, 500);
    const comparable = normalizeComparableText(text);
    if (comparable.length >= 16) needles.push({ kind, text, comparable, weight, length: comparable.length });
  };
  add('created', candidate.scoring?.firstPrompt, 0.62);
  add('last_message', candidate.scoring?.lastPrompt, 0.62);
  for (const sample of candidate.scoring?.assistantSamples || []) add('assistant', sample, 0.42);
  return needles;
};

const scoreTakeoutItemForCandidate = (item, candidate) => {
  const hits = [];
  let score = 0;
  for (const needle of candidateNeedles(candidate)) {
    if (!item.comparableText.includes(needle.comparable)) continue;
    hits.push(needle);
    score += needle.weight;
  }
  const promptHits = hits.filter((hit) => hit.kind === 'created' || hit.kind === 'last_message');
  const assistantHits = hits.filter((hit) => hit.kind === 'assistant');
  const hasLongPrompt = promptHits.some((hit) => hit.length >= 48);
  if (!promptHits.length) return null;
  if (!hasLongPrompt && !assistantHits.length) return null;
  const kinds = new Set(promptHits.map((hit) => hit.kind));
  const kind = kinds.size === 1 ? Array.from(kinds)[0] : 'unknown';
  return {
    chatId: candidate.chatId,
    date: item.date,
    kind,
    score: Math.min(1, Number(score.toFixed(2))),
    source: 'takeout-html',
    textHash: item.textHash,
    sampleHash: hashText(hits.map((hit) => `${hit.kind}:${hit.text}`).join('\n')),
    sampleLength: item.sampleLength,
  };
};

const matchTakeoutHtmlItems = (items, candidates = []) => {
  const matches = [];
  for (const item of items) {
    const scored = candidates
      .map((candidate) => scoreTakeoutItemForCandidate(item, candidate))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const [best, runnerUp] = scored;
    if (!best || best.score < 0.72) continue;
    if (runnerUp && runnerUp.score >= best.score - 0.05) continue;
    matches.push(best);
  }
  return matches;
};

const loadTakeoutJsonMatches = (path) => {
  if (!path) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  const matches = [];
  for (const item of collectTakeoutObjects(parsed)) {
    const chatId =
      String(item.chatId || item.chat_id || '').match(CHAT_ID_RE)?.[0] ||
      String(item.url || item.link || item.titleUrl || '').match(URL_CHAT_ID_RE)?.[1] ||
      String(item.href || '').match(URL_CHAT_ID_RE)?.[1];
    const date = portableIsoSeconds(
      item.date || item.timestamp || item.time || item.time_usec || item.createdAt,
    );
    if (!chatId || !date) continue;
    matches.push({
      chatId: chatId.toLowerCase(),
      date,
      kind: item.kind || item.type || 'unknown',
      score: 1,
      textHash: item.textHash || item.hash || null,
    });
  }
  return matches;
};

const loadTakeoutMatches = (path, candidates = []) => {
  if (!path) return [];
  const text = readFileSync(path, 'utf-8');
  if (/^\s*</.test(text) || /\.html?$/i.test(path)) {
    return matchTakeoutHtmlItems(parseTakeoutHtmlItems(text), candidates);
  }
  return loadTakeoutJsonMatches(path);
};

const loadPreviousCheckpoint = (reportPath) => {
  if (!reportPath || !existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    return report.activityCheckpoint || null;
  } catch {
    return null;
  }
};

const requestActivityScan = async ({ bridgeUrl, candidates, resume, openIfMissing = true }) => {
  const response = await fetch(`${bridgeUrl}/agent/activity-scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidates: candidates.map((candidate) => ({
        chatId: candidate.chatId,
        firstPrompt: candidate.scoring.firstPrompt,
        lastPrompt: candidate.scoring.lastPrompt,
        assistantSamples: candidate.scoring.assistantSamples,
      })),
      resume: resume || null,
      openIfMissing,
    }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    const err = new Error(payload.nextAction || payload.error || `Bridge retornou HTTP ${response.status}`);
    err.code = payload.code || null;
    throw err;
  }
  return payload;
};

const reportItem = (candidate, status, dates, evidence = []) => ({
  chatId: candidate.chatId,
  file: candidate.relativePath,
  status,
  dateCreated: dates.dateCreated || null,
  dateLastMessage: dates.dateLastMessage || null,
  dateExported: portableIsoSeconds(candidate.dateExported) || null,
  turnCount: candidate.turnCount,
  candidateHash: hashText(
    [
      candidate.scoring.firstPrompt,
      candidate.scoring.lastPrompt,
      ...(candidate.scoring.assistantSamples || []),
    ].join('\n'),
  ),
  evidence: evidence.map((item) => ({
    kind: item.kind || 'unknown',
    date: item.date || null,
    score: item.score ?? null,
    source: item.source || null,
    textHash: item.textHash || null,
    sampleHash: item.sampleHash || null,
    sampleLength: item.sampleLength || null,
  })),
});

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const vaultDir = resolve(expandUserPath(args.vaultDir));
  if (!existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) {
    throw new Error(`Vault não encontrado: ${vaultDir}`);
  }
  const reportPath = args.report ? resolve(expandUserPath(args.report)) : '';
  const files = collectMarkdownFiles(vaultDir);
  const candidates = files.map((file) => buildCandidate(file, vaultDir)).filter(Boolean);
  const selected = args.limit > 0 ? candidates.slice(0, args.limit) : candidates;

  const matches = [];
  let activityCheckpoint = loadPreviousCheckpoint(reportPath);
  let activityError = null;
  if (args.takeout) matches.push(...loadTakeoutMatches(resolve(expandUserPath(args.takeout)), selected));
  if (args.useMyActivity && selected.length) {
    try {
      const activity = await requestActivityScan({
        bridgeUrl: args.bridgeUrl,
        candidates: selected,
        resume: activityCheckpoint,
        openIfMissing: args.openIfMissing,
      });
      matches.push(...(activity.matches || []));
      activityCheckpoint = activity.checkpoint || activityCheckpoint || null;
    } catch (err) {
      activityError = {
        code: err.code || 'activity_scan_failed',
        message: err.message,
      };
    }
  }

  const grouped = groupActivityMatches(matches);
  const items = [];
  let updated = 0;
  let matched = 0;
  let unresolved = 0;
  for (const candidate of selected) {
    const match = grouped.get(candidate.chatId);
    const dates = {
      dateCreated: match?.dateCreated || candidate.dateCreated || null,
      dateLastMessage: match?.dateLastMessage || candidate.dateLastMessage || null,
    };
    const status = match?.dateCreated || match?.dateLastMessage ? 'matched' : 'unresolved';
    if (status === 'matched') matched += 1;
    else unresolved += 1;
    writeCandidate(candidate, dates);
    updated += 1;
    items.push(reportItem(candidate, status, dates, match?.evidence || []));
  }

  const report = {
    schema: 'gemini-md-export.metadata-backfill-report.v1',
    generatedAt: portableIsoSeconds(new Date()),
    vaultDir,
    sources: {
      myActivity: args.useMyActivity,
      takeout: args.takeout ? basename(args.takeout) : null,
    },
    summary: {
      totalChats: selected.length,
      updated,
      matched,
      unresolved,
      ambiguous: 0,
    },
    activityCheckpoint,
    activityError,
    items,
  };

  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }
  process.stdout.write(
    `Backfill metadata: ${updated} atualizado(s), ${matched} com datas, ${unresolved} sem match confiável.\n`,
  );
  if (activityError) {
    process.stdout.write(`My Activity: ${activityError.message}\n`);
  }
};

run().catch((err) => {
  process.stderr.write(`${err.message}\n\n${usage()}`);
  process.exitCode = 1;
});
