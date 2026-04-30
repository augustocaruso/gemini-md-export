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
      '  --report-dir <dir>        Default: <vault>/.gemini-md-export-repair',
      '  --staging-dir <dir>       Default: <report-dir>/staging',
      '  --backup-dir <dir>        Default: <report-dir>/backups/<timestamp>',
      '  --bridge-url <url>        Default: http://127.0.0.1:47283',
      '  --skip-browser-check      Uso de teste/debug: pula gemini_browser_status.',
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
  explicitPaths,
  paths,
  itemsNeedingDirectVerificationFirst: rawQueue.slice(0, 200).map((note) => ({
    path: note.path,
    relativePath: note.relativePath,
    chatId: note.chatId,
    title: note.title || '',
    suspect: note.suspect === true,
    reasons: note.reasons || [],
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

const ensureBrowserReady = async (options) => {
  const status = await callMcpTool({
    bridgeUrl: options.bridgeUrl,
    name: 'gemini_browser_status',
    args: {
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
      name: 'gemini_export_job_status',
      args: { jobId },
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
    const started = await callMcpTool({
      bridgeUrl: options.bridgeUrl,
      name: 'gemini_reexport_chats',
      args: {
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

  const preliminary = createPreliminaryReport({
    audit,
    mode,
    dryRun: options.dryRun,
    paths,
    rawQueue,
    wikiQueue,
    explicitPaths: options.explicitPaths,
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

  const itemResults = [...rawResults, ...wikiResults];
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
