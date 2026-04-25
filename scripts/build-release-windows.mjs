#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RELEASE_ROOT = resolve(ROOT, 'release');
const PKG_VERSION = '6.19.0';
const PKG_TARGET = 'node20-win-x64';

const pkgJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const version = pkgJson.version;
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '-');
const releaseName = `gemini-md-export-windows-v${version}-${stamp}`;
const stageDir = resolve(RELEASE_ROOT, `${releaseName}.bundle`);
const exePath = resolve(RELEASE_ROOT, `${releaseName}.exe`);

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

const listFilesRecursively = (dir, root = dir) => {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const absolutePath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(absolutePath, root));
      continue;
    }
    const relativePath = absolutePath.slice(root.length + 1).split(sep).join('/');
    files.push(relativePath);
  }
  return files.sort();
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
mkdirSync(stageDir, { recursive: true });
mkdirSync(RELEASE_ROOT, { recursive: true });

run('npm', ['test'], 'npm test');

const includePaths = [
  'dist/extension',
  'dist/gemini-cli-extension',
  'scripts/install-windows.mjs',
  'scripts/install-windows-launcher.cjs',
  'diagnose-windows-mcp.ps1',
  'package.json',
];

log('\n>> Copiando bundle de release');
for (const relativePath of includePaths) {
  log(`   - ${relativePath}`);
  copyPath(relativePath);
}

log('\n>> Preparando manifesto embutido do instalador');
const releaseManifest = {
  version,
  files: listFilesRecursively(stageDir).filter((relativePath) => relativePath !== 'release-manifest.json'),
};
writeFileSync(
  resolve(stageDir, 'release-manifest.json'),
  JSON.stringify(releaseManifest, null, 2) + '\n',
  'utf-8',
);

log('\n>> Ajustando package.json do bundle para gerar o .exe standalone');
const stagePackageJsonPath = resolve(stageDir, 'package.json');
const stagePackageJson = JSON.parse(readFileSync(stagePackageJsonPath, 'utf-8'));
stagePackageJson.bin = 'scripts/install-windows-launcher.cjs';
stagePackageJson.pkg = {
  scripts: ['scripts/install-windows-launcher.cjs'],
  assets: ['**/*'],
};
writeFileSync(stagePackageJsonPath, JSON.stringify(stagePackageJson, null, 2) + '\n', 'utf-8');

run(
  'npx',
  [
    '--yes',
    `@yao-pkg/pkg@${PKG_VERSION}`,
    'package.json',
    '--target',
    PKG_TARGET,
    '--compress',
    'Brotli',
    '--output',
    exePath,
  ],
  'Gerando install-windows.exe',
  stageDir,
);

log('\n============================================================');
log('  Instalador Windows standalone gerado com sucesso.');
log('============================================================');
log(`Bundle temporario: ${stageDir}`);
log(`EXE final:         ${exePath}`);
