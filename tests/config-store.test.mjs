import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  defaultConfigPath,
  loadGeminiMdExportConfig,
  resolveGeminiMdExportVaultDir,
  saveGeminiMdExportConfig,
  setGeminiMdExportConfigValue,
} from '../build/ts/cli/config-store.js';

test('config store persists vaultDir in the default user config file', () => {
  const homeDir = resolve(tmpdir(), `gme-config-${process.pid}-${Date.now()}`);
  const vaultDir = join(homeDir, 'vault chats');
  mkdirSync(vaultDir, { recursive: true });
  try {
    const configPath = defaultConfigPath({ homeDir, env: {} });
    const saved = setGeminiMdExportConfigValue({
      key: 'vaultDir',
      value: vaultDir,
      options: { homeDir, env: {} },
    });

    assert.equal(saved.config.vaultDir, vaultDir);
    assert.equal(saved.configPath, configPath);
    assert.equal(existsSync(configPath), true);
    assert.equal(loadGeminiMdExportConfig({ homeDir, env: {} }).vaultDir, vaultDir);
    assert.match(readFileSync(configPath, 'utf-8'), /vaultDir/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('config store resolves XDG_CONFIG_HOME before home fallback', () => {
  const homeDir = resolve(tmpdir(), `gme-config-home-${process.pid}-${Date.now()}`);
  const xdgDir = resolve(tmpdir(), `gme-config-xdg-${process.pid}-${Date.now()}`);
  try {
    assert.equal(
      defaultConfigPath({ homeDir, env: { XDG_CONFIG_HOME: xdgDir } }),
      join(xdgDir, 'gemini-md-export', 'config.json'),
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(xdgDir, { recursive: true, force: true });
  }
});

test('config store rejects unknown keys instead of creating parallel config', () => {
  assert.throws(
    () =>
      saveGeminiMdExportConfig({
        config: { unknown: '/tmp/nope' },
        options: { homeDir: tmpdir(), env: {} },
      }),
    /Chave de configuracao desconhecida/,
  );
});

test('vault dir resolution tells agents exactly how to persist memory-derived paths', () => {
  const homeDir = resolve(tmpdir(), `gme-config-resolve-${process.pid}-${Date.now()}`);
  try {
    const resolution = resolveGeminiMdExportVaultDir({ options: { homeDir, env: {} } });

    assert.equal(resolution.ok, false);
    assert.equal(resolution.blockedReason, 'missing_vault_dir');
    assert.equal(resolution.requiredInputs[0], 'vaultDir');
    assert.equal(
      resolution.nextAction.command,
      'gemini-md-export config set vaultDir <absolute-path-from-agent-memory>',
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('vault dir resolution prefers explicit path, then env override, then persisted config', () => {
  const homeDir = resolve(tmpdir(), `gme-config-precedence-${process.pid}-${Date.now()}`);
  const explicitVault = join(homeDir, 'explicit');
  const envVault = join(homeDir, 'env');
  const configVault = join(homeDir, 'config');
  mkdirSync(explicitVault, { recursive: true });
  mkdirSync(envVault, { recursive: true });
  mkdirSync(configVault, { recursive: true });

  try {
    setGeminiMdExportConfigValue({
      key: 'vaultDir',
      value: configVault,
      options: { homeDir, env: {} },
    });

    assert.deepEqual(
      resolveGeminiMdExportVaultDir({
        explicitVaultDir: explicitVault,
        options: { homeDir, env: { GME_VAULT_DIR: envVault } },
      }).source,
      'explicit',
    );
    assert.deepEqual(
      resolveGeminiMdExportVaultDir({
        options: { homeDir, env: { GME_VAULT_DIR: envVault } },
      }).source,
      'env:GME_VAULT_DIR',
    );
    assert.deepEqual(
      resolveGeminiMdExportVaultDir({ options: { homeDir, env: {} } }).source,
      'config:vaultDir',
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('vault dir resolution reuses MedNotes raw_dir env when exporter config is absent', () => {
  const homeDir = resolve(tmpdir(), `gme-config-mednotes-env-${process.pid}-${Date.now()}`);
  const rawDir = join(homeDir, 'Chats_Raw');
  mkdirSync(rawDir, { recursive: true });
  try {
    const resolution = resolveGeminiMdExportVaultDir({
      options: { homeDir, env: { MED_RAW_DIR: rawDir } },
    });

    assert.equal(resolution.ok, true);
    assert.equal(resolution.vaultDir, rawDir);
    assert.equal(resolution.source, 'mednotes:env:MED_RAW_DIR');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('vault dir resolution reuses MedNotes config [paths].raw_dir as compatibility fallback', () => {
  const homeDir = resolve(tmpdir(), `gme-config-mednotes-paths-${process.pid}-${Date.now()}`);
  const rawDir = join(homeDir, 'Chats_Raw');
  const mednotesConfig = join(homeDir, '.gemini', 'medical-notes-workbench', 'config.toml');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(homeDir, '.gemini', 'medical-notes-workbench'), { recursive: true });
  writeFileSync(
    mednotesConfig,
    `[paths]\nwiki_dir = "${join(homeDir, 'Wiki_Medicina')}"\nraw_dir = "${rawDir}"\n`,
  );
  try {
    const resolution = resolveGeminiMdExportVaultDir({ options: { homeDir, env: {} } });

    assert.equal(resolution.ok, true);
    assert.equal(resolution.vaultDir, rawDir);
    assert.equal(resolution.source, 'mednotes:config:[paths].raw_dir');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('vault dir resolution reads MedNotes legacy [chat_processor].raw_dir after canonical paths', () => {
  const homeDir = resolve(tmpdir(), `gme-config-mednotes-legacy-${process.pid}-${Date.now()}`);
  const rawDir = join(homeDir, 'Legacy_Chats_Raw');
  const mednotesConfig = join(homeDir, '.gemini', 'medical-notes-workbench', 'config.toml');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(homeDir, '.gemini', 'medical-notes-workbench'), { recursive: true });
  writeFileSync(mednotesConfig, `[chat_processor]\nraw_dir = "${rawDir}"\n`);
  try {
    const resolution = resolveGeminiMdExportVaultDir({ options: { homeDir, env: {} } });

    assert.equal(resolution.ok, true);
    assert.equal(resolution.vaultDir, rawDir);
    assert.equal(resolution.source, 'mednotes:legacy_config:[chat_processor].raw_dir');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
