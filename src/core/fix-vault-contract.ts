import type { MetadataBackfillSummary } from './metadata-backfill-contract.js';

export type FixVaultStepStatus = 'completed' | 'blocked' | 'failed' | 'skipped';

export type FixVaultStepName =
  | 'repair-audit'
  | 'metadata-diagnosis'
  | 'web-repair'
  | 'metadata-backfill'
  | 'vault-validation';

export type FixVaultProgressPhase =
  | 'diagnosing_takeout_and_vault'
  | 'repairing_suspect_exports'
  | 'updating_metadata_dates'
  | 'validating_updated_vault';

export const FIX_VAULT_STEP_ORDER = [
  'repair-audit',
  'metadata-diagnosis',
  'web-repair',
  'metadata-backfill',
  'vault-validation',
] as const satisfies readonly FixVaultStepName[];

export const FIX_VAULT_PROGRESS_MESSAGES = {
  diagnosing_takeout_and_vault: 'Diagnosticando Takeout e chats do vault',
  repairing_suspect_exports: 'Reparando exports e assets pela API privada',
  updating_metadata_dates: 'Atualizando datas do vault',
  validating_updated_vault: 'Validando vault atualizado',
} as const satisfies Record<FixVaultProgressPhase, string>;

export type RepairAuditStep = {
  name: 'repair-audit';
  status: Extract<FixVaultStepStatus, 'completed' | 'failed'>;
  exitCode: number;
  reportDir: string;
};

export type MetadataDiagnosisStep = {
  name: 'metadata-diagnosis';
  status: Extract<FixVaultStepStatus, 'completed' | 'blocked' | 'failed'>;
  exitCode: number;
  reportPath: string;
};

export type WebRepairStep = {
  name: 'web-repair';
  status: Extract<FixVaultStepStatus, 'completed' | 'blocked' | 'failed' | 'skipped'>;
  exitCode: number;
  targetCount: number;
  reportDir: string;
};

export type MetadataBackfillStep = {
  name: 'metadata-backfill';
  status: Extract<FixVaultStepStatus, 'completed' | 'blocked' | 'failed'>;
  exitCode: number;
  reportPath: string;
};

export type VaultValidationStep = {
  name: 'vault-validation';
  status: Extract<FixVaultStepStatus, 'completed' | 'blocked' | 'failed'>;
  exitCode: number;
};

export type FixVaultStep =
  | RepairAuditStep
  | MetadataDiagnosisStep
  | WebRepairStep
  | MetadataBackfillStep
  | VaultValidationStep;

export type FixVaultStepTuple = [
  RepairAuditStep,
  MetadataDiagnosisStep,
  WebRepairStep,
  MetadataBackfillStep,
  VaultValidationStep,
];

export type FixVaultReportSummary = {
  repair: {
    verificationQueueSize: number;
    wikiReviewQueueSize: number;
    takeoutEvidence: unknown;
  };
  diagnosis: MetadataBackfillSummary | null;
  webRepair: {
    targetCount: number;
    exitCode: number;
    skipped: boolean;
    unavailable?: {
      code: string;
      message: string;
      nextAction?: string;
      failedChatIds?: string[];
    } | null;
  };
  metadata: MetadataBackfillSummary | null;
};

export type FixVaultReport = {
  schema: 'gemini-md-export.fix-vault-report.v1';
  generatedAt: string;
  vaultDir: string;
  takeout: string | null;
  ok: boolean;
  steps: FixVaultStepTuple;
  reports: {
    repairPreliminaryReport: string | null;
    metadataDiagnosisReport: string;
    metadataReport: string;
  };
  summary: FixVaultReportSummary;
  warnings: Array<{
    code: string;
    message: string;
    nextAction?: string;
    unresolvedChatIds?: string[];
  }>;
};
