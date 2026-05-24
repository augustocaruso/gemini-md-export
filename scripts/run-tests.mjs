#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testsDir = resolve(root, 'tests');

const collectTestFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectTestFiles(path, out);
    } else if (entry.endsWith('.test.mjs')) {
      out.push(path);
    }
  }
  return out.sort();
};

const files = collectTestFiles(testsDir);
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
