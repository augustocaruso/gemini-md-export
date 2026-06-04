import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('CLI exposes config and fix-vault doctor/smoke without putting workflow logic in bin', () => {
  const bin = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const help = readFileSync(resolve(ROOT, 'src', 'cli', 'help-text.ts'), 'utf-8');
  const fixVaultCli = readFileSync(resolve(ROOT, 'src', 'cli', 'fix-vault-cli-command.ts'), 'utf-8');

  assert.match(help, /config get\|set/);
  assert.match(help, /fix-vault doctor/);
  assert.match(help, /fix-vault smoke/);
  assert.match(bin, /runConfigCommand/);
  assert.match(bin, /runFixVaultDoctorCommand/);
  assert.match(fixVaultCli, /runFixVaultSmokeCommand/);
  assert.doesNotMatch(bin, /storage_state_missing/);
  assert.doesNotMatch(bin, /fix_vault_preflight_failed/);
});
