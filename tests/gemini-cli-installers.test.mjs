import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('instalador Windows verifica e repara instalacao da extensao Gemini CLI', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'install-windows.mjs'), 'utf-8');
  const prebuiltRelease = readFileSync(
    resolve(ROOT, 'scripts', 'build-release-windows-prebuilt.mjs'),
    'utf-8',
  );
  const standaloneRelease = readFileSync(resolve(ROOT, 'scripts', 'build-release-windows.mjs'), 'utf-8');

  assert.match(source, /verifyGeminiCliExtensionInstall/);
  assert.match(source, /installGeminiCliExtensionOfficial/);
  assert.match(source, /gemini-extensions-install-retried/);
  assert.match(source, /stopRunningExporterMcpProcesses/);
  assert.match(source, /manifest-missing/);
  assert.match(source, /browser-extension['"], ['"]manifest\.json/);
  assert.match(source, /windows-extension-sync-plan\.js/);
  assert.match(source, /Dependencias do pacote/);
  assert.match(source, /prebuilt: dependencias ja embutidas/);
  assert.doesNotMatch(prebuiltRelease, /scripts\/lib\/windows-extension-sync-plan\.mjs/);
  assert.doesNotMatch(standaloneRelease, /scripts\/lib\/windows-extension-sync-plan\.mjs/);
});

test('instalador Windows ignora arquivos AppleDouble do macOS ao copiar pacotes', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'install-windows.mjs'), 'utf-8');

  assert.match(source, /isInstallCopyAllowed/);
  assert.match(source, /AppleDouble/);
  assert.match(source, /\\\._\.\*/);
  assert.match(source, /\.DS_Store/);
  assert.match(source, /filter: isInstallCopyAllowed/);
});

test('instalador macOS verifica e repara instalacao da extensao Gemini CLI', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'install-macos.sh'), 'utf-8');

  assert.match(source, /verify_gemini_cli_extension_install/);
  assert.match(source, /stop_running_mcp_processes/);
  assert.match(source, /copy_gemini_cli_fallback/);
  assert.match(source, /tentando reinstalacao oficial mais uma vez/);
  assert.match(source, /browser-extension.+manifest\.json/s);
});
