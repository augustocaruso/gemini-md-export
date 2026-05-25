#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);

const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const takeout = valueOf('--takeout');
const outputDir =
  valueOf('--output-dir') ||
  resolve(process.env.HOME || '.', 'Downloads', `gemini-md-export-native-gate-${Date.now()}`);
const maxChats = valueOf('--max-chats') || '30';

if (!takeout) {
  console.error(
    'Uso: node scripts/native-broker-release-gate-smoke.mjs --takeout <takeout.zip> [--output-dir <dir>] [--max-chats 30]',
  );
  process.exit(64);
}

mkdirSync(outputDir, { recursive: true });

const extractResultJson = (stdout) => {
  const lines = String(stdout || '').trimEnd().split(/\r?\n/).reverse();
  const marker = lines.find((line) => line.startsWith('RESULT_JSON '));
  if (!marker) return null;
  return JSON.parse(marker.slice('RESULT_JSON '.length));
};

const run = (label, commandArgs, { capture = false } = {}) => {
  console.log(`\n## ${label}`);
  console.log(`node bin/gemini-md-export.mjs ${commandArgs.join(' ')}`);
  const result = spawnSync(process.execPath, ['bin/gemini-md-export.mjs', ...commandArgs], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) process.exit(result.status || 1);
  return capture ? extractResultJson(result.stdout) : null;
};

// tabs reload
run('Native reload existing tabs', [
  'tabs',
  'reload',
  '--allow-reload',
  '--no-wake',
  '--no-activate-tab',
  '--no-focus-window',
  '--plain',
  '--result-json',
]);

// tabs list
run('Native list tabs', [
  'tabs',
  'list',
  '--no-wake',
  '--no-activate-tab',
  '--no-focus-window',
  '--plain',
  '--result-json',
]);

// tabs claim
const claimResult = run(
  'Native claim existing Gemini tab',
  [
    'tabs',
    'claim',
    '--allow-reload',
    '--no-wake',
    '--no-activate-tab',
    '--no-focus-window',
    '--plain',
    '--result-json',
  ],
  { capture: true },
);

const claimId = claimResult?.claim?.claimId;
if (!claimId) {
  console.error('Nao recebi claimId do comando tabs claim.');
  process.exit(1);
}

// export recent
run('Export recent release gate', [
  'export',
  'recent',
  '--max-chats',
  maxChats,
  '--output-dir',
  outputDir,
  '--takeout',
  takeout,
  '--claim-id',
  claimId,
  '--no-wake',
  '--activate-tab',
  '--no-focus-window',
  '--ready-wait-ms',
  '60000',
  '--timeout-ms',
  '900000',
  '--poll-ms',
  '1500',
  '--plain',
  '--result-json',
]);
