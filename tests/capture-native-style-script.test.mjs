import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const script = new URL('../build/ts/cli/capture-native-style.js', import.meta.url);
const fixture = new URL('./fixtures/native-style/gemini-lr26-dia-native.json', import.meta.url);

test('capture-native-style validates sanitized fixture in check mode', () => {
  const result = spawnSync(
    process.execPath,
    [script.pathname, '--fixture', fixture.pathname, '--check', '--json'],
    {
      cwd: root.pathname,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'check');
  assert.equal(payload.profileName, 'gemini-lr26-dia-native');
  assert.equal(payload.tokenCount, 59);
  assert.equal(payload.outputPath, null);
});

test('capture-native-style fails closed when live capture lacks an output path', () => {
  const result = spawnSync(process.execPath, [script.pathname, '--json'], {
    cwd: root.pathname,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /--out is required/);
});
