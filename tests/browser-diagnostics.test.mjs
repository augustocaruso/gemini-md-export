import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import {
  buildLocalDoctorReport,
  nativeHostManifestPath,
  securePreferencesPath,
} from '../src/browser-diagnostics.mjs';

const writeJson = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
};

test('diagnostico local encontra extensao e native host no Dia', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-dia-doctor-'));
  try {
    const packageRoot = resolve(home, 'pkg');
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const extensionPath = resolve(packageRoot, 'browser-extension');
    const nativeHostPath = resolve(packageRoot, 'bin', 'gemini-md-export-native-host.mjs');
    mkdirSync(extensionPath, { recursive: true });
    mkdirSync(resolve(packageRoot, 'bin'), { recursive: true });
    writeFileSync(nativeHostPath, '#!/usr/bin/env node\n', 'utf-8');
    writeJson(resolve(extensionPath, 'manifest.json'), {
      manifest_version: 3,
      name: 'Gemini Chat -> Markdown Export',
      version: '0.8.6',
    });

    const securePrefs = securePreferencesPath({
      browser: 'dia',
      home,
      platform: 'darwin',
      profileDirectory: 'Default',
    });
    writeJson(securePrefs, {
      extensions: {
        settings: {
          [extensionId]: {
            location: 4,
            state: 1,
            path: extensionPath,
          },
        },
      },
    });

    writeJson(
      nativeHostManifestPath({ browser: 'dia', home, platform: 'darwin' }),
      {
        name: 'com.augustocaruso.gemini_md_export',
        description: 'Gemini Markdown Export native host',
        path: nativeHostPath,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
    );

    const report = buildLocalDoctorReport({
      browser: 'dia',
      home,
      packageRoot,
      platform: 'darwin',
      profileDirectory: 'Default',
      version: '0.8.6',
    });

    assert.equal(report.ok, true);
    assert.equal(report.browser, 'dia');
    assert.equal(report.loadedExtension.extension.id, extensionId);
    assert.equal(report.loadedExtension.extension.locationKind, 'unpacked');
    assert.equal(report.nativeHost.status, 'ready');
    assert.equal(report.warnings.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('diagnostico local sinaliza runtime antigo e native host ausente', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-stale-doctor-'));
  try {
    const packageRoot = resolve(home, 'pkg');
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const extensionPath = resolve(packageRoot, 'browser-extension');
    const staleExtensionPath = resolve(home, 'old-runtime', 'browser-extension');
    mkdirSync(extensionPath, { recursive: true });
    mkdirSync(staleExtensionPath, { recursive: true });
    writeJson(resolve(extensionPath, 'manifest.json'), {
      manifest_version: 3,
      name: 'Gemini Chat -> Markdown Export',
      version: '0.8.6',
    });
    writeJson(resolve(staleExtensionPath, 'manifest.json'), {
      manifest_version: 3,
      name: 'Gemini Chat -> Markdown Export',
      version: '0.8.5',
    });
    writeJson(
      securePreferencesPath({
        browser: 'dia',
        home,
        platform: 'darwin',
        profileDirectory: 'Default',
      }),
      {
        extensions: {
          settings: {
            [extensionId]: {
              location: 4,
              path: staleExtensionPath,
            },
          },
        },
      },
    );

    const report = buildLocalDoctorReport({
      browser: 'dia',
      home,
      packageRoot,
      platform: 'darwin',
      profileDirectory: 'Default',
      version: '0.8.6',
    });

    assert.equal(report.ok, false);
    assert.ok(report.warnings.includes('runtime_versao_diferente_dos_arquivos'));
    assert.ok(report.warnings.includes('native_host_missing'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
