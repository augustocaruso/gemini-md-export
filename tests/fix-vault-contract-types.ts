import type {
  FixVaultProgressPhase,
  FixVaultReport,
  FixVaultStepTuple,
} from '../src/core/fix-vault-contract.js';
import {
  FIX_VAULT_PROGRESS_MESSAGES,
  FIX_VAULT_STEP_ORDER,
} from '../src/core/fix-vault-contract.js';

const orderedSteps = [
  {
    name: 'repair-audit',
    status: 'completed',
    exitCode: 0,
    reportDir: '/tmp/repair',
  },
  {
    name: 'metadata-diagnosis',
    status: 'blocked',
    exitCode: 2,
    reportPath: '/tmp/metadata-diagnosis.json',
  },
  {
    name: 'web-repair',
    status: 'completed',
    exitCode: 0,
    targetCount: 1,
    reportDir: '/tmp/repair',
  },
  {
    name: 'metadata-backfill',
    status: 'completed',
    exitCode: 0,
    reportPath: '/tmp/metadata-backfill.json',
  },
  {
    name: 'vault-validation',
    status: 'completed',
    exitCode: 0,
  },
] satisfies FixVaultStepTuple;

void orderedSteps;

const validReport = {
  schema: 'gemini-md-export.fix-vault-report.v1',
  generatedAt: '2026-05-21T00:00:00Z',
  vaultDir: '/tmp/vault',
  takeout: 'Minhaatividade.html',
  ok: true,
  steps: orderedSteps,
  reports: {
    repairPreliminaryReport: '/tmp/preliminary.json',
    metadataDiagnosisReport: '/tmp/metadata-diagnosis.json',
    metadataReport: '/tmp/metadata-backfill.json',
  },
  summary: {
    repair: {
      verificationQueueSize: 1,
      wikiReviewQueueSize: 0,
      takeoutEvidence: { enabled: true },
    },
    diagnosis: null,
    webRepair: {
      targetCount: 1,
      exitCode: 0,
      skipped: false,
    },
    metadata: null,
  },
  warnings: [],
} satisfies FixVaultReport;

void validReport;

const invalidOrder = [
  orderedSteps[0],
  orderedSteps[1],
  // @ts-expect-error fix-vault steps must stay in the public phase order.
  orderedSteps[3],
  // @ts-expect-error fix-vault steps must stay in the public phase order.
  orderedSteps[2],
  orderedSteps[4],
] satisfies FixVaultStepTuple;

void invalidOrder;

const invalidStatus = {
  name: 'web-repair',
  // @ts-expect-error web-repair has explicit terminal states, never generic pending.
  status: 'pending',
  exitCode: 0,
  targetCount: 0,
  reportDir: '/tmp/repair',
} satisfies FixVaultStepTuple[2];

void invalidStatus;

const allProgressMessages: Record<FixVaultProgressPhase, string> = FIX_VAULT_PROGRESS_MESSAGES;

void allProgressMessages;
void FIX_VAULT_STEP_ORDER;
