import type { MetadataBackfillSummary } from './metadata-backfill-contract.js';

export type FixVaultStepStatus = 'completed' | 'blocked' | 'failed' | 'skipped';

export type FixVaultStepName =
  | 'repair-audit'
  | 'metadata-diagnosis'
  | 'private-api-repair'
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
  'private-api-repair',
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

export type ChatRepairStep = {
  name: 'private-api-repair' | 'web-repair';
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
  | ChatRepairStep
  | MetadataBackfillStep
  | VaultValidationStep;

export type FixVaultStepTuple = [
  RepairAuditStep,
  MetadataDiagnosisStep,
  ChatRepairStep,
  MetadataBackfillStep,
  VaultValidationStep,
];

export type FixVaultChatRepairSummary = {
  adapter: 'private_api' | 'web';
  targetCount: number;
  exitCode: number;
  skipped: boolean;
  unavailable?: {
    code: string;
    message: string;
    nextAction?: string;
    failedChatIds?: string[];
    failureCodeCounts?: Record<string, number>;
    failureSamples?: Array<{
      index: number;
      chatId: string | null;
      title: string | null;
      code: string | null;
      error: string;
    }>;
  } | null;
};

export type FixVaultReportSummary = {
  repair: {
    verificationQueueSize: number;
    wikiReviewQueueSize: number;
    takeoutEvidence: unknown;
  };
  diagnosis: MetadataBackfillSummary | null;
  chatRepair: FixVaultChatRepairSummary;
  /** @deprecated Use chatRepair. Kept as a schema-v1 compatibility alias. */
  webRepair: Omit<FixVaultChatRepairSummary, 'adapter'>;
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
