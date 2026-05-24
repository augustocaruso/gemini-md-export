import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FixVaultReport } from './fix-vault-contract.js';
import { buildFixVaultProgressViewModel } from './progress-view-model.js';

export type FixVaultFlowFlags = {
  bridgeUrl: string;
  takeout?: string | null;
  noMyActivity?: boolean;
  openIfMissing?: boolean | null;
  limit?: number | null;
  claimId?: string | null;
  clientId?: string | null;
  tabId?: number | string | null;
  session?: string | null;
  activateTab?: boolean | null;
};

export const FIX_VAULT_MANUAL_ACTION_EXIT_CODE = 2;

export const diagnosisExitIsUsable = (exitCode: number): boolean =>
  exitCode === 0 || exitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE;

export const buildRepairAuditArgs = ({
  vaultDir,
  repairReportDir,
  takeout = '',
}: {
  vaultDir: string;
  repairReportDir: string;
  takeout?: string | null;
}): string[] => {
  const args = ['--dry-run', '--skip-browser-check', '--report-dir', repairReportDir];
  if (takeout) args.push('--takeout', takeout);
  args.push(vaultDir);
  return args;
};

export const buildMetadataArgs = ({
  vaultDir,
  reportPath,
  flags,
  diagnoseOnly = false,
}: {
  vaultDir: string;
  reportPath: string;
  flags: FixVaultFlowFlags;
  diagnoseOnly?: boolean;
}): string[] => {
  const args = [vaultDir, '--report', reportPath, '--bridge-url', flags.bridgeUrl];
  if (flags.takeout) args.push('--takeout', flags.takeout);
  if (!flags.noMyActivity) args.push('--use-my-activity');
  if (flags.openIfMissing === false) args.push('--no-open-if-missing');
  else if (flags.openIfMissing === true) args.push('--open-if-missing');
  if (Number.isFinite(flags.limit) && Number(flags.limit) > 0) {
    args.push('--limit', String(flags.limit));
  }
  if (diagnoseOnly) args.push('--diagnose-only');
  return args;
};

export const buildWebRepairArgs = ({
  vaultDir,
  repairReportDir,
  flags,
  repairTargetPaths,
}: {
  vaultDir: string;
  repairReportDir: string;
  flags: FixVaultFlowFlags;
  repairTargetPaths: string[];
}): string[] => {
  const args = ['--report-dir', repairReportDir, '--bridge-url', flags.bridgeUrl];
  if (flags.takeout) args.push('--takeout', flags.takeout);
  if (flags.claimId) args.push('--claim-id', flags.claimId);
  if (flags.clientId) args.push('--client-id', flags.clientId);
  if (flags.tabId !== null && flags.tabId !== undefined) args.push('--tab-id', String(flags.tabId));
  if (flags.session) args.push('--session', flags.session);
  if (flags.activateTab === true) args.push('--activate-tab');
  for (const targetPath of repairTargetPaths) args.push('--path', targetPath);
  args.push(vaultDir);
  return args;
};

export const metadataExportErrorItems = (
  diagnosisReport: { items?: Array<{ status?: string; file?: string | null }> } | null | undefined,
): Array<{ status?: string; file?: string | null }> =>
  (diagnosisReport?.items || []).filter((item) => item.status === 'export_error');

export const repairTargetPathsFromDiagnosis = ({
  vaultDir,
  diagnosisReport,
}: {
  vaultDir: string;
  diagnosisReport: { items?: Array<{ status?: string; file?: string | null }> } | null | undefined;
}): string[] =>
  metadataExportErrorItems(diagnosisReport)
    .map((item) => (item.file ? resolve(vaultDir, item.file) : null))
    .filter((item): item is string => Boolean(item && existsSync(item)));

export const formatFixVaultProgressLine = ({
  format,
  current,
  total,
  message,
}: {
  format: string;
  current: number;
  total: number;
  message: string;
}): string => {
  const view = buildFixVaultProgressViewModel({ current, total, message });
  if (format !== 'tui' && format !== 'tui-stream') return `Fix vault: ${message}...\n`;
  const width = 28;
  const filled = Math.round((view.barCurrent / Math.max(1, view.total)) * width);
  return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏ ${view.countLabel} ${view.label}\n`;
};

export const buildFixVaultCombinedReport = ({
  generatedAt,
  vaultDir,
  takeout,
  repairExitCode,
  diagnosisExitCode,
  webRepairExitCode,
  webRepairSkipped,
  webRepairTargetCount,
  webRepairUnavailable = null,
  metadataExitCode,
  repairReportDir,
  repairPreliminaryReportPath,
  metadataDiagnosisReportPath,
  metadataReportPath,
  repairSummary,
  diagnosisSummary,
  metadataSummary,
  warnings,
}: {
  generatedAt: string;
  vaultDir: string;
  takeout: string | null;
  repairExitCode: number;
  diagnosisExitCode: number;
  webRepairExitCode: number;
  webRepairSkipped: boolean;
  webRepairTargetCount: number;
  webRepairUnavailable?: FixVaultReport['summary']['webRepair']['unavailable'];
  metadataExitCode: number;
  repairReportDir: string;
  repairPreliminaryReportPath: string | null;
  metadataDiagnosisReportPath: string;
  metadataReportPath: string;
  repairSummary?: {
    verificationQueueSize?: number;
    wikiReviewQueueSize?: number;
    takeoutEvidence?: { summary?: unknown };
  } | null;
  diagnosisSummary?: FixVaultReport['summary']['diagnosis'];
  metadataSummary?: FixVaultReport['summary']['metadata'];
  warnings: FixVaultReport['warnings'];
}): FixVaultReport => {
  const diagnosisUsable = diagnosisExitIsUsable(diagnosisExitCode);
  const ok =
    repairExitCode === 0 &&
    diagnosisUsable &&
    webRepairExitCode === 0 &&
    metadataExitCode === 0;
  return {
    schema: 'gemini-md-export.fix-vault-report.v1',
    generatedAt,
    vaultDir,
    takeout,
    ok,
    steps: [
      {
        name: 'repair-audit',
        status: repairExitCode === 0 ? 'completed' : 'failed',
        exitCode: repairExitCode,
        reportDir: repairReportDir,
      },
      {
        name: 'metadata-diagnosis',
        status: diagnosisExitCode === 0 ? 'completed' : diagnosisExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE ? 'blocked' : 'failed',
        exitCode: diagnosisExitCode,
        reportPath: metadataDiagnosisReportPath,
      },
      {
        name: 'web-repair',
        status: webRepairSkipped
          ? 'skipped'
          : webRepairExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE
            ? 'blocked'
            : webRepairExitCode === 0
              ? 'completed'
              : 'failed',
        exitCode: webRepairExitCode,
        targetCount: webRepairTargetCount,
        reportDir: repairReportDir,
      },
      {
        name: 'metadata-backfill',
        status: metadataExitCode === 0 ? 'completed' : metadataExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE ? 'blocked' : 'failed',
        exitCode: metadataExitCode,
        reportPath: metadataReportPath,
      },
      {
        name: 'vault-validation',
        status: ok ? 'completed' : 'blocked',
        exitCode: repairExitCode || (diagnosisUsable ? 0 : diagnosisExitCode) || webRepairExitCode || metadataExitCode,
      },
    ],
    reports: {
      repairPreliminaryReport: repairPreliminaryReportPath,
      metadataDiagnosisReport: metadataDiagnosisReportPath,
      metadataReport: metadataReportPath,
    },
    summary: {
      repair: {
        verificationQueueSize: repairSummary?.verificationQueueSize || 0,
        wikiReviewQueueSize: repairSummary?.wikiReviewQueueSize || 0,
        takeoutEvidence: repairSummary?.takeoutEvidence?.summary || { enabled: false },
      },
      diagnosis: diagnosisSummary || null,
      webRepair: {
        targetCount: webRepairTargetCount,
        exitCode: webRepairExitCode,
        skipped: webRepairSkipped,
        unavailable: webRepairUnavailable,
      },
      metadata: metadataSummary || null,
    },
    warnings,
  };
};
