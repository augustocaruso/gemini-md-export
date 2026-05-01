import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

test('build gera bundle da extensao do Gemini CLI com contexto proprio', () => {
  const extensionDir = resolve(ROOT, 'dist', 'gemini-cli-extension');
  const manifestPath = resolve(extensionDir, 'gemini-extension.json');
  const contextPath = resolve(extensionDir, 'GEMINI.md');
  const serverPath = resolve(extensionDir, 'src', 'mcp-server.js');
  const guardPath = resolve(extensionDir, 'src', 'chrome-extension-guard.mjs');
  const browserLaunchPath = resolve(extensionDir, 'src', 'browser-launch.mjs');
  const jobProgressBroadcastPath = resolve(extensionDir, 'src', 'job-progress-broadcast.mjs');
  const bridgeVersionPath = resolve(extensionDir, 'bridge-version.json');
  const browserManifestPath = resolve(extensionDir, 'browser-extension', 'manifest.json');
  const hooksConfigPath = resolve(extensionDir, 'hooks', 'hooks.json');
  const repairAgentPath = resolve(extensionDir, 'agents', 'gemini-vault-repair.md');
  const repairCommandPath = resolve(extensionDir, 'commands', 'exporter', 'repair-vault.toml');
  const repairAuditScriptPath = resolve(extensionDir, 'scripts', 'vault-repair-audit.mjs');
  const repairScriptPath = resolve(extensionDir, 'scripts', 'vault-repair.mjs');
  const hookScriptPath = resolve(
    extensionDir,
    'scripts',
    'hooks',
    'gemini-md-export-hook.mjs',
  );

  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(contextPath), true);
  assert.equal(existsSync(serverPath), true);
  assert.equal(existsSync(guardPath), true);
  assert.equal(existsSync(browserLaunchPath), true);
  assert.equal(existsSync(jobProgressBroadcastPath), true);
  assert.equal(existsSync(bridgeVersionPath), true);
  assert.equal(existsSync(browserManifestPath), true);
  assert.equal(existsSync(hooksConfigPath), true);
  assert.equal(existsSync(repairAgentPath), true);
  assert.equal(existsSync(repairCommandPath), true);
  assert.equal(existsSync(repairAuditScriptPath), true);
  assert.equal(existsSync(repairScriptPath), true);
  assert.equal(existsSync(hookScriptPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  assert.equal(manifest.contextFileName, 'GEMINI.md');
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.agents, undefined);
  assert.equal(typeof manifest.mcpServers?.['gemini-md-export']?.command, 'string');
  assert.match(
    manifest.mcpServers?.['gemini-md-export']?.args?.[0] || '',
    /mcp-server\.js$/,
  );
  assert.equal(
    manifest.mcpServers?.['gemini-md-export']?.env?.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED,
    'false',
  );
  assert.equal(manifest.mcpServers?.['gemini-md-export']?.cwd, undefined);

  const hooksConfig = JSON.parse(readFileSync(hooksConfigPath, 'utf-8'));
  assert.ok(Array.isArray(hooksConfig.hooks?.AfterTool));
  assert.ok(Array.isArray(hooksConfig.hooks?.BeforeTool));
  assert.equal(hooksConfig.hooks?.SessionStart, undefined);
  assert.match(hooksConfig.hooks.AfterTool[0].matcher, /mcp_diagnose_processes/);
  assert.match(hooksConfig.hooks.AfterTool[0].matcher, /mcp_cleanup_stale_processes/);
  assert.notEqual(hooksConfig.hooks.BeforeTool[0].matcher, '*');
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /browser_status/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /export_missing_chats/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /mcp_\+gemini/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /get_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /set_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_status/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_cancel/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /mcp_diagnose_processes/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /mcp_cleanup_stale_processes/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /reexport/);
  assert.equal(hooksConfig.hooks.BeforeTool[0].hooks[0].timeout, 20000);
  const scopeGuard = hooksConfig.hooks.BeforeTool.find(
    (entry) => entry.hooks?.[0]?.name === 'gemini-md-export-scope-guard',
  );
  assert.ok(scopeGuard);
  assert.match(scopeGuard.matcher, /write_file/);
  assert.match(scopeGuard.matcher, /run_shell_command/);
  assert.equal(scopeGuard.hooks[0].timeout, 3000);

  const repairAgent = readFileSync(repairAgentPath, 'utf-8');
  assert.match(repairAgent, /^---\nname: gemini-vault-repair/m);
  assert.match(repairAgent, /^model: gemini-3-flash-preview$/m);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_download_chat/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_reexport_chats/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_export_job_status/);
  assert.match(repairAgent, /vault-repair\.mjs/);
  assert.match(repairAgent, /vault-repair-audit\.mjs/);
  assert.match(repairAgent, /Continue only when the tool\s+returns `ready=true`/);
  assert.match(repairAgent, /stop before the scanner/);
  assert.match(repairAgent, /before any reexport\/download call/);
  assert.match(repairAgent, /blockingIssue/);
  assert.match(repairAgent, /selfHeal/);
  assert.match(repairAgent, /manual reload\s+only after/i);
  assert.match(repairAgent, /preliminary-report/);
  assert.match(repairAgent, /You cannot call another Gemini CLI subagent yourself/);
  assert.match(repairAgent, /ask the parent agent to call the appropriate/);
  assert.match(repairAgent, /wikiCandidate/);
  assert.match(repairAgent, /deduplicated union of every/);
  assert.match(repairAgent, /wikiFooterMissingSourceLinks/);
  assert.match(repairAgent, /requiredFinalGeminiSourceLinks/);

  const repairCommand = readFileSync(repairCommandPath, 'utf-8');
  assert.match(repairCommand, /gemini-vault-repair/);
  assert.match(repairCommand, /vault-repair\.mjs/);
  assert.match(repairCommand, /vault-repair-audit\.mjs/);
  assert.match(repairCommand, /relatorio preliminar/);
  assert.match(repairCommand, /nao deve chamar outro subagent/);
  assert.match(repairCommand, /uniao\s+deduplicada/);

  const browserManifest = JSON.parse(readFileSync(browserManifestPath, 'utf-8'));
  const bridgeVersion = JSON.parse(readFileSync(bridgeVersionPath, 'utf-8'));
  assert.ok(browserManifest.host_permissions.includes('https://lh3.google.com/*'));
  assert.ok(browserManifest.host_permissions.includes('https://*.googleusercontent.com/*'));
  assert.ok(browserManifest.permissions.includes('storage'));
  assert.equal(browserManifest.version, bridgeVersion.extensionVersion);
  assert.equal(typeof bridgeVersion.protocolVersion, 'number');

  const context = readFileSync(contextPath, 'utf-8');
  assert.match(context, /ready=false/);
  assert.match(context, /blockingIssue/);
  assert.match(context, /selfHeal\.reloadAttempts/);
  assert.match(context, /gemini_reload_gemini_tabs/);
  assert.match(context, /gemini_mcp_diagnose_processes/);
  assert.match(context, /gemini_mcp_cleanup_stale_processes/);
  assert.match(context, /Only ask for manual reload/);
  assert.match(context, /Do not keep\s+calling `gemini_download_chat`/);
  assert.match(context, /gemini_reexport_chats/);
  assert.match(context, /gemini_export_missing_chats/);
  assert.match(context, /resumeReportFile/);
  assert.match(context, /skips chats already completed/);
  assert.match(context, /webConversationCount - existingVaultCount = missingCount/);
  assert.match(context, /webConversationCount`, `existingVaultCount`, and `missingCount/);
  assert.match(context, /assets\/<chatId>\/\.\.\.` stay\s+inside the vault/);
  assert.match(context, /Do not emulate this by\s+listing pages in chat/);
  assert.match(context, /progressMessage/);
  assert.match(context, /decisionSummary/);
  assert.match(context, /nextAction/);
  assert.match(context, /nextAction\.command\.text/);
});

test('auditor coleta todos os links Gemini de origem em nota wiki consolidada', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-wiki-'));
  try {
    const wikiDir = resolve(root, 'Wiki_Medicina');
    mkdirSync(wikiDir, { recursive: true });
    const wikiPath = resolve(wikiDir, 'ISRS.md');
    writeFileSync(
      wikiPath,
      [
        '---',
        'title: "ISRS"',
        'aliases: ["ISRS"]',
        'tags: [psiquiatria]',
        '---',
        '',
        '# ISRS',
        '',
        'Nota consolidada a partir de [[Farmacologia]] e conversas de estudo.',
        '',
        '## Fontes Gemini',
        '',
        '- https://gemini.google.com/app/b8e7c075effe9457',
        '- [Efeitos adversos](https://gemini.google.com/app/c8e7c075effe9458)',
        '',
      ].join('\n'),
      'utf-8',
    );

    const scriptPath = resolve(ROOT, 'gemini-cli-extension', 'scripts', 'vault-repair-audit.mjs');
    const output = execFileSync(process.execPath, [scriptPath, '--include-notes', root], {
      encoding: 'utf-8',
    });
    const report = JSON.parse(output);
    const note = report.notes.find((item) => item.relativePath === 'Wiki_Medicina/ISRS.md');

    assert.ok(note, 'nota wiki com links Gemini no corpo deve entrar no relatorio');
    assert.equal(note.wikiCandidate, true);
    assert.deepEqual(note.sourceChatIds, [
      'b8e7c075effe9457',
      'c8e7c075effe9458',
    ]);
    assert.deepEqual(note.geminiSourceLinks, [
      'https://gemini.google.com/app/b8e7c075effe9457',
      'https://gemini.google.com/app/c8e7c075effe9458',
    ]);
    assert.deepEqual(note.wikiFooterGeminiSourceLinks, note.geminiSourceLinks);
    assert.deepEqual(note.wikiFooterMissingSourceLinks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const runNode = (args, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        const err = new Error(`node exited with ${code}: ${stderr}`);
        err.stdout = stdout;
        err.stderr = stderr;
        rejectRun(err);
      }
    });
  });

const readRequestJson = (req) =>
  new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('error', rejectBody);
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
  });

const sendToolResult = (res, structuredContent) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      result: {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      },
    }),
  );
};

test('repair runner compara somente corpo e preserva YAML original ao reparar raw export', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-repair-'));
  const chatId = 'b8e7c075effe9457';
  const cleanChatId = 'c8e7c075effe9458';
  const notePath = resolve(root, `${chatId}.md`);
  const cleanNotePath = resolve(root, `${cleanChatId}.md`);
  const jobs = new Map();

  try {
    writeFileSync(
      notePath,
      [
        '---',
        `chat_id: ${chatId}`,
        'title: "Metadados manuais preciosos"',
        `url: https://gemini.google.com/app/${chatId}`,
        'exported_at: 2026-04-20T12:00:00.000Z',
        'model: "2.5 Pro com anotacao manual"',
        'source: gemini-web',
        'tags: [gemini-export]',
        'note_uuid: valor-precioso',
        '---',
        '',
        '## 🧑 Usuário',
        '',
        'Pergunta antiga que veio do chat errado.',
        '',
        '---',
        '',
        '## 🤖 Gemini',
        '',
        'Resposta antiga contaminada.',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      cleanNotePath,
      [
        '---',
        `chat_id: ${cleanChatId}`,
        'title: "YAML local nao deve virar divergencia"',
        `url: https://gemini.google.com/app/${cleanChatId}`,
        'exported_at: 2026-04-21T12:00:00.000Z',
        'model: "2.5 Pro preservado"',
        'source: gemini-web',
        'tags: [gemini-export]',
        'note_uuid: yaml-only-diff',
        '---',
        '',
        '## 🧑 Usuário',
        '',
        'Pergunta limpa que ja estava correta.',
        '',
        '---',
        '',
        '## 🤖 Gemini',
        '',
        'Resposta limpa que ja estava correta.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.url !== '/agent/mcp-tool-call') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }

        const payload = await readRequestJson(req);
        const args = payload.arguments || {};
        if (payload.name === 'gemini_reexport_chats') {
          mkdirSync(args.outputDir, { recursive: true });
          const successes = args.items.map((item, index) => {
            const filePath = resolve(args.outputDir, `${item.chatId}.md`);
            const bodyLines =
              item.chatId === cleanChatId
                ? [
                    'Pergunta limpa que ja estava correta.',
                    'Resposta limpa que ja estava correta.',
                  ]
                : [
                    'Pergunta correta reexportada pelo chatId.',
                    'Resposta correta reexportada pelo chatId.',
                  ];
            writeFileSync(
              filePath,
              [
                '---',
                `chat_id: ${item.chatId}`,
                'title: "Titulo novo vindo do Gemini"',
                `url: https://gemini.google.com/app/${item.chatId}`,
                'exported_at: 2026-04-30T12:00:00.000Z',
                'source: gemini-web',
                'tags: [gemini-export]',
                '---',
                '',
                '## 🧑 Usuário',
                '',
                bodyLines[0],
                '',
                '---',
                '',
                '## 🤖 Gemini',
                '',
                bodyLines[1],
                '',
              ].join('\n'),
              'utf-8',
            );
            return {
              index: index + 1,
              chatId: item.chatId,
              title: item.title,
              filename: `${item.chatId}.md`,
              filePath,
              bytes: readFileSync(filePath).byteLength,
              turns: 2,
              sourcePath: item.sourcePath,
            };
          });
          const jobId = `job-${jobs.size + 1}`;
          const reportFile = resolve(args.outputDir, `${jobId}.json`);
          const report = {
            job: { jobId, status: 'completed' },
            outputDir: args.outputDir,
            successes,
            failures: [],
          };
          writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
          jobs.set(jobId, { reportFile, successes });
          sendToolResult(res, {
            jobId,
            status: 'running',
            reportFile,
            successCount: successes.length,
            failureCount: 0,
          });
          return;
        }

        if (payload.name === 'gemini_export_job_status') {
          const job = jobs.get(args.jobId);
          sendToolResult(res, {
            jobId: args.jobId,
            status: 'completed',
            phase: 'done',
            reportFile: job.reportFile,
            successCount: job.successes.length,
            failureCount: 0,
            recentSuccesses: job.successes,
            failures: [],
          });
          return;
        }

        sendToolResult(res, { ok: true });
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });

    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      const scriptPath = resolve(ROOT, 'gemini-cli-extension', 'scripts', 'vault-repair.mjs');
      const { stdout } = await runNode([
        scriptPath,
        '--skip-browser-check',
        '--poll-ms',
        '100',
        '--bridge-url',
        `http://127.0.0.1:${address.port}`,
        root,
      ]);
      const summary = JSON.parse(stdout);
      const repaired = readFileSync(notePath, 'utf-8');
      const finalReport = JSON.parse(readFileSync(summary.finalReportPath, 'utf-8'));
      const repairedItem = finalReport.items.find((item) => item.chatId === chatId);
      const cleanItem = finalReport.items.find((item) => item.chatId === cleanChatId);

      assert.equal(summary.statusCounts.repaired, 1);
      assert.equal(summary.statusCounts.verified_clean, 1);
      assert.equal(repairedItem.comparisonMode, 'body_only_frontmatter_ignored');
      assert.equal(repairedItem.metadataPolicy, 'original_frontmatter_preserved');
      assert.match(repaired, /title: "Metadados manuais preciosos"/);
      assert.match(repaired, /model: "2\.5 Pro com anotacao manual"/);
      assert.match(repaired, /note_uuid: valor-precioso/);
      assert.doesNotMatch(repaired, /Titulo novo vindo do Gemini/);
      assert.match(repaired, /Pergunta correta reexportada pelo chatId/);
      assert.match(repaired, /Resposta correta reexportada pelo chatId/);
      assert.equal(existsSync(repairedItem.backupPath), true);
      assert.equal(cleanItem.status, 'verified_clean');
      assert.equal(cleanItem.yamlOnlyDifferenceIgnored, true);
      assert.equal(cleanItem.backupPath, undefined);
      assert.match(readFileSync(cleanNotePath, 'utf-8'), /note_uuid: yaml-only-diff/);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
