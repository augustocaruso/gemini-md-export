#!/usr/bin/env node

import { mkdtempSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCE_DIR = resolve(ROOT, 'dist', 'gemini-cli-extension');
const BRANCH = process.env.GME_GEMINI_EXTENSION_BRANCH || 'gemini-cli-extension';
const REMOTE_NAME = 'publish-origin';

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
};

const output = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
};

const remoteUrl = () => {
  if (process.env.GME_GEMINI_EXTENSION_REMOTE_URL) {
    return process.env.GME_GEMINI_EXTENSION_REMOTE_URL;
  }
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    return `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
  }
  return output('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
};

if (!existsSync(resolve(SOURCE_DIR, 'gemini-extension.json'))) {
  console.error(`Missing ${resolve(SOURCE_DIR, 'gemini-extension.json')}. Run npm run build first.`);
  process.exit(1);
}

const workDir = mkdtempSync(resolve(tmpdir(), 'gemini-md-export-extension-branch-'));

try {
  cpSync(SOURCE_DIR, workDir, { recursive: true });
  run('git', ['init'], { cwd: workDir });
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: workDir });
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], {
    cwd: workDir,
  });
  run('git', ['add', '.'], { cwd: workDir });
  run('git', ['commit', '-m', 'build: publicar extensao gemini cli'], { cwd: workDir });
  run('git', ['branch', '-M', BRANCH], { cwd: workDir });
  run('git', ['remote', 'add', REMOTE_NAME, remoteUrl()], { cwd: workDir });
  run('git', ['push', '--force', REMOTE_NAME, `${BRANCH}:refs/heads/${BRANCH}`], { cwd: workDir });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
