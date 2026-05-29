import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildFixVaultCombinedReport,
  buildFixVaultPrivateRepairTargets,
  buildFixVaultRepairAdapterPlan,
  buildWebRepairArgs,
} from '../build/ts/core/fix-vault-flow.js';
import { runFixVaultCommand } from '../build/ts/cli/fix-vault-runner.js';

test('fix-vault marca reparo web como bloqueado quando chats nao abrem nesta conta', () => {
  const report = buildFixVaultCombinedReport({
    generatedAt: '2026-05-21T00:00:00Z',
    vaultDir: '/tmp/vault',
    takeout: 'Minhaatividade.html',
    repairExitCode: 0,
    diagnosisExitCode: 2,
    webRepairExitCode: 2,
    webRepairSkipped: false,
    webRepairTargetCount: 59,
    webRepairUnavailable: {
      code: 'gemini_web_chats_unavailable',
      message: 'O Gemini Web desta conta nao abriu os primeiros chats que precisavam de reparo.',
      nextAction: 'Use uma sessao do navegador logada na conta dona desses chats.',
      failedChatIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'],
    },
    metadataExitCode: 1,
    repairReportDir: '/tmp/repair',
    repairPreliminaryReportPath: '/tmp/repair/preliminary.json',
    metadataDiagnosisReportPath: '/tmp/metadata-diagnosis.json',
    metadataReportPath: '/tmp/metadata-backfill.json',
    repairSummary: {
      verificationQueueSize: 59,
      wikiReviewQueueSize: 0,
      takeoutEvidence: { summary: { enabled: true } },
    },
    diagnosisSummary: null,
    metadataSummary: null,
    warnings: [],
  });

  assert.equal(report.ok, false);
  assert.equal(report.steps[2].name, 'web-repair');
  assert.equal(report.steps[2].status, 'blocked');
  assert.equal(report.summary.webRepair.unavailable?.code, 'gemini_web_chats_unavailable');
});

test('fix-vault repassa claim explicita para o reparo web sem escolher outra aba', () => {
  const args = buildWebRepairArgs({
    vaultDir: '/tmp/vault',
    repairReportDir: '/tmp/repair',
    flags: {
      bridgeUrl: 'http://127.0.0.1:47283',
      takeout: '/tmp/Minhaatividade.html',
      claimId: 'claim-123',
      activateTab: true,
    },
    repairTargetPaths: ['/tmp/vault/a.md'],
  });

  assert.deepEqual(args.slice(0, 10), [
    '--report-dir',
    '/tmp/repair',
    '--bridge-url',
    'http://127.0.0.1:47283',
    '--takeout',
    '/tmp/Minhaatividade.html',
    '--claim-id',
    'claim-123',
    '--activate-tab',
    '--path',
  ]);
});

test('fix-vault monta fila da API privada a partir dos registros do indice Markdown', () => {
  const root = resolve(tmpdir(), `gme-fix-vault-assets-${process.pid}-${Date.now()}`);
  const vault = join(root, 'vault');
  const nested = join(vault, 'Gemini');
  mkdirSync(nested, { recursive: true });
  const chatPath = join(nested, 'abc123abc123.md');
  writeFileSync(chatPath, '# fixture\n', 'utf-8');

  try {
    const targets = buildFixVaultPrivateRepairTargets({
      vaultDir: vault,
      diagnosisReport: { items: [] },
      vaultRecords: [
        {
          chatId: 'abc123abc123',
          title: 'Chat com asset',
          url: 'https://gemini.google.com/app/abc123abc123',
          sourcePath: chatPath,
          relativePath: 'Gemini/abc123abc123.md',
          missingAssets: ['assets/abc123abc123/missing.png'],
        },
      ],
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].chatId, 'abc123abc123');
    assert.equal(targets[0].sourcePath, chatPath);
    assert.equal(targets[0].outputDir, nested);
    assert.equal(targets[0].filename, 'abc123abc123.md');
    assert.equal(targets[0].title, 'Chat com asset');
    assert.deepEqual(targets[0].reasons, ['missing_asset']);
    assert.deepEqual(targets[0].missingAssets, ['assets/abc123abc123/missing.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-vault adapter plan prefers private API and avoids browser lease for known targets', () => {
  const plan = buildFixVaultRepairAdapterPlan({
    flags: { privateApi: true, openIfMissing: false },
    targets: [{ chatId: 'abc123abc123' }],
  });

  assert.deepEqual(plan.adapters.map((adapter) => adapter.kind), ['private_api']);
  assert.equal(plan.requiresBrowserLease, false);
});

test('fix-vault adapter plan uses browser fallback only when private API is disabled', () => {
  const plan = buildFixVaultRepairAdapterPlan({
    flags: { privateApi: false, openIfMissing: true },
    targets: [{ chatId: 'abc123abc123' }],
  });

  assert.deepEqual(plan.adapters.map((adapter) => adapter.kind), [
    'browser_inventory',
    'dom_legacy',
  ]);
  assert.equal(plan.requiresBrowserLease, true);
});

test('fix-vault bloqueia datas e nao reutiliza relatorio antigo quando reparo web falha', async () => {
  const root = resolve(tmpdir(), `gme-fix-vault-${process.pid}-${Date.now()}`);
  const vault = join(root, 'vault');
  const report = join(root, 'fix-vault-report.json');
  const staleMetadataReport = join(root, 'metadata-backfill.json');
  const metadataRan = join(root, 'metadata-ran');
  const repairScript = join(root, 'repair.mjs');
  const metadataScript = join(root, 'metadata.mjs');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'broken.md'), '# raw export\n', 'utf-8');
  writeFileSync(
    staleMetadataReport,
    JSON.stringify({ summary: { totalChats: 999, filesRewritten: 999 } }),
    'utf-8',
  );
  writeFileSync(
    repairScript,
    `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const reportDir = args[args.indexOf('--report-dir') + 1];
mkdirSync(reportDir, { recursive: true });
if (args.includes('--dry-run')) {
  const preliminaryReportPath = join(reportDir, 'preliminary.json');
  writeFileSync(preliminaryReportPath, JSON.stringify({ summary: { verificationQueueSize: 1, wikiReviewQueueSize: 0 } }));
  console.log(JSON.stringify({ preliminaryReportPath }));
  process.exit(0);
}
console.error('web repair failed');
process.exit(1);
`,
    'utf-8',
  );
  writeFileSync(
    metadataScript,
    `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const report = args[args.indexOf('--report') + 1];
if (args.includes('--diagnose-only')) {
  writeFileSync(report, JSON.stringify({
    summary: { totalChats: 1, filesRewritten: 0, datesMatched: 0, exportErrors: 1, sourceGaps: 0, complete: false },
    items: [{ status: 'export_error', file: 'broken.md' }]
  }));
  process.exit(2);
}
writeFileSync(${JSON.stringify(metadataRan)}, 'ran');
process.exit(0);
`,
    'utf-8',
  );

  let stdoutText = '';
  let stderrText = '';
  const result = await runFixVaultCommand({
    parsed: {
      flags: {
        bridgeUrl: 'http://127.0.0.1:47283',
        privateApi: false,
        report,
        takeout: join(root, 'Minhaatividade.html'),
        format: 'plain',
      },
      positionals: [vault],
    },
    streams: {
      stdout: { write: (chunk) => { stdoutText += String(chunk); return true; } },
      stderr: { write: (chunk) => { stderrText += String(chunk); return true; } },
    },
    packageRoot: root,
    repairPath: repairScript,
    metadataPath: metadataScript,
  });

  const combined = JSON.parse(readFileSync(report, 'utf-8'));
  assert.equal(result.exitCode, 1);
  assert.equal(combined.steps[2].status, 'failed');
  assert.equal(combined.steps[3].status, 'blocked');
  assert.equal(combined.steps[3].exitCode, 2);
  assert.equal(combined.summary.metadata, null);
  assert.equal(existsSync(metadataRan), false);
  assert.match(stdoutText, /Datas bloqueadas ate o reparo terminar/);
  assert.doesNotMatch(stdoutText, /Atualizando datas do vault/);
  assert.match(stderrText, /web repair failed/);
});
