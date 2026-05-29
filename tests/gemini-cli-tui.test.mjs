import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { main } from '../bin/gemini-md-export.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;

test('CLI usa timeout honesto e status visivel para readiness lenta', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  assert.match(source, /const DEFAULT_READY_REQUEST_TIMEOUT_MS = 60_000/);
  assert.match(source, /process\.env\.GEMINI_MD_EXPORT_READY_REQUEST_TIMEOUT_MS/);
  assert.match(source, /Ainda verificando Gemini Web\.\.\. \$\{formatDuration\(elapsedMs\)\} decorridos; sem fallback MCP/);
});

const captureStream = ({ isTTY = false, columns = 88 } = {}) => {
  let text = '';
  return {
    isTTY,
    columns,
    write(chunk) {
      text += String(chunk);
      return true;
    },
    text: () => text,
  };
};

const withServer = async (handler, fn) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;
    let jsonBody = null;
    try {
      jsonBody = body ? JSON.parse(body) : null;
    } catch {
      jsonBody = null;
    }
    const requestRecord = {
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      body,
      jsonBody,
    };
    requests.push(requestRecord);
    handler(req, res, url, requestRecord);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const withEnv = async (patch, fn) => {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const writeExecutableScript = (path, source) => {
  writeFileSync(path, source, { encoding: 'utf-8', mode: 0o755 });
};

const getFreePort = async () => {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

const waitForHealth = async (bridgeUrl, timeoutMs = 4000) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${bridgeUrl}/healthz`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(80);
  }
  throw lastError || new Error(`healthz nao ficou pronto em ${timeoutMs}ms`);
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const waitForChildExit = async (child, timeoutMs = 3000) => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(timeoutMs).then(() => false),
  ]);
};

const spawnFakeOldBridge = async (port, healthPatch = {}) => {
  const code = `
    import { createServer } from 'node:http';
    const port = Number(process.env.GME_FAKE_BRIDGE_PORT);
    const healthPatch = JSON.parse(process.env.GME_FAKE_BRIDGE_HEALTH_PATCH || '{}');
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          name: 'gemini-md-export',
          version: '0.0.1',
          protocolVersion: 2,
          bridgeRole: 'primary',
          pid: process.pid,
          process: {
            pid: process.pid,
            ppid: process.ppid,
            argv: [process.execPath, process.cwd() + '/src/mcp-server.js'],
            root: process.cwd(),
            cwd: process.cwd()
          },
          ...healthPatch
        }));
        return;
      }
      if (url.pathname === '/agent/ready') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'old bridge should not be used' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found: ' + url.pathname }));
    });
    server.listen(port, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GME_FAKE_BRIDGE_PORT: String(port),
      GME_FAKE_BRIDGE_HEALTH_PATCH: JSON.stringify(healthPatch),
    },
  });
  await waitForHealth(`http://127.0.0.1:${port}`);
  return child;
};

const runningJob = {
  jobId: 'job-1',
  status: 'running',
  phase: 'exporting',
  requested: 2,
  completed: 1,
  loadedCount: 2,
  progressMessage: 'Baixando conversas novas (2/2): ECG',
  reportFile: '/tmp/gme-report.json',
  current: { title: 'ECG', chatId: 'abc123abc123' },
  decisionSummary: {
    fullHistoryRequested: true,
    fullHistoryVerified: false,
    totals: {
      geminiWebSeen: 2,
      existingInVault: 1,
      missingInVault: 1,
      downloadedNow: 1,
      skipped: 1,
      mediaWarnings: 0,
      failed: 0,
    },
  },
};

const completedJob = {
  ...runningJob,
  status: 'completed',
  phase: 'writing-report',
  completed: 2,
  progressMessage: 'Vault atualizado. 1 conversa nova salva.',
  decisionSummary: {
    ...runningJob.decisionSummary,
    fullHistoryVerified: true,
    reportFile: '/tmp/gme-report.json',
    nextAction: { code: 'done', message: 'Importação concluída.', command: null },
  },
};

const completedWithErrorsJob = {
  ...runningJob,
  status: 'completed_with_errors',
  phase: 'done',
  requested: 33,
  completed: 33,
  loadedCount: 33,
  successCount: 32,
  failureCount: 1,
  progressMessage: 'Não consegui confirmar o fim do histórico.',
  loadMoreTimedOut: true,
  loadMoreRoundsCompleted: 1,
  failures: [
    {
      index: 24,
      chatId: '3c1d9107303b754e',
      title: 'SurrealDB Roadmap',
      error: 'Esta aba do Gemini já está ocupada com outro comando pesado.',
    },
  ],
  decisionSummary: {
    fullHistoryRequested: true,
    fullHistoryVerified: false,
    reportFile: '/tmp/gme-report.json',
    nextAction: { code: 'resume_available', message: 'Retome pelo relatório.', command: null },
    totals: {
      geminiWebSeen: 33,
      existingInVault: 0,
      missingInVault: 1,
      downloadedNow: 32,
      skipped: 0,
      mediaWarnings: 0,
      failed: 1,
    },
  },
};

const mockSyncServer = ({ completedImmediately = false } = {}) => {
  let statusCalls = 0;
  return (req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/sync-vault') {
      sendJson(res, 202, completedImmediately ? completedJob : runningJob);
      return;
    }
    if (
      url.pathname === '/agent/export-recent-chats' ||
      url.pathname === '/agent/export-missing-chats' ||
      url.pathname === '/agent/reexport-chats' ||
      url.pathname === '/agent/export-notebook'
    ) {
      sendJson(res, 202, completedImmediately ? completedJob : runningJob);
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      statusCalls += 1;
      sendJson(res, 200, statusCalls >= 1 ? completedJob : runningJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  };
};

test('CLI --help na posicao inicial sai com sucesso', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(['--help'], { stdout, stderr });

  assert.equal(run.exitCode, 0);
  assert.match(stdout.text(), /Uso:/);
  assert.match(stdout.text(), /Exit codes:/);
  assert.match(stdout.text(), /--json/);
  assert.match(stdout.text(), /export missing/);
  assert.match(stdout.text(), /export selected/);
  assert.match(stdout.text(), /export reexport/);
  assert.match(stdout.text(), /export notebook/);
  assert.match(stdout.text(), /fix-vault/);
  assert.doesNotMatch(stdout.text(), /repair-vault/);
  assert.doesNotMatch(stdout.text(), /metadata backfill/);
  assert.equal(stderr.text(), '');
});

test('CLI --version imprime versao sem tocar na bridge', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(['--version'], { stdout, stderr });

  assert.equal(run.exitCode, 0);
  assert.match(stdout.text(), /^gemini-md-export \d+\.\d+\.\d+/);
  assert.equal(stderr.text(), '');
});

test('CLI fix-vault expõe ajuda pública única e executa backfill com Takeout', async () => {
  const helpStdout = captureStream();
  const help = await main(['help', 'fix-vault'], {
    stdout: helpStdout,
    stderr: captureStream(),
  });
  assert.equal(help.exitCode, 0);
  assert.match(helpStdout.text(), /fix-vault/);
  assert.match(helpStdout.text(), /--use-my-activity/);
  assert.match(helpStdout.text(), /--takeout/);
  assert.doesNotMatch(helpStdout.text(), /repair-vault/);

  const vault = mkdtempSync(resolve(tmpdir(), 'gme-cli-fix-vault-'));
  const reportPath = resolve(vault, 'fix-report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const chatPath = resolve(vault, 'b8e7c075effe9457.md');
  writeFileSync(
    chatPath,
    [
      '---',
      'chat_id: b8e7c075effe9457',
      'url: https://gemini.google.com/app/b8e7c075effe9457',
      'exported_at: 2026-05-17T18:55:08.245Z',
      'source: gemini-web',
      'tags: [gemini-export]',
      '---',
      '',
      '## 🧑 Usuário',
      '',
      'Explique o mecanismo dos ISRS com detalhes clinicos',
      '',
      '---',
      '',
      '## 🤖 Gemini',
      '',
      'Os ISRS bloqueiam o transportador de serotonina e aumentam serotonina sinaptica.',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    takeoutPath,
    [
      '<html><body>',
      '<div class="outer-cell">',
      '<div>Gemini Apps</div>',
      '<div>Prompted&nbsp;Explique o mecanismo dos ISRS com detalhes clinicos</div>',
      '<div>Os ISRS bloqueiam o transportador de serotonina e aumentam serotonina sinaptica.</div>',
      '<div>10 de mai. de 2026, 06:46:09 BRT</div>',
      '</div>',
      '</body></html>',
    ].join('\n'),
    'utf-8',
  );

  try {
    const stdout = captureStream();
    const run = await main(
      ['fix-vault', vault, '--takeout', takeoutPath, '--report', reportPath, '--no-open-if-missing'],
      {
      stdout,
      stderr: captureStream(),
      },
    );
    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Fix vault/);
    assert.match(stdout.text(), /My Activity/);
    assert.doesNotMatch(stdout.text(), /preliminaryReportPath/);
    const updated = readFileSync(chatPath, 'utf-8');
    assert.match(updated, /^---\ntype: gemini_chat\n/);
    assert.match(updated, /\ndate_created: 2026-05-10T09:46:09Z\n/);
    assert.match(updated, /\ndate_last_message: 2026-05-10T09:46:09Z\n/);
    assert.match(updated, /\ndate_exported: 2026-05-17T18:55:08Z\n/);
    assert.match(updated, /\nturn_count: 1\n/);
    assert.equal(existsSync(reportPath), true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.schema, 'gemini-md-export.fix-vault-report.v1');
    assert.equal(report.summary.metadata.matched, 1);
    assert.equal(report.summary.repair.takeoutEvidence.matched, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI fix-vault bloqueia relatório quando datas ficam pendentes', async () => {
  const vault = mkdtempSync(resolve(tmpdir(), 'gme-cli-fix-vault-blocked-'));
  const reportPath = resolve(vault, 'fix-report.json');
  const chatPath = resolve(vault, 'bbbbbbbbbbbb.md');
  writeFileSync(
    chatPath,
    [
      '---',
      'chat_id: bbbbbbbbbbbb',
      'url: https://gemini.google.com/app/bbbbbbbbbbbb',
      'exported_at: 2026-05-17T18:55:08.245Z',
      'source: gemini-web',
      'tags: [gemini-export]',
      '---',
      '',
      '## 🧑 Usuário',
      '',
      'Conversa sem evidencia externa',
      '',
      '---',
      '',
      '## 🤖 Gemini',
      '',
      'Resposta sem data confiavel.',
      '',
    ].join('\n'),
    'utf-8',
  );

  try {
    const stdout = captureStream();
    const run = await main(
      ['fix-vault', vault, '--report', reportPath, '--no-my-activity', '--no-open-if-missing'],
      {
        stdout,
        stderr: captureStream(),
      },
    );

    assert.equal(run.exitCode, 2);
    assert.match(stdout.text(), /0\/1 com datas completas/);
    assert.match(stdout.text(), /Fluxo bloqueado/);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.ok, false);
    assert.equal(report.steps.find((step) => step.name === 'metadata-backfill').status, 'blocked');
    assert.equal(report.summary.metadata.contractStatus, 'blocked');
    assert.equal(report.summary.metadata.unresolved, 1);
    assert.equal(report.warnings[0].code, 'metadata_unresolved');
    assert.deepEqual(report.warnings[0].unresolvedChatIds, ['bbbbbbbbbbbb']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI fix-vault com Takeout diagnostica, repara e só depois escreve datas', async () => {
  const vault = mkdtempSync(resolve(tmpdir(), 'gme-cli-fix-vault-phases-'));
  const reportPath = resolve(vault, 'fix-report.json');
  const takeoutPath = resolve(vault, 'Minhaatividade.html');
  const repairScript = resolve(vault, 'fake-repair.mjs');
  const metadataScript = resolve(vault, 'fake-metadata.mjs');
  const privateApiRunner = resolve(vault, 'fake-private-api.mjs');
  const eventsPath = resolve(vault, 'events.jsonl');
  const chatPath = resolve(vault, 'cccccccccccc.md');
  writeFileSync(
    chatPath,
    [
      '---',
      'chat_id: cccccccccccc',
      'url: https://gemini.google.com/app/cccccccccccc',
      'tags: [gemini-export]',
      '---',
      '',
      '## 🧑 Usuário',
      '',
      'raw suspeito',
      '',
      '---',
      '',
      '## 🤖 Gemini',
      '',
      'resposta raw suspeita ![imagem faltando](assets/cccccccccccc/missing.png)',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(takeoutPath, '<html><body>Gemini Apps</body></html>', 'utf-8');

  writeExecutableScript(
    repairScript,
    `
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const delayMs = Number(process.env.GME_FAKE_DELAY_MS || 0);
if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
const eventsPath = process.env.GME_FAKE_EVENTS;
const args = process.argv.slice(2);
const reportDir = args[args.indexOf('--report-dir') + 1];
const dryRun = args.includes('--dry-run');
const paths = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--path') paths.push(args[index + 1]);
}
appendFileSync(eventsPath, JSON.stringify({ tool: 'repair', dryRun, paths }) + '\\n');
mkdirSync(reportDir, { recursive: true });
const preliminaryReportPath = resolve(reportDir, 'preliminary.json');
writeFileSync(preliminaryReportPath, JSON.stringify({
  verificationQueueSize: 1,
  wikiReviewQueueSize: 0,
  takeoutEvidence: { summary: { enabled: true, matched: 0, unmatched: 1 } }
}, null, 2));
if (!dryRun) {
  const marker = resolve(dirname(eventsPath), 'repair-done');
  writeFileSync(marker, 'ok');
}
process.stdout.write(JSON.stringify({ ok: true, dryRun, preliminaryReportPath }) + '\\n');
`,
  );

  writeExecutableScript(
    metadataScript,
    `
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const delayMs = Number(process.env.GME_FAKE_DELAY_MS || 0);
if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
const eventsPath = process.env.GME_FAKE_EVENTS;
const args = process.argv.slice(2);
const vault = args[0];
const reportPath = args[args.indexOf('--report') + 1];
const diagnoseOnly = args.includes('--diagnose-only');
appendFileSync(eventsPath, JSON.stringify({ tool: 'metadata', diagnoseOnly, repairDone: existsSync(resolve(dirname(eventsPath), 'repair-done')) }) + '\\n');
mkdirSync(dirname(reportPath), { recursive: true });
const blocked = {
  schema: 'gemini-md-export.metadata-backfill-report.v1',
  ok: false,
  diagnoseOnly,
  contract: {
    ok: false,
    status: 'blocked',
    code: 'raw_export_suspected',
    message: '1 chat parece ter export raw inconsistente.',
    unresolvedChatIds: ['cccccccccccc']
  },
  summary: {
    totalChats: 1,
    filesRewritten: 0,
    datesMatched: 0,
    matched: 0,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 1,
    sourceGaps: 0,
    updated: 0,
    complete: false,
    contractStatus: 'blocked'
  },
  rawExportDiagnostics: {
    enabled: true,
    diagnosed: 1,
    byCode: { takeout_no_evidence_for_raw_chat: 1 }
  },
  items: [{
    chatId: 'cccccccccccc',
    file: 'cccccccccccc.md',
    status: 'export_error',
    dateCreated: null,
    dateLastMessage: null,
    diagnostic: { status: 'raw_export_suspected', repair: { action: 'reexport_chat' } }
  }]
};
const complete = {
  schema: 'gemini-md-export.metadata-backfill-report.v1',
  ok: true,
  diagnoseOnly,
  contract: { ok: true, status: 'complete', code: null, message: 'Todos os chats têm datas completas.', unresolvedChatIds: [] },
  summary: {
    totalChats: 1,
    filesRewritten: 1,
    datesMatched: 1,
    matched: 1,
    partial: 0,
    unresolved: 0,
    ambiguous: 0,
    exportErrors: 0,
    sourceGaps: 0,
    updated: 1,
    complete: true,
    contractStatus: 'complete'
  },
  rawExportDiagnostics: { enabled: true, diagnosed: 0, byCode: {} },
  items: [{ chatId: 'cccccccccccc', file: 'cccccccccccc.md', status: 'matched', dateCreated: '2026-05-10T09:46:09Z', dateLastMessage: '2026-05-10T09:46:09Z' }]
};
writeFileSync(reportPath, JSON.stringify(diagnoseOnly ? blocked : complete, null, 2));
process.stdout.write(diagnoseOnly ? 'Backfill metadata: 0 arquivo(s) normalizado(s); 0/1 com datas completas; 1 export raw suspeito(s).\\n' : 'Backfill metadata: 1 arquivo(s) normalizado(s); 1/1 com datas completas; 0 pendente(s).\\n');
if (!diagnoseOnly && !existsSync(resolve(dirname(eventsPath), 'repair-done'))) process.exitCode = 9;
else if (diagnoseOnly) process.exitCode = 2;
`,
  );

  writeExecutableScript(
    privateApiRunner,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const eventsPath = process.env.GME_FAKE_EVENTS;
const request = JSON.parse(readFileSync(0, 'utf-8'));
const chatId = String(request.chat_id || '').replace(/^c_/, '');
const assetsRelDir = request.assets_rel_dir || 'assets/' + chatId;
const assetPath = resolve(request.assets_dir, 'turn-0001-asset-00.png');
mkdirSync(dirname(assetPath), { recursive: true });
writeFileSync(assetPath, Buffer.from([1, 2, 3, 4]));
writeFileSync(resolve(dirname(eventsPath), 'repair-done'), 'ok');
appendFileSync(eventsPath, JSON.stringify({ tool: 'private-api', chatId, assetsRelDir }) + '\\n');
process.stdout.write(JSON.stringify({
  ok: true,
  chat_id: chatId,
  private_chat_id: 'c_' + chatId,
  title: 'Pergunta correta reexportada pelo chatId',
  date_created: '2026-05-10T09:46:09Z',
  date_last_message: '2026-05-10T09:46:09Z',
  turns: [
    { role: 'user', markdown: 'Pergunta correta reexportada pelo chatId', created_at: '2026-05-10T09:46:09Z' },
    {
      role: 'assistant',
      markdown: 'Resposta correta reexportada pelo chatId.',
      created_at: '2026-05-10T09:46:09Z',
      attachments: [{ kind: 'image', label: 'Imagem reexportada', url: assetsRelDir + '/turn-0001-asset-00.png', asset_id: 'turn-0001-asset-00' }]
    }
  ],
  asset_receipts: [{
    asset_id: 'turn-0001-asset-00',
    status: 'downloaded',
    files: [{
      path: assetPath,
      relative_path: assetsRelDir + '/turn-0001-asset-00.png',
      content_type: 'image/png',
      bytes: 4,
      sha256: 'sha256-fixture'
    }]
  }],
  warnings: []
}) + '\\n');
`,
  );

  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_REPAIR_SCRIPT: repairScript,
        GEMINI_MD_EXPORT_METADATA_SCRIPT: metadataScript,
        GME_GEMINI_WEBAPI_RUNNER: privateApiRunner,
        GEMINI_MD_EXPORT_PROGRESS_TICK_MS: '10',
        GME_FAKE_DELAY_MS: '350',
        GME_FAKE_EVENTS: eventsPath,
      },
      async () => {
        const stdout = captureStream({ isTTY: true });
        const run = await main(
          [
            'fix-vault',
            vault,
            '--takeout',
            takeoutPath,
            '--report',
            reportPath,
            '--no-open-if-missing',
            '--tui',
          ],
          { stdout, stderr: captureStream() },
        );
        assert.equal(run.exitCode, 0);
        assert.match(stdout.text(), /Diagnosticando Takeout e chats do vault/);
        assert.match(stdout.text(), /Reparando exports e assets pela API privada/);
        assert.match(stdout.text(), /Atualizando datas do vault/);
        assert.match(stdout.text(), /Validando vault atualizado/);
        assert.match(stdout.text(), /em andamento/);
        assert.match(stdout.text(), /▕/);
        assert.match(stdout.text(), /5\/5 Fluxo concluido/);
      },
    );

    const events = readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) =>
        event.tool === 'metadata'
          ? `${event.tool}:${event.diagnoseOnly}`
          : event.tool === 'repair'
            ? `${event.tool}:${event.dryRun}`
            : `${event.tool}:${event.chatId}`,
      ),
      ['repair:true', 'metadata:true', 'private-api:cccccccccccc', 'metadata:false'],
    );
    assert.equal(events[2].assetsRelDir, 'assets/cccccccccccc');
    assert.equal(events[3].repairDone, true);
    assert.match(readFileSync(chatPath, 'utf-8'), /Resposta correta reexportada pelo chatId/);
    assert.deepEqual(
      [...readFileSync(resolve(vault, 'assets/cccccccccccc/turn-0001-asset-00.png'))],
      [1, 2, 3, 4],
    );

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.steps.map((step) => step.name),
      ['repair-audit', 'metadata-diagnosis', 'web-repair', 'metadata-backfill', 'vault-validation'],
    );
    assert.equal(report.summary.metadata.matched, 1);
    assert.equal(report.summary.diagnosis.exportErrors, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('CLI expõe ajuda contextual para comandos e subcomandos', async () => {
  const syncStdout = captureStream();
  const jobStdout = captureStream();

  assert.equal((await main(['sync', '--help'], { stdout: syncStdout })).exitCode, 0);
  assert.match(syncStdout.text(), /gemini-md-export sync/);
  assert.match(syncStdout.text(), /--resume-report-file/);
  assert.match(syncStdout.text(), /--takeout/);
  assert.match(syncStdout.text(), /--no-my-activity/);
  assert.match(syncStdout.text(), /Contrato para agentes/);

  assert.equal((await main(['help', 'job', 'status'], { stdout: jobStdout })).exitCode, 0);
  assert.match(jobStdout.text(), /gemini-md-export job status/);
  assert.match(jobStdout.text(), /running/);
  assert.match(jobStdout.text(), /--jsonl/);

  const jobListStdout = captureStream();
  assert.equal((await main(['help', 'job', 'list'], { stdout: jobListStdout })).exitCode, 0);
  assert.match(jobListStdout.text(), /gemini-md-export job list/);
  assert.match(jobListStdout.text(), /--active/);

  const exportStdout = captureStream();
  assert.equal((await main(['export', 'missing', '--help'], { stdout: exportStdout })).exitCode, 0);
  assert.match(exportStdout.text(), /gemini-md-export export missing/);
  assert.match(exportStdout.text(), /--max-chats/);
  assert.match(exportStdout.text(), /--takeout/);
  assert.match(exportStdout.text(), /--no-my-activity/);

  const selectedStdout = captureStream();
  assert.equal((await main(['export', 'selected', '--help'], { stdout: selectedStdout })).exitCode, 0);
  assert.match(selectedStdout.text(), /gemini-md-export export selected/);
  assert.match(selectedStdout.text(), /--chat-id/);
  assert.match(selectedStdout.text(), /--selection-file/);
  assert.match(selectedStdout.text(), /--expected-count/);
  assert.doesNotMatch(selectedStdout.text(), /gemini-md-export export reexport/);

  const reexportStdout = captureStream();
  assert.equal((await main(['export', 'reexport', '--help'], { stdout: reexportStdout })).exitCode, 0);
  assert.match(reexportStdout.text(), /Legado: use export selected/);

  const tabsStdout = captureStream();
  assert.equal((await main(['tabs', '--help'], { stdout: tabsStdout })).exitCode, 0);
  assert.match(tabsStdout.text(), /gemini-md-export tabs/);
  assert.match(tabsStdout.text(), /tabs claim/);

  const chatsStdout = captureStream();
  assert.equal((await main(['chats', '--help'], { stdout: chatsStdout })).exitCode, 0);
  assert.match(chatsStdout.text(), /gemini-md-export chats/);
  assert.match(chatsStdout.text(), /chats count/);
  assert.match(chatsStdout.text(), /chats list/);
  assert.match(chatsStdout.text(), /--save-selection/);
  assert.match(chatsStdout.text(), /Total confirmado/);
});

test('CLI deixa My Activity no default do runtime para export e sync', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const parseDefaults = source.match(/flags:\s*\{[\s\S]*?version: firstArgIsVersion,[\s\S]*?\}/)?.[0] || '';
  const startSyncStart = source.indexOf('const startSyncJob = async');
  const startExportStart = source.indexOf('const startExportJob = async');
  const fetchJobStatusStart = source.indexOf('const fetchJobStatus');
  const startSyncBlock =
    startSyncStart >= 0 && startExportStart > startSyncStart
      ? source.slice(startSyncStart, startExportStart)
      : '';
  const startExportBlock =
    startExportStart >= 0 && fetchJobStatusStart > startExportStart
      ? source.slice(startExportStart, fetchJobStatusStart)
      : '';

  assert.doesNotMatch(parseDefaults, /useMyActivity:\s*false/);
  assert.match(startSyncBlock, /useMyActivity:\s*flags\.noMyActivity \? false : flags\.useMyActivity/);
  assert.match(startExportBlock, /useMyActivity:\s*flags\.noMyActivity \? false : flags\.useMyActivity/);
});

test('CLI doctor --plain nao imprime RESULT_JSON sem pedido explicito', async () => {
  const port = await getFreePort();
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(
    [
      'doctor',
      '--bridge-url',
      `http://127.0.0.1:${port}`,
      '--no-start-bridge',
      '--plain',
    ],
    { stdout, stderr },
  );

  assert.equal(run.exitCode, 3);
  assert.match(stdout.text(), /NAO PRONTO:/);
  assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
});

test('CLI tabs list usa endpoint proprio sem preflight gemini_ready', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs') {
      sendJson(res, 200, {
        ok: true,
        action: 'list',
        connectedTabCount: 1,
        connectedClientCount: 1,
        tabs: [
          {
            index: 1,
            clientId: 'client-1',
            tabId: 123,
            page: {
              url: 'https://gemini.google.com/app/abc123abc123',
              title: 'Chat - Gemini',
              chatId: 'abc123abc123',
              kind: 'chat',
              listedConversationCount: 42,
            },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['tabs', 'list', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });
    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /1 aba\(s\) Gemini conectada\(s\)/);
    assert.match(stdout.text(), /clientId=client-1/);
    assert.match(stdout.text(), /conversas_visiveis=42/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    assert.equal(run.result.tabs[0].clientId, 'client-1');
    assert.equal(run.result.tabs[0].listedConversationCount, 42);
    assert.equal(stderr.text(), '');
    assert.equal(requests.some((item) => item.pathname === '/agent/ready'), false);
  });
});

test('CLI encaminha cdp-url para o broker de abas sem transformar CDP em scraper', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs') {
      sendJson(res, 200, {
        ok: true,
        action: 'list',
        controlPlane: 'cdp',
        cdp: { attempted: true, controlPlane: 'cdp', geminiTargets: [] },
        connectedTabCount: 0,
        connectedClientCount: 0,
        tabs: [],
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const run = await main(
      [
        'tabs',
        'list',
        '--bridge-url',
        bridgeUrl,
        '--cdp-url',
        'http://127.0.0.1:9222',
        '--plain',
      ],
      { stdout },
    );

    assert.equal(run.exitCode, 0);
    const tabsRequest = requests.find((request) => request.pathname === '/agent/tabs');
    assert.ok(tabsRequest);
    assert.equal(tabsRequest.searchParams.get('cdpUrl'), 'http://127.0.0.1:9222');
    assert.equal(tabsRequest.searchParams.get('controlPlane'), 'cdp');
  });
});

test('CLI recusa bridge antiga com --no-start-bridge antes de chamar readiness', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        name: 'gemini-md-export',
        version: '0.0.1',
        protocolVersion: 2,
        pid: 999999,
        process: {
          pid: 999999,
          argv: ['/usr/local/bin/node', '/tmp/gemini-md-export/src/mcp-server.js'],
          root: '/tmp/gemini-md-export',
        },
      });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 500, { error: 'ready da bridge antiga nao deveria ser chamado' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () =>
        main(
          ['chats', 'count', '--bridge-url', bridgeUrl, '--no-start-bridge', '--plain'],
          { stdout, stderr },
        ),
      /Bridge local desatualizada.*0\.0\.1/s,
    );
    assert.equal(requests.some((item) => item.pathname === '/agent/ready'), false);
    assert.match(stdout.text(), /Conectando na bridge/);
    assert.equal(stderr.text(), '');
  });
});

test('CLI recusa encerrar dono de porta que nao e gemini-md-export', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        name: 'outro-servico',
        version: '9.9.9',
        protocolVersion: 2,
        pid: 999998,
        process: {
          pid: 999998,
          argv: ['/usr/bin/python3', '/tmp/server.py'],
          root: '/tmp',
        },
      });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 500, { error: 'ready de outro servico nao deveria ser chamado' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    await assert.rejects(
      () => main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], { stdout }),
      /outro-servico/,
    );
    assert.equal(requests.some((item) => item.pathname === '/agent/ready'), false);
  });
});

test('CLI substitui bridge antiga segura por bridge atual antes de seguir', async () => {
  const port = await getFreePort();
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const oldBridge = await spawnFakeOldBridge(port);
  const stdout = captureStream();
  const stderr = captureStream();
  let freshBridgePid = null;

  try {
    const run = await main(
      [
        'doctor',
        '--bridge-url',
        bridgeUrl,
        '--json',
        '--no-wake',
        '--no-self-heal',
        '--no-reload',
        '--ready-wait-ms',
        '0',
        '--bridge-start-wait-ms',
        '10000',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.bridge.ok, true);
    assert.equal(parsed.bridge.version, PACKAGE_VERSION);
    assert.notEqual(parsed.bridge.pid, oldBridge.pid);
    assert.equal(stderr.text(), '');
    assert.equal(await waitForChildExit(oldBridge), true);

    const health = await waitForHealth(bridgeUrl);
    freshBridgePid = health.pid;
    assert.equal(health.version, PACKAGE_VERSION);
    assert.equal(health.bridgeOnly, true);
  } finally {
    if (freshBridgePid) {
      try {
        process.kill(freshBridgePid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
    if (isPidAlive(oldBridge.pid)) {
      try {
        process.kill(oldBridge.pid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
    await sleep(150);
  }
});

test('CLI substitui bridge com arquivos instalados mais novos que o processo', async () => {
  const port = await getFreePort();
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const oldBridge = await spawnFakeOldBridge(port, {
    version: PACKAGE_VERSION,
    protocolVersion: 2,
    startedAt: '2020-01-01T00:00:00.000Z',
  });
  const stdout = captureStream();
  const stderr = captureStream();
  let freshBridgePid = null;

  try {
    const run = await main(
      [
        'doctor',
        '--bridge-url',
        bridgeUrl,
        '--json',
        '--no-wake',
        '--no-self-heal',
        '--no-reload',
        '--ready-wait-ms',
        '0',
        '--bridge-start-wait-ms',
        '10000',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.bridge.ok, true);
    assert.equal(parsed.bridge.version, PACKAGE_VERSION);
    assert.notEqual(parsed.bridge.pid, oldBridge.pid);
    assert.equal(stderr.text(), '');
    assert.equal(await waitForChildExit(oldBridge), true);

    const health = await waitForHealth(bridgeUrl);
    freshBridgePid = health.pid;
    assert.equal(health.version, PACKAGE_VERSION);
    assert.equal(health.bridgeOnly, true);
  } finally {
    if (freshBridgePid) {
      try {
        process.kill(freshBridgePid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
    if (isPidAlive(oldBridge.pid)) {
      try {
        process.kill(oldBridge.pid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
    await sleep(150);
  }
});

test('CLI nao substitui bridge antiga enquanto ha export ativo', async () => {
  const port = await getFreePort();
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const oldBridge = await spawnFakeOldBridge(port, {
    idleLifecycle: {
      activeJobCount: 1,
      blockedBy: ['active_job'],
    },
  });
  const stdout = captureStream();
  const stderr = captureStream();

  try {
    await assert.rejects(
      () =>
        main(
          [
            'chats',
            'count',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--no-wake',
            '--bridge-start-wait-ms',
            '1000',
          ],
          { stdout, stderr },
        ),
      /tem 1 export ativo.*Nao vou reiniciar/s,
    );
    assert.equal(isPidAlive(oldBridge.pid), true);
    const health = await waitForHealth(bridgeUrl);
    assert.equal(health.pid, oldBridge.pid);
    assert.doesNotMatch(stdout.text(), /Reiniciando bridge local/);
    assert.equal(stderr.text(), '');
  } finally {
    if (isPidAlive(oldBridge.pid)) {
      try {
        process.kill(oldBridge.pid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
    await sleep(150);
  }
});

test('CLI chats count carrega ate o fim sem despejar lista no chat', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      assert.equal(url.searchParams.get('label'), '🔎 Conferindo');
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 203,
        countSource: 'browser_dom_count_match',
        countConfidence: 'dom-counts-agree',
        knownLoadedCount: 203,
        minimumKnownCount: 203,
        pagination: {
          loadedCount: 203,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
          tabId: Number(url.searchParams.get('tabId')),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Bridge conectada/);
    assert.match(stdout.text(), /Buscando o fim da lista/);
    assert.match(stdout.text(), /Total confirmado: 203 chat\(s\)/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    const result = run.result;
    assert.equal(result.totalKnown, true);
    assert.equal(result.totalCount, 203);
    assert.equal(result.countSource, 'browser_dom_count_match');
    assert.equal(result.countConfidence, 'dom-counts-agree');
    assert.equal(result.knownLoadedCount, 203);
    assert.equal(stderr.text(), '');

    const countRequest = requests.find((item) => item.pathname === '/agent/recent-chats');
    assert.equal(countRequest.searchParams.get('countOnly'), 'true');
    assert.equal(countRequest.searchParams.get('untilEnd'), 'true');
    assert.equal(countRequest.searchParams.get('preferActive'), 'true');
    assert.equal(countRequest.searchParams.get('limit'), '1');
    assert.ok(Number(countRequest.searchParams.get('loadMoreTimeoutMs')) >= 899000);
    assert.equal(countRequest.searchParams.get('maxNoGrowthRounds'), '8');
    assert.equal(countRequest.searchParams.get('loadMoreBrowserRounds'), '12');
    assert.equal(countRequest.searchParams.get('loadMoreBrowserTimeoutMs'), '30000');
    assert.equal(countRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(countRequest.searchParams.get('tabId'), '101');
    assert.equal(countRequest.searchParams.get('autoClaim'), 'false');
    assert.equal(countRequest.searchParams.get('autoReleaseClaim'), 'false');
    const claimRequest = requests.find((item) => item.pathname === '/agent/tabs');
    assert.equal(claimRequest.searchParams.get('preferRecent'), 'true');
    assert.equal(claimRequest.searchParams.get('openIfMissing'), 'false');
    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(releaseRequest.searchParams.get('tabId'), '101');
  });
});

test('CLI chats list salva selection manifest com IDs da pagina', async () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'gme-selection-'));
  const selectionFile = resolve(tempDir, 'selection.json');
  try {
    await withServer((req, res, url) => {
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/recent-chats') {
        sendJson(res, 200, {
          ok: true,
          countStatus: 'partial',
          totalKnown: false,
          minimumKnownCount: 13,
          knownLoadedCount: 13,
          pagination: {
            offset: 0,
            limit: 10,
            returned: 10,
            loadedCount: 13,
          },
          conversations: Array.from({ length: 10 }, (_, index) => ({
            index: index + 1,
            chatId: `${String(index + 1).padStart(12, 'a')}abcd`,
            title: `Conversa ${index + 1}`,
            url: `https://gemini.google.com/app/${String(index + 1).padStart(12, 'a')}abcd`,
            source: 'sidebar',
          })),
        });
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl, requests) => {
      const stdout = captureStream();
      const run = await main(
        [
          'chats',
          'list',
          '--limit',
          '10',
          '--save-selection',
          '--selection-file',
          selectionFile,
          '--bridge-url',
          bridgeUrl,
          '--plain',
        ],
        { stdout },
      );

      assert.equal(run.exitCode, 0);
      assert.match(stdout.text(), /10 conversa\(s\) listada\(s\)/);
      assert.match(stdout.text(), /selectionFile:/);
      assert.equal(existsSync(selectionFile), true);
      const manifest = JSON.parse(readFileSync(selectionFile, 'utf-8'));
      assert.equal(manifest.kind, 'gemini-md-export-selection');
      assert.equal(manifest.expectedCount, 10);
      assert.equal(manifest.chatIds.length, 10);
      const listRequest = requests.find((item) => item.pathname === '/agent/recent-chats');
      assert.equal(listRequest.searchParams.get('limit'), '10');
      assert.equal(listRequest.searchParams.get('offset'), '0');
      assert.notEqual(listRequest.searchParams.get('countOnly'), 'true');
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI chats count --result-json reativa RESULT_JSON explicitamente', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--plain', '--result-json'],
      { stdout },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Total confirmado: 277 chat\(s\)/);
    assert.match(stdout.text(), /RESULT_JSON /);
  });
});

test('CLI chats count nao transforma contagem parcial em total', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'incomplete',
        countIsTotal: false,
        totalKnown: false,
        totalCount: null,
        knownLoadedCount: 73,
        minimumKnownCount: 73,
        countWarning: 'Contagem parcial: nao informe como total.',
        loadMoreError: 'Nao consegui confirmar o fim do historico.',
        pagination: {
          loadedCount: 73,
          reachedEnd: false,
          canLoadMore: true,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 1);
    assert.match(stdout.text(), /Contagem parcial: pelo menos 73 chat\(s\)/);
    assert.match(stdout.text(), /Nao consegui confirmar o fim/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    const result = run.result;
    assert.equal(result.totalKnown, false);
    assert.equal(result.totalCount, null);
    assert.equal(result.minimumKnownCount, 73);
    assert.match(result.loadMoreError, /confirmar o fim/);
    assert.match(result.warning, /parcial/);
    assert.equal(stderr.text(), '');
  });
});

test('CLI chats count espera e tenta de novo quando a aba esta ocupada', async () => {
  let countRequests = 0;
  await withEnv({ GEMINI_MD_EXPORT_CLI_STATUS_INTERVAL_MS: '250' }, async () =>
    withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      countRequests += 1;
      if (countRequests === 1) {
        sendJson(res, 200, {
          ok: true,
          countStatus: 'incomplete',
          totalKnown: false,
          knownLoadedCount: 13,
          minimumKnownCount: 13,
          loadMoreError: 'Esta aba do Gemini ja esta ocupada com outro comando pesado.',
          refreshError: 'Timeout após 2500ms.',
          pagination: {
            loadedCount: 13,
            reachedEnd: false,
            canLoadMore: true,
          },
          conversations: [],
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 91,
        knownLoadedCount: 91,
        minimumKnownCount: 91,
        pagination: {
          loadedCount: 91,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
      const run = await main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], {
        stdout,
        stderr,
      });

      assert.equal(run.exitCode, 0);
      assert.equal(countRequests, 2);
      assert.match(stdout.text(), /Ainda tentando confirmar o total/);
      assert.match(stdout.text(), /Total confirmado: 91 chat\(s\)/);
      assert.equal(run.result.totalKnown, true);
      assert.equal(run.result.totalCount, 91);
      assert.equal(stderr.text(), '');
    }),
  );
});

test('CLI chats count --tui mostra contagem indeterminada com feedback humano', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/clients') {
      sendJson(res, 200, {
        connectedClients: [
          {
            clientId: 'client-1',
            tabId: 101,
            isActiveTab: true,
            lastSeenAt: new Date().toISOString(),
            listedConversationCount: 13,
            sidebarConversationCount: 13,
            page: {
              listedConversationCount: 13,
            },
            serverClaim: {
              claimId: 'count-claim',
              label: '🔎 Conferindo',
            },
          },
        ],
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 91,
        knownLoadedCount: 91,
        minimumKnownCount: 91,
        pagination: {
          loadedCount: 91,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream({ isTTY: true, columns: 100 });
    const stderr = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--tui', '--result-json'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Gemini Markdown Export/);
    assert.match(stdout.text(), /contagem/);
    assert.match(stdout.text(), /13 conversas encontradas ate agora/);
    assert.match(stdout.text(), /Buscando o fim da lista/);
    assert.doesNotMatch(stdout.text(), /0 vistas|tool MCP|fallback/);
    assert.match(stdout.text(), /Total confirmado: 91 chat\(s\)/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI chats count continua quando o indicador visual da aba trava', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 503, {
        ok: false,
        error: 'Timeout aguardando resposta do comando claim-tab.',
        code: 'command_timeout',
      });
      return;
    }
    if (url.pathname === '/agent/clients') {
      sendJson(res, 200, {
        connectedClients: [
          {
            clientId: 'client-1',
            tabId: 101,
            isActiveTab: true,
            lastSeenAt: new Date().toISOString(),
            listedConversationCount: 33,
            sidebarConversationCount: 33,
          },
        ],
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 118,
        knownLoadedCount: 118,
        minimumKnownCount: 118,
        pagination: {
          loadedCount: 118,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream({ isTTY: true, columns: 100 });
    const stderr = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--tui', '--result-json'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Indicador visual da aba nao respondeu/);
    assert.match(stdout.text(), /Total confirmado: 118 chat\(s\)/);
    assert.equal(stderr.text(), '');
    const countRequest = requests.find((item) => item.pathname === '/agent/recent-chats');
    assert.equal(countRequest.searchParams.get('autoClaim'), 'false');
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
  });
});

test('CLI chats count continua quando canal do indicador visual ainda esta reconectando', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'post-update',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 503, {
        ok: false,
        error: 'A aba ativa ainda nao abriu o canal de comandos.',
        code: 'command_channel_unready',
      });
      return;
    }
    if (url.pathname === '/agent/clients') {
      sendJson(res, 200, {
        connectedClients: [
          {
            clientId: 'client-1',
            tabId: 101,
            isActiveTab: true,
            lastSeenAt: new Date().toISOString(),
            listedConversationCount: 33,
            sidebarConversationCount: 33,
          },
        ],
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 119,
        knownLoadedCount: 119,
        minimumKnownCount: 119,
        pagination: {
          loadedCount: 119,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--plain', '--result-json'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Indicador visual da aba nao respondeu/);
    assert.match(stdout.text(), /Total confirmado: 119 chat\(s\)/);
    assert.equal(stderr.text(), '');
    const countRequest = requests.find((item) => item.pathname === '/agent/recent-chats');
    assert.equal(countRequest.searchParams.get('autoClaim'), 'false');
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
  });
});

test('CLI chats count libera claim explicita sem imprimir JSON extra', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--claim-id', 'claim-123', '--plain'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Total confirmado: 277 chat\(s\)/);
    assert.equal(
      stdout.text().split(/\r?\n/).filter((line) => line.startsWith('RESULT_JSON ')).length,
      0,
      'count plain nao deve emitir RESULT_JSON',
    );
    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.ok(releaseRequest, 'deve liberar a claim depois da contagem');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'claim-123');
    assert.equal(releaseRequest.searchParams.get('reason'), 'cli-chats-count-finished');
    assert.equal(stderr.text(), '');
  });
});

test('CLI chats count libera claim propria quando a bridge cai durante a contagem', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: '🔎 Conferindo',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      req.socket.destroy(new Error('simulated bridge drop'));
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
          tabId: Number(url.searchParams.get('tabId')),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () => main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], { stdout, stderr }),
      /Conexao com a bridge caiu antes da resposta/,
    );

    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.ok(releaseRequest, 'deve liberar a claim mesmo quando a contagem cai');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(releaseRequest.searchParams.get('tabId'), '101');
    assert.equal(stderr.text(), '');
  });
});

test('CLI --keep-claim preserva claim explicita', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 500, { ok: false, error: 'nao deveria liberar' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'chats',
        'count',
        '--bridge-url',
        bridgeUrl,
        '--claim-id',
        'claim-123',
        '--keep-claim',
        '--plain',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
    assert.equal(stderr.text(), '');
  });
});

test('CLI diagnose page abre artefatos e pede liberação da claim no endpoint', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/diagnose-page') {
      sendJson(res, 200, {
        ok: true,
        page: {
          chatId: '46b61afe42a5956d',
          url: url.searchParams.get('url'),
          title: 'Artefato',
        },
        summary: {
          total: 1,
          launcherCount: 1,
          clickedLauncherCount: 1,
          htmlExtractable: 1,
        },
        launcherOpen: {
          close: { ok: true },
        },
        items: [
          {
            id: 'artifact-001',
            kind: 'gemini_code_immersive',
            srcKind: 'remote_usercontent_goog',
            htmlExtractable: true,
            recommendedExport: 'html_asset',
          },
        ],
        tabClaimRelease: {
          ok: true,
          released: { claimId: 'claim-123' },
        },
        artifactHtmlSave: {
          ok: true,
          captureCount: 1,
          savedCount: 1,
          outputDir: '/tmp/artifacts',
          manifestFile: '/tmp/artifacts/artifact-46b61afe42a5956d-manifest.json',
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'diagnose',
        'page',
        'https://gemini.google.com/app/46b61afe42a5956d',
        '--bridge-url',
        bridgeUrl,
        '--claim-id',
        'claim-123',
        '--save-html',
        '--output-dir',
        '/tmp/artifacts',
        '--plain',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Botões candidatos: 1; abertos: 1/);
    assert.match(stdout.text(), /Captura HTML: ok; payloads: 1/);
    assert.match(stdout.text(), /HTML salvo: 1 arquivo\(s\) em \/tmp\/artifacts/);
    assert.match(stdout.text(), /Superfície aberta: fechada após o diagnóstico/);
    assert.match(stdout.text(), /Claim da aba: liberada/);
    const diagnoseRequest = requests.find((item) => item.pathname === '/agent/diagnose-page');
    assert.ok(diagnoseRequest);
    assert.equal(diagnoseRequest.searchParams.get('claimId'), 'claim-123');
    assert.equal(diagnoseRequest.searchParams.get('saveHtml'), 'true');
    assert.equal(diagnoseRequest.searchParams.get('outputDir'), '/tmp/artifacts');
    assert.equal(diagnoseRequest.searchParams.get('releaseClaimOnOperationEnd'), 'true');
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync --plain emite progresso estavel e RESULT_JSON final', async () => {
  await withServer(mockSyncServer(), async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Conectando na bridge/);
    assert.match(stdout.text(), /running\/exporting/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');

    const resultLine = stdout
      .text()
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON '));
    const result = JSON.parse(resultLine.replace('RESULT_JSON ', ''));
    assert.equal(result.status, 'completed');
    assert.equal(result.downloadedCount, 1);
    assert.equal(result.fullHistoryVerified, true);

    const syncRequest = requests.find((item) => item.pathname === '/agent/sync-vault');
    assert.equal(syncRequest.searchParams.get('vaultDir'), '/vault/Gemini');
    assert.equal(syncRequest.searchParams.get('outputDir'), '/vault/Gemini');
  });
});

test('CLI sync --plain destaca historico incompleto e falhas no RESULT_JSON', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/sync-vault') {
      sendJson(res, 202, completedWithErrorsJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );
    assert.equal(run.exitCode, 1);

    assert.match(stdout.text(), /ATENCAO: o fim do historico nao foi confirmado/);
    assert.match(stdout.text(), /Falhas registradas:/);
    assert.match(stdout.text(), /3c1d9107303b754e/);
    const resultLine = stdout
      .text()
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON '));
    const result = JSON.parse(resultLine.replace('RESULT_JSON ', ''));
    assert.equal(result.status, 'completed_with_errors');
    assert.equal(result.fullHistoryVerified, false);
    assert.equal(result.failures[0].chatId, '3c1d9107303b754e');
    assert.equal(result.loadMoreTimedOut, true);
    assert.equal(stderr.text(), '');
  });
});

test('CLI RESULT_JSON trata datas pendentes como export não concluído e orienta fix-vault', async () => {
  const completedWithPendingDates = {
    ...completedJob,
    status: 'completed_with_errors',
    decisionSummary: {
      ...completedJob.decisionSummary,
      totals: {
        ...completedJob.decisionSummary.totals,
        dateImport: {
          matched: 1,
          partial: 0,
          unresolved: 1,
          pending: 1,
        },
      },
      warnings: ['1 conversa ficou sem datas no Takeout/My Activity.'],
      nextAction: {
        code: 'fix_vault_required',
        message: 'Não consegui preencher todas as datas. Rode fix-vault.',
        command: {
          tool: 'shell',
          text: "gemini-md-export fix-vault '/tmp/gemini-md-export-test' --use-my-activity",
        },
      },
    },
  };

  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 202, completedWithPendingDates);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'export',
        'recent',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--result-json',
        '--poll-ms',
        '10',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 1);
    assert.match(stdout.text(), /Próximo passo:/);
    assert.match(stdout.text(), /Não consegui preencher todas as datas/);
    assert.match(stdout.text(), /Comando:/);
    assert.match(stdout.text(), /gemini-md-export fix-vault/);
    const resultLine = stdout
      .text()
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON '));
    const result = JSON.parse(resultLine.replace('RESULT_JSON ', ''));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'completed_with_errors');
    assert.equal(result.nextAction.code, 'fix_vault_required');
    assert.equal(result.warningCount, 1);
    assert.deepEqual(result.dateImport, {
      matched: 1,
      partial: 0,
      unresolved: 1,
      pending: 1,
    });
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync cancela job em timeout e libera claim visual da aba', async () => {
  const claimedRunningJob = {
    ...runningJob,
    jobId: 'job-timeout-sync',
    tabClaimId: 'claim-sync-timeout',
    tabClaim: {
      claimId: 'claim-sync-timeout',
      tabId: 12345,
      status: 'active',
    },
  };
  let cancelRequested = false;

  await withEnv({ GEMINI_MD_EXPORT_JOB_TIMEOUT_CLEANUP_MS: '250' }, async () => {
    await withServer((req, res, url) => {
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/sync-vault') {
        sendJson(res, 202, claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-status') {
        sendJson(res, 200, cancelRequested
          ? { ...claimedRunningJob, status: 'cancelled', phase: 'cancelled' }
          : claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-cancel') {
        cancelRequested = true;
        sendJson(res, 200, { ...claimedRunningJob, status: 'cancel_requested' });
        return;
      }
      if (url.pathname === '/agent/release-tab') {
        sendJson(res, 200, {
          ok: true,
          released: {
            claimId: url.searchParams.get('claimId'),
            tabId: Number(url.searchParams.get('tabId')),
          },
          visual: { ok: true },
        });
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl, requests) => {
      const stdout = captureStream();
      const stderr = captureStream();
      await assert.rejects(
        () =>
          main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--timeout-ms',
              '20',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          ),
        /Timeout aguardando job job-timeout-sync/,
      );

      assert.match(stdout.text(), /cancelando no navegador e liberando a aba/);
      assert.equal(stderr.text(), '');
      assert.equal(requests.some((item) => item.pathname === '/agent/export-job-cancel'), true);
      const release = requests.find((item) => item.pathname === '/agent/release-tab');
      assert.ok(release);
      assert.equal(release.searchParams.get('claimId'), 'claim-sync-timeout');
      assert.equal(release.searchParams.get('tabId'), '12345');
    });
  });
});

test('CLI export cancela job e libera claim ao receber SIGTERM externo', { timeout: 10000 }, async () => {
  const claimedRunningJob = {
    ...runningJob,
    jobId: 'job-sigterm',
    tabClaimId: 'claim-sigterm',
    tabClaim: {
      claimId: 'claim-sigterm',
      tabId: 4242,
      status: 'active',
    },
    traceFile: '/tmp/job-sigterm.trace.jsonl',
  };
  let cancelRequested = false;

  await withEnv({ GEMINI_MD_EXPORT_JOB_TIMEOUT_CLEANUP_MS: '1000' }, async () => {
    await withServer((req, res, url) => {
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/export-recent-chats') {
        sendJson(res, 202, claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-status') {
        sendJson(
          res,
          200,
          cancelRequested
            ? { ...claimedRunningJob, status: 'cancelled', phase: 'cancelled' }
            : claimedRunningJob,
        );
        return;
      }
      if (url.pathname === '/agent/export-job-cancel') {
        cancelRequested = true;
        sendJson(res, 200, { ...claimedRunningJob, status: 'cancel_requested' });
        return;
      }
      if (url.pathname === '/agent/release-tab') {
        sendJson(res, 200, {
          ok: true,
          released: {
            claimId: url.searchParams.get('claimId'),
            tabId: Number(url.searchParams.get('tabId')),
          },
        });
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl, requests) => {
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, 'bin', 'gemini-md-export.mjs'),
          'export',
          'recent',
          '--browser-export',
          '--bridge-url',
          bridgeUrl,
          '--plain',
          '--poll-ms',
          '50',
          '--timeout-ms',
          '300000',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      let killed = false;
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (!killed && stdout.includes('Job iniciado: job-sigterm')) {
          killed = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const exit = await new Promise((resolveExit) => {
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });

      assert.equal(exit.code, 2);
      assert.equal(exit.signal, null);
      assert.match(stdout, /Interrupcao recebida \(SIGTERM\); cancelando job job-sigterm/);
      assert.match(stdout, /traceFile: \/tmp\/job-sigterm\.trace\.jsonl/);
      assert.equal(stderr, '');
      assert.equal(requests.some((item) => item.pathname === '/agent/export-job-cancel'), true);
      const release = requests.find((item) => item.pathname === '/agent/release-tab');
      assert.ok(release);
      assert.equal(release.searchParams.get('claimId'), 'claim-sigterm');
      assert.equal(release.searchParams.get('tabId'), '4242');
    });
  });
});

test('CLI sync acorda Gemini Web pela propria CLI antes de exportar quando --wake foi pedido', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-launch-'));
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            readyCalls += 1;
            const ready = readyCalls >= 2;
            sendJson(res, 200, {
              ready,
              mode: ready ? 'warm' : 'cold',
              connectedClientCount: ready ? 1 : 0,
              selectableTabCount: ready ? 1 : 0,
              commandReadyClientCount: ready ? 1 : 0,
              blockingIssue: ready ? null : 'no_connected_clients',
            });
            return;
          }
          if (url.pathname === '/agent/sync-vault') {
            sendJson(res, 202, completedJob);
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl, requests) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const run = await main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--wake',
              '--ready-wait-ms',
              '300',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          );

          assert.equal(run.exitCode, 0);
          assert.match(stdout.text(), /Abrindo Gemini Web em background/);
          assert.match(stdout.text(), /Aguardando a extensao conectar/);
          assert.match(stdout.text(), /RESULT_JSON /);
          assert.equal(stderr.text(), '');

          const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
          assert.equal(readyRequests.length >= 2, true);
          assert.equal(readyRequests.every((item) => item.searchParams.get('wakeBrowser') === 'false'), true);
          assert.equal(readyRequests[0].searchParams.get('waitMs'), '0');
          assert.equal(readyRequests[1].searchParams.get('waitMs'), '300');

          const launchState = JSON.parse(readFileSync(resolve(tmpRoot, 'browser-launch.json'), 'utf-8'));
          assert.equal(launchState.source, 'cli');
          assert.equal(launchState.status, 'dry-run');
          assert.equal(launchState.launch.dryRun, true);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI browser status nao recarrega varias abas quando falta aba Gemini ativa', async () => {
  let reloadRequested = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-update',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_selectable_gemini_tab',
                  mode: 'hot',
                  connectedClientCount: 1,
                  selectableTabCount: 0,
                  commandReadyClientCount: 1,
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'extension-tabs-api',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [
              {
                clientId: 'client-1',
                tabId: 101,
                isActiveTab: true,
                lastSeenAt: new Date().toISOString(),
                page: { url: 'https://gemini.google.com/app', kind: 'chat' },
              },
            ],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl, requests) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 4);
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(stderr.text(), '');
        const reloadRequest = requests.find(
          (item) => item.pathname === '/agent/tabs' && item.searchParams.get('action') === 'reload',
        );
        assert.equal(reloadRequest, undefined);
        const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
        assert.equal(readyRequests.every((item) => item.searchParams.get('wakeBrowser') === 'false'), true);
        assert.equal(run.result.existingTabsReload, null);
        assert.equal(run.result.blockingIssue, 'no_selectable_gemini_tab');
      });
    },
  );
});

test('CLI browser status acorda Gemini quando so My Activity esta conectado', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-activity-only-wake-'));
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '300',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            sendJson(res, 200, {
              ready: false,
              blockingIssue: 'no_selectable_gemini_tab',
              mode: 'hot',
              connectedClientCount: 3,
              selectableTabCount: 0,
              commandReadyClientCount: 3,
              diagnosticClients: [
                {
                  clientId: 'activity-1',
                  tabId: 101,
                  page: {
                    kind: 'activity',
                    url: 'https://myactivity.google.com/product/gemini',
                  },
                },
                {
                  clientId: 'activity-2',
                  tabId: 102,
                  page: {
                    kind: 'activity',
                    url: 'https://myactivity.google.com/product/gemini',
                  },
                },
              ],
            });
            return;
          }
          if (url.pathname === '/agent/clients') {
            sendJson(res, 200, {
              mcp: { bridgeRole: 'primary' },
              connectedClients: [
                {
                  clientId: 'activity-1',
                  tabId: 101,
                  page: {
                    kind: 'activity',
                    url: 'https://myactivity.google.com/product/gemini',
                  },
                },
              ],
            });
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl, requests) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const run = await main(
            [
              'browser',
              'status',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--wake',
              '--ready-wait-ms',
              '10',
            ],
            { stdout, stderr },
          );

          assert.equal(run.exitCode, 4);
          assert.match(stdout.text(), /Abrindo Gemini Web em background/);
          assert.doesNotMatch(stdout.text(), /Aguardando aba Gemini existente reconectar/);
          assert.equal(stderr.text(), '');
          assert.equal(run.result.blockingIssue, 'no_selectable_gemini_tab');
          assert.equal(
            requests.some((item) => item.pathname === '/agent/tabs' && item.searchParams.get('action') === 'reload'),
            false,
          );

          const launchState = JSON.parse(readFileSync(resolve(tmpRoot, 'browser-launch.json'), 'utf-8'));
          assert.equal(launchState.source, 'cli');
          assert.equal(launchState.status, 'dry-run');
          assert.equal(launchState.launch.dryRun, true);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI browser status recarrega abas existentes quando build da extensao diverge', async () => {
  let reloadRequested = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-update',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'extension_build_mismatch',
                  mode: 'hot',
                  connectedClientCount: 1,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'extension-tabs-api',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl, requests) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(stderr.text(), '');
        assert.equal(reloadRequested, true);
        assert.equal(run.result.existingTabsReload?.reloaded, 1);
      });
    },
  );
});

test('CLI browser status recarrega aba existente depois que self-heal derruba content scripts', async () => {
  let reloadRequested = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-update',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_connected_clients',
                  mode: 'hot',
                  connectedClientCount: 0,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                  extensionReadiness: {
                    reload: {
                      attempted: true,
                      attempts: 1,
                      worked: true,
                    },
                  },
                  selfHeal: {
                    attempted: true,
                    ok: true,
                    reloadAttempts: 1,
                  },
                  nativeBroker: {
                    configured: true,
                    available: true,
                    response: {
                      result: {
                        tabs: [
                          {
                            state: 'debuggable',
                            tab: {
                              id: 101,
                              active: true,
                              url: 'https://gemini.google.com/app',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'native-broker',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl, requests) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(stderr.text(), '');
        assert.equal(reloadRequested, true);
        assert.equal(run.result.existingTabsReload?.mode, 'native-broker');
        assert.equal(run.result.existingTabsReload?.reloaded, 1);
      });
    },
  );
});

test('CLI browser status recarrega aba Gemini ativa via native broker quando nao ha content scripts', async () => {
  let reloadRequested = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-reload',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_connected_clients',
                  mode: 'hot',
                  connectedClientCount: 0,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                  nativeBroker: {
                    configured: true,
                    available: true,
                    response: {
                      result: {
                        tabs: [
                          {
                            state: 'debuggable',
                            tab: {
                              id: 101,
                              active: true,
                              url: 'https://gemini.google.com/app',
                            },
                          },
                          {
                            state: 'debuggable',
                            tab: {
                              id: 102,
                              active: false,
                              url: 'https://gemini.google.com/app/f05318e93e234d75',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'native-broker',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl, requests) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(stderr.text(), '');
        assert.equal(reloadRequested, true);
        assert.equal(run.result.existingTabsReload?.mode, 'native-broker');
        assert.equal(run.result.existingTabsReload?.reloaded, 1);
        const reloadRequest = requests.find(
          (item) => item.pathname === '/agent/tabs' && item.searchParams.get('action') === 'reload',
        );
        assert.equal(reloadRequest?.searchParams.get('reloadAll'), 'false');
      });
    },
  );
});

test('CLI browser status recarrega abas Gemini inativas via native broker sem abrir outra aba', async () => {
  let reloadRequested = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-reload',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_connected_clients',
                  mode: 'hot',
                  connectedClientCount: 0,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                  nativeBroker: {
                    configured: true,
                    available: true,
                    response: {
                      result: {
                        tabs: [
                          {
                            state: 'debuggable',
                            tab: {
                              id: 101,
                              active: false,
                              url: 'https://gemini.google.com/app',
                            },
                          },
                          {
                            state: 'debuggable',
                            tab: {
                              id: 102,
                              active: false,
                              url: 'https://gemini.google.com/app/f05318e93e234d75',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          assert.equal(url.searchParams.get('reloadAll'), 'true');
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 2,
            mode: 'native-broker',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(stderr.text(), '');
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(reloadRequested, true);
        assert.equal(run.result.existingTabsReload?.mode, 'native-broker');
        assert.equal(run.result.existingTabsReload?.reloaded, 2);
      });
    },
  );
});

test('CLI browser status repete reload nativo quando a primeira chamada expira', async () => {
  let reloadAttempts = 0;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadAttempts >= 2
              ? {
                  ready: true,
                  mode: 'post-reload-retry',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_connected_clients',
                  mode: 'hot',
                  connectedClientCount: 0,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                  nativeBroker: {
                    configured: true,
                    available: true,
                    response: {
                      result: {
                        tabs: [
                          {
                            state: 'debuggable',
                            tab: {
                              id: 101,
                              active: false,
                              url: 'https://gemini.google.com/app',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadAttempts += 1;
          if (reloadAttempts === 1) {
            sendJson(res, 200, {
              ok: false,
              action: 'reload',
              code: 'extension_request_timeout',
              error: 'service worker ainda reconectando',
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'native-broker',
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, {
            mcp: { bridgeRole: 'primary' },
            connectedClients: [],
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--allow-reload',
            '--ready-wait-ms',
            '50',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(stderr.text(), '');
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(reloadAttempts, 2);
        assert.equal(run.result.existingTabsReload?.retryAttempted, true);
        assert.equal(run.result.existingTabsReload?.firstAttempt?.code, 'extension_request_timeout');
        assert.equal(run.result.existingTabsReload?.reloaded, 1);
      });
    },
  );
});

test('CLI export recent recarrega abas existentes automaticamente antes de iniciar job', async () => {
  let reloadRequested = false;
  let exportStarted = false;
  await withEnv(
    {
      GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          sendJson(
            res,
            200,
            reloadRequested
              ? {
                  ready: true,
                  mode: 'post-reload',
                  connectedClientCount: 1,
                  selectableTabCount: 1,
                  commandReadyClientCount: 1,
                }
              : {
                  ready: false,
                  blockingIssue: 'no_connected_clients',
                  mode: 'hot',
                  connectedClientCount: 0,
                  selectableTabCount: 0,
                  commandReadyClientCount: 0,
                  nativeBroker: {
                    configured: true,
                    available: true,
                    response: {
                      result: {
                        tabs: [
                          {
                            state: 'debuggable',
                            tab: {
                              id: 101,
                              active: true,
                              url: 'https://gemini.google.com/app',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
          reloadRequested = true;
          sendJson(res, 200, {
            ok: true,
            action: 'reload',
            reloaded: 1,
            mode: 'native-broker',
          });
          return;
        }
        if (url.pathname === '/agent/export-recent-chats') {
          exportStarted = true;
          sendJson(res, 200, {
            jobId: 'job-1',
            status: 'completed',
            phase: 'done',
            successCount: 1,
            failureCount: 0,
            completed: 1,
            requested: 1,
            outputDir: '/tmp/gemini-md-export-test',
          });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl, requests) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'export',
            'recent',
            '--browser-export',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--no-wake',
            '--max-chats',
            '1',
            '--output-dir',
            '/tmp/gemini-md-export-test',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(stderr.text(), '');
        assert.equal(reloadRequested, true);
        assert.equal(exportStarted, true);
        const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
        assert.equal(readyRequests[0]?.searchParams.get('allowReload'), 'true');
        const reloadRequest = requests.find(
          (item) => item.pathname === '/agent/tabs' && item.searchParams.get('action') === 'reload',
        );
        assert.equal(reloadRequest?.searchParams.get('allowReload'), 'true');
        const exportRequest = requests.find((item) => item.pathname === '/agent/export-recent-chats');
        assert.equal(exportRequest?.searchParams.get('activateTab'), 'true');
        const postReloadReady = readyRequests.find(
          (item) => item.searchParams.get('waitMs') === '75000',
        );
        assert.ok(postReloadReady, 'export deve aguardar uma janela maior depois de reload automático');
      });
    },
  );
});

test('CLI export recent respeita opt-out explicito de ativacao de aba', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 200, {
        jobId: 'job-1',
        status: 'completed',
        phase: 'done',
        successCount: 1,
        failureCount: 0,
        completed: 1,
        requested: 1,
        outputDir: '/tmp/gemini-md-export-test',
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'export',
        'recent',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--no-activate-tab',
        '--max-chats',
        '1',
        '--output-dir',
        '/tmp/gemini-md-export-test',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(stderr.text(), '');
    const exportRequest = requests.find((item) => item.pathname === '/agent/export-recent-chats');
    assert.equal(exportRequest?.searchParams.get('activateTab'), 'false');
  });
});

test('CLI export recent preserva opt-in explicito de ativacao de aba', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 200, {
        jobId: 'job-1',
        status: 'completed',
        phase: 'done',
        successCount: 1,
        failureCount: 0,
        completed: 1,
        requested: 1,
        outputDir: '/tmp/gemini-md-export-test',
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'export',
        'recent',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--activate-tab',
        '--max-chats',
        '1',
        '--output-dir',
        '/tmp/gemini-md-export-test',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(stderr.text(), '');
    const exportRequest = requests.find((item) => item.pathname === '/agent/export-recent-chats');
    assert.equal(exportRequest?.searchParams.get('activateTab'), 'true');
  });
});

test('CLI export recent adota job ativo quando start retorna aba ocupada', async () => {
  const outputDir = '/tmp/gemini-md-export-adopt';
  let activeJobsRequested = false;
  let statusRequested = false;

  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 503, {
        code: 'tab_operation_in_progress',
        error: 'A aba ja esta executando uma operacao pesada.',
      });
      return;
    }
    if (url.pathname === '/agent/export-jobs') {
      activeJobsRequested = url.searchParams.get('active') === 'true';
      sendJson(res, 200, {
        ok: true,
        jobs: [
          {
            jobId: 'job-adopted',
            type: 'recent-chats-export',
            status: 'running',
            phase: 'exporting',
            outputDir,
            maxChats: 2,
            successCount: 1,
            failureCount: 0,
            skippedCount: 0,
            completed: 1,
            requested: 2,
          },
        ],
      });
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      statusRequested = true;
      sendJson(res, 200, {
        jobId: 'job-adopted',
        type: 'recent-chats-export',
        status: 'completed',
        phase: 'done',
        outputDir,
        maxChats: 2,
        successCount: 2,
        failureCount: 0,
        skippedCount: 0,
        completed: 2,
        requested: 2,
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'export',
        'recent',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--max-chats',
        '2',
        '--output-dir',
        outputDir,
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(activeJobsRequested, true);
    assert.equal(statusRequested, true);
    assert.match(stdout.text(), /Job ja estava ativo; acompanhando job-adopted/);
    assert.equal(stderr.text(), '');
  });
});

test('CLI tabs reload explica quando nao ha canal para recarregar abas existentes', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
      sendJson(res, 200, {
        ok: false,
        action: 'reload',
        reloaded: 0,
        code: 'no_connected_clients_for_reload',
        error: 'Nenhuma aba viva do Gemini conectada à extensão.',
        nextAction:
          'Sem aba conectada, a CLI nao consegue recarregar abas existentes por comando. Use um cliente conectado, CDP ou native broker antes do reload.',
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'tabs',
        'reload',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--no-wake',
        '--result-json',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    assert.match(stdout.text(), /Sem aba conectada, a CLI nao consegue recarregar abas existentes/);
    assert.equal(run.result.nextAction.includes('native broker'), true);
    assert.equal(stderr.text(), '');
  });
});

test('CLI browser status surfaces native broker blocker from readiness', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: false,
        blockingIssue: 'native_broker_extension_disconnected',
        connectedClientCount: 0,
        selectableTabCount: 0,
        commandReadyClientCount: 0,
        nativeBroker: {
          configured: true,
          available: false,
          code: 'native_broker_extension_disconnected',
          message: 'A extensão ainda não abriu a porta nativa do broker.',
        },
      });
      return;
    }
    if (url.pathname === '/agent/clients') {
      sendJson(res, 200, { mcp: { bridgeRole: 'primary' }, connectedClients: [] });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['browser', 'status', '--bridge-url', bridgeUrl, '--plain', '--no-wake', '--result-json'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    assert.match(stdout.text(), /A extensão ainda não abriu a porta nativa do broker/);
    assert.equal(run.result.nativeBroker.code, 'native_broker_extension_disconnected');
    assert.equal(stderr.text(), '');
  });
});

test('CLI browser status permite ativar aba inativa existente quando --wake foi pedido', async () => {
  const readyRequests = [];
  await withEnv(
    {
      GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
    },
    async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          readyRequests.push(new URLSearchParams(url.searchParams));
          const canActivate = url.searchParams.get('activateTab') === 'true';
          sendJson(res, 200, {
            ready: canActivate,
            blockingIssue: canActivate ? null : 'no_active_claimable_gemini_tab',
            connectedClientCount: 1,
            selectableTabCount: 1,
            commandReadyClientCount: 1,
          });
          return;
        }
        if (url.pathname === '/agent/clients') {
          sendJson(res, 200, { mcp: { bridgeRole: 'primary' }, connectedClients: [] });
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'browser',
            'status',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--ready-wait-ms',
            '0',
            '--result-json',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.equal(run.result.ready, true);
        assert.equal(readyRequests[0]?.get('activateTab'), 'true');
        assert.equal(stderr.text(), '');
      });
    },
  );
});

test('CLI passes explicit HTTP browser fallback flag only when requested', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
      sendJson(res, 200, {
        ok: true,
        allowHttpBrowserFallback: url.searchParams.get('allowHttpBrowserFallback'),
        reloaded: 0,
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'tabs',
        'reload',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--allow-http-browser-fallback',
        '--result-json',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(run.result.allowHttpBrowserFallback, 'true');
    assert.equal(stderr.text(), '');
  });
});

test('CLI prints native broker next action for strict release blocker', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 503, {
        ok: false,
        code: 'native_broker_extension_disconnected',
        error: 'A extensão ainda não abriu a porta nativa do broker.',
        nextAction: 'Recarregue a extensão ou rode doctor para ver o native broker.',
      });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, { ready: true, connectedClientCount: 1, selectableTabCount: 1 });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () =>
        main(
          [
            'export',
            'recent',
            '--browser-export',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--max-chats',
            '1',
          ],
          { stdout, stderr },
        ),
      /Recarregue a extensão ou rode doctor para ver o native broker/,
    );
  });
});

test('CLI falha rapido quando navegador cai na verificacao do Google', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-google-sorry-'));
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
        GEMINI_MD_EXPORT_FAST_BROWSER_DIAGNOSTIC_MS: '200',
        GEMINI_MD_EXPORT_ACTIVE_TAB_URL:
          'https://www.google.com/sorry/index?continue=https://gemini.google.com/app&q=blocked',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            sendJson(res, 200, {
              ready: false,
              connectedClientCount: 0,
              selectableTabCount: 0,
              commandReadyClientCount: 0,
              blockingIssue: 'no_connected_clients',
            });
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const startedAt = Date.now();
          await assert.rejects(
            () =>
              main(
                [
                  'chats',
                  'count',
                  '--bridge-url',
                  bridgeUrl,
                  '--plain',
                  '--ready-wait-ms',
                  '30000',
                ],
                { stdout, stderr },
              ),
            /google_verification_required/,
          );
          assert.ok(Date.now() - startedAt < 3000);
          assert.match(stderr.text(), /Google abriu uma tela de verificação/);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI falha rapido quando navegador esta no login do Google', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-google-login-'));
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
        GEMINI_MD_EXPORT_FAST_BROWSER_DIAGNOSTIC_MS: '200',
        GEMINI_MD_EXPORT_ACTIVE_TAB_URL:
          'https://accounts.google.com/signin/v2/identifier?continue=https://gemini.google.com/app',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            sendJson(res, 200, {
              ready: false,
              connectedClientCount: 0,
              selectableTabCount: 0,
              commandReadyClientCount: 0,
              blockingIssue: 'no_connected_clients',
            });
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const startedAt = Date.now();
          await assert.rejects(
            () =>
              main(
                [
                  'chats',
                  'count',
                  '--bridge-url',
                  bridgeUrl,
                  '--plain',
                  '--ready-wait-ms',
                  '30000',
                ],
                { stdout, stderr },
              ),
            /google_login_required/,
          );
          assert.ok(Date.now() - startedAt < 3000);
          assert.match(stderr.text(), /login do Google/);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI espera apenas janela curta quando Gemini abriu mas extensao nao conectou', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-gemini-no-extension-'));
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
        GEMINI_MD_EXPORT_FAST_BROWSER_DIAGNOSTIC_MS: '100',
        GEMINI_MD_EXPORT_GEMINI_EXTENSION_CONNECT_GRACE_MS: '300',
        GEMINI_MD_EXPORT_ACTIVE_TAB_URL: 'https://gemini.google.com/app',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            sendJson(res, 200, {
              ready: false,
              connectedClientCount: 0,
              selectableTabCount: 0,
              commandReadyClientCount: 0,
              blockingIssue: 'no_connected_clients',
            });
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const startedAt = Date.now();
          await assert.rejects(
            () =>
              main(
                [
                  'chats',
                  'count',
                  '--bridge-url',
                  bridgeUrl,
                  '--plain',
                  '--ready-wait-ms',
                  '30000',
                ],
                { stdout, stderr },
              ),
            /extension_not_connected/,
          );
          assert.ok(Date.now() - startedAt < 3000);
          assert.match(stderr.text(), /Gemini Web abriu, mas a extensão ainda não conectou/);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI espera aba Gemini existente reconectar antes de abrir nova aba', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-existing-tab-'));
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '300',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            readyCalls += 1;
            const ready = readyCalls >= 2;
            sendJson(res, 200, {
              ready,
              connectedClientCount: 1,
              selectableTabCount: ready ? 1 : 0,
              commandReadyClientCount: ready ? 1 : 0,
              blockingIssue: ready ? null : 'no_selectable_gemini_tab',
            });
            return;
          }
          if (url.pathname === '/agent/sync-vault') {
            sendJson(res, 202, completedJob);
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl, requests) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const run = await main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--ready-wait-ms',
              '300',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          );

          assert.equal(run.exitCode, 0);
          assert.match(stdout.text(), /Aguardando aba Gemini existente reconectar \(1s\)/);
          assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
          assert.equal(existsSync(resolve(tmpRoot, 'browser-launch.json')), false);
          assert.equal(stderr.text(), '');

          const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
          assert.equal(readyRequests.length, 2);
          assert.equal(readyRequests[0].searchParams.get('waitMs'), '0');
          assert.equal(readyRequests[1].searchParams.get('waitMs'), '300');
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI sync reaproveita estado legado de launch em andamento para evitar aba duplicada', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-launch-'));
  const legacyLaunchStatePath = resolve(tmpRoot, 'hook-browser-launch.json');
  writeFileSync(
    legacyLaunchStatePath,
    JSON.stringify({
      source: 'cli',
      launchId: 'existing-cli-launch',
      status: 'attempted',
      lastAttemptAt: Date.now(),
      expiresAt: Date.now() + 5000,
    }),
    'utf-8',
  );
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
      },
      async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          readyCalls += 1;
          const ready = readyCalls >= 2;
          sendJson(res, 200, {
            ready,
            connectedClientCount: ready ? 1 : 0,
            selectableTabCount: ready ? 1 : 0,
            commandReadyClientCount: ready ? 1 : 0,
            blockingIssue: ready ? null : 'no_connected_clients',
          });
          return;
        }
        if (url.pathname === '/agent/sync-vault') {
          sendJson(res, 202, completedJob);
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'sync',
            '/vault/Gemini',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--wake',
            '--ready-wait-ms',
            '300',
            '--poll-ms',
            '10',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.match(stdout.text(), /Outra chamada ja esta abrindo Gemini Web/);
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(stderr.text(), '');

        const launchState = JSON.parse(readFileSync(legacyLaunchStatePath, 'utf-8'));
        assert.equal(launchState.launchId, 'existing-cli-launch');
      });
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI sync --tui renderiza painel ANSI quando usado com TTY', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream({ isTTY: true, columns: 100 });
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /\x1b\[\?25l/);
    assert.match(stdout.text(), /\x1b\[\?25h/);
    assert.match(stdout.text(), /Gemini Markdown Export/);
    assert.match(stdout.text(), /▕.*[█▓░].*▏/);
    assert.match(stdout.text(), /Concluido/);
    assert.match(stdout.text(), /Salvas 1 \| Puladas 1 \| Falhas 0/);
    assert.doesNotMatch(stdout.text(), /contas web|trace compacto|status cmd|Job iniciado/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync --tui reinicia frame apos readiness e conta quebras de linha', async () => {
  await withEnv({ GEMINI_CLI: '1' }, async () => {
    await withServer(mockSyncServer(), async (bridgeUrl) => {
      const stdout = captureStream({ isTTY: true, columns: 36 });
      const stderr = captureStream();
      const run = await main(
        ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
        { stdout, stderr },
      );

      assert.equal(run.exitCode, 0);
      assert.match(stdout.text(), /\x1b\[\?25l/);
      const cursorMoves = [...stdout.text().matchAll(/\x1b\[(\d+)F/g)].map((match) => Number(match[1]));
      assert.equal(cursorMoves.length, 2);
      assert.ok(cursorMoves.every((move) => move >= 5), `cursor deveria considerar o painel; recebeu ${cursorMoves.join(',')}`);
      assert.doesNotMatch(stdout.text(), /Job iniciado: job-1/);
      assert.doesNotMatch(stdout.text(), /relatorio ainda nao gravado|trace compacto/);
      assert.match(stdout.text(), /RESULT_JSON /);
      assert.equal(stderr.text(), '');
    });
  });
});

test('CLI --tui renderiza readiness sem misturar logs plain', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-tui-ready-'));
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            sendJson(res, 200, {
              ready: false,
              connectedClientCount: 0,
              selectableTabCount: 0,
              commandReadyClientCount: 0,
              blockingIssue: 'no_connected_clients',
            });
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl) => {
          const stdout = captureStream({ isTTY: true, columns: 92 });
          const stderr = captureStream();
          await assert.rejects(
            () =>
              main(
                [
                  'chats',
                  'count',
                  '--bridge-url',
                  bridgeUrl,
                  '--tui',
                  '--ready-wait-ms',
                  '300',
                ],
                { stdout, stderr },
              ),
            /extension_not_connected|no_connected_clients/,
          );

          assert.match(stdout.text(), /Gemini Markdown Export/);
          assert.match(stdout.text(), /preparando/);
          assert.doesNotMatch(stdout.text(), /trabalhando/);
          assert.doesNotMatch(stdout.text(), /\nAbrindo Gemini Web em background\.\.\.\n/);
          assert.doesNotMatch(stdout.text(), /\nAguardando a extensao conectar/);
          assert.match(stderr.text(), /Gemini Web ainda nao esta pronto/);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI readiness imprime blockingIssue estruturado sem [object Object]', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: false,
        connectedClientCount: 1,
        selectableTabCount: 0,
        commandReadyClientCount: 0,
        blockingIssue: {
          code: 'runtime_epoch_not_ready',
          message: 'A aba observada pertence a outro runtime da extensao ou esta stale.',
          source: 'tab-orchestrator',
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () =>
        main(
          [
            'export',
            'recent',
            '--browser-export',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--no-wake',
            '--ready-wait-ms',
            '0',
          ],
          { stdout, stderr },
        ),
      /runtime_epoch_not_ready/,
    );

    assert.match(stderr.text(), /Motivo: runtime_epoch_not_ready/);
    assert.match(
      stderr.text(),
      /A aba observada pertence a outro runtime da extensao ou esta stale\./,
    );
    assert.doesNotMatch(stderr.text(), /\[object Object\]/);
  });
});

test('CLI sync --tui usa stream compacto quando pedido por env', async () => {
  await withEnv({ GEMINI_CLI: '1', GEMINI_MD_EXPORT_TUI_MODE: 'stream' }, async () => {
    let statusCalls = 0;
    await withServer((req, res, url) => {
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/sync-vault') {
        sendJson(res, 202, runningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-status') {
        statusCalls += 1;
        sendJson(res, 200, statusCalls >= 3 ? completedJob : runningJob);
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl) => {
      const stdout = captureStream({ isTTY: true, columns: 100 });
      const stderr = captureStream();
      const run = await main(
        ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
        { stdout, stderr },
      );

      assert.equal(run.exitCode, 0);
      assert.doesNotMatch(stdout.text(), /\x1b\[\?25l/);
      assert.doesNotMatch(stdout.text(), /\x1b\[\d+F/);
      assert.match(stdout.text(), /Gemini Markdown Export/);
      assert.match(stdout.text(), /▕.*[█▓░].*▏/);
      assert.equal(stdout.text().match(/Gemini Markdown Export/g)?.length, 1);
      assert.equal(stdout.text().match(/running\/exporting/g)?.length, 1);
      assert.match(stdout.text(), /completed\/writing-report/);
      assert.match(stdout.text(), /RESULT_JSON /);
      assert.equal(stderr.text(), '');
    });
  });
});

test('CLI sync --tui avisa e cai para plain sem TTY', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.doesNotMatch(stdout.text(), /\x1b\[\?25l/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.match(stderr.text(), /--tui precisa de terminal interativo/);
  });
});

test('CLI sync --json preserva stdout como JSON puro', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--json', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.reportFile, '/tmp/gme-report.json');
    assert.equal(stderr.text(), '');
  });
});

test('CLI job status considera job em andamento como consulta bem-sucedida', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-job-status') {
      sendJson(res, 200, runningJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['job', 'status', 'job-1', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /running/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI job cancel --wait aguarda estado terminal ou instrui status seguro', async () => {
  let statusCalls = 0;
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-job-cancel') {
      sendJson(res, 200, {
        ...runningJob,
        status: 'cancel_requested',
        progressMessage: 'Cancelamento solicitado. Vou parar antes da próxima conversa.',
      });
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      statusCalls += 1;
      sendJson(res, 200, statusCalls >= 2 ? { ...runningJob, status: 'cancelled', phase: 'cancelled' } : {
        ...runningJob,
        status: 'cancel_requested',
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const run = await main(
      ['job', 'cancel', 'job-1', '--wait', '--wait-ms', '5000', '--poll-ms', '10', '--bridge-url', bridgeUrl, '--plain'],
      { stdout },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Cancelamento solicitado; aguardando/);
    assert.match(stdout.text(), /cancelled/);
    assert.equal(statusCalls, 2);
  });
});

test('CLI job list mostra jobs ativos em plain e json', async () => {
  const jobList = {
    ok: true,
    action: 'list',
    activeOnly: true,
    activeCount: 1,
    jobs: [
      {
        ...runningJob,
        traceFile: '/tmp/gme-job.trace.jsonl',
      },
    ],
  };
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-jobs') {
      assert.equal(url.searchParams.get('active'), 'true');
      assert.equal(url.searchParams.get('limit'), '5');
      sendJson(res, 200, jobList);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const plainStdout = captureStream();
    const plainStderr = captureStream();
    const plain = await main(
      ['job', 'list', '--active', '--limit', '5', '--bridge-url', bridgeUrl, '--plain'],
      { stdout: plainStdout, stderr: plainStderr },
    );

    assert.equal(plain.exitCode, 0);
    assert.match(plainStdout.text(), /job-1 running\/exporting/);
    assert.match(plainStdout.text(), /gemini-md-export job status job-1 --tui --result-json/);
    assert.match(plainStdout.text(), /gemini-md-export job cancel job-1 --tui --result-json/);
    assert.match(plainStdout.text(), /RESULT_JSON /);
    assert.equal(plainStderr.text(), '');

    const jsonStdout = captureStream();
    const json = await main(
      ['job', 'list', '--active', '--limit', '5', '--bridge-url', bridgeUrl, '--json'],
      { stdout: jsonStdout },
    );
    assert.equal(json.exitCode, 0);
    assert.equal(JSON.parse(jsonStdout.text()).jobs[0].jobId, 'job-1');
  });
});

test('CLI job trace consulta endpoint dedicado sem despejar MCP no chat', async () => {
  const traceResult = {
    ok: true,
    jobId: 'job-1',
    status: 'failed',
    trace: { filePath: '/tmp/job-1.trace.jsonl', retained: true },
    summary: { eventCount: 2, byType: { job_created: 1, job_error: 1 } },
    events: [
      { ts: '2026-05-02T00:00:00.000Z', type: 'job_created', data: { phase: 'queued' } },
      {
        ts: '2026-05-02T00:00:01.000Z',
        type: 'job_error',
        data: { error: 'Timeout', code: 'job_timeout', layer: 'job' },
      },
    ],
  };
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-job-trace') {
      sendJson(res, 200, traceResult);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['job', 'trace', 'job-1', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Trace do job job-1/);
    assert.match(stdout.text(), /job_error/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI export missing inicia job com vaultDir e segue ate resultado final', async () => {
  await withServer(mockSyncServer(), async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['export', 'missing', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');

    const exportRequest = requests.find((item) => item.pathname === '/agent/export-missing-chats');
    assert.equal(exportRequest.searchParams.get('vaultDir'), '/vault/Gemini');
    assert.equal(exportRequest.searchParams.get('outputDir'), '/vault/Gemini');
  });
});

test('CLI plain progress não duplica contador no texto', async () => {
  const stdout = captureStream();
  const job = {
    jobId: 'job-progress',
    status: 'running',
    phase: 'exporting',
    requested: 30,
    completed: 24,
    batchPosition: 25,
    batchTotal: 30,
    progressMessage: 'Baixando conversas do Gemini (25/30): DAS vs. DARF',
    current: { title: 'DAS vs. DARF', chatId: 'abc123abc123' },
  };

  const run = await withServer((req, res, url) => {
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, version: PACKAGE_VERSION, protocolVersion: 2 });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, { ready: true, ok: true });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 200, job);
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      sendJson(res, 200, { ...job, status: 'completed', phase: 'done', completed: 30 });
      return;
    }
    sendJson(res, 404, { error: 'unexpected ' + url.pathname });
  }, async (bridgeUrl) => {
    return main(
      [
        'export',
        'recent',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--no-start-bridge',
        '--plain',
        '--poll-ms',
        '10',
      ],
      { stdout },
    );
  });

  if (run && typeof run === 'object' && 'exitCode' in run) {
    assert.equal(run.exitCode, 0);
  }
  assert.match(stdout.text(), /running\/exporting: 25 de 30/);
  assert.doesNotMatch(stdout.text(), /completed\/done: 25 de 30/);
  assert.match(stdout.text(), /completed\/done: 30 de 30/);
  assert.doesNotMatch(stdout.text(), /25\/30.*25\/30/);
});

test('CLI export selected e notebook usam endpoints diretos da bridge', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl, requests) => {
    const selectedStdout = captureStream();
    const notebookStdout = captureStream();

    assert.equal(
      (
        await main(
          [
            'export',
            'selected',
            '--chat-id',
            'abc123abc123',
            'def456def456',
            '--output-dir',
            '/vault/staging',
            '--expected-count',
            '2',
            '--browser-export',
            '--resume-report-file',
            '/vault/staging/partial-direct-report.json',
            '--hydration-timeout-ms',
            '900000',
            '--hydration-stall-ms',
            '60000',
            '--export-browser-timeout-ms',
            '960000',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--poll-ms',
            '10',
          ],
          { stdout: selectedStdout },
        )
      ).exitCode,
      0,
    );

    assert.equal(
      (
        await main(
          ['export', 'notebook', '--start-index', '2', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
          { stdout: notebookStdout },
        )
      ).exitCode,
      0,
    );

    const reexportRequest = requests.find((item) => item.pathname === '/agent/reexport-chats');
    assert.equal(reexportRequest.method, 'POST');
    assert.deepEqual(reexportRequest.jsonBody.chatIds, ['abc123abc123', 'def456def456']);
    assert.equal(reexportRequest.jsonBody.expectedCount, 2);
    assert.equal(reexportRequest.jsonBody.outputDir, '/vault/staging');
    assert.equal(reexportRequest.jsonBody.resumeReportFile, '/vault/staging/partial-direct-report.json');
    assert.equal(reexportRequest.jsonBody.hydrationMaxTotalMs, 900000);
    assert.equal(reexportRequest.jsonBody.hydrationStallTimeoutMs, 60000);
    assert.equal(reexportRequest.jsonBody.exportBrowserTimeoutMs, 960000);

    const notebookRequest = requests.find((item) => item.pathname === '/agent/export-notebook');
    assert.equal(notebookRequest.searchParams.get('startIndex'), '2');
  });
});

test('CLI export selected usa API privada por padrão e exige opt-out para bridge', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const runExportBlock =
    source.match(/const runExport = async \(parsed, streams = \{\}\) => \{[\s\S]*?\n\};\n\nconst runJob/)?.[0] ||
    '';

  assert.match(source, /--browser-export/);
  assert.match(source, /--no-private-api/);
  assert.match(
    runExportBlock,
    /\(isSelectedExport \|\| subcommand === 'recent'\) && flags\.privateApi !== false/,
  );
  assert.ok(
    runExportBlock.indexOf('runPrivateApiSelectedExportCommand') <
      runExportBlock.indexOf('ensureBridgeAvailable'),
    'export selected/recent precisa tentar API privada antes de bridge/aba',
  );
});

test('CLI export selected falha antes da bridge quando expected-count nao bate', async () => {
  const stdout = captureStream();
  await assert.rejects(
    () =>
      main(
        [
          'export',
          'selected',
          '--chat-id',
          'abc123abc123',
          'def456def456',
          '--expected-count',
          '10',
          '--bridge-url',
          'http://127.0.0.1:9',
          '--plain',
        ],
        { stdout },
      ),
    (err) => {
      assert.equal(err.code, 'usage');
      assert.match(err.message, /A selecao tem 2 chatId\(s\) unico\(s\).*expected-count pediu 10/);
      return true;
    },
  );
  assert.equal(stdout.text(), '');
});

test('CLI export selected usa selection-file sem duplicar chatIds do manifesto', async () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'gme-reexport-selection-'));
  const selectionFile = resolve(tempDir, 'selection.json');
  writeFileSync(
    selectionFile,
    JSON.stringify({
      kind: 'gemini-md-export-selection',
      expectedCount: 2,
      chatIds: ['abc123abc123', 'def456def456'],
      conversations: [
        { index: 1, chatId: 'abc123abc123', title: 'Um' },
        { index: 2, chatId: 'def456def456', title: 'Dois' },
      ],
    }),
  );
  try {
    await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl, requests) => {
      const stdout = captureStream();
      const run = await main(
        [
          'export',
          'selected',
          '--selection-file',
          selectionFile,
          '--browser-export',
          '--bridge-url',
          bridgeUrl,
          '--plain',
          '--poll-ms',
          '10',
        ],
        { stdout },
      );

      assert.equal(run.exitCode, 0);
      assert.match(stdout.text(), /Selecao para download: 2 chatId\(s\) unico\(s\); esperado=2/);
      const request = requests.find((item) => item.pathname === '/agent/reexport-chats');
      assert.deepEqual(request.jsonBody.chatIds, ['abc123abc123', 'def456def456']);
      assert.equal(request.jsonBody.expectedCount, 2);
      assert.equal(request.jsonBody.selectionFile, selectionFile);
      assert.equal(request.jsonBody.items.length, 2);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI export reexport legado avisa em saida humana sem quebrar JSON', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const plainStdout = captureStream();
    const plain = await main(
      [
        'export',
        'reexport',
        '--chat-id',
        'abc123abc123',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--poll-ms',
        '10',
      ],
      { stdout: plainStdout },
    );
    assert.equal(plain.exitCode, 0);
    assert.match(plainStdout.text(), /export reexport.*legado.*export selected/);
    assert.match(plainStdout.text(), /Selecao para download: 1 chatId\(s\) unico\(s\)/);

    const jsonStdout = captureStream();
    const json = await main(
      [
        'export',
        'reexport',
        '--chat-id',
        'def456def456',
        '--browser-export',
        '--bridge-url',
        bridgeUrl,
        '--json',
        '--poll-ms',
        '10',
      ],
      { stdout: jsonStdout },
    );
    assert.equal(json.exitCode, 0);
    assert.doesNotMatch(jsonStdout.text(), /legado|export selected/);
    assert.doesNotThrow(() => JSON.parse(jsonStdout.text()));
  });
});

test('CLI export-dir get e cleanup stale-processes usam endpoints da bridge', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-dir') {
      sendJson(res, 200, { outputDir: '/vault/Gemini', defaultExportDir: '/Downloads' });
      return;
    }
    if (url.pathname === '/agent/cleanup-stale-processes') {
      sendJson(res, 200, { ok: false, dryRun: true, wouldTerminate: [], message: 'Dry-run' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const exportDirStdout = captureStream();
    const cleanupStdout = captureStream();

    assert.equal(
      (await main(['export-dir', 'get', '--bridge-url', bridgeUrl, '--plain'], { stdout: exportDirStdout })).exitCode,
      0,
    );
    assert.match(exportDirStdout.text(), /Diretorio de export/);
    assert.match(exportDirStdout.text(), /RESULT_JSON /);

    assert.equal(
      (
        await main(['cleanup', 'stale-processes', '--bridge-url', bridgeUrl, '--plain'], {
          stdout: cleanupStdout,
        })
      ).exitCode,
      0,
    );
    assert.match(cleanupStdout.text(), /Dry-run/);
    assert.equal(requests.some((item) => item.pathname === '/agent/cleanup-stale-processes'), true);
  });
});

test('CLI doctor consegue iniciar bridge-only local quando a bridge esta fora', async () => {
  const port = await getFreePort();
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const stdout = captureStream();
  const stderr = captureStream();
  let bridgePid = null;

  try {
    const run = await main(
      [
        'doctor',
        '--bridge-url',
        bridgeUrl,
        '--json',
        '--no-wake',
        '--no-self-heal',
        '--no-reload',
        '--ready-wait-ms',
        '0',
        '--bridge-start-wait-ms',
        '5000',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.ready, false);
    assert.equal(stderr.text(), '');

    const health = await fetch(`${bridgeUrl}/healthz`).then((response) => response.json());
    bridgePid = health.pid;
    assert.equal(health.bridgeOnly, true);
    assert.equal(health.process.bridgeOnly, true);
    assert.equal(health.idleLifecycle.enabled, true);
  } finally {
    if (bridgePid) {
      try {
        process.kill(bridgePid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
      await sleep(150);
    }
  }
});

test('release gate smoke script documents native broker command sequence', () => {
  const sourcePath = resolve(ROOT, 'src', 'cli', 'native-broker-release-gate-smoke.ts');
  const wrapperPath = resolve(ROOT, 'scripts', 'native-broker-release-gate-smoke');
  const source = readFileSync(sourcePath, 'utf-8');
  const wrapper = readFileSync(wrapperPath, 'utf-8');

  assert.match(source, /tabs reload/);
  assert.match(source, /tabs list/);
  assert.match(source, /tabs claim/);
  assert.match(source, /export recent/);
  assert.match(source, /--allow-reload/);
  assert.match(source, /--no-wake/);
  assert.match(source, /--no-focus-window/);
  assert.match(source, /--takeout/);
  assert.match(wrapper, /build\/ts\/cli\/native-broker-release-gate-smoke\.js/);
});

test('build publica binario CLI no bundle da extensao Gemini CLI', () => {
  assert.equal(
    existsSync(resolve(ROOT, 'dist', 'gemini-cli-extension', 'bin', 'gemini-md-export.mjs')),
    true,
  );
  assert.equal(existsSync(resolve(ROOT, 'src', 'bridge-server.js')), true);
});
