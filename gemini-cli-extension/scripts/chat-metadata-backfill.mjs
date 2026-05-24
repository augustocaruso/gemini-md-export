#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47283';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const compiledModuleUrl = (...segments) => {
  const candidates = [
    resolve(SCRIPT_DIR, '..', '..', 'build', 'ts', ...segments),
    resolve(SCRIPT_DIR, '..', 'build', 'ts', ...segments),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Modulo TypeScript compilado nao encontrado: ${segments.join('/')} (rode npm run build:ts).`,
    );
  }
  return pathToFileURL(found).href;
};

const [
  { portableIsoSeconds },
  { requestMetadataActivityScan },
  { groupMetadataEvidence },
  {
    metadataBackfillHumanSummary,
  },
  { filterCandidatesMissingResolvedMetadataDates },
  { buildMetadataBackfillReportState },
  { buildMarkdownChatNote },
  { buildCanonicalFrontmatter: buildSharedCanonicalFrontmatter },
  { loadTakeoutMatches: loadSharedTakeoutMatches },
] = await Promise.all([
  import(compiledModuleUrl('core', 'date.js')),
  import(compiledModuleUrl('core', 'activity-scan-request.js')),
  import(compiledModuleUrl('core', 'metadata-evidence.js')),
  import(compiledModuleUrl('core', 'metadata-backfill-contract.js')),
  import(compiledModuleUrl('core', 'metadata-date-resolution.js')),
  import(compiledModuleUrl('core', 'metadata-backfill-report.js')),
  import(compiledModuleUrl('core', 'markdown-note.js')),
  import(compiledModuleUrl('core', 'yaml.js')),
  import(compiledModuleUrl('takeout', 'takeout-adapter.js')),
]);

const usage = () => `Uso:
  gemini-md-export metadata backfill <vaultDir> --use-my-activity --report <report.json>
  gemini-md-export metadata backfill <vaultDir> --takeout <takeout.zip|Minhaatividade.html|MyActivity.json> --report <report.json>

Opções:
  --use-my-activity        usa uma aba My Activity conectada pela extensão
  --takeout <arquivo>      usa arquivo offline do Google Takeout/My Activity (.zip, .html ou .json)
  --bridge-url <url>       bridge local (default: ${DEFAULT_BRIDGE_URL})
  --report <json>          caminho do relatório/checkpoint
  --limit <n>              limita quantidade de chats processados
  --diagnose-only          gera relatório sem reescrever os arquivos
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
    diagnoseOnly: false,
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
    else if (arg === '--diagnose-only') args.diagnoseOnly = true;
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
  const note = buildMarkdownChatNote({
    filePath,
    relativePath: relative(vaultDir, filePath),
    raw: original,
    fallbackChatId: basename(filePath, '.md'),
  });
  if (!note) return null;
  return {
    ...note,
    filePath,
    relativePath: note.relativePath,
    original,
    dateCreated: note.metadata.dateCreated || null,
    dateLastMessage: note.metadata.dateLastMessage || null,
    dateExported: note.metadata.dateExported || null,
    model: note.metadata.model || note.model || '',
    turnCount: note.metadata.assistantTurnCount,
    attachmentCount: (note.body.match(/!\[[^\]]*\]\(assets\/[^)\s]+\)/g) || []).length,
  };
};

const buildCanonicalFrontmatter = (candidate, dates = {}) => {
  return buildSharedCanonicalFrontmatter(
    {
      chatId: candidate.chatId,
      title: candidate.title,
      url: candidate.url,
      tags: candidate.tags,
      model: candidate.model,
      metadata: {
        dateCreated: candidate.dateCreated,
        dateLastMessage: candidate.dateLastMessage,
        dateExported: candidate.dateExported,
        assistantTurnCount: candidate.turnCount,
        model: candidate.model,
      },
    },
    {
      dateCreated: dates.dateCreated,
      dateLastMessage: dates.dateLastMessage,
    },
  );
};

const writeCandidate = (candidate, dates) => {
  const updated = buildCanonicalFrontmatter(candidate, dates) + candidate.body.replace(/^\n+/, '');
  writeFileSync(candidate.filePath, updated, 'utf-8');
};

const groupActivityMatches = (matches = []) => groupMetadataEvidence(matches);

const loadTakeoutMatches = (path, candidates = []) => {
  if (!path) return [];
  return loadSharedTakeoutMatches(path, candidates);
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
  let activitySkipped = null;
  if (args.takeout) matches.push(...loadTakeoutMatches(resolve(expandUserPath(args.takeout)), selected));
  if (args.useMyActivity && selected.length) {
    const remainingCandidates = filterCandidatesMissingResolvedMetadataDates(selected, groupActivityMatches(matches));
    if (remainingCandidates.length === 0) {
      activitySkipped = {
        code: 'no_remaining_dates',
        message: 'nao foi necessario consultar porque Takeout/frontmatter ja cobriram todos os chats.',
      };
    } else {
      try {
        const activity = await requestMetadataActivityScan({
          bridgeUrl: args.bridgeUrl,
          candidates: remainingCandidates,
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
  }

  const grouped = groupActivityMatches(matches);
  const reportState = buildMetadataBackfillReportState({
    candidates: selected,
    groupedMatches: grouped,
    filesRewritten: args.diagnoseOnly ? 0 : selected.length,
    takeoutPath: args.takeout ? resolve(expandUserPath(args.takeout)) : '',
    activityError,
  });
  const itemByChatId = new Map(reportState.items.map((item) => [item.chatId, item]));
  if (!args.diagnoseOnly) {
    for (const candidate of selected) {
      const item = itemByChatId.get(candidate.chatId);
      writeCandidate(candidate, {
        dateCreated: item?.dateCreated || null,
        dateLastMessage: item?.dateLastMessage || null,
      });
    }
  }
  const { items, summary, contract, rawExportDiagnostics } = reportState;

  const report = {
    schema: 'gemini-md-export.metadata-backfill-report.v1',
    generatedAt: portableIsoSeconds(new Date()),
    ok: contract.ok,
    diagnoseOnly: args.diagnoseOnly,
    contract,
    vaultDir,
    sources: {
      myActivity: args.useMyActivity,
      takeout: args.takeout ? basename(args.takeout) : null,
    },
    summary,
    activityCheckpoint,
    activityError,
    activitySkipped,
    rawExportDiagnostics,
    items,
  };

  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }
  process.stdout.write(metadataBackfillHumanSummary(summary, contract));
  if (activityError) {
    process.stdout.write(`My Activity: ${activityError.message}\n`);
  } else if (activitySkipped) {
    process.stdout.write(`My Activity: ${activitySkipped.message}\n`);
  }
  if (!contract.ok) {
    process.stdout.write(`${contract.message} Veja o relatorio para resolver os itens pendentes.\n`);
    process.exitCode = 2;
  }
};

run().catch((err) => {
  process.stderr.write(`${err.message}\n\n${usage()}`);
  process.exitCode = 1;
});
