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
  const hookScriptPath = resolve(
    extensionDir,
    'scripts',
    'hooks',
    'gemini-md-export-hook.mjs',
  );
  const hookPrelaunchPath = resolve(
    extensionDir,
    'scripts',
    'hooks',
    'prelaunch-browser-windows.ps1',
  );

  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(contextPath), true);
  assert.equal(existsSync(serverPath), true);
  assert.equal(existsSync(guardPath), true);
  assert.equal(existsSync(browserLaunchPath), true);
  assert.equal(existsSync(bridgeVersionPath), true);
  assert.equal(existsSync(browserManifestPath), true);
  assert.equal(existsSync(hooksConfigPath), true);
  assert.equal(existsSync(hookScriptPath), true);
  assert.equal(existsSync(hookPrelaunchPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  assert.equal(manifest.contextFileName, 'GEMINI.md');
  assert.equal(manifest.hooks, undefined);
  assert.equal(typeof manifest.mcpServers?.['gemini-md-export']?.command, 'string');
  assert.match(
    manifest.mcpServers?.['gemini-md-export']?.args?.[0] || '',
    /mcp-server\.js$/,
  );
  assert.equal(manifest.mcpServers?.['gemini-md-export']?.cwd, undefined);

  const hooksConfig = JSON.parse(readFileSync(hooksConfigPath, 'utf-8'));
  assert.ok(Array.isArray(hooksConfig.hooks?.SessionStart));
  assert.ok(Array.isArray(hooksConfig.hooks?.AfterTool));
  assert.ok(Array.isArray(hooksConfig.hooks?.BeforeTool));
  assert.match(
    hooksConfig.hooks.SessionStart[0].hooks[0].command,
    /\$\{extensionPath\}.*gemini-md-export-hook\.mjs/,
  );

  const browserManifest = JSON.parse(readFileSync(browserManifestPath, 'utf-8'));
  const bridgeVersion = JSON.parse(readFileSync(bridgeVersionPath, 'utf-8'));
  assert.ok(browserManifest.host_permissions.includes('https://lh3.google.com/*'));
  assert.ok(browserManifest.host_permissions.includes('https://*.googleusercontent.com/*'));
  assert.ok(browserManifest.permissions.includes('storage'));
  assert.equal(browserManifest.version, bridgeVersion.extensionVersion);
  assert.equal(typeof bridgeVersion.protocolVersion, 'number');
});
