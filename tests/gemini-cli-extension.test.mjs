import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  assert.notEqual(hooksConfig.hooks.BeforeTool[0].matcher, '*');
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /browser_status/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /export_missing_chats/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /mcp_\+gemini/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /get_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /set_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_status/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_cancel/);
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /reexport/);
  assert.equal(hooksConfig.hooks.BeforeTool[0].hooks[0].timeout, 20000);

  const repairAgent = readFileSync(repairAgentPath, 'utf-8');
  assert.match(repairAgent, /^---\nname: gemini-vault-repair/m);
  assert.match(repairAgent, /^model: gemini-3-flash-preview$/m);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_download_chat/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_reexport_chats/);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_export_job_status/);
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
  assert.match(context, /Only ask for manual reload/);
  assert.match(context, /Do not keep\s+calling `gemini_download_chat`/);
  assert.match(context, /gemini_reexport_chats/);
  assert.match(context, /gemini_export_missing_chats/);
  assert.match(context, /webConversationCount - existingVaultCount = missingCount/);
  assert.match(context, /assets\/<chatId>\/\.\.\.` stay\s+inside the vault/);
  assert.match(context, /Do not emulate this by\s+listing pages in chat/);
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
