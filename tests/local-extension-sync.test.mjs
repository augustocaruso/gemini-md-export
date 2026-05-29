import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readyHasExtensionMismatchClients,
  runLocalExtensionReloadPreflight,
} from '../build/ts/cli/local-extension-reload-preflight.js';
import { syncLoadedUnpackedExtension } from '../build/ts/cli/local-extension-sync.js';

const EXTENSION_NAME = 'Gemini Chat -> Markdown Export';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const writeJson = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
};

const writeExtension = (dir, { buildStamp, stale = false } = {}) => {
  mkdirSync(dir, { recursive: true });
  writeJson(resolve(dir, 'manifest.json'), {
    manifest_version: 3,
    name: EXTENSION_NAME,
    version: '0.8.56',
    background: { service_worker: 'background.js', type: 'module' },
  });
  writeFileSync(resolve(dir, 'background.js'), `const buildStamp = '${buildStamp}';\n`, 'utf-8');
  writeFileSync(resolve(dir, 'content.js'), `const BUILD_STAMP = '${buildStamp}';\n`, 'utf-8');
  mkdirSync(resolve(dir, 'assets'), { recursive: true });
  writeFileSync(resolve(dir, 'assets', 'current.txt'), `build=${buildStamp}\n`, 'utf-8');
  if (stale) writeFileSync(resolve(dir, 'stale-only.js'), 'old file\n', 'utf-8');
};

test('sincroniza pasta unpacked carregada e remove arquivos velhos antes do reload', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-local-extension-sync-'));
  try {
    const sourceDir = resolve(home, 'dist', 'extension');
    const loadedDir = resolve(home, 'Dia', 'Loaded Extension');
    writeExtension(sourceDir, { buildStamp: '20260528-1343' });
    writeExtension(loadedDir, { buildStamp: '20260528-1020', stale: true });

    const result = syncLoadedUnpackedExtension({
      allowReload: true,
      activeJobCount: 0,
      sourceDir,
      loadedExtension: {
        id: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
        locationKind: 'unpacked',
        path: loadedDir,
      },
    });

    assert.equal(result.status, 'synced');
    assert.equal(result.sourceBuildStamp, '20260528-1343');
    assert.equal(result.previousBuildStamp, '20260528-1020');
    assert.equal(result.targetBuildStamp, '20260528-1343');
    assert.equal(readFileSync(resolve(loadedDir, 'background.js'), 'utf-8'), readFileSync(resolve(sourceDir, 'background.js'), 'utf-8'));
    assert.equal(readFileSync(resolve(loadedDir, 'assets', 'current.txt'), 'utf-8'), 'build=20260528-1343\n');
    assert.equal(existsSync(resolve(loadedDir, 'stale-only.js')), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('CLI sincroniza pasta unpacked antes de recarregar abas existentes', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const preflightSource = readFileSync(
    resolve(ROOT, 'src', 'cli', 'local-extension-reload-preflight.ts'),
    'utf-8',
  );
  const readyBlock = source.match(
    /const readyWithCliWake = async \(bridgeUrl, flags, ui\) => \{[\s\S]*?\n\};\n\nconst ensureReady/,
  )?.[0] || '';

  assert.match(source, /runLocalExtensionReloadPreflight/);
  assert.doesNotMatch(source, /local-extension-cdp-reload/);
  assert.doesNotMatch(source, /reloadExtensionFromDevToolsActivePort/);
  assert.match(source, /createBridgeLocalExtensionCdpReloadPort/);
  assert.match(preflightSource, /\/agent\/cdp\/extension-reload/);
  assert.match(preflightSource, /runLocalExtensionCdpReload/);
  assert.match(preflightSource, /syncLoadedUnpackedExtension/);
  assert.match(preflightSource, /resolveSourceExtensionDir/);
  assert.match(source, /const syncLoadedExtensionBeforeReload = async/);
  assert.doesNotMatch(source, /const fetchActiveJobCountForLocalExtensionSync = async/);
  assert.ok(readyBlock.includes('localExtensionSync = await syncLoadedExtensionBeforeReload'));
  assert.ok(readyBlock.includes('localExtensionSync?.shouldReloadExistingTabs !== false'));
  assert.ok(
    readyBlock.indexOf('localExtensionSync = await syncLoadedExtensionBeforeReload') <
      readyBlock.indexOf('existingTabsReload = await reloadExistingTabsFromCli'),
  );
  assert.ok(
    readyBlock.indexOf('localExtensionSync = await syncLoadedExtensionBeforeReload') <
      readyBlock.indexOf('requestReadyStatus(bridgeUrl, flags, { waitMs: 0 })'),
  );
  assert.match(readyBlock, /localExtensionSync\?\.status === 'synced'[\s\S]*reloadExistingTabsFromCli/);
  assert.match(readyBlock, /readyHasExtensionMismatchClients\(ready\)/);
  assert.match(readyBlock, /Recarregando abas com content script antigo/);
});

test('detecta content script velho em clientes diagnosticos', () => {
  assert.equal(
    readyHasExtensionMismatchClients({
      ready: true,
      connectedClients: [
        {
          id: 'active-chat',
          bridgeHealth: { blockingIssue: null },
        },
      ],
      diagnosticClients: [
        {
          id: 'stale-chat',
          bridgeHealth: { blockingIssue: 'extension_version_mismatch' },
        },
      ],
    }),
    true,
  );
});

test('bloqueia sync e reload quando ha job ativo', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-local-extension-sync-active-job-'));
  try {
    const sourceDir = resolve(home, 'dist', 'extension');
    const loadedDir = resolve(home, 'Dia', 'Loaded Extension');
    writeExtension(sourceDir, { buildStamp: '20260528-1343' });
    writeExtension(loadedDir, { buildStamp: '20260528-1020', stale: true });

    const result = syncLoadedUnpackedExtension({
      allowReload: true,
      activeJobCount: 1,
      sourceDir,
      loadedExtension: {
        id: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
        locationKind: 'unpacked',
        path: loadedDir,
      },
    });

    assert.equal(result.status, 'blocked-active-job');
    assert.equal(readFileSync(resolve(loadedDir, 'background.js'), 'utf-8'), "const buildStamp = '20260528-1020';\n");
    assert.equal(existsSync(resolve(loadedDir, 'stale-only.js')), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('preflight aciona reload via CDP depois de sync local autorizado', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-local-extension-cdp-preflight-'));
  try {
    const sourceDir = resolve(home, 'dist', 'extension');
    const loadedDir = resolve(home, 'Dia', 'Loaded Extension');
    writeExtension(sourceDir, { buildStamp: '20260528-1343' });
    writeExtension(loadedDir, { buildStamp: '20260528-1020' });
    const calls = [];

    const result = await runLocalExtensionReloadPreflight(
      {
        allowReload: true,
        packageRoot: home,
      },
      {
        fetchActiveJobCount: async () => ({ ok: true, activeJobCount: 0 }),
        buildLocalDoctorReport: () => ({
          browser: 'dia',
          profileDirectory: 'Default',
          loadedExtension: {
            extension: {
              id: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
              locationKind: 'unpacked',
              path: loadedDir,
            },
          },
        }),
        runLocalExtensionCdpReload: async (args) => {
          calls.push(args);
          return {
            ok: true,
            attempted: true,
            mode: 'cdp-browser-websocket',
            extensionId: args.extensionId,
            targetId: 'extensions',
            targetUrl: 'chrome://extensions/?id=ikjanjokpogoakdlikhcgfgcjbgoogkc',
            devToolsActivePortFile: '/tmp/DevToolsActivePort',
          };
        },
      },
    );

    assert.equal(result.status, 'synced');
    assert.equal(result.cdpReload?.ok, true);
    assert.deepEqual(calls, [
      {
        allowReload: true,
        browser: 'dia',
        extensionId: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('nao ressincroniza quando a pasta carregada ja tem o build stamp atual', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'gme-local-extension-sync-current-'));
  try {
    const sourceDir = resolve(home, 'dist', 'extension');
    const loadedDir = resolve(home, 'Dia', 'Loaded Extension');
    writeExtension(sourceDir, { buildStamp: '20260528-1343' });
    writeExtension(loadedDir, { buildStamp: '20260528-1343', stale: true });

    const result = syncLoadedUnpackedExtension({
      allowReload: true,
      activeJobCount: 0,
      sourceDir,
      loadedExtension: {
        id: 'ikjanjokpogoakdlikhcgfgcjbgoogkc',
        locationKind: 'unpacked',
        path: loadedDir,
      },
    });

    assert.equal(result.status, 'skipped-up-to-date');
    assert.equal(result.shouldReloadExistingTabs, true);
    assert.equal(existsSync(resolve(loadedDir, 'stale-only.js')), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
