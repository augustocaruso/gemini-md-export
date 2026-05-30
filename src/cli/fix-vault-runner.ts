import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  buildFixVaultCombinedReport,
  buildFixVaultPrivateRepairTargets,
  buildFixVaultRepairAdapterPlan,
  buildMetadataArgs,
  buildRepairAuditArgs,
  buildWebRepairArgs,
  diagnosisExitIsUsable,
  type FixVaultPrivateRepairTarget,
  formatFixVaultProgressLine,
  repairTargetPathsFromDiagnosis,
} from '../core/fix-vault-flow.js';
import { buildFixVaultMetadataStatus } from '../core/metadata-backfill-contract.js';
import { loadMarkdownDbFixVaultRecords } from '../mcp/markdown-db-vault-adapter.js';
import {
  type PrivateApiSelectedExportJob,
  runPrivateApiSelectedExport,
  summarizePrivateApiSelectedExportJob,
} from './private-api-selected-export.js';

type CliStreams = {
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream;
};

type ParsedCommand = {
  flags: Record<string, any> & { bridgeUrl: string };
  positionals: string[];
};

type RepairRunResult = {
  exitCode: number;
  stdoutText: string;
  stderrText: string;
  skipped?: boolean;
};

const reportTimestamp = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

const readJsonIfExists = (filePath: string) => {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
};

const parseJsonText = (text: string) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const copyFileWithParents = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

const backupPrivateRepairTargets = ({
  targets,
  backupDir,
  vaultDir,
}: {
  targets: FixVaultPrivateRepairTarget[];
  backupDir: string;
  vaultDir: string;
}) => {
  const copiedAssets = new Set<string>();
  for (const target of targets) {
    copyFileWithParents(target.sourcePath, join(backupDir, relative(vaultDir, target.sourcePath)));
    const assetsDir = join(dirname(target.sourcePath), 'assets', target.chatId);
    if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) continue;
    if (copiedAssets.has(assetsDir)) continue;
    copiedAssets.add(assetsDir);
    const backupAssetsDir = join(backupDir, relative(vaultDir, assetsDir));
    mkdirSync(dirname(backupAssetsDir), { recursive: true });
    cpSync(assetsDir, backupAssetsDir, { recursive: true });
  }
};

const mediaFailureCountFor = (job: PrivateApiSelectedExportJob): number =>
  job.savedFiles.reduce((sum, file) => sum + Number(file.mediaFailureCount || 0), 0);

const privateRepairUnavailableForJob = (job: PrivateApiSelectedExportJob) => {
  const mediaFailureCount = mediaFailureCountFor(job);
  if (job.failureCount > 0) {
    return {
      code: 'gemini_private_api_repair_failed',
      message: 'A API privada nao conseguiu reexportar todos os chats que precisavam de reparo.',
      nextAction:
        'Confirme que a sessao/cookies do Google estao validos e rode fix-vault novamente.',
      failedChatIds: job.failures
        .map((failure) => failure.chatId)
        .filter((chatId): chatId is string => Boolean(chatId)),
    };
  }
  if (mediaFailureCount > 0) {
    return {
      code: 'gemini_private_api_asset_download_failed',
      message:
        'A API privada reparou o Markdown, mas alguns assets nao foram baixados com sucesso.',
      nextAction:
        'Confirme que a sessao/cookies do Google estao validos e rode fix-vault novamente para completar os assets.',
      failedChatIds: job.savedFiles
        .filter((file) => Number(file.mediaFailureCount || 0) > 0)
        .map((file) => file.chatId),
    };
  }
  return null;
};

const privateRepairRunResult = (job: PrivateApiSelectedExportJob): RepairRunResult => {
  const unavailable = privateRepairUnavailableForJob(job);
  const summary = summarizePrivateApiSelectedExportJob(job);
  return {
    exitCode: unavailable ? 1 : 0,
    stderrText: '',
    stdoutText: `${JSON.stringify(
      {
        ok: !unavailable,
        mode: 'private-api',
        privateApiRepair: summary,
        webRepairUnavailable: unavailable,
        statusCounts: {
          repaired: job.successCount,
          failed: job.failureCount,
          mediaFailures: mediaFailureCountFor(job),
        },
      },
      null,
      2,
    )}\n`,
  };
};

const markdownDbUnavailableRunResult = (err: unknown): RepairRunResult => ({
  exitCode: 1,
  stdoutText: `${JSON.stringify(
    {
      ok: false,
      mode: 'private-api',
      webRepairUnavailable: {
        code: 'markdown_db_unavailable',
        message:
          'Nao consegui preparar o indice Markdown para encontrar exports e assets do vault.',
        nextAction:
          'Atualize ou reinstale a extensao para restaurar as dependencias e rode fix-vault novamente.',
        failedChatIds: [],
        error: err instanceof Error ? err.message : String(err),
      },
    },
    null,
    2,
  )}\n`,
  stderrText: err instanceof Error ? err.message : String(err),
  skipped: false,
});

const loadFixVaultMarkdownDbRecords = async ({
  vaultDir,
  enabled,
}: {
  vaultDir: string;
  enabled: boolean;
}) => {
  if (!enabled) return { records: [], unavailable: null as RepairRunResult | null };
  try {
    const result = await loadMarkdownDbFixVaultRecords({ vaultDir });
    return { records: result.records, unavailable: null as RepairRunResult | null };
  } catch (err) {
    return { records: [], unavailable: markdownDbUnavailableRunResult(err) };
  }
};

const selectFixVaultFormat = (flags: Record<string, any>, stdout: CliStreams['stdout']) => {
  if (flags.format === 'tui' && !stdout?.isTTY) return 'plain';
  if (flags.format && flags.format !== 'auto') return flags.format;
  return stdout?.isTTY && process.env.TERM !== 'dumb' ? 'tui' : 'plain';
};

const fixVaultProgressTickMs = () => {
  const configured = Number(process.env.GEMINI_MD_EXPORT_PROGRESS_TICK_MS || 8000);
  return Number.isFinite(configured) && configured > 0 ? Math.max(250, configured) : 8000;
};

const runNodeScript = async ({
  scriptPath,
  args,
  streams,
  packageRoot,
  streamStdout = true,
  progress,
}: {
  scriptPath: string;
  args: string[];
  streams: CliStreams;
  packageRoot: string;
  streamStdout?: boolean;
  progress?: {
    format: string;
    current: number;
    total: number;
    message: string;
  };
}) => {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  let stdoutText = '';
  let stderrText = '';
  const startedAt = Date.now();
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const progressTick = progress
    ? setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        stdout.write(
          formatFixVaultProgressLine({
            format: progress.format,
            current: progress.current,
            total: progress.total,
            message: `${progress.message} (em andamento, ${elapsedSeconds}s)`,
          }),
        );
      }, fixVaultProgressTickMs())
    : null;
  child.stdout.on('data', (chunk) => {
    stdoutText += String(chunk);
    if (streamStdout) stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
    stderr.write(chunk);
  });
  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
  if (progressTick) clearInterval(progressTick);
  return { exitCode, stdoutText, stderrText };
};

const runPrivateApiRepair = async ({
  targets,
  parsed,
  streams,
  format,
  backupDir,
  vaultDir,
}: {
  targets: FixVaultPrivateRepairTarget[];
  parsed: ParsedCommand;
  streams: CliStreams;
  format: string;
  backupDir: string;
  vaultDir: string;
}): Promise<RepairRunResult> => {
  const stdout = streams.stdout || process.stdout;
  backupPrivateRepairTargets({ targets, backupDir, vaultDir });
  let lastProgressKey = '';
  const job = await runPrivateApiSelectedExport({
    items: targets.map((target) => ({
      chatId: target.chatId,
      title: target.title,
      url: target.url,
      sourcePath: target.sourcePath,
      outputDir: target.outputDir,
      filename: target.filename,
    })),
    expectedCount: targets.length,
    bridgeUrl: parsed.flags.bridgeUrl,
    limit: parsed.flags.limit,
    waitMs: parsed.flags.waitMs,
    privateReadWaitMs: parsed.flags.privateReadWaitMs,
    timeoutMs: parsed.flags.timeoutMs,
    pollMs: parsed.flags.pollMs,
    clientId: parsed.flags.clientId,
    tabId: parsed.flags.tabId,
    claimId: parsed.flags.claimId,
    sessionId: parsed.flags.sessionId || parsed.flags.session,
    bootstrapTimeoutMs: parsed.flags.bootstrapTimeoutMs,
    python: parsed.flags.python,
    cookiesJson: parsed.flags.cookiesJson,
    delayMs: parsed.flags.delayMs,
    onProgress: (progress) => {
      const active = progress.current && progress.status === 'running' ? 1 : 0;
      const count = Math.min(progress.requested, progress.completed + active);
      const key = `${progress.status}:${progress.completed}:${progress.current?.chatId || ''}:${progress.progressMessage}`;
      if (key === lastProgressKey) return;
      lastProgressKey = key;
      const unifiedPrepMessages = new Set([
        'Lendo conversa pela API privada',
        'Export privado em andamento',
        'Export privado unificado',
      ]);
      const pythonPrepMessages = new Set([
        'Preparando API privada',
        'Preparacao da API privada falhou',
        'Listando conversas pela API privada',
      ]);
      const message = unifiedPrepMessages.has(progress.progressMessage)
        ? `Preparando export privado unificado (${count}/${progress.requested})`
        : progress.progressMessage === 'Export privado concluido'
          ? `Export privado unificado concluido (${count}/${progress.requested})`
          : pythonPrepMessages.has(progress.progressMessage)
            ? `${progress.progressMessage} (${count}/${progress.requested})`
            : `Reparando exports/assets pela API privada (${count}/${progress.requested})`;
      stdout.write(
        formatFixVaultProgressLine({
          format,
          current: 3,
          total: 5,
          message,
        }),
      );
    },
  });
  return privateRepairRunResult(job);
};

export const runFixVaultCommand = async ({
  parsed,
  streams = {},
  packageRoot,
  repairPath,
  metadataPath,
}: {
  parsed: ParsedCommand;
  streams?: CliStreams;
  packageRoot: string;
  repairPath: string;
  metadataPath: string;
}) => {
  const vaultDir = parsed.flags.vaultDir || parsed.positionals[0];
  if (!vaultDir) throw new Error('Informe vaultDir para fix-vault.');
  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) throw new Error(`Vault nao encontrado: ${resolvedVaultDir}`);

  const reportPath = resolve(
    parsed.flags.report ||
      `${resolvedVaultDir}/.gemini-md-export-fix/fix-vault-${reportTimestamp()}.json`,
  );
  const reportDir = dirname(reportPath);
  const repairReportDir = resolve(reportDir, 'repair');
  const metadataReportPath = resolve(reportDir, 'metadata-backfill.json');
  const metadataDiagnosisReportPath = resolve(reportDir, 'metadata-diagnosis.json');
  mkdirSync(reportDir, { recursive: true });

  const stdout = streams.stdout || process.stdout;
  const format = selectFixVaultFormat(parsed.flags, stdout);
  const writePhase = (current: number, total: number, message: string) =>
    stdout.write(formatFixVaultProgressLine({ format, current, total, message }));

  writePhase(1, 5, 'Diagnosticando Takeout e chats do vault');
  const repair = await runNodeScript({
    scriptPath: repairPath,
    args: buildRepairAuditArgs({
      vaultDir: resolvedVaultDir,
      repairReportDir,
      takeout: parsed.flags.takeout || '',
    }),
    streams,
    packageRoot,
    streamStdout: false,
    progress: { format, current: 1, total: 5, message: 'Diagnosticando Takeout e chats do vault' },
  });

  writePhase(2, 5, 'Conferindo datas e exports raw');
  const diagnosis =
    repair.exitCode === 0
      ? await runNodeScript({
          scriptPath: metadataPath,
          args: buildMetadataArgs({
            vaultDir: resolvedVaultDir,
            reportPath: metadataDiagnosisReportPath,
            flags: parsed.flags,
            diagnoseOnly: true,
          }),
          streams,
          packageRoot,
          streamStdout: false,
          progress: { format, current: 2, total: 5, message: 'Conferindo datas e exports raw' },
        })
      : { exitCode: 1, stdoutText: '', stderrText: 'repair_failed' };

  const repairOutput = parseJsonText(repair.stdoutText) || {};
  const repairSummary = readJsonIfExists(repairOutput.preliminaryReportPath);
  const diagnosisReport = readJsonIfExists(metadataDiagnosisReportPath);
  const diagnosisRepairTargetPaths = repairTargetPathsFromDiagnosis({
    vaultDir: resolvedVaultDir,
    diagnosisReport,
  });
  const markdownDb = await loadFixVaultMarkdownDbRecords({
    vaultDir: resolvedVaultDir,
    enabled: parsed.flags.privateApi !== false,
  });
  const repairTargets = buildFixVaultPrivateRepairTargets({
    vaultDir: resolvedVaultDir,
    diagnosisReport,
    vaultRecords: markdownDb.records,
  });
  const repairAdapterPlan = buildFixVaultRepairAdapterPlan({
    flags: {
      privateApi: parsed.flags.privateApi,
      openIfMissing: parsed.flags.openIfMissing,
    },
    targets: repairTargets,
  });
  const usePrivateApiRepair = repairAdapterPlan.adapters.some(
    (adapter) => adapter.kind === 'private_api',
  );
  const repairTargetPaths = !usePrivateApiRepair
    ? diagnosisRepairTargetPaths
    : repairTargets.map((target) => target.sourcePath);
  let webRepair: RepairRunResult = {
    exitCode: 0,
    stdoutText: '',
    stderrText: '',
    skipped: true,
  };
  const diagnosisUsable = diagnosisExitIsUsable(diagnosis.exitCode);
  if (diagnosisUsable) {
    if (markdownDb.unavailable) {
      writePhase(3, 5, 'Indice Markdown indisponivel para reparo');
      webRepair = markdownDb.unavailable;
    } else if (repairTargetPaths.length > 0) {
      const repairMessage = !usePrivateApiRepair
        ? 'Reparando exports suspeitos pelo Gemini Web'
        : 'Reparando exports e assets pela API privada';
      writePhase(3, 5, repairMessage);
      webRepair = !usePrivateApiRepair
        ? await runNodeScript({
            scriptPath: repairPath,
            args: buildWebRepairArgs({
              vaultDir: resolvedVaultDir,
              repairReportDir,
              flags: parsed.flags,
              repairTargetPaths,
            }),
            streams,
            packageRoot,
            streamStdout: false,
            progress: {
              format,
              current: 3,
              total: 5,
              message: repairMessage,
            },
          })
        : await runPrivateApiRepair({
            targets: repairTargets,
            parsed,
            streams,
            format,
            backupDir: resolve(repairReportDir, 'private-api-backups', reportTimestamp()),
            vaultDir: resolvedVaultDir,
          });
    } else {
      writePhase(3, 5, 'Nenhum export suspeito para reexportar');
    }
  }
  const webRepairOutput = parseJsonText(webRepair.stdoutText) || {};
  const webRepairUnavailable = webRepairOutput.webRepairUnavailable || null;
  const webRepairWarnings = webRepairUnavailable
    ? [
        {
          code: webRepairUnavailable.code || 'web_repair_unavailable',
          message:
            webRepairUnavailable.message ||
            'O reparo pelo Gemini Web nao conseguiu abrir os chats desta conta.',
          nextAction:
            webRepairUnavailable.nextAction ||
            'Use uma sessao do navegador logada na conta dona desses chats ou forneca outra fonte de reparo.',
          unresolvedChatIds: webRepairUnavailable.failedChatIds || [],
        },
      ]
    : [];

  const canWriteMetadata = repair.exitCode === 0 && diagnosisUsable && webRepair.exitCode === 0;
  let metadata: { exitCode: number; stdoutText: string; stderrText: string };
  if (canWriteMetadata) {
    writePhase(4, 5, 'Atualizando datas do vault');
    metadata = await runNodeScript({
      scriptPath: metadataPath,
      args: buildMetadataArgs({
        vaultDir: resolvedVaultDir,
        reportPath: metadataReportPath,
        flags: parsed.flags,
      }),
      streams,
      packageRoot,
      progress: { format, current: 4, total: 5, message: 'Atualizando datas do vault' },
    });
  } else {
    writePhase(4, 5, 'Datas bloqueadas ate o reparo terminar');
    metadata = { exitCode: 2, stdoutText: '', stderrText: 'metadata_blocked_by_repair' };
  }

  writePhase(5, 5, 'Validando vault atualizado');
  const metadataReport = canWriteMetadata ? readJsonIfExists(metadataReportPath) : null;
  const metadataUi = buildFixVaultMetadataStatus({
    exitCode: metadata.exitCode,
    report: metadataReport,
  });
  if (metadataUi.activityWarningText) stdout.write(metadataUi.activityWarningText);

  const combined = buildFixVaultCombinedReport({
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    vaultDir: resolvedVaultDir,
    takeout: parsed.flags.takeout ? basename(parsed.flags.takeout) : null,
    repairExitCode: repair.exitCode,
    diagnosisExitCode: diagnosis.exitCode,
    webRepairExitCode: webRepair.exitCode,
    webRepairSkipped: webRepair.skipped === true,
    webRepairTargetCount: repairTargetPaths.length,
    webRepairUnavailable,
    metadataExitCode: metadata.exitCode,
    repairReportDir,
    repairPreliminaryReportPath: repairOutput.preliminaryReportPath || null,
    metadataDiagnosisReportPath,
    metadataReportPath,
    repairSummary,
    diagnosisSummary: diagnosisReport?.summary || null,
    metadataSummary: metadataReport?.summary || null,
    warnings: [...webRepairWarnings, ...metadataUi.warnings],
  });
  writeFileSync(reportPath, `${JSON.stringify(combined, null, 2)}\n`, 'utf-8');
  const finalStep = combined.steps[combined.steps.length - 1];
  const finalMessage = combined.ok
    ? 'Fluxo concluido'
    : finalStep?.status === 'failed'
      ? 'Fluxo falhou'
      : 'Fluxo bloqueado';
  writePhase(5, 5, finalMessage);
  stdout.write(`Fix vault: relatorio combinado em ${reportPath}\n`);

  const exitCode = repair.exitCode || webRepair.exitCode || metadata.exitCode || 0;
  if (parsed.flags.resultJson === true) {
    stdout.write(`RESULT_JSON ${JSON.stringify(combined)}\n`);
  }
  return { exitCode, result: combined };
};
