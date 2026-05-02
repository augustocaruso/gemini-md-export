import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SMOKE_SCRIPT = resolve(ROOT, 'scripts', 'bridge-smoke.mjs');

test('bridge smoke valida healthz, snapshot, SSE, ready, clients e diagnostico sem login', () => {
  const output = execFileSync(process.execPath, [SMOKE_SCRIPT, '--spawn', '--json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 20000,
  });
  const result = JSON.parse(output);
  const checkNames = result.checks.map((check) => check.name);

  assert.equal(result.ok, true);
  assert.equal(result.health.name, 'gemini-md-export');
  assert.equal(result.health.bridgeRole, 'primary');
  assert.equal(result.expected.protocolVersion, 2);
  assert.deepEqual(checkNames, [
    'healthz',
    'agent_expected_extension',
    'bridge_snapshot',
    'bridge_events_sse',
    'bridge_heartbeat',
    'bridge_heartbeat_extension_origin',
    'agent_ready',
    'agent_clients',
    'agent_diagnostics',
    'process_diagnostics',
  ]);
  assert.equal(result.checks.every((check) => check.ok), true);
  assert.equal(
    result.checks.find((check) => check.name === 'agent_clients').value.smokeClient.bridgeHealth.status,
    'healthy',
  );
  assert.equal(result.checks.find((check) => check.name === 'agent_ready').value.ready, true);
  assert.equal(
    result.checks.find((check) => check.name === 'agent_diagnostics').value.status,
    'ready',
  );
});

test('bridge smoke destrutivo exercita claim e release com cliente sintetico', () => {
  const output = execFileSync(
    process.execPath,
    [SMOKE_SCRIPT, '--spawn', '--destructive-fixture', '--json'],
    {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 25000,
    },
  );
  const result = JSON.parse(output);
  const destructive = result.checks.find(
    (check) => check.name === 'destructive_fixture_claim_release',
  );

  assert.equal(result.ok, true);
  assert.ok(destructive);
  assert.equal(destructive.ok, true);
  assert.equal(
    destructive.value.commands.some((command) => command.type === 'claim-tab'),
    true,
  );
  assert.equal(
    destructive.value.commands.some((command) => command.type === 'release-tab-claim'),
    true,
  );
});

test('build publica bridge-smoke no bundle da extensao Gemini CLI', () => {
  assert.equal(
    existsSync(resolve(ROOT, 'dist', 'gemini-cli-extension', 'scripts', 'bridge-smoke.mjs')),
    true,
  );
});
