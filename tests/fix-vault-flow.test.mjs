import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildFixVaultCombinedReport,
  buildFixVaultPrivateRepairExportOptions,
  buildFixVaultPrivateRepairTargets,
  buildFixVaultRepairAdapterPlan,
  buildWebRepairArgs,
} from '../build/ts/core/fix-vault-flow.js';
import {
  privateRepairUnavailableForJob,
  runFixVaultCommand,
} from '../build/ts/cli/fix-vault-runner.js';

const minimalReportArgs = (overrides = {}) => ({
  generatedAt: '2026-05-21T00:00:00Z',
  vaultDir: '/tmp/vault',
  takeout: 'Minhaatividade.html',
  repairExitCode: 0,
  diagnosisExitCode: 2,
  webRepairExitCode: 0,
  webRepairSkipped: false,
  webRepairTargetCount: 1,
  metadataExitCode: 0,
  repairReportDir: '/tmp/repair',
  repairPreliminaryReportPath: '/tmp/repair/preliminary.json',
  metadataDiagnosisReportPath: '/tmp/metadata-diagnosis.json',
  metadataReportPath: '/tmp/metadata-backfill.json',
  repairSummary: {
    verificationQueueSize: 1,
    wikiReviewQueueSize: 0,
    takeoutEvidence: { summary: { enabled: true } },
  },
  diagnosisSummary: null,
  metadataSummary: null,
  warnings: [],
  ...overrides,
});

test('fix-vault marca reparo web como bloqueado quando chats nao abrem nesta conta', () => {
  const report = buildFixVaultCombinedReport(minimalReportArgs({
    repairAdapter: 'web',
    webRepairExitCode: 2,
    webRepairTargetCount: 59,
    webRepairUnavailable: {
      code: 'gemini_web_chats_unavailable',
      message: 'O Gemini Web desta conta nao abriu os primeiros chats que precisavam de reparo.',
      nextAction: 'Use uma sessao do navegador logada na conta dona desses chats.',
      failedChatIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'],
    },
    metadataExitCode: 1,
    repairSummary: { verificationQueueSize: 59, wikiReviewQueueSize: 0, takeoutEvidence: { summary: { enabled: true } } },
  }));

  assert.equal(report.ok, false);
  assert.equal(report.steps[2].name, 'web-repair');
  assert.equal(report.steps[2].status, 'blocked');
  assert.equal(report.summary.webRepair.unavailable?.code, 'gemini_web_chats_unavailable');
});

test('fix-vault nomeia o step de reparo privado como private-api-repair', () => {
  const report = buildFixVaultCombinedReport(minimalReportArgs({ repairAdapter: 'private_api' }));

  assert.equal(report.steps[2].name, 'private-api-repair');
  assert.equal(report.steps[2].status, 'completed');
  assert.equal(report.summary.chatRepair.targetCount, 1);
  assert.equal(report.summary.chatRepair.adapter, 'private_api');
  assert.equal(report.summary.webRepair.targetCount, 1);
});

test('fix-vault preserva web-repair quando o fallback legado e usado', () => {
  const report = buildFixVaultCombinedReport(minimalReportArgs({ repairAdapter: 'web' }));

  assert.equal(report.steps[2].name, 'web-repair');
  assert.equal(report.steps[2].status, 'completed');
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

test('fix-vault monta alvo privado a partir da diagnosis quando MarkdownDB nao traz record', () => {
  const root = resolve(tmpdir(), `gme-fix-vault-diagnosis-target-${process.pid}-${Date.now()}`);
  const vault = join(root, 'vault');
  const chatPath = join(vault, '003ef13f36239f09.md');
  mkdirSync(vault, { recursive: true });
  writeFileSync(chatPath, '# raw export suspeito\n', 'utf-8');

  try {
    const targets = buildFixVaultPrivateRepairTargets({
      vaultDir: vault,
      diagnosisReport: {
        items: [
          {
            chatId: '003ef13f36239f09',
            file: '003ef13f36239f09.md',
            status: 'export_error',
            title: 'Raw suspeito',
          },
        ],
      },
      vaultRecords: [],
    });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].chatId, '003ef13f36239f09');
    assert.equal(targets[0].sourcePath, chatPath);
    assert.equal(targets[0].outputDir, vault);
    assert.equal(targets[0].filename, '003ef13f36239f09.md');
    assert.equal(targets[0].url, 'https://gemini.google.com/app/003ef13f36239f09');
    assert.deepEqual(targets[0].reasons, ['metadata_export_error']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-vault private repair progress surfaces unified export and Python fallback distinctly', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'fix-vault-runner.ts'),
    'utf-8',
  );

  assert.match(source, /progress\.progressMessage/);
  assert.match(source, /Preparando export privado unificado/);
  assert.match(source, /Reparando exports\/assets pela API privada/);
});

test('fix-vault private repair reuses validated private session without browser lifecycle effects', () => {
  const options = buildFixVaultPrivateRepairExportOptions({
    bridgeUrl: 'http://127.0.0.1:47283',
    wakeBrowser: true,
    allowReload: true,
    openIfMissing: true,
    activateTab: true,
    clientId: 'client-1',
    claimId: 'claim-1',
    tabId: 42,
    session: 'session-1',
    waitMs: 90000,
    privateReadWaitMs: 45000,
    bridgeKeepAliveMs: 900000,
  });

  assert.equal(options.bridgeUrl, 'http://127.0.0.1:47283');
  assert.equal(options.clientId, 'client-1');
  assert.equal(options.claimId, 'claim-1');
  assert.equal(options.tabId, 42);
  assert.equal(options.sessionId, 'session-1');
  assert.equal(options.waitMs, 90000);
  assert.equal(options.privateReadWaitMs, 45000);
  assert.equal(options.browserKeepAliveMs, 900000);
  assert.equal(options.wakeBrowser, false);
  assert.equal(options.allowReload, false);
  assert.equal(options.openIfMissing, false);
  assert.equal(options.activateTab, false);
});

test('fix-vault private repair report keeps failure code counts and samples', () => {
  const unavailable = privateRepairUnavailableForJob({
    failureCount: 3,
    savedFiles: [],
    failures: [
      {
        index: 1,
        chatId: 'aaaaaaaaaaaa',
        title: 'A',
        code: 'bridge_private_read_failed',
        error: 'falha A',
      },
      {
        index: 2,
        chatId: 'bbbbbbbbbbbb',
        title: 'B',
        code: 'bridge_private_read_failed',
        error: 'falha B',
      },
      {
        index: 3,
        chatId: 'cccccccccccc',
        title: 'C',
        code: 'gemini_private_protocol_failed',
        error: 'falha C',
      },
    ],
  });

  assert.equal(unavailable?.code, 'gemini_private_api_repair_failed');
  assert.deepEqual(unavailable?.failureCodeCounts, {
    bridge_private_read_failed: 2,
    gemini_private_protocol_failed: 1,
  });
  assert.deepEqual(
    unavailable?.failureSamples?.map((failure) => failure.chatId),
    ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'],
  );
});

test('fix-vault private repair delegates to the unified private export workflow', () => {
  const fixVaultSource = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'fix-vault-runner.ts'),
    'utf-8',
  );
  const exportSource = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'private-api-selected-export.ts'),
    'utf-8',
  );
  const bridgeMode = exportSource.indexOf('const useBridgePrivateRead = shouldAttemptBridgePrivateExport');
  const browserBackgroundCall = exportSource.indexOf('runtimeDeps.runBrowserBackgroundReadChat({');
  const pythonReadCall = exportSource.indexOf('runtimeDeps.runReadChat({');
  const pythonBootstrapGate = exportSource.indexOf('if (!useBridgePrivateRead)');
  const pythonCall = exportSource.indexOf('const bootstrapResult = await runtimeDeps.bootstrapPythonSidecar');
  const privateRepairSource = fixVaultSource.slice(
    fixVaultSource.indexOf('const runPrivateApiRepair'),
    fixVaultSource.indexOf('export const runFixVaultCommand'),
  );

  assert.match(fixVaultSource, /runPrivateApiSelectedExport\(\s*\{/);
  assert.match(fixVaultSource, /buildFixVaultPrivateRepairExportOptions\(parsed\.flags\)/);
  assert.match(privateRepairSource, /recoverBrowserBackgroundSession/);
  assert.doesNotMatch(privateRepairSource, /wakeBrowser: parsed\.flags\.wakeBrowser/);
  assert.doesNotMatch(privateRepairSource, /allowReload: parsed\.flags\.allowReload/);
  assert.doesNotMatch(privateRepairSource, /openIfMissing: parsed\.flags\.openIfMissing/);
  assert.doesNotMatch(privateRepairSource, /activateTab: parsed\.flags\.activateTab/);
  const preparePrivateRepair = fixVaultSource.indexOf('await preparePrivateApiRepair?.()');
  const unifiedPrivateExport = fixVaultSource.indexOf('runPrivateApiSelectedExport(');
  assert.ok(preparePrivateRepair > 0, 'fix-vault deve chamar o preflight do reparo privado');
  assert.ok(
    preparePrivateRepair < unifiedPrivateExport,
    'fix-vault precisa preparar a bridge antes do reparo privado unificado',
  );
  const cliSource = readFileSync(resolve(import.meta.dirname, '..', 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const privatePreflightSource = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'cli', 'fix-vault-private-preflight.ts'),
    'utf-8',
  );
  const fixVaultBlock =
    cliSource.match(/const runFixVault = async \(parsed, streams = \{\}\) => \{[\s\S]*?\n\};\n\nconst runMetadata/)?.[0] ||
    '';
  assert.match(fixVaultBlock, /createFixVaultBrowserPrivateSessionPreflight/);
  assert.match(privatePreflightSource, /ensureBridgeAvailable\(flags, ui\)/);
  assert.doesNotMatch(
    fixVaultBlock,
    /ensureReadyForExport/,
    'fix-vault private repair deve permitir native broker\/service worker sem content client pronto',
  );
  assert.ok(bridgeMode > 0, 'export privado deve decidir modo bridge/background');
  assert.ok(browserBackgroundCall > 0, 'export privado deve ler pelo browser/background');
  assert.ok(pythonCall > 0, 'export privado ainda deve manter fallback Python interno');
  assert.ok(pythonBootstrapGate > 0, 'bootstrap Python deve ser pulado no modo bridge');
  assert.ok(
    browserBackgroundCall < pythonReadCall,
    'export privado deve tentar browser/background antes do read Python',
  );
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

test('fix-vault transforma falha de preflight privado em relatório acionável', async () => {
  const root = resolve(tmpdir(), `gme-fix-vault-private-preflight-${process.pid}-${Date.now()}`);
  const vault = join(root, 'vault');
  const report = join(root, 'fix-vault-report.json');
  const metadataRan = join(root, 'metadata-ran');
  const repairScript = join(root, 'repair.mjs');
  const metadataScript = join(root, 'metadata.mjs');
  mkdirSync(vault, { recursive: true });
  const chatPath = join(vault, 'aaaaaaaaaaaa.md');
  writeFileSync(
    chatPath,
    [
      '---',
      'chat_id: aaaaaaaaaaaa',
      'title: "Chat com asset faltando"',
      'url: https://gemini.google.com/app/aaaaaaaaaaaa',
      'tags: [gemini-export]',
      '---',
      '',
      '## 🧑 Usuário',
      '',
      'pergunta',
      '',
      '---',
      '',
      '## 🤖 Gemini',
      '',
      'resposta ![asset faltando](assets/aaaaaaaaaaaa/missing.png)',
      '',
    ].join('\n'),
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
const preliminaryReportPath = join(reportDir, 'preliminary.json');
writeFileSync(preliminaryReportPath, JSON.stringify({ verificationQueueSize: 1, wikiReviewQueueSize: 0 }));
console.log(JSON.stringify({ preliminaryReportPath }));
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
    rawExportDiagnostics: { enabled: true, diagnosed: 1, byCode: { missing_local_asset: 1 } },
    items: [{
      chatId: 'aaaaaaaaaaaa',
      file: 'aaaaaaaaaaaa.md',
      status: 'export_error',
      diagnostic: { status: 'raw_export_suspected', repair: { action: 'reexport_chat' } }
    }]
  }));
  process.exit(2);
}
writeFileSync(${JSON.stringify(metadataRan)}, 'ran');
process.exit(0);
`,
    'utf-8',
  );

  try {
    let stdoutText = '';
    const result = await runFixVaultCommand({
      parsed: {
        flags: {
          bridgeUrl: 'http://127.0.0.1:47283',
          privateApi: true,
          report,
          takeout: join(root, 'Minhaatividade.html'),
          format: 'plain',
        },
        positionals: [vault],
      },
      streams: {
        stdout: {
          write: (chunk) => {
            stdoutText += String(chunk);
            return true;
          },
        },
        stderr: { write: () => true },
      },
      packageRoot: root,
      repairPath: repairScript,
      metadataPath: metadataScript,
      preparePrivateApiRepair: async () => {
        const err = new Error('Abra o Gemini no navegador logado e aguarde a extensao conectar.');
        err.code = 'browser_session_not_connected';
        err.nextAction = 'Recarregue uma aba Gemini logada e rode fix-vault novamente.';
        throw err;
      },
    });

    const combined = JSON.parse(readFileSync(report, 'utf-8'));
    assert.equal(result.exitCode, 1);
    assert.equal(combined.steps[2].status, 'failed');
    assert.equal(combined.summary.webRepair.unavailable?.code, 'browser_session_not_connected');
    assert.match(
      combined.summary.webRepair.unavailable?.message || '',
      /Abra o Gemini no navegador logado/,
    );
    assert.match(stdoutText, /Indexando vault com MarkdownDB/);
    assert.equal(combined.steps[3].status, 'blocked');
    assert.equal(existsSync(metadataRan), false);
    assert.match(stdoutText, /Datas bloqueadas ate o reparo terminar/);
    assert.doesNotMatch(stdoutText, /Atualizando datas do vault/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
