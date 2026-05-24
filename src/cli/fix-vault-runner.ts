import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  buildFixVaultCombinedReport,
  buildMetadataArgs,
  buildRepairAuditArgs,
  buildWebRepairArgs,
  diagnosisExitIsUsable,
  formatFixVaultProgressLine,
  repairTargetPathsFromDiagnosis,
} from '../core/fix-vault-flow.js';
import { buildFixVaultMetadataStatus } from '../core/metadata-backfill-contract.js';

type CliStreams = {
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream;
};

type ParsedCommand = {
  flags: Record<string, any> & { bridgeUrl: string };
  positionals: string[];
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
  const repairTargetPaths = repairTargetPathsFromDiagnosis({
    vaultDir: resolvedVaultDir,
    diagnosisReport,
  });
  let webRepair: { exitCode: number; stdoutText: string; stderrText: string; skipped?: boolean } = {
    exitCode: 0,
    stdoutText: '',
    stderrText: '',
    skipped: true,
  };
  const diagnosisUsable = diagnosisExitIsUsable(diagnosis.exitCode);
  if (diagnosisUsable) {
    if (repairTargetPaths.length > 0) {
      writePhase(2, 5, 'Reparando exports suspeitos pelo Gemini Web');
      webRepair = await runNodeScript({
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
          message: 'Reparando exports suspeitos pelo Gemini Web',
        },
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
  return { exitCode, result: combined };
};
