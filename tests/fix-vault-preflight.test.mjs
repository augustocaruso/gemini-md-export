import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildFixVaultPreflightReport,
  fixVaultPreflightPlainLabel,
} from '../build/ts/cli/fix-vault-preflight.js';

test('fix-vault preflight marks the private API happy path as ready without browser', async () => {
  const root = resolve(tmpdir(), `gme-preflight-ready-${process.pid}-${Date.now()}`);
  const vaultDir = join(root, 'vault');
  const takeout = join(root, 'takeout.zip');
  const cookiesJson = join(root, 'storage_state.json');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(takeout, 'zip fixture');
  writeFileSync(cookiesJson, '{"cookies":[]}');

  try {
    const report = await buildFixVaultPreflightReport({
      flags: { vaultDir, takeout, cookiesJson, bridgeUrl: 'http://127.0.0.1:47283' },
      deps: {
        checkMarkdownDb: async () => ({ ok: true }),
        checkAuthStatus: async () => ({ ok: true, selectedAdapter: 'privateApiGeminiWebapi' }),
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.requiresBrowser, false);
    assert.equal(report.checks.vault.ok, true);
    assert.equal(report.checks.takeout.ok, true);
    assert.equal(report.checks.session.ok, true);
    assert.equal(report.checks.markdownDb.ok, true);
    assert.match(fixVaultPreflightPlainLabel(report), /pronto/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-vault preflight accepts authenticated browserBackground without storage state', async () => {
  const root = resolve(tmpdir(), `gme-preflight-browser-${process.pid}-${Date.now()}`);
  const vaultDir = join(root, 'vault');
  const takeout = join(root, 'takeout.zip');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(takeout, 'zip fixture');

  try {
    const report = await buildFixVaultPreflightReport({
      flags: { vaultDir, takeout, bridgeUrl: 'http://127.0.0.1:47283' },
      deps: {
        checkMarkdownDb: async () => ({ ok: true }),
        checkAuthStatus: async () => ({ ok: true, selectedAdapter: 'browserBackground' }),
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.requiresBrowser, false);
    assert.equal(report.checks.session.ok, true);
    assert.equal(report.checks.session.selectedAdapter, 'browserBackground');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-vault preflight explains missing vault, takeout and session plainly', async () => {
  const root = resolve(tmpdir(), `gme-preflight-missing-${process.pid}-${Date.now()}`);
  try {
    const report = await buildFixVaultPreflightReport({
      flags: {
        vaultDir: join(root, 'missing-vault'),
        takeout: join(root, 'missing.zip'),
        bridgeUrl: 'http://127.0.0.1:47283',
      },
      deps: {
        checkMarkdownDb: async () => ({ ok: false, message: 'mddb ausente' }),
        checkAuthStatus: async () => ({
          ok: false,
          nextAction: { message: 'Atualize os cookies.' },
        }),
      },
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.vault.ok, false);
    assert.equal(report.checks.takeout.ok, false);
    assert.equal(report.checks.session.ok, false);
    assert.equal(report.nextAction.code, 'fix_vault_preflight_failed');
    assert.match(fixVaultPreflightPlainLabel(report), /requer acao/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
