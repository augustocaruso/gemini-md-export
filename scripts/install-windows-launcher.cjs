#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ZIP_TEMP_SEGMENT = `${path.sep}AppData${path.sep}Local${path.sep}Temp${path.sep}`.toLowerCase();

const snapshotRoot = path.resolve(__dirname, '..');

const readEmbeddedManifest = () => {
  const manifestPath = path.resolve(snapshotRoot, 'release-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
};

const extractEmbeddedBundle = () => {
  const manifest = readEmbeddedManifest();
  if (!manifest?.files?.length) return null;

  const extractRoot = path.resolve(
    os.tmpdir(),
    'gemini-md-export-installer',
    `v${manifest.version || 'dev'}`,
  );

  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });

  for (const relativePath of manifest.files) {
    const source = path.resolve(snapshotRoot, relativePath);
    const target = path.resolve(extractRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(source));
  }

  return {
    manifest,
    rootDir: extractRoot,
  };
};

const embeddedBundle = process.pkg ? extractEmbeddedBundle() : null;
const rootDir = embeddedBundle?.rootDir || path.resolve(__dirname, '..');
const installerPath = path.resolve(rootDir, 'scripts', 'install-windows.mjs');
const packagedMcpServerPath = path.resolve(rootDir, 'dist', 'gemini-cli-extension', 'src', 'mcp-server.js');
const expectedSiblings = [
  installerPath,
  path.resolve(rootDir, 'package.json'),
  path.resolve(rootDir, 'dist', 'extension', 'manifest.json'),
  packagedMcpServerPath,
];

const shouldPause = process.platform === 'win32' && !process.argv.includes('--no-pause');

const pauseBeforeExit = async () => {
  if (!shouldPause) return;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => {
    rl.question('\nPressione Enter para fechar esta janela...', () => resolve());
  });
  rl.close();
};

const resolveSystemNodeCommand = () => {
  if (/^(node|node\.exe)$/i.test(path.basename(process.execPath || ''))) {
    return process.execPath;
  }

  const probes = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const probeName of probes) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [probeName], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      shell: false,
    });
    if (probe.status !== 0) continue;
    const first = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  }

  return null;
};

const failEarly = async (lines, code = 1) => {
  process.stderr.write(`\n${lines.join('\n')}\n`);
  await pauseBeforeExit();
  process.exit(code);
};

const rootLooksLikeZipPreview = () =>
  !process.pkg && String(rootDir).toLowerCase().includes(ZIP_TEMP_SEGMENT);

const missingSibling = expectedSiblings.find((candidate) => !fs.existsSync(candidate));
if (rootLooksLikeZipPreview() || missingSibling) {
  const details = rootLooksLikeZipPreview()
    ? [
        '[ERRO] Este install-windows.exe parece estar sendo executado direto do zip.',
        '',
        `Pasta detectada: ${rootDir}`,
        '',
        'O que fazer:',
        '  1. Feche esta janela.',
        '  2. No Explorador de Arquivos, clique com o botao direito no zip.',
        '  3. Escolha "Extrair tudo...".',
        '  4. Entre na pasta extraida e execute install-windows.exe dali.',
      ]
    : [
        '[ERRO] Este install-windows.exe esta sem os arquivos vizinhos esperados.',
        '',
        `Pasta detectada: ${rootDir}`,
        `Arquivo faltando: ${missingSibling}`,
        '',
        'O executavel precisa estar na pasta extraida completa do projeto.',
      ];
  failEarly(details).catch((err) => {
    process.stderr.write(`\n[ERRO] ${err.message}\n`);
    process.exit(1);
  });
} else {
  process.chdir(rootDir);
  if (embeddedBundle) {
    process.env.GEMINI_INSTALL_PREBUILT_PAYLOAD = '1';
  }
  const nodeCommand = resolveSystemNodeCommand();
  if (!nodeCommand) {
    failEarly(
      [
        '[ERRO] Nao encontrei node.exe para iniciar o instalador.',
        '',
        'Este .exe standalone ainda depende de Node.js 20+ instalado no Windows.',
        'Baixe em https://nodejs.org/pt-br/download e rode o instalador novamente.',
      ],
      1,
    ).catch((err) => {
      process.stderr.write(`\n[ERRO] ${err.message}\n`);
      process.exit(1);
    });
  } else {
    const args = [installerPath, ...process.argv.slice(2).filter((arg) => arg !== '--no-pause')];
    const result = spawnSync(nodeCommand, args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });

    const code = result.error ? 1 : result.status ?? 0;
    if (result.error) {
      process.stderr.write(`\n[ERRO] ${result.error.message}\n`);
    }

    pauseBeforeExit()
      .then(() => process.exit(code))
      .catch((err) => {
        process.stderr.write(`\n[ERRO] ${err.message}\n`);
        process.exit(code || 1);
      });
  }
}
