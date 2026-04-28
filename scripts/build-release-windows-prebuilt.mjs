#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RELEASE_ROOT = resolve(ROOT, 'release');

const pkgJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const version = pkgJson.version;
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '-');
const releaseName = `gemini-md-export-windows-prebuilt-v${version}-${stamp}`;
const stageDir = resolve(RELEASE_ROOT, releaseName);
const zipPath = resolve(RELEASE_ROOT, `${releaseName}.zip`);
const stableZipPath = resolve(RELEASE_ROOT, 'gemini-md-export-windows-prebuilt.zip');
const stableUpdaterPath = resolve(RELEASE_ROOT, 'update-windows.ps1');
const stableRepairPath = resolve(RELEASE_ROOT, 'repair-windows-gemini-extension.ps1');

const includePaths = [
  'dist/extension',
  'dist/gemini-cli-extension',
  'scripts/install-windows.mjs',
  'scripts/update-windows.ps1',
  'scripts/repair-windows-gemini-extension.ps1',
  'install-windows.cmd',
  'diagnose-windows-mcp.ps1',
  'LEIA-ME.txt',
  'package.json',
];

const log = (line = '') => process.stdout.write(`${line}\n`);

const run = (command, args, label, cwd = ROOT) => {
  log(`\n>> ${label}`);
  log(`   $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: processo saiu com codigo ${result.status}`);
  }
};

const ensureParentDir = (targetPath) => {
  mkdirSync(dirname(targetPath), { recursive: true });
};

const copyPath = (relativePath) => {
  const source = resolve(ROOT, relativePath);
  const target = resolve(stageDir, relativePath);
  ensureParentDir(target);

  if (!existsSync(source)) {
    throw new Error(`Arquivo/pasta obrigatorio ausente: ${source}`);
  }

  if (lstatSync(source).isDirectory()) {
    cpSync(source, target, {
      recursive: true,
      filter: (src) => !src.endsWith('.DS_Store'),
    });
  } else {
    copyFileSync(source, target);
  }
};

rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
rmSync(stableZipPath, { force: true });
rmSync(stableUpdaterPath, { force: true });
rmSync(stableRepairPath, { force: true });
mkdirSync(RELEASE_ROOT, { recursive: true });
mkdirSync(stageDir, { recursive: true });

run('npm', ['test'], 'npm test');

log('\n>> Copiando bundle precompilado');
for (const relativePath of includePaths) {
  log(`   - ${relativePath}`);
  copyPath(relativePath);
}

run(
  'zip',
  ['-r', '-X', zipPath, basename(stageDir)],
  'Compactando bundle precompilado (.zip)',
  RELEASE_ROOT,
);

copyFileSync(zipPath, stableZipPath);
copyFileSync(resolve(ROOT, 'scripts', 'update-windows.ps1'), stableUpdaterPath);
copyFileSync(resolve(ROOT, 'scripts', 'repair-windows-gemini-extension.ps1'), stableRepairPath);

log('\n============================================================');
log('  Pacote Windows precompilado gerado com sucesso.');
log('============================================================');
log(`Pasta: ${stageDir}`);
log(`ZIP:   ${zipPath}`);
log(`ZIP estavel para GitHub Releases: ${stableZipPath}`);
log(`Updater PowerShell: ${stableUpdaterPath}`);
log(`Repair PowerShell: ${stableRepairPath}`);
