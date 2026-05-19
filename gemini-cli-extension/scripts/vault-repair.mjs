#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_URL = 'http://127.0.0.1:47283';
const DIRECT_REEXPORT_CHUNK_SIZE = 500;
const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const auditScriptPath = resolve(__dirname, 'vault-repair-audit.mjs');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const timestampForFilename = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');

const expandHome = (value) =>
  String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || '');

const hashText = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

const normalizeText = (value) =>
  String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const portableIsoSeconds = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const sampleText = (value, max = 1200) =>
  String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const normalizeComparableText = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const parseFrontmatter = (text) => {
  if (!String(text || '').startsWith('---\n')) return { frontmatter: '', body: text || '', fields: {} };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: '', body: text || '', fields: {} };
  const frontmatter = text.slice(4, end).trim();
  const bodyStart = text.indexOf('\n', end + 4);
  const body = bodyStart >= 0 ? text.slice(bodyStart + 1) : '';
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return { frontmatter, body, fields };
};

const splitMarkdownDocument = (text) => {
  const raw = String(text || '');
  if (!raw.startsWith('---\n')) {
    return { hasFrontmatter: false, header: '', body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    return { hasFrontmatter: false, header: '', body: raw };
  }
  const bodyStart = raw.indexOf('\n', end + 4);
  if (bodyStart === -1) {
    return { hasFrontmatter: true, header: raw, body: '' };
  }
  return {
    hasFrontmatter: true,
    header: raw.slice(0, bodyStart + 1),
    body: raw.slice(bodyStart + 1),
  };
};

const replaceBodyPreservingOriginalFrontmatter = (originalRaw, stagedRaw) => {
  const original = splitMarkdownDocument(originalRaw);
  const staged = splitMarkdownDocument(stagedRaw);
  if (!original.hasFrontmatter) return stagedRaw;
  return `${original.header}${staged.body}`;
};

const chatIdFromValue = (value) => {
  const text = String(value || '');
  const prefixed = text.match(/\bc_([a-f0-9]{12,})\b/i);
  if (prefixed) return prefixed[1].toLowerCase();
  const app = text.match(/\/app\/([a-f0-9]{12,})/i);
  if (app) return app[1].toLowerCase();
  const bare = text.match(/\b([a-f0-9]{12,})\b/i);
  return bare?.[1]?.toLowerCase() || '';
};

const canonicalGeminiLink = (chatId) =>
  `https://gemini.google.com/app/${String(chatId || '').toLowerCase()}`;

const turnCountFor = (body) => {
  const matches = String(body || '').match(
    /^##\s+(?:🧑\s*)?(?:Usuário|Usuario)|^##\s+(?:🤖\s*)?Gemini/gim,
  );
  return matches?.length || 0;
};

const bodyFingerprintFor = (markdown) => {
  const { body } = parseFrontmatter(markdown);
  return hashText(normalizeText(body));
};

const sectionsForRole = (body, role) => {
  const emoji = role === 'user' ? '🧑' : '🤖';
  const otherEmoji = role === 'user' ? '🤖' : '🧑';
  const re = new RegExp(
    `^##\\s*${emoji}\\s*[^\\n]*\\n\\n([\\s\\S]*?)(?=\\n\\n---\\n\\n##\\s*${otherEmoji}|\\n\\n---\\n\\n##\\s*${emoji}|$)`,
    'gm',
  );
  return Array.from(String(body || '').matchAll(re), (match) => match[1].trim()).filter(Boolean);
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
  return portableIsoSeconds(
    new Date(
      Date.UTC(
        Number(yearText),
        month - 1,
        Number(dayText),
        Number(hourText) - offsetHours,
        Number(minuteText),
        Number(secondText),
      ),
    ),
  );
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
        comparableText: normalizeComparableText(text),
        textHash: hashText(text),
        sampleLength: text.length,
      };
    })
    .filter(Boolean);
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

const buildTakeoutCandidate = (note) => {
  const chatId = String(note.chatId || '').toLowerCase();
  if (!/^[a-f0-9]{12,}$/.test(chatId) || !note.path || !existsSync(note.path)) return null;
  const raw = readFileSync(note.path, 'utf-8');
  const { body } = parseFrontmatter(raw);
  const userTurns = sectionsForRole(body, 'user');
  const assistantTurns = sectionsForRole(body, 'assistant');
  return {
    chatId,
    scoring: {
      firstPrompt: sampleText(userTurns[0] || ''),
      lastPrompt: sampleText(userTurns.at(-1) || ''),
      assistantSamples: [assistantTurns.at(-1), assistantTurns[0]]
        .filter(Boolean)
        .map((text) => sampleText(text)),
    },
  };
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
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  const matches = [];
  for (const item of collectTakeoutObjects(parsed)) {
    const chatId =
      String(item.chatId || item.chat_id || '').match(/^[a-f0-9]{12,}$/i)?.[0] ||
      String(item.url || item.link || item.titleUrl || '').match(/\/app\/([a-f0-9]{12,})/i)?.[1] ||
      String(item.href || '').match(/\/app\/([a-f0-9]{12,})/i)?.[1];
    const date = portableIsoSeconds(
      item.date || item.timestamp || item.time || item.time_usec || item.createdAt,
    );
    if (!chatId || !date) continue;
    matches.push({
      chatId: chatId.toLowerCase(),
      date,
      kind: item.kind || item.type || 'unknown',
      score: 1,
      source: 'takeout-json',
      textHash: item.textHash || item.hash || null,
    });
  }
  return matches;
};

const dateFromMatch = (match) => portableIsoSeconds(match?.date || match?.timestamp || match?.time);

const groupTakeoutMatches = (matches = []) => {
  const grouped = new Map();
  for (const match of matches) {
    const chatId = String(match.chatId || '').toLowerCase();
    const date = dateFromMatch(match);
    if (!chatId || !date) continue;
    const current = grouped.get(chatId) || { created: [], last: [], evidence: [] };
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
      status: 'matched',
      dateCreated: (value.created.length ? value.created : allDates).sort()[0] || null,
      dateLastMessage: (value.last.length ? value.last : allDates).sort().at(-1) || null,
      evidence: value.evidence,
    });
  }
  return result;
};

const emptyTakeoutEvidence = (takeoutPath = '') => ({
  sourceFile: takeoutPath ? basename(takeoutPath) : null,
  summary: {
    enabled: Boolean(takeoutPath),
    itemsIndexed: 0,
    candidates: 0,
    matched: 0,
    unmatched: 0,
  },
  byChatId: new Map(),
});

const loadTakeoutEvidence = ({ takeoutPath, notes }) => {
  if (!takeoutPath) return emptyTakeoutEvidence('');
  const resolved = resolve(expandHome(takeoutPath));
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Takeout nao encontrado: ${resolved}`);
  }

  const candidates = notes.map(buildTakeoutCandidate).filter(Boolean);
  const raw = readFileSync(resolved, 'utf-8');
  let indexedItems = 0;
  const matches = /^\s*</.test(raw) || /\.html?$/i.test(resolved)
    ? (() => {
        const items = parseTakeoutHtmlItems(raw);
        indexedItems = items.length;
        return matchTakeoutHtmlItems(items, candidates);
      })()
    : (() => {
        const directMatches = loadTakeoutJsonMatches(resolved);
        indexedItems = directMatches.length;
        return directMatches;
      })();

  const grouped = groupTakeoutMatches(matches);
  const byChatId = new Map();
  for (const candidate of candidates) {
    const match = grouped.get(candidate.chatId);
    byChatId.set(candidate.chatId, match || { status: 'unmatched', evidence: [] });
  }

  const matched = Array.from(byChatId.values()).filter((item) => item.status === 'matched').length;
  return {
    sourceFile: basename(resolved),
    summary: {
      enabled: true,
      itemsIndexed: indexedItems,
      candidates: candidates.length,
      matched,
      unmatched: Math.max(0, candidates.length - matched),
    },
    byChatId,
  };
};

const takeoutEvidenceFor = (takeoutEvidence, chatId) => {
  if (!takeoutEvidence?.summary?.enabled) return undefined;
  const evidence = takeoutEvidence.byChatId.get(String(chatId || '').toLowerCase());
  return {
    status: evidence?.status || 'unmatched',
    dateCreated: evidence?.dateCreated || null,
    dateLastMessage: evidence?.dateLastMessage || null,
    evidence: (evidence?.evidence || []).map((item) => ({
      kind: item.kind || 'unknown',
      date: item.date || null,
      score: item.score ?? null,
      source: item.source || null,
      textHash: item.textHash || null,
      sampleHash: item.sampleHash || null,
      sampleLength: item.sampleLength || null,
    })),
  };
};

const parseArgs = (argv) => {
  const options = {
    dryRun: false,
    quickTriage: false,
    skipBrowserCheck: false,
    allowStagedDuplicates: false,
    bridgeUrl: BRIDGE_URL,
    pollMs: 2000,
    jobTimeoutMs: 30 * 60 * 1000,
    explicitPaths: [],
    takeout: '',
  };
  let root = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Valor ausente para ${arg}`);
      }
      i += 1;
      return value;
    };

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--quick-triage') {
      options.quickTriage = true;
    } else if (arg === '--skip-browser-check') {
      options.skipBrowserCheck = true;
    } else if (arg === '--allow-staged-duplicates') {
      options.allowStagedDuplicates = true;
    } else if (arg === '--takeout') {
      options.takeout = takeValue();
    } else if (arg === '--bridge-url') {
      options.bridgeUrl = takeValue().replace(/\/+$/, '');
    } else if (arg === '--report-dir') {
      options.reportDir = resolve(expandHome(takeValue()));
    } else if (arg === '--staging-dir') {
      options.stagingDir = resolve(expandHome(takeValue()));
    } else if (arg === '--backup-dir') {
      options.backupDir = resolve(expandHome(takeValue()));
    } else if (arg === '--poll-ms') {
      options.pollMs = Math.max(100, Number(takeValue()));
    } else if (arg === '--job-timeout-ms') {
      options.jobTimeoutMs = Math.max(1000, Number(takeValue()));
    } else if (arg === '--path') {
      options.explicitPaths.push(resolve(expandHome(takeValue())));
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Opcao desconhecida: ${arg}`);
    } else if (!root) {
      root = resolve(expandHome(arg));
    } else {
      throw new Error(`Argumento extra inesperado: ${arg}`);
    }
  }

  return { root, options };
};

const usage = () => {
  process.stderr.write(
    [
      'Usage: node vault-repair.mjs [options] <vault-or-folder>',
      '',
      'Options:',
      '  --dry-run                 Audita e escreve relatorio preliminar, sem reexportar nem sobrescrever.',
      '  --quick-triage            Reexporta apenas candidatos heuristicos, nao todos os raw exports.',
      '  --path <file.md>          Prioriza/limita a verificacao a um caminho explicito. Pode repetir.',
      '  --takeout <file>          Usa Takeout/My Activity como evidencia sanitizada de integridade.',
      '  --report-dir <dir>        Default: <vault>/.gemini-md-export-repair',
      '  --staging-dir <dir>       Default: <report-dir>/staging',
      '  --backup-dir <dir>        Default: <report-dir>/backups/<timestamp>',
      '  --bridge-url <url>        Default: http://127.0.0.1:47283',
      '  --skip-browser-check      Uso de teste/debug: pula gemini_ready.',
      '',
    ].join('\n') + '\n',
  );
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf-8'));

const writeJson = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
};

const copyFileWithParents = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

const noteMatchesExplicitPaths = (note, explicitPathSet) => {
  if (explicitPathSet.size === 0) return true;
  return explicitPathSet.has(resolve(note.path));
};

const isRawGeminiExportNote = (note) => !note.wikiCandidate && !!note.chatId;

const createPreliminaryReport = ({
  audit,
  mode,
  dryRun,
  paths,
  rawQueue,
  wikiQueue,
  explicitPaths,
  takeoutEvidence,
}) => ({
  createdAt: new Date().toISOString(),
  mode,
  dryRun,
  root: audit.summary.root,
  scannedMarkdownFiles: audit.summary.scannedMarkdownFiles,
  geminiExportNotes: audit.summary.geminiExportNotes,
  verificationQueueSize: rawQueue.length,
  wikiReviewQueueSize: wikiQueue.length,
  heuristicSuspectCount: audit.summary.suspectNotes,
  wikiCandidateCount: audit.summary.wikiCandidates,
  duplicateGroups: audit.duplicateGroups || [],
  takeoutEvidence: takeoutEvidence?.summary?.enabled
    ? {
        sourceFile: takeoutEvidence.sourceFile,
        summary: takeoutEvidence.summary,
      }
    : { summary: { enabled: false } },
  explicitPaths,
  paths,
  itemsNeedingDirectVerificationFirst: rawQueue.slice(0, 200).map((note) => ({
    path: note.path,
    relativePath: note.relativePath,
    chatId: note.chatId,
    title: note.title || '',
    suspect: note.suspect === true,
    reasons: note.reasons || [],
    takeoutEvidence: takeoutEvidenceFor(takeoutEvidence, note.chatId),
  })),
  truncatedItemsNeedingDirectVerification:
    rawQueue.length > 200 ? rawQueue.length - 200 : 0,
});

const runAudit = ({ root, auditReportPath }) => {
  execFileSync(
    process.execPath,
    [auditScriptPath, '--include-notes', '--report', auditReportPath, root],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return readJson(auditReportPath);
};

const callMcpTool = async ({ bridgeUrl, name, args = {} }) => {
  const response = await fetch(`${bridgeUrl}/agent/mcp-tool-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Falha HTTP ${response.status} ao chamar ${name}`);
  }
  const result = payload.result || {};
  const structured = result.structuredContent || {};
  if (result.isError) {
    throw new Error(structured.error || `Tool ${name} retornou erro.`);
  }
  return structured;
};

const callAgentEndpoint = async ({ bridgeUrl, path, method = 'GET', body = null }) => {
  const response = await fetch(`${bridgeUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Falha HTTP ${response.status} em ${path}`);
  }
  return payload;
};

const ensureBrowserReady = async (options) => {
  const status = await callMcpTool({
    bridgeUrl: options.bridgeUrl,
    name: 'gemini_ready',
    args: {
      action: 'status',
      wakeBrowser: true,
      selfHeal: true,
      allowReload: true,
    },
  });
  if (
    status.ready !== true ||
    status.blockingIssue ||
    !Array.isArray(status.connectedClients) ||
    status.connectedClients.length === 0
  ) {
    const problem = {
      ready: status.ready === true,
      blockingIssue: status.blockingIssue || null,
      expectedChromeExtension: status.expectedChromeExtension || null,
      browserWake: status.browserWake || null,
      selfHeal: status.selfHeal || null,
      connectedClients: status.connectedClients || [],
    };
    throw new Error(`Browser/MCP nao esta pronto para reexportar: ${JSON.stringify(problem)}`);
  }
  return status;
};

const pollExportJob = async ({ bridgeUrl, jobId, pollMs, timeoutMs }) => {
  const startedAt = Date.now();
  let status = null;

  while (Date.now() - startedAt <= timeoutMs) {
    status = await callMcpTool({
      bridgeUrl,
      name: 'gemini_job',
      args: { action: 'status', jobId },
    });
    if (TERMINAL_JOB_STATUSES.has(status.status)) return status;
    await sleep(pollMs);
  }

  throw new Error(`Timeout aguardando job de reexportacao ${jobId}.`);
};

const readJobReport = (status) => {
  if (status.reportFile && existsSync(status.reportFile)) return readJson(status.reportFile);
  return {
    successes: Array.isArray(status.recentSuccesses) ? status.recentSuccesses : [],
    failures: Array.isArray(status.failures) ? status.failures : [],
  };
};

const chunkItems = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const reexportChats = async ({ items, paths, options }) => {
  const successes = [];
  const failures = [];
  const jobs = [];

  for (const chunk of chunkItems(items, DIRECT_REEXPORT_CHUNK_SIZE)) {
    const started = await callAgentEndpoint({
      bridgeUrl: options.bridgeUrl,
      path: '/agent/reexport-chats',
      method: 'POST',
      body: {
        outputDir: paths.stagingDir,
        items: chunk,
      },
    });
    const status = await pollExportJob({
      bridgeUrl: options.bridgeUrl,
      jobId: started.jobId,
      pollMs: options.pollMs,
      timeoutMs: options.jobTimeoutMs,
    });
    const report = readJobReport(status);
    successes.push(...(Array.isArray(report.successes) ? report.successes : []));
    failures.push(...(Array.isArray(report.failures) ? report.failures : []));
    jobs.push({
      jobId: status.jobId,
      status: status.status,
      reportFile: status.reportFile || null,
      successCount: status.successCount || 0,
      failureCount: status.failureCount || 0,
    });
  }

  return { successes, failures, jobs };
};

const buildReexportItems = (notes) => {
  const byChatId = new Map();
  for (const note of notes) {
    const chatId = String(note.chatId || '').toLowerCase();
    if (!/^[a-f0-9]{12,}$/.test(chatId) || byChatId.has(chatId)) continue;
    byChatId.set(chatId, {
      chatId,
      title: note.title || chatId,
      sourcePath: note.path,
    });
  }
  return Array.from(byChatId.values());
};

const stagedSuccessMap = (successes) => {
  const byChatId = new Map();
  for (const success of successes) {
    const chatId = String(success.chatId || '').toLowerCase();
    if (!chatId || byChatId.has(chatId)) continue;
    byChatId.set(chatId, success);
  }
  return byChatId;
};

const stagedDuplicateChatIds = (successes) => {
  const groups = new Map();
  for (const success of successes) {
    if (!success.filePath || !existsSync(success.filePath)) continue;
    const fingerprint = bodyFingerprintFor(readFileSync(success.filePath, 'utf-8'));
    const members = groups.get(fingerprint) || [];
    members.push(String(success.chatId || '').toLowerCase());
    groups.set(fingerprint, members);
  }

  const duplicates = new Set();
  for (const members of groups.values()) {
    const chatIds = [...new Set(members.filter(Boolean))];
    if (chatIds.length > 1) chatIds.forEach((chatId) => duplicates.add(chatId));
  }
  return duplicates;
};

const validateStagedExport = ({ chatId, stagedPath, duplicateStaged, allowStagedDuplicates }) => {
  const errors = [];
  if (!stagedPath || !existsSync(stagedPath)) {
    return { ok: false, errors: ['missing_staged_export'] };
  }

  const expectedFilename = `${chatId}.md`;
  if (basename(stagedPath).toLowerCase() !== expectedFilename) {
    errors.push('staged_filename_chat_id_mismatch');
  }

  const raw = readFileSync(stagedPath, 'utf-8');
  const { body, fields } = parseFrontmatter(raw);
  const frontmatterChatId = chatIdFromValue(fields.chat_id);
  const urlChatId = chatIdFromValue(fields.url);
  const bodyText = normalizeText(body);

  if (frontmatterChatId !== chatId) errors.push('staged_frontmatter_chat_id_mismatch');
  if (urlChatId !== chatId) errors.push('staged_url_chat_id_mismatch');
  if (!bodyText) errors.push('staged_empty_body');
  if (turnCountFor(body) === 0) errors.push('staged_no_gemini_turns');
  if (duplicateStaged.has(chatId) && !allowStagedDuplicates) {
    errors.push('staged_duplicate_body_different_chat_ids');
  }

  return {
    ok: errors.length === 0,
    errors,
    bodyFingerprint: hashText(bodyText),
    turnCount: turnCountFor(body),
    bytes: Buffer.byteLength(raw, 'utf-8'),
  };
};

const copyStagedAssetsForChat = ({ chatId, originalPath, stagingDir, backupDir, root }) => {
  const sourceAssets = join(stagingDir, 'assets', chatId);
  if (!existsSync(sourceAssets) || !statSync(sourceAssets).isDirectory()) return null;

  const targetAssets = join(dirname(originalPath), 'assets', chatId);
  const backupAssets = join(backupDir, relative(root, targetAssets));
  if (existsSync(targetAssets)) {
    mkdirSync(dirname(backupAssets), { recursive: true });
    cpSync(targetAssets, backupAssets, { recursive: true });
    rmSync(targetAssets, { recursive: true, force: true });
  }
  mkdirSync(dirname(targetAssets), { recursive: true });
  cpSync(sourceAssets, targetAssets, { recursive: true });
  return {
    sourceAssets,
    targetAssets,
    backupAssets: existsSync(backupAssets) ? backupAssets : null,
  };
};

const repairRawNote = ({
  note,
  success,
  duplicateStaged,
  paths,
  root,
  dryRun,
  allowStagedDuplicates,
}) => {
  const chatId = String(note.chatId || '').toLowerCase();
  const stagedPath = success?.filePath || join(paths.stagingDir, `${chatId}.md`);
  const validation = validateStagedExport({
    chatId,
    stagedPath,
    duplicateStaged,
    allowStagedDuplicates,
  });

  const baseResult = {
    path: note.path,
    relativePath: note.relativePath,
    chatId,
    title: note.title || '',
    reasons: note.reasons || [],
    stagedPath,
    validation,
  };

  if (!validation.ok) {
    return {
      ...baseResult,
      status: 'blocked',
      blockedReason: validation.errors.join(','),
    };
  }

  const expectedFilename = `${chatId}.md`;
  if (basename(note.path).toLowerCase() !== expectedFilename) {
    return {
      ...baseResult,
      status: 'blocked',
      blockedReason: 'original_filename_chat_id_mismatch_requires_manual_rename',
    };
  }

  const originalRaw = readFileSync(note.path, 'utf-8');
  const stagedRaw = readFileSync(stagedPath, 'utf-8');
  const originalBodyFingerprint = bodyFingerprintFor(originalRaw);
  const stagedBodyFingerprint = bodyFingerprintFor(stagedRaw);

  if (originalBodyFingerprint === stagedBodyFingerprint) {
    return {
      ...baseResult,
      status: 'verified_clean',
      comparisonMode: 'body_only_frontmatter_ignored',
      metadataPolicy: 'original_frontmatter_preserved',
      yamlOnlyDifferenceIgnored: originalRaw !== stagedRaw,
      originalBodyFingerprint,
      stagedBodyFingerprint,
    };
  }

  const metadataMismatchReason = (note.reasons || []).find((reason) =>
    ['filename_chat_id_mismatch', 'url_chat_id_mismatch', 'missing_chat_id'].includes(reason),
  );
  if (metadataMismatchReason) {
    return {
      ...baseResult,
      status: 'blocked',
      blockedReason: `metadata_mismatch_requires_manual_review:${metadataMismatchReason}`,
      comparisonMode: 'body_only_frontmatter_ignored',
      metadataPolicy: 'original_frontmatter_preserved',
      originalBodyFingerprint,
      stagedBodyFingerprint,
    };
  }

  const backupPath = join(paths.backupDir, relative(root, note.path));
  const repairedRaw = replaceBodyPreservingOriginalFrontmatter(originalRaw, stagedRaw);
  if (!dryRun) {
    copyFileWithParents(note.path, backupPath);
    writeFileSync(note.path, repairedRaw, 'utf-8');
  }

  const assets = dryRun
    ? null
    : copyStagedAssetsForChat({
        chatId,
        originalPath: note.path,
        stagingDir: paths.stagingDir,
        backupDir: paths.backupDir,
        root,
      });

  return {
    ...baseResult,
    status: dryRun ? 'repair_needed' : 'repaired',
    comparisonMode: 'body_only_frontmatter_ignored',
    metadataPolicy: 'original_frontmatter_preserved',
    backupPath,
    assets,
    originalBodyFingerprint,
    stagedBodyFingerprint,
  };
};

const dedupeLinks = (links) => {
  const seen = new Set();
  const out = [];
  for (const link of links.filter(Boolean)) {
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
};

const writeWikiCase = ({ note, success, paths, root, dryRun }) => {
  const chatId = String(note.chatId || '').toLowerCase();
  const hasChatId = /^[a-f0-9]{12,}$/.test(chatId);
  const caseId = hasChatId ? chatId : hashText(note.path);
  const backupPath = join(paths.backupDir, relative(root, note.path));
  if (!dryRun) copyFileWithParents(note.path, backupPath);

  const stagedRawExportPath =
    success?.filePath || (hasChatId ? join(paths.stagingDir, `${chatId}.md`) : null);
  const requiredFinalGeminiSourceLinks = dedupeLinks([
    ...(Array.isArray(note.geminiSourceLinks) ? note.geminiSourceLinks : []),
    hasChatId ? canonicalGeminiLink(chatId) : null,
  ]);
  const status = hasChatId ? 'wiki_repair_required' : 'wiki_repair_blocked';
  const caseFile = join(paths.wikiReviewDir, `${caseId}.json`);
  const body = {
    createdAt: new Date().toISOString(),
    status,
    wikiNotePath: note.path,
    relativePath: note.relativePath,
    sourceChatId: hasChatId ? chatId : null,
    geminiSourceLinks: note.geminiSourceLinks || [],
    sourceChatIds: note.sourceChatIds || [],
    wikiFooterGeminiSourceLinks: note.wikiFooterGeminiSourceLinks || [],
    wikiFooterMissingSourceLinks: note.wikiFooterMissingSourceLinks || [],
    requiredFinalGeminiSourceLinks,
    stagedRawExportPath: existsSync(stagedRawExportPath || '') ? stagedRawExportPath : null,
    wikiSignals: note.wikiSignals || [],
    suspicionReasons: note.reasons || [],
    backupPath,
    recommendedNextAction: hasChatId
      ? 'Reprocessar o raw corrigido em staging e comparar/mesclar com a wiki atual, preservando o rodape de fontes Gemini completo.'
      : 'Mapear manualmente qual chat Gemini originou esta wiki antes de reprocessar ou mesclar.',
  };

  if (!dryRun) writeJson(caseFile, body);

  return {
    path: note.path,
    relativePath: note.relativePath,
    chatId: hasChatId ? chatId : null,
    status,
    reasons: note.reasons || [],
    wikiSignals: note.wikiSignals || [],
    backupPath,
    caseFile: dryRun ? null : caseFile,
    stagedRawExportPath: body.stagedRawExportPath,
    requiredFinalGeminiSourceLinks,
  };
};

const countStatuses = (items) => {
  const counts = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  return counts;
};

const main = async () => {
  const { root, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!root) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Pasta nao encontrada: ${root}`);
  }

  const stamp = timestampForFilename();
  const repairDir = options.reportDir || join(root, '.gemini-md-export-repair');
  const paths = {
    repairDir,
    auditReportPath: join(repairDir, `audit-report-${stamp}.json`),
    preliminaryReportPath: join(repairDir, `preliminary-report-${stamp}.json`),
    finalReportPath: join(repairDir, `repair-report-${stamp}.json`),
    stagingDir: options.stagingDir || join(repairDir, 'staging'),
    backupDir: options.backupDir || join(repairDir, 'backups', stamp),
    wikiReviewDir: join(repairDir, 'wiki-review'),
  };

  mkdirSync(paths.repairDir, { recursive: true });
  mkdirSync(paths.stagingDir, { recursive: true });
  mkdirSync(paths.backupDir, { recursive: true });
  mkdirSync(paths.wikiReviewDir, { recursive: true });

  let browserStatus = null;
  if (!options.dryRun && !options.skipBrowserCheck) {
    browserStatus = await ensureBrowserReady(options);
  }

  const audit = runAudit({ root, auditReportPath: paths.auditReportPath });
  const notes = Array.isArray(audit.notes) ? audit.notes : [];
  const candidates = Array.isArray(audit.candidates) ? audit.candidates : [];
  const explicitPathSet = new Set(options.explicitPaths.map((item) => resolve(item)));

  const selectedNotes =
    explicitPathSet.size > 0
      ? notes.filter((note) => noteMatchesExplicitPaths(note, explicitPathSet))
      : options.quickTriage
        ? candidates
        : notes;

  const rawQueue = selectedNotes.filter(isRawGeminiExportNote);
  const wikiQueue = selectedNotes.filter(
    (note) =>
      note.wikiCandidate === true &&
      (explicitPathSet.size > 0 || note.suspect === true || (note.reasons || []).length > 0),
  );
  const mode =
    explicitPathSet.size > 0 ? 'explicit-paths' : options.quickTriage ? 'quick-triage' : 'full';
  const takeoutEvidence = loadTakeoutEvidence({
    takeoutPath: options.takeout,
    notes: selectedNotes,
  });

  const preliminary = createPreliminaryReport({
    audit,
    mode,
    dryRun: options.dryRun,
    paths,
    rawQueue,
    wikiQueue,
    explicitPaths: options.explicitPaths,
    takeoutEvidence,
  });
  writeJson(paths.preliminaryReportPath, preliminary);

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          dryRun: true,
          preliminaryReportPath: paths.preliminaryReportPath,
          auditReportPath: paths.auditReportPath,
          verificationQueueSize: rawQueue.length,
          wikiReviewQueueSize: wikiQueue.length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const reexportItems = buildReexportItems([...rawQueue, ...wikiQueue]);
  const reexport = reexportItems.length > 0
    ? await reexportChats({ items: reexportItems, paths, options })
    : { successes: [], failures: [], jobs: [] };

  const successesByChatId = stagedSuccessMap(reexport.successes);
  const duplicateStaged = stagedDuplicateChatIds(reexport.successes);
  const reexportFailuresByChatId = new Map(
    reexport.failures.map((failure) => [String(failure.chatId || '').toLowerCase(), failure]),
  );

  const rawResults = rawQueue.map((note) => {
    const chatId = String(note.chatId || '').toLowerCase();
    const failure = reexportFailuresByChatId.get(chatId);
    if (failure) {
      return {
        path: note.path,
        relativePath: note.relativePath,
        chatId,
        status: 'failed',
        reasons: note.reasons || [],
        error: failure.error || 'Falha ao reexportar chatId.',
      };
    }
    return repairRawNote({
      note,
      success: successesByChatId.get(chatId),
      duplicateStaged,
      paths,
      root,
      dryRun: false,
      allowStagedDuplicates: options.allowStagedDuplicates,
    });
  });

  const wikiResults = wikiQueue.map((note) => {
    const chatId = String(note.chatId || '').toLowerCase();
    return writeWikiCase({
      note,
      success: successesByChatId.get(chatId),
      paths,
      root,
      dryRun: false,
    });
  });

  const itemResults = [...rawResults, ...wikiResults].map((item) => ({
    ...item,
    takeoutEvidence: takeoutEvidenceFor(takeoutEvidence, item.chatId),
  }));
  const statusCounts = countStatuses(itemResults);
  const finalReport = {
    createdAt: new Date().toISOString(),
    root,
    mode,
    browserStatus,
    paths,
    scannedMarkdownFiles: audit.summary.scannedMarkdownFiles,
    geminiExportNotes: audit.summary.geminiExportNotes,
    directLinkVerified: rawResults.filter((item) =>
      ['verified_clean', 'repaired', 'blocked'].includes(item.status),
    ).length,
    heuristicSuspectCount: audit.summary.suspectNotes,
    wikiCandidateCount: audit.summary.wikiCandidates,
    takeoutEvidence: takeoutEvidence?.summary?.enabled
      ? {
          sourceFile: takeoutEvidence.sourceFile,
          summary: takeoutEvidence.summary,
        }
      : { summary: { enabled: false } },
    reexportJobs: reexport.jobs,
    reexportFailures: reexport.failures,
    statusCounts,
    items: itemResults,
  };
  writeJson(paths.finalReportPath, finalReport);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode,
        scannedMarkdownFiles: finalReport.scannedMarkdownFiles,
        geminiExportNotes: finalReport.geminiExportNotes,
        directLinkVerified: finalReport.directLinkVerified,
        statusCounts,
        auditReportPath: paths.auditReportPath,
        preliminaryReportPath: paths.preliminaryReportPath,
        finalReportPath: paths.finalReportPath,
        stagingDir: paths.stagingDir,
        backupDir: paths.backupDir,
        wikiReviewDir: paths.wikiReviewDir,
      },
      null,
      2,
    )}\n`,
  );
};

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
