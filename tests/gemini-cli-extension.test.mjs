import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  assert.match(hooksConfig.hooks.BeforeTool[0].matcher, /mcp_\+gemini/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /get_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /set_export_dir/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_status/);
  assert.doesNotMatch(hooksConfig.hooks.BeforeTool[0].matcher, /export_job_cancel/);
  assert.equal(hooksConfig.hooks.BeforeTool[0].hooks[0].timeout, 20000);

  const repairAgent = readFileSync(repairAgentPath, 'utf-8');
  assert.match(repairAgent, /^---\nname: gemini-vault-repair/m);
  assert.match(repairAgent, /mcp_gemini-md-export_gemini_download_chat/);
  assert.match(repairAgent, /vault-repair-audit\.mjs/);
  assert.match(repairAgent, /wikiCandidate/);

  const repairCommand = readFileSync(repairCommandPath, 'utf-8');
  assert.match(repairCommand, /gemini-vault-repair/);
  assert.match(repairCommand, /vault-repair-audit\.mjs/);

  const browserManifest = JSON.parse(readFileSync(browserManifestPath, 'utf-8'));
  const bridgeVersion = JSON.parse(readFileSync(bridgeVersionPath, 'utf-8'));
  assert.ok(browserManifest.host_permissions.includes('https://lh3.google.com/*'));
  assert.ok(browserManifest.host_permissions.includes('https://*.googleusercontent.com/*'));
  assert.ok(browserManifest.permissions.includes('storage'));
  assert.equal(browserManifest.version, bridgeVersion.extensionVersion);
  assert.equal(typeof bridgeVersion.protocolVersion, 'number');
});
