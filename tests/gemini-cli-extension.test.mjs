import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const listFilesRecursive = (dir) => {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
};

test('build gera bundle da extensao do Gemini CLI com contexto proprio', () => {
  const extensionDir = resolve(ROOT, 'dist', 'gemini-cli-extension');
  const manifestPath = resolve(extensionDir, 'gemini-extension.json');
  const contextPath = resolve(extensionDir, 'GEMINI.md');
  const serverPath = resolve(extensionDir, 'src', 'mcp-server.js');
  const bridgeServerPath = resolve(extensionDir, 'src', 'bridge-server.js');
  const guardPath = resolve(extensionDir, 'src', 'chrome-extension-guard.mjs');
  const browserLaunchPath = resolve(extensionDir, 'src', 'browser-launch.mjs');
  const jobProgressBroadcastPath = resolve(extensionDir, 'src', 'job-progress-broadcast.mjs');
  const jobTracePath = resolve(extensionDir, 'src', 'job-trace.mjs');
  const tabSessionPath = resolve(extensionDir, 'src', 'tab-session.mjs');
  const timeoutDiagnosticsPath = resolve(extensionDir, 'src', 'timeout-diagnostics.mjs');
  const telemetryPath = resolve(extensionDir, 'src', 'telemetry.mjs');
  const compiledTakeoutAdapterPath = resolve(
    extensionDir,
    'build',
    'ts',
    'takeout',
    'takeout-adapter.js',
  );
  const compiledMetadataEvidencePath = resolve(
    extensionDir,
    'build',
    'ts',
    'core',
    'metadata-evidence.js',
  );
  const compiledNativeHostRuntimePath = resolve(
    extensionDir,
    'build',
    'ts',
    'native',
    'native-host-runtime.js',
  );
  const nativeHostPath = resolve(extensionDir, 'src', 'native-host.mjs');
  const bridgeVersionPath = resolve(extensionDir, 'bridge-version.json');
  const browserManifestPath = resolve(extensionDir, 'browser-extension', 'manifest.json');
  const artifactCapturePath = resolve(extensionDir, 'browser-extension', 'artifact-capture.js');
  const activityContentScriptPath = resolve(
    extensionDir,
    'browser-extension',
    'activity-content-script.js',
  );
  const offscreenHtmlPath = resolve(extensionDir, 'browser-extension', 'offscreen.html');
  const offscreenScriptPath = resolve(extensionDir, 'browser-extension', 'offscreen.js');
  const chromeDebuggerPath = resolve(
    extensionDir,
    'browser-extension',
    'browser',
    'shared',
    'chrome-debugger.js',
  );
  const nativeHostBinPath = resolve(extensionDir, 'bin', 'gemini-md-export-native-host.mjs');
  const nativeManifestTemplatePath = resolve(
    extensionDir,
    'native-messaging',
    'com.augustocaruso.gemini_md_export.template.json',
  );
  const hooksConfigPath = resolve(extensionDir, 'hooks', 'hooks.json');
  const repairAgentPath = resolve(extensionDir, 'agents', 'gemini-vault-repair.md');
  const skillNames = [
    'gemini-chat-inventory',
    'gemini-vault-sync',
    'gemini-vault-repair',
    'gemini-mcp-diagnostics',
    'gemini-tabs-and-browser',
  ];
  const syncCommandPath = resolve(extensionDir, 'commands', 'sync.toml');
  const fixVaultCommandPath = resolve(extensionDir, 'commands', 'exporter', 'fix-vault.toml');
  const repairCommandPath = resolve(extensionDir, 'commands', 'exporter', 'repair-vault.toml');
  const metadataBackfillCommandPath = resolve(
    extensionDir,
    'commands',
    'exporter',
    'metadata-backfill.toml',
  );
  const diagnosePageCommandPath = resolve(
    extensionDir,
    'commands',
    'exporter',
    'diagnose-page.toml',
  );
  const captureArtifactsCommandPath = resolve(
    extensionDir,
    'commands',
    'exporter',
    'capture-artifacts.toml',
  );
  const telemetryCommandPath = resolve(extensionDir, 'commands', 'exporter', 'telemetry.toml');
  const docsDir = resolve(extensionDir, 'docs');
  const telemetryDocPath = resolve(extensionDir, 'docs', 'reference', 'telemetry.md');
  const superpowersDocsPath = resolve(extensionDir, 'docs', 'superpowers');
  const repairAuditScriptPath = resolve(extensionDir, 'scripts', 'vault-repair-audit.mjs');
  const repairScriptPath = resolve(extensionDir, 'scripts', 'vault-repair.mjs');
  const metadataBackfillScriptPath = resolve(
    extensionDir,
    'scripts',
    'chat-metadata-backfill.mjs',
  );
  const nativeHostManifestScriptPath = resolve(extensionDir, 'scripts', 'native-host-manifest.mjs');
  const hookScriptPath = resolve(
    extensionDir,
    'scripts',
    'hooks',
    'gemini-md-export-hook.mjs',
  );

  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(contextPath), true);
  assert.equal(existsSync(serverPath), true);
  assert.equal(existsSync(bridgeServerPath), true);
  assert.equal(existsSync(guardPath), true);
  assert.equal(existsSync(browserLaunchPath), true);
  assert.equal(existsSync(jobProgressBroadcastPath), true);
  assert.equal(existsSync(jobTracePath), true);
  assert.equal(existsSync(tabSessionPath), true);
  assert.equal(existsSync(timeoutDiagnosticsPath), true);
  assert.equal(existsSync(telemetryPath), true);
  assert.equal(existsSync(compiledTakeoutAdapterPath), true);
  assert.equal(existsSync(compiledMetadataEvidencePath), true);
  assert.equal(existsSync(compiledNativeHostRuntimePath), true);
  assert.equal(existsSync(nativeHostPath), true);
  assert.equal(existsSync(bridgeVersionPath), true);
  assert.equal(existsSync(browserManifestPath), true);
  assert.equal(existsSync(artifactCapturePath), true);
  assert.equal(existsSync(activityContentScriptPath), true);
  assert.equal(existsSync(offscreenHtmlPath), true);
  assert.equal(existsSync(offscreenScriptPath), true);
  assert.equal(existsSync(chromeDebuggerPath), true);
  assert.equal(existsSync(nativeHostBinPath), true);
  assert.equal(existsSync(nativeManifestTemplatePath), true);
  assert.equal(existsSync(hooksConfigPath), true);
  for (const skillName of skillNames) {
    assert.equal(existsSync(resolve(extensionDir, 'skills', skillName, 'SKILL.md')), true);
    const skill = readFileSync(resolve(extensionDir, 'skills', skillName, 'SKILL.md'), 'utf-8');
    assert.match(skill, /^---\nname: /);
    assert.match(skill, /^description: /m);
  }
  assert.equal(existsSync(repairAgentPath), true);
  assert.equal(existsSync(syncCommandPath), true);
  assert.equal(existsSync(fixVaultCommandPath), true);
  assert.equal(existsSync(repairCommandPath), false);
  assert.equal(existsSync(metadataBackfillCommandPath), false);
  assert.equal(existsSync(diagnosePageCommandPath), true);
  assert.equal(existsSync(captureArtifactsCommandPath), true);
  assert.equal(existsSync(telemetryCommandPath), true);
  assert.equal(existsSync(telemetryDocPath), true);
  assert.equal(existsSync(superpowersDocsPath), false);
  assert.deepEqual(
    listFilesRecursive(docsDir).filter((filePath) =>
      filePath.split('/').includes('superpowers') || filePath.split('/').includes('plans'),
    ),
    [],
  );
  assert.equal(existsSync(repairAuditScriptPath), true);
  assert.equal(existsSync(repairScriptPath), true);
  assert.equal(existsSync(metadataBackfillScriptPath), true);
  assert.equal(existsSync(nativeHostManifestScriptPath), true);
  assert.equal(existsSync(hookScriptPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const browserManifest = JSON.parse(readFileSync(browserManifestPath, 'utf-8'));
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
  assert.ok(
    browserManifest.host_permissions.includes('https://*.usercontent.goog/*'),
    'browser extension precisa conseguir diagnosticar iframes scf.usercontent.goog',
  );
  assert.ok(
    browserManifest.host_permissions.includes('https://myactivity.google.com/*'),
    'browser extension precisa acessar My Activity para backfill de datas',
  );
  assert.ok(
    browserManifest.host_permissions.includes('https://www.google.com/sorry/*'),
    'browser extension precisa detectar tela de verificacao do Google',
  );
  assert.ok(
    browserManifest.host_permissions.includes('https://accounts.google.com/*'),
    'browser extension precisa detectar login do Google antes do Gemini',
  );
  assert.ok(
    browserManifest.content_scripts.some(
      (entry) =>
        entry.js?.includes('activity-content-script.js') &&
        entry.run_at === 'document_idle' &&
        entry.matches?.includes('https://myactivity.google.com/product/gemini*'),
    ),
    'browser extension precisa registrar content script dedicado no My Activity',
  );
  assert.ok(
    browserManifest.content_scripts.some(
      (entry) =>
        entry.js?.includes('google-blocker-content-script.js') &&
        entry.run_at === 'document_idle' &&
        entry.matches?.includes('https://www.google.com/sorry/*') &&
        entry.matches?.includes('https://accounts.google.com/*'),
    ),
    'browser extension precisa registrar content script para bloqueios Google',
  );
  assert.ok(
    browserManifest.content_scripts.some(
      (entry) =>
        entry.js?.includes('artifact-capture.js') &&
        entry.all_frames === true &&
        entry.run_at === 'document_start' &&
        entry.matches?.includes('https://*.usercontent.goog/gemini-code-immersive/*'),
    ),
    'browser extension precisa capturar postMessage dos iframes gemini-code-immersive',
  );

  const hooksConfig = JSON.parse(readFileSync(hooksConfigPath, 'utf-8'));
  assert.deepEqual(hooksConfig, { hooks: {} });

  const hookSource = readFileSync(hookScriptPath, 'utf-8');
  assert.match(hookSource, /hooksRegisteredByDefault:\s*false/);
  assert.doesNotMatch(hookSource, /Start-Process/);
  assert.doesNotMatch(hookSource, /waitForConnectedBrowserClient/);
  assert.doesNotMatch(hookSource, /decision:\s*'deny'/);

  const repairAgent = readFileSync(repairAgentPath, 'utf-8');
  assert.match(repairAgent, /^---\nname: gemini-vault-repair/m);
  assert.match(repairAgent, /^model: gemini-3-flash-preview$/m);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_ready/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_chats/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_export/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_job/);
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

  const syncCommand = readFileSync(syncCommandPath, 'utf-8');
  assert.match(syncCommand, /gemini-vault-sync/);
  assert.match(syncCommand, /code: "use_cli"/);
  assert.match(syncCommand, /gemini-md-export\.mjs/);
  assert.match(syncCommand, /vault correto ja conhecido/);
  assert.match(syncCommand, /Nao pergunte pelo caminho apenas porque/);
  assert.doesNotMatch(syncCommand, /acompanhe com `gemini_job`/);
  assert.match(syncCommand, /nao liste todo o historico/i);

  const fixVaultCommand = readFileSync(fixVaultCommandPath, 'utf-8');
  assert.match(fixVaultCommand, /gemini-md-export\.mjs fix-vault/);
  assert.match(fixVaultCommand, /--takeout/);
  assert.match(fixVaultCommand, /My Activity/);
  assert.match(fixVaultCommand, /vault-repair\.mjs/);
  assert.match(fixVaultCommand, /chat-metadata-backfill\.mjs/);
  assert.match(fixVaultCommand, /nao exponha `repair-vault`/i);

  const captureArtifactsCommand = readFileSync(captureArtifactsCommandPath, 'utf-8');
  assert.match(captureArtifactsCommand, /--save-html/);
  assert.match(captureArtifactsCommand, /--output-dir/);
  assert.match(captureArtifactsCommand, /Captura HTML/);
  assert.match(captureArtifactsCommand, /N(?:ao|\u00e3o) tente burlar/);

  const telemetryCommand = readFileSync(telemetryCommandPath, 'utf-8');
  assert.match(telemetryCommand, /telemetry enable/);
  assert.match(telemetryCommand, /telemetry send/);
  assert.match(readFileSync(telemetryDocPath, 'utf-8'), /gemini-md-export-telemetry/);

  const bridgeVersion = JSON.parse(readFileSync(bridgeVersionPath, 'utf-8'));
  assert.ok(browserManifest.host_permissions.includes('https://lh3.google.com/*'));
  assert.ok(browserManifest.host_permissions.includes('https://*.googleusercontent.com/*'));
  assert.ok(browserManifest.permissions.includes('storage'));
  assert.ok(browserManifest.permissions.includes('tabGroups'));
  assert.ok(browserManifest.permissions.includes('scripting'));
  assert.ok(browserManifest.permissions.includes('nativeMessaging'));
  assert.ok(browserManifest.permissions.includes('offscreen'));
  assert.ok(browserManifest.permissions.includes('debugger'));
  assert.equal(browserManifest.permissions.includes('alarms'), false);
  assert.equal(browserManifest.version, bridgeVersion.extensionVersion);
  assert.equal(typeof bridgeVersion.protocolVersion, 'number');

  const context = readFileSync(contextPath, 'utf-8');
  const chatInventorySkill = readFileSync(
    resolve(extensionDir, 'skills', 'gemini-chat-inventory', 'SKILL.md'),
    'utf-8',
  );
  const vaultSyncSkill = readFileSync(
    resolve(extensionDir, 'skills', 'gemini-vault-sync', 'SKILL.md'),
    'utf-8',
  );
  assert.equal(context.length < 7000, true);
  assert.match(context, /Only these MCP tools are public/);
  for (const toolName of [
    'gemini_ready',
    'gemini_tabs',
    'gemini_chats',
    'gemini_export',
    'gemini_job',
    'gemini_config',
    'gemini_support',
  ]) {
    assert.match(context, new RegExp(toolName));
  }
  assert.match(context, /gemini-vault-sync/);
  assert.match(context, /gemini-vault-repair/);
  assert.match(context, /gemini-mcp-diagnostics/);
  assert.match(context, /gemini-tabs-and-browser/);
  assert.match(context, /gemini-chat-inventory/);
  assert.match(context, /gemini-md-export telemetry/);
  assert.match(context, /with `--tui` by default for every human-facing command/);
  assert.match(context, /Add `--result-json`/);
  assert.match(context, /chats list --limit 10 --save-selection --tui --result-json/);
  assert.match(context, /export selected --selection-file/);
  assert.match(context, /--expected-count/);
  assert.match(context, /job list --active --tui --result-json/);
  assert.match(context, /detail: "full"/);
  assert.match(context, /code: "tool_renamed"/);
  assert.match(context, /code: "use_cli"/);
  assert.doesNotMatch(context, /gemini_export_recent_chats/);
  assert.doesNotMatch(context, /gemini_download_chat/);
  assert.match(chatInventorySkill, /chats list --limit/);
  assert.match(chatInventorySkill, /--tui --result-json/);
  assert.match(chatInventorySkill, /export selected --selection-file/);
  assert.match(chatInventorySkill, /--expected-count/);
  assert.match(chatInventorySkill, /job list --active --tui --result-json/);
  assert.doesNotMatch(chatInventorySkill, /export recent --limit/);
  assert.match(vaultSyncSkill, /export selected --selection-file/);
  assert.match(vaultSyncSkill, /every human-facing bundled CLI command\s+with `--tui`/);
  assert.match(vaultSyncSkill, /Do not use `--plain` just\s+because a command is short/);
  assert.match(vaultSyncSkill, /--expected-count/);
  assert.match(vaultSyncSkill, /job list --active --tui --result-json/);
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

test('repair runner aceita Takeout como evidencia sanitizada de integridade', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-repair-takeout-'));
  const chatId = 'b8e7c075effe9457';
  const notePath = resolve(root, `${chatId}.md`);
  const takeoutPath = resolve(root, 'Minhaatividade.html');
  const reportDir = resolve(root, 'repair-report');

  try {
    writeFileSync(
      notePath,
      [
        '---',
        `chat_id: ${chatId}`,
        'title: "ISRS"',
        `url: https://gemini.google.com/app/${chatId}`,
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
        '<div>Explique o mecanismo dos ISRS com detalhes clinicos</div>',
        '<div>Os ISRS bloqueiam o transportador de serotonina e aumentam serotonina sinaptica.</div>',
        '<div>10 de mai. de 2026, 06:46:09 BRT</div>',
        '</div>',
        '</body></html>',
      ].join('\n'),
      'utf-8',
    );

    const scriptPath = resolve(ROOT, 'gemini-cli-extension', 'scripts', 'vault-repair.mjs');
    const output = execFileSync(
      process.execPath,
      [scriptPath, '--dry-run', '--takeout', takeoutPath, '--report-dir', reportDir, root],
      { encoding: 'utf-8' },
    );
    const summary = JSON.parse(output);
    const preliminary = JSON.parse(readFileSync(summary.preliminaryReportPath, 'utf-8'));
    const item = preliminary.itemsNeedingDirectVerificationFirst.find(
      (candidate) => candidate.chatId === chatId,
    );
    const serialized = JSON.stringify(preliminary);

    assert.equal(preliminary.takeoutEvidence.summary.itemsIndexed, 1);
    assert.equal(preliminary.takeoutEvidence.summary.matched, 1);
    assert.equal(item.takeoutEvidence.status, 'matched');
    assert.equal(item.takeoutEvidence.dateCreated, '2026-05-10T09:46:09Z');
    assert.equal(item.takeoutEvidence.dateLastMessage, '2026-05-10T09:46:09Z');
    assert.doesNotMatch(serialized, /Explique o mecanismo dos ISRS/);
    assert.doesNotMatch(serialized, /bloqueiam o transportador/);
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
        if (
          req.url !== '/agent/mcp-tool-call' &&
          req.url !== '/agent/reexport-chats' &&
          !String(req.url).startsWith('/agent/export-job-status')
        ) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }

        const payload = req.method === 'POST' ? await readRequestJson(req) : {};
        const args =
          req.url === '/agent/reexport-chats'
            ? payload
            : payload.arguments || {};
        if (
          (payload.name === 'gemini_export' && args.action === 'reexport') ||
          req.url === '/agent/reexport-chats'
        ) {
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
          const started = {
            jobId,
            status: 'running',
            reportFile,
            successCount: successes.length,
            failureCount: 0,
          };
          if (req.url === '/agent/reexport-chats') {
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end(JSON.stringify(started));
          } else {
            sendToolResult(res, started);
          }
          return;
        }

        if (
          (payload.name === 'gemini_job' && args.action === 'status') ||
          String(req.url).startsWith('/agent/export-job-status')
        ) {
          const jobId = args.jobId || new URL(req.url, 'http://127.0.0.1').searchParams.get('jobId');
          const job = jobs.get(jobId);
          const statusPayload = {
            jobId,
            status: 'completed',
            phase: 'done',
            reportFile: job.reportFile,
            successCount: job.successes.length,
            failureCount: 0,
            recentSuccesses: job.successes,
            failures: [],
          };
          if (String(req.url).startsWith('/agent/export-job-status')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(statusPayload));
          } else {
            sendToolResult(res, statusPayload);
          }
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
