import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('instalador Windows verifica e repara instalacao da extensao Gemini CLI', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'install-windows.mjs'), 'utf-8');

  assert.match(source, /verifyGeminiCliExtensionInstall/);
  assert.match(source, /installGeminiCliExtensionOfficial/);
  assert.match(source, /gemini-extensions-install-retried/);
  assert.match(source, /stopRunningExporterMcpProcesses/);
  assert.match(source, /manifest-missing/);
  assert.match(source, /browser-extension['"], ['"]manifest\.json/);
});

test('instalador macOS verifica e repara instalacao da extensao Gemini CLI', () => {
  const source = readFileSync(resolve(ROOT, 'scripts', 'install-macos.sh'), 'utf-8');

  assert.match(source, /verify_gemini_cli_extension_install/);
  assert.match(source, /stop_running_mcp_processes/);
  assert.match(source, /copy_gemini_cli_fallback/);
  assert.match(source, /tentando reinstalacao oficial mais uma vez/);
  assert.match(source, /browser-extension.+manifest\.json/s);
});
