import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  applyPrivateApiSessionDefaults,
  privateApiSessionStorageCandidates,
  resolvePrivateApiSessionStoragePath,
} from '../build/ts/cli/private-api-session-store.js';

const withTempHome = (name) => {
  const root = resolve(tmpdir(), `gme-session-store-${process.pid}-${name}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
};

test('private API session store prefers explicit cookiesJson flag', () => {
  const homeDir = withTempHome('explicit');
  const envPath = join(homeDir, 'env-storage-state.json');
  writeFileSync(envPath, '{"cookies":[]}\n', 'utf-8');

  try {
    const flags = applyPrivateApiSessionDefaults(
      { cookiesJson: '/tmp/explicit-storage-state.json' },
      { env: { GME_GEMINI_WEBAPI_STORAGE_STATE: envPath }, homeDir },
    );

    assert.equal(flags.cookiesJson, '/tmp/explicit-storage-state.json');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('private API session store uses env storage_state path when present', () => {
  const homeDir = withTempHome('env');
  const envPath = join(homeDir, 'google-storage-state.json');
  writeFileSync(envPath, '{"cookies":[]}\n', 'utf-8');

  try {
    assert.equal(
      resolvePrivateApiSessionStoragePath({
        env: { GME_GEMINI_WEBAPI_STORAGE_STATE: envPath },
        homeDir,
      }),
      envPath,
    );
    assert.equal(
      applyPrivateApiSessionDefaults(
        { bridgeUrl: 'http://127.0.0.1:47283' },
        { env: { GME_GEMINI_WEBAPI_STORAGE_STATE: envPath }, homeDir },
      ).cookiesJson,
      envPath,
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('private API session store finds default persisted storage_state', () => {
  const homeDir = withTempHome('default');
  const defaultPath = join(homeDir, '.gemini-md-export', 'google-storage-state.json');
  mkdirSync(join(homeDir, '.gemini-md-export'), { recursive: true });
  writeFileSync(defaultPath, '{"cookies":[]}\n', 'utf-8');

  try {
    assert.deepEqual(privateApiSessionStorageCandidates({ env: {}, homeDir }).slice(0, 2), [
      defaultPath,
      join(homeDir, '.gemini-md-export', 'storage_state.json'),
    ]);
    assert.equal(resolvePrivateApiSessionStoragePath({ env: {}, homeDir }), defaultPath);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('private API session store returns original flags when no persisted session exists', () => {
  const homeDir = withTempHome('missing');

  try {
    const flags = { bridgeUrl: 'http://127.0.0.1:47283' };
    const resolved = applyPrivateApiSessionDefaults(flags, { env: {}, homeDir });

    assert.equal(resolvePrivateApiSessionStoragePath({ env: {}, homeDir }), null);
    assert.deepEqual(resolved, flags);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
