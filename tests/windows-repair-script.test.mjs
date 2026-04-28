import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('Windows repair script is published as a standalone safe recovery path', () => {
  const script = readFileSync(
    resolve(ROOT, 'scripts', 'repair-windows-gemini-extension.ps1'),
    'utf-8',
  );
  const releaseBuilder = readFileSync(
    resolve(ROOT, 'scripts', 'build-release-windows-prebuilt.mjs'),
    'utf-8',
  );
  const workflow = readFileSync(resolve(ROOT, '.github', 'workflows', 'release-windows.yml'), 'utf-8');

  assert.match(script, /gemini extensions uninstall/);
  assert.match(script, /gemini extensions install/);
  assert.match(script, /--auto-update/);
  assert.match(script, /Assert-InstalledExtension/);
  assert.match(script, /cwd/);
  assert.match(releaseBuilder, /repair-windows-gemini-extension\.ps1/);
  assert.match(workflow, /repair-windows-gemini-extension\.ps1/);
});
