#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SERVER_NAME = 'gemini-md-export';
const EXTENSION_MANIFEST_NAME = 'Gemini Chat -> Markdown Export';
const DEFAULT_INSTALL_DIR = resolve(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'GeminiMdExport',
);

const args = process.argv.slice(2);

const hasFlag = (name) => args.includes(name);
const readOption = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
};

const options = {
  dryRun: hasFlag('--dry-run'),
  forceClaude: hasFlag('--configure-claude'),
  skipClaude: hasFlag('--no-claude'),
  forceGeminiCli: hasFlag('--configure-gemini-cli'),
  skipGeminiCli: hasFlag('--no-gemini-cli'),
  openBrowser: hasFlag('--open-browser') && !hasFlag('--no-open-browser'),
  browser: readOption('--browser', 'chrome'),
  installDir: readOption('--install-dir', null),
  exportDir: readOption('--export-dir', null),
  help: hasFlag('--help') || hasFlag('-h'),
};

const log = (message = '') => {
  process.stdout.write(`${message}\n`);
};

const TOTAL_STEPS = 10;
let currentStep = 0;
const step = (label) => {
  currentStep += 1;
  log('');
  log(`[${currentStep}/${TOTAL_STEPS}] ${label}`);
  log('-'.repeat(60));
};

const fail = (message) => {
  process.stderr.write(`\n[ERRO] ${message}\n`);
  process.stderr.write(`\nA instalacao foi interrompida. Se precisar de ajuda,\n`);
  process.stderr.write(`envie um print desta janela para quem te mandou o zip.\n`);
  process.exit(1);
};

const usage = () => {
  log([
    `${SERVER_NAME} Windows installer`,
    '',
    'Uso:',
    '  node scripts\\install-windows.mjs [opcoes]',
    '',
    'Opcoes:',
    '  --install-dir <path>      Onde instalar MCP/extensao. Sem isso, tenta localizar install anterior.',
    '  --export-dir <path>       Opcional: pasta fixa dos exports. Sem isso, MCP usa Downloads e o modal permite escolher.',
    '  --configure-claude        Forca escrita em %%APPDATA%%\\Claude\\claude_desktop_config.json',
    '  --no-claude               Nao altera config do Claude Desktop',
    '  --configure-gemini-cli    Forca instalacao da extensao em %%USERPROFILE%%\\.gemini\\extensions',
    '  --no-gemini-cli           Nao instala/configura a extensao do Gemini CLI',
    '  --open-browser            Abre a pagina de extensoes do browser escolhido no fim',
    '  --browser chrome|edge|brave|dia',
    '                           Browser para abrir a tela de extensoes. Default: chrome',
    '  --dry-run                 Mostra o que faria sem alterar arquivos nem rodar npm',
    '  --help                    Mostra esta ajuda',
    '',
  ].join('\n'));
};

if (options.help) {
  usage();
  process.exit(0);
}

if (process.platform !== 'win32' && !options.dryRun) {
  fail('Este instalador foi feito para Windows. Use --dry-run para simular em outro sistema.');
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cmdCommand = process.platform === 'win32' ? 'cmd.exe' : 'cmd';
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const programFiles = process.env.ProgramFiles || join('C:\\', 'Program Files');
const programFilesX86 = process.env['ProgramFiles(x86)'] || join('C:\\', 'Program Files (x86)');

const normalizedExportDir = options.exportDir ? resolve(options.exportDir) : null;
const prebuiltPayload = process.env.GEMINI_INSTALL_PREBUILT_PAYLOAD === '1';
const sourceExtensionPath = resolve(ROOT, 'dist', 'extension');
const sourceGeminiCliExtensionPath = resolve(ROOT, 'dist', 'gemini-cli-extension');
const sourceMcpRuntimeDir = resolve(sourceGeminiCliExtensionPath, 'src');
const geminiCliExtensionSource =
  process.env.GME_GEMINI_EXTENSION_SOURCE ||
  'https://www.github.com/augustocaruso/gemini-md-export.git';
const geminiCliExtensionRef = process.env.GME_GEMINI_EXTENSION_REF || 'gemini-cli-extension';
const geminiCliExtensionInstallSource = `${geminiCliExtensionSource} --ref=${geminiCliExtensionRef} --auto-update`;

const timestamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');

const quoteCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quotePs = (value) => `'${String(value).replace(/'/g, "''")}'`;

const basenameLooksLikeNode = (value) => /^(node|node\.exe)$/i.test(basename(String(value || '')));

const firstWorkingCommand = (candidates) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }

  const probes =
    process.platform === 'win32'
      ? ['node.exe', 'node']
      : ['node'];

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

const resolvedNodeCommand = (() => {
  if (process.env.GEMINI_INSTALL_NODE_COMMAND) {
    return process.env.GEMINI_INSTALL_NODE_COMMAND;
  }

  if (basenameLooksLikeNode(process.execPath)) {
    return process.execPath;
  }

  return firstWorkingCommand([
    process.platform === 'win32' ? resolve(programFiles, 'nodejs', 'node.exe') : null,
    process.platform === 'win32' ? resolve(programFilesX86, 'nodejs', 'node.exe') : null,
  ]);
})();

const claudeConfigPath = () => {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return resolve(appData, 'Claude', 'claude_desktop_config.json');
};

const geminiCliConfigPath = () => {
  // Gemini CLI usa ~/.gemini/settings.json em todas as plataformas.
  return resolve(homedir(), '.gemini', 'settings.json');
};

const geminiCliExtensionsRoot = () => resolve(homedir(), '.gemini', 'extensions');
const geminiCliExtensionInstallPath = () => resolve(geminiCliExtensionsRoot(), SERVER_NAME);

const readJsonIfExists = (filePath) => {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON invalido em ${filePath}: ${err.message}`);
  }
};

const readJsonForDiscovery = (filePath) => {
  try {
    return readJsonIfExists(filePath);
  } catch {
    return null;
  }
};

const normalizeKey = (value) =>
  process.platform === 'win32' ? String(value).toLowerCase() : String(value);

const sanitizePathPart = (value) =>
  String(value || 'item')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';

const manifestLooksLikeThisExtension = (manifest) =>
  manifest?.name === EXTENSION_MANIFEST_NAME ||
  manifest?.short_name === EXTENSION_MANIFEST_NAME;

const extensionDirLooksLikeThisExtension = (dir) => {
  if (!dir) return false;
  const manifest = readJsonForDiscovery(resolve(dir, 'manifest.json'));
  return manifestLooksLikeThisExtension(manifest);
};

const browserUserDataRoots = () => {
  return [
    {
      browser: 'Chrome',
      root: resolve(localAppData, 'Google', 'Chrome', 'User Data'),
    },
    {
      browser: 'Edge',
      root: resolve(localAppData, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      browser: 'Brave',
      root: resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    },
    {
      browser: 'Dia',
      root: resolve(appData, 'Dia', 'User Data'),
    },
    {
      browser: 'Dia',
      root: resolve(localAppData, 'The Browser Company', 'Dia', 'User Data'),
    },
  ];
};

const browserLaunchTargets = () => ({
  chrome: {
    name: 'Chrome',
    url: 'chrome://extensions',
    binaryCandidates: [
      resolve(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      resolve(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      resolve(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    pathCommands: ['chrome', 'chrome.exe'],
  },
  edge: {
    name: 'Edge',
    url: 'edge://extensions',
    binaryCandidates: [
      resolve(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      resolve(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      resolve(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    pathCommands: ['msedge', 'msedge.exe'],
  },
  brave: {
    name: 'Brave',
    url: 'brave://extensions',
    binaryCandidates: [
      resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      resolve(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      resolve(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    pathCommands: ['brave', 'brave.exe'],
  },
  dia: {
    name: 'Dia',
    url: 'chrome://extensions',
    binaryCandidates: [
      resolve(localAppData, 'Programs', 'Dia', 'Dia.exe'),
      resolve(localAppData, 'The Browser Company', 'Dia', 'Application', 'Dia.exe'),
      resolve(appData, 'Dia', 'Application', 'Dia.exe'),
    ],
    pathCommands: ['dia', 'dia.exe'],
  },
});

const resolveBrowserBinary = (target) => {
  const fromFileSystem = target.binaryCandidates.find((candidate) => existsSync(candidate));
  if (fromFileSystem) {
    return {
      binary: fromFileSystem,
      resolvedBy: 'filesystem',
    };
  }

  if (process.platform !== 'win32') {
    return {
      binary: null,
      resolvedBy: null,
    };
  }

  for (const candidate of target.pathCommands) {
    const probe = spawnSync('where', [candidate], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      shell: false,
    });
    if (probe.status === 0) {
      const first = String(probe.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) {
        return {
          binary: first,
          resolvedBy: 'where',
        };
      }
    }
  }

  return {
    binary: null,
    resolvedBy: null,
  };
};

const resolveBrowserLaunchTarget = (browserOption) => {
  const targets = browserLaunchTargets();
  const requestedKey = String(browserOption || 'chrome').trim().toLowerCase();
  const requestedTarget = targets[requestedKey] || targets.chrome;
  const requestedResolution = resolveBrowserBinary(requestedTarget);
  if (requestedResolution.binary) {
    return {
      ...requestedTarget,
      ...requestedResolution,
      requested: requestedKey,
    };
  }

  for (const [key, target] of Object.entries(targets)) {
    if (target === requestedTarget) continue;
    const resolution = resolveBrowserBinary(target);
    if (!resolution.binary) continue;
    return {
      ...target,
      ...resolution,
      requested: requestedKey,
      fallbackFrom: requestedTarget.name,
    };
  }

  return {
    ...requestedTarget,
    ...requestedResolution,
    requested: requestedKey,
  };
};

const discoverLoadedBrowserExtensions = () => {
  const found = [];
  const seen = new Set();

  for (const { browser, root } of browserUserDataRoots()) {
    if (!existsSync(root)) continue;

    let profileDirs = [];
    try {
      profileDirs = readdirSync(root)
        .map((name) => resolve(root, name))
        .filter((entry) => {
          try {
            return lstatSync(entry).isDirectory() && existsSync(resolve(entry, 'Preferences'));
          } catch {
            return false;
          }
        });
    } catch {
      continue;
    }

    for (const profileDir of profileDirs) {
      const preferencesPath = resolve(profileDir, 'Preferences');
      const preferences = readJsonForDiscovery(preferencesPath);
      const settings = preferences?.extensions?.settings || {};

      for (const [extensionId, setting] of Object.entries(settings)) {
        const rawPath = setting?.path || setting?.install_path;
        if (!rawPath) continue;
        const resolvedPath = isAbsolute(String(rawPath))
          ? resolve(String(rawPath))
          : resolve(profileDir, String(rawPath));

        const manifestMatches = manifestLooksLikeThisExtension(setting?.manifest);
        const pathMatches = extensionDirLooksLikeThisExtension(resolvedPath);
        if (!manifestMatches && !pathMatches) continue;

        const key = normalizeKey(resolvedPath);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          browser,
          profile: dirname(preferencesPath).split(/[\\/]/).pop(),
          extensionId,
          extensionPath: resolvedPath,
          preferencesPath,
        });
      }
    }
  }

  return found;
};

const mcpConfigInstallDir = (config) => {
  const server = config?.mcpServers?.[SERVER_NAME];
  if (!server || typeof server !== 'object') return null;

  const argsList = Array.isArray(server.args) ? server.args : [];
  const serverPathArg = argsList.find((arg) => /mcp-server\.js$/i.test(String(arg || '')));
  if (!serverPathArg) return null;

  const rawServerPath = String(serverPathArg).replace(/^"|"$/g, '');
  const serverPath = isAbsolute(rawServerPath)
    ? rawServerPath
    : server.cwd
      ? resolve(String(server.cwd), rawServerPath)
      : resolve(rawServerPath);

  const normalizedServerPath = resolve(serverPath);
  const bundledServerSuffix = resolve('gemini-cli-extension', 'src', 'mcp-server.js');
  if (normalizedServerPath.endsWith(bundledServerSuffix)) {
    return dirname(dirname(dirname(normalizedServerPath)));
  }

  return dirname(dirname(serverPath));
};

const discoverExistingInstallDirs = () => {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (dir, source) => {
    if (!dir) return;
    const resolvedDir = resolve(dir);
    const key = normalizeKey(resolvedDir);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dir: resolvedDir, source });
  };

  addCandidate(mcpConfigInstallDir(readJsonForDiscovery(geminiCliConfigPath())), 'Gemini CLI settings');
  addCandidate(mcpConfigInstallDir(readJsonForDiscovery(claudeConfigPath())), 'Claude Desktop config');

  if (
    existsSync(resolve(DEFAULT_INSTALL_DIR, 'gemini-cli-extension', 'src', 'mcp-server.js')) ||
    existsSync(resolve(DEFAULT_INSTALL_DIR, 'extension', 'manifest.json'))
  ) {
    addCandidate(DEFAULT_INSTALL_DIR, 'pasta padrao existente');
  }

  return candidates;
};

const discoveredInstallDirs = discoverExistingInstallDirs();
const discoveredLoadedExtensions = discoverLoadedBrowserExtensions();
const selectedInstallDir = options.installDir
  ? { dir: resolve(options.installDir), source: '--install-dir' }
  : discoveredInstallDirs[0] || { dir: DEFAULT_INSTALL_DIR, source: 'pasta padrao' };

const installDir = selectedInstallDir.dir;
const GEMINI_APP_URL = 'https://gemini.google.com/app';
const extensionPath = resolve(installDir, 'extension');
const geminiCliExtensionBundlePath = resolve(installDir, 'gemini-cli-extension');
const geminiCliBrowserExtensionPath = resolve(geminiCliExtensionInstallPath(), 'browser-extension');
const mcpServerPath = resolve(geminiCliExtensionBundlePath, 'src', 'mcp-server.js');
const browserLaunchTarget = resolveBrowserLaunchTarget(options.browser);
const browserLaunchArgs = (url) => ['--new-tab', url];
const browserLaunchCmd = (url) =>
  browserLaunchTarget.binary
    ? `start "" ${quoteCmd(browserLaunchTarget.binary)} --new-tab ${quoteCmd(url)}`
    : `echo [AVISO] Navegador ${browserLaunchTarget.name} nao encontrado automaticamente. Abra manualmente: ${url}`;
const browserUrlForLoadedExtension = (loadedExtension) => {
  const browserKey = String(loadedExtension?.browser || options.browser || 'chrome').trim().toLowerCase();
  const target = browserLaunchTargets()[browserKey] || browserLaunchTarget;
  if (!loadedExtension?.extensionId) return target.url;
  return `${target.url}/?id=${loadedExtension.extensionId}`;
};

const findGeminiCommand = () => {
  const candidates = process.platform === 'win32' ? ['gemini.cmd', 'gemini.exe', 'gemini'] : ['gemini'];
  for (const candidate of candidates) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
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

const run = (command, commandArgs, label) => {
  log(`    $ ${command} ${commandArgs.join(' ')}`);
  if (options.dryRun) return;

  // Node.js 24+ recusa `spawnSync` de arquivos .cmd/.bat no Windows com
  // `shell: false` (CVE-2024-27980). npm no Windows é `npm.cmd`. Usar
  // `shell: true` quando o comando termina em .cmd/.bat no Windows.
  const needsShell =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: needsShell,
  });

  if (result.error) {
    fail(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label}: processo saiu com codigo ${result.status}`);
  }
  log(`    OK`);
};

const ensureNodeVersion = () => {
  if (!resolvedNodeCommand) {
    fail(
      'Nao encontrei node.exe para a instalacao final.\n' +
        '    O instalador standalone roda sozinho, mas o MCP instalado ainda precisa de Node.js 20+ no Windows.\n' +
        '    Instale o Node.js em https://nodejs.org/pt-br/download e rode o instalador novamente.',
    );
  }

  const versionProbe = spawnSync(resolvedNodeCommand, ['--version'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
    shell: false,
  });
  const versionText =
    versionProbe.status === 0
      ? String(versionProbe.stdout || '').trim()
      : `v${process.versions.node}`;
  const major = Number(versionText.replace(/^v/i, '').split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    fail(
      `Node.js ${versionText} detectado.\n` +
        `    Precisa Node.js 20 ou superior.\n` +
        `    Baixe em https://nodejs.org/pt-br/download e reinstale.`,
    );
  }
  log(`    Node.js ${versionText} OK (>= 20)`);
};

const ensureDir = (dir) => {
  if (options.dryRun) {
    log(`[dry-run] criaria ${dir}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
};

const writeFile = (filePath, content) => {
  if (options.dryRun) {
    log(`[dry-run] escreveria ${filePath}`);
    return;
  }
  writeFileSync(filePath, content, 'utf-8');
};

const copyFile = (from, to) => {
  if (options.dryRun) {
    log(`[dry-run] copiaria ${from} -> ${to}`);
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

const copyDir = (from, to) => {
  if (options.dryRun) {
    log(`[dry-run] copiaria diretorio ${from} -> ${to}`);
    return;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

const runGeminiCommand = (geminiCommand, commandArgs, label, { ignoreFailure = false } = {}) => {
  log(`    $ ${geminiCommand} ${commandArgs.join(' ')}`);
  if (options.dryRun) {
    return { ok: true, status: 0, dryRun: true };
  }

  const needsShell =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(geminiCommand);
  const result = spawnSync(geminiCommand, commandArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    shell: needsShell,
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (stdout) log(stdout.split(/\r?\n/).map((line) => `      ${line}`).join('\n'));
  if (stderr) log(stderr.split(/\r?\n/).map((line) => `      ${line}`).join('\n'));

  if (result.error) {
    if (ignoreFailure) return { ok: false, error: result.error.message };
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = `${label}: processo saiu com codigo ${result.status}`;
    if (ignoreFailure) return { ok: false, status: result.status, stdout, stderr, error: message };
    throw new Error(message);
  }
  return { ok: true, status: result.status, stdout, stderr };
};

const mcpServerConfig = () => {
  const config = {
    command: resolvedNodeCommand,
    args: [mcpServerPath],
  };
  if (normalizedExportDir) {
    config.env = {
      GEMINI_MCP_EXPORT_DIR: normalizedExportDir,
    };
  }
  return config;
};

const patchedGeminiCliExtensionManifest = () => {
  const manifest = readJsonIfExists(resolve(sourceGeminiCliExtensionPath, 'gemini-extension.json'));
  manifest.version = manifest.version || JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;
  manifest.mcpServers = {
    ...(manifest.mcpServers || {}),
    [SERVER_NAME]: {
      ...(manifest.mcpServers?.[SERVER_NAME] || {}),
      command: resolvedNodeCommand,
      args: ['${extensionPath}${/}src${/}mcp-server.js'],
      ...(normalizedExportDir
        ? {
            env: {
              GEMINI_MCP_EXPORT_DIR: normalizedExportDir,
            },
          }
        : {}),
    },
  };
  return manifest;
};

const writeInstalledGeminiCliExtension = (targetDir) => {
  if (options.dryRun) {
    log(`[dry-run] instalaria extensao Gemini CLI em ${targetDir}`);
    return;
  }

  copyDir(sourceGeminiCliExtensionPath, targetDir);
  writeFileSync(
    resolve(targetDir, 'gemini-extension.json'),
    JSON.stringify(patchedGeminiCliExtensionManifest(), null, 2) + '\n',
    'utf-8',
  );
};

const removeInstalledGeminiCliExtension = (reason = 'reinstalacao') => {
  const targetDir = geminiCliExtensionInstallPath();
  if (options.dryRun) {
    log(`    [dry-run] removeria extensao Gemini CLI existente (${reason}): ${targetDir}`);
    return;
  }
  if (!existsSync(targetDir)) {
    log(`    Gemini CLI: nenhuma pasta anterior para remover em ${targetDir}`);
    return;
  }
  rmSync(targetDir, { recursive: true, force: true });
  log(`    Gemini CLI: pasta anterior removida (${reason}): ${targetDir}`);
};

const patchGeminiCliExtensionBundle = (targetDir) => {
  if (options.dryRun) {
    log(`[dry-run] atualizaria manifest Gemini CLI em ${targetDir}`);
    return;
  }
  writeFileSync(
    resolve(targetDir, 'gemini-extension.json'),
    JSON.stringify(patchedGeminiCliExtensionManifest(), null, 2) + '\n',
    'utf-8',
  );
};

let installBackupPath = null;
let syncedLoadedExtensions = [];

const backupExistingInstall = () => {
  const backupTimestamp = timestamp();
  const backupRoot = resolve(installDir, 'backups', backupTimestamp);
  const backupCandidates = [
    'extension',
    'start-mcp.cmd',
    'start-mcp.ps1',
    'mcp-config.claude.json',
    'gemini-cli-extension',
    'open-gemini.cmd',
    'open-browser-extensions.cmd',
    'refresh-browser-extension.cmd',
    'restart-gemini-cli.cmd',
    'INSTALL-SUMMARY.txt',
    'INSTALL-MANIFEST.json',
  ];

  const existingItems = backupCandidates
    .map((relativePath) => ({
      relativePath,
      from: resolve(installDir, relativePath),
      to: resolve(backupRoot, relativePath),
    }))
    .filter((item) => existsSync(item.from));

  if (existingItems.length === 0) {
    log('    nenhuma instalacao anterior encontrada nesse destino');
    return null;
  }

  log(`    backup da instalacao anterior: ${backupRoot}`);

  if (options.dryRun) {
    log(`    [dry-run] copiaria ${existingItems.length} item(ns) para backup`);
    return backupRoot;
  }

  for (const item of existingItems) {
    mkdirSync(dirname(item.to), { recursive: true });
    if (lstatSync(item.from).isDirectory()) {
      cpSync(item.from, item.to, { recursive: true });
    } else {
      copyFileSync(item.from, item.to);
    }
  }

  const backupsDir = resolve(installDir, 'backups');
  const backupsToKeep = 5;
  const backupDirs = readdirSync(backupsDir)
    .map((name) => resolve(backupsDir, name))
    .filter((entry) => {
      try {
        return lstatSync(entry).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();

  for (const oldBackup of backupDirs.slice(backupsToKeep)) {
    rmSync(oldBackup, { recursive: true, force: true });
  }

  return backupRoot;
};

const stageInstall = () => {
  log(`    destino: ${installDir}`);
  installBackupPath = backupExistingInstall();
  ensureDir(installDir);
  copyDir(sourceExtensionPath, extensionPath);
  copyDir(sourceGeminiCliExtensionPath, geminiCliExtensionBundlePath);
  log(`    extensao legado: ${extensionPath}`);
  log(`    gemini:   ${geminiCliExtensionBundlePath}`);
  log(`    extensao atualizavel pelo Gemini CLI: ${geminiCliBrowserExtensionPath}`);
  log(`    mcp:      ${mcpServerPath}`);
};

const syncLoadedBrowserExtensions = () => {
  syncedLoadedExtensions = [];

  if (discoveredLoadedExtensions.length === 0) {
    log('    nenhuma extensao desempacotada ja carregada foi detectada nos perfis locais');
    return syncedLoadedExtensions;
  }

  log('    extensoes desempacotadas detectadas:');
  for (const loaded of discoveredLoadedExtensions) {
    log(`      - ${loaded.browser}/${loaded.profile}: ${loaded.extensionPath}`);
  }

  for (const loaded of discoveredLoadedExtensions) {
    const target = loaded.extensionPath;
    const sameAsInstalled = normalizeKey(target) === normalizeKey(extensionPath);
    const sameAsGeminiCliBrowserExtension =
      normalizeKey(target) === normalizeKey(geminiCliBrowserExtensionPath);
    const sameAsCurrentBuild = normalizeKey(target) === normalizeKey(sourceExtensionPath);

    if (sameAsInstalled || sameAsGeminiCliBrowserExtension || sameAsCurrentBuild) {
      syncedLoadedExtensions.push({
        ...loaded,
        status: 'already-current-path',
      });
      log(`    OK: ${loaded.browser}/${loaded.profile} ja aponta para a pasta atual`);
      continue;
    }

    const backupRoot = resolve(
      installDir,
      'backups',
      timestamp(),
      'loaded-extension',
      sanitizePathPart(`${loaded.browser}-${loaded.profile}-${loaded.extensionId}`),
    );

    if (options.dryRun) {
      log(`[dry-run] sincronizaria ${sourceExtensionPath} -> ${target}`);
      syncedLoadedExtensions.push({
        ...loaded,
        status: 'dry-run',
        backupPath: backupRoot,
      });
      continue;
    }

    try {
      if (existsSync(target)) {
        mkdirSync(dirname(backupRoot), { recursive: true });
        cpSync(target, backupRoot, { recursive: true });
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      cpSync(sourceExtensionPath, target, { recursive: true });
      syncedLoadedExtensions.push({
        ...loaded,
        status: 'synced',
        backupPath: existsSync(backupRoot) ? backupRoot : null,
      });
      log(`    sincronizada: ${loaded.browser}/${loaded.profile} -> ${target}`);
    } catch (err) {
      syncedLoadedExtensions.push({
        ...loaded,
        status: 'failed',
        error: err.message,
      });
      log(`    falha ao sincronizar ${loaded.browser}/${loaded.profile}: ${err.message}`);
    }
  }

  return syncedLoadedExtensions;
};

const linkLegacyBrowserExtensionPath = () => {
  if (options.dryRun) {
    log(`[dry-run] apontaria ${extensionPath} para ${geminiCliBrowserExtensionPath}`);
    return;
  }
  if (!existsSync(geminiCliBrowserExtensionPath)) {
    log(`    [AVISO] pasta atualizavel da extensao do browser nao encontrada: ${geminiCliBrowserExtensionPath}`);
    return;
  }
  try {
    rmSync(extensionPath, { recursive: true, force: true });
    mkdirSync(dirname(extensionPath), { recursive: true });
    symlinkSync(geminiCliBrowserExtensionPath, extensionPath, 'junction');
    log(`    extensao legado agora aponta para: ${geminiCliBrowserExtensionPath}`);
  } catch (err) {
    log(`    [AVISO] nao consegui criar junction ${extensionPath}: ${err.message}`);
  }
};

const writeLaunchers = () => {
  ensureDir(installDir);

  const exportDirCmdLine = normalizedExportDir
    ? [`set "GEMINI_MCP_EXPORT_DIR=${normalizedExportDir}"`]
    : [];
  const exportDirPsLine = normalizedExportDir
    ? [`$env:GEMINI_MCP_EXPORT_DIR = ${quotePs(normalizedExportDir)}`]
    : [];

  const startCmd = [
    '@echo off',
    'setlocal',
    ...exportDirCmdLine,
    `${quoteCmd(resolvedNodeCommand)} ${quoteCmd(mcpServerPath)}`,
    '',
  ].join('\r\n');

  const startPs1 = [
    ...exportDirPsLine,
    `& ${quotePs(resolvedNodeCommand)} ${quotePs(mcpServerPath)}`,
    '',
  ].join('\r\n');

  const openExtensionsCmd = [
    '@echo off',
    'setlocal',
    browserLaunchCmd(browserLaunchTarget.url),
    '',
  ].join('\r\n');

  const openGeminiCmd = [
    '@echo off',
    'setlocal',
    browserLaunchCmd(GEMINI_APP_URL),
    '',
  ].join('\r\n');

  const preferredLoadedExtension =
    discoveredLoadedExtensions.find(
      (loaded) =>
        String(loaded.browser || '').toLowerCase() === String(browserLaunchTarget.name || '').toLowerCase(),
    ) || discoveredLoadedExtensions[0] || null;

  const refreshBrowserCmd = [
    '@echo off',
    'setlocal',
    'echo ============================================================',
    'echo   Gemini -> Markdown Export   |   Refresh da extensao',
    'echo ============================================================',
    'echo.',
    browserLaunchCmd(browserUrlForLoadedExtension(preferredLoadedExtension)),
    'echo A pagina de extensoes foi aberta.',
    'echo.',
    'echo Proximo passo:',
    'echo   1. Ache o card "Gemini Chat -^> Markdown Export".',
    'echo   2. Clique no icone circular de reload do card.',
    'echo   3. Confira que a pasta carregada e:',
    `echo        ${geminiCliBrowserExtensionPath}`,
    ...(preferredLoadedExtension
      ? [
          'echo.',
          'echo Browser/perfil detectado anteriormente:',
          `echo        ${preferredLoadedExtension.browser}/${preferredLoadedExtension.profile}`,
          `echo        id: ${preferredLoadedExtension.extensionId}`,
          `echo        pasta: ${preferredLoadedExtension.extensionPath}`,
        ]
      : []),
    'echo.',
    'pause',
    '',
  ].join('\r\n');

  const restartGeminiCliCmd = [
    '@echo off',
    'setlocal',
    'echo ============================================================',
    'echo   Gemini -> Markdown Export   |   Refresh do Gemini CLI',
    'echo ============================================================',
    'echo.',
    'echo Fechando MCPs antigos do exporter, se existirem...',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node(.exe)?$\' -and $_.CommandLine -match \'mcp-server\\\\.js\' -and $_.CommandLine -match \'gemini-md-export\' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host (\'  encerrado PID \' + $_.ProcessId) } catch { Write-Host (\'  falha ao encerrar PID \' + $_.ProcessId + \': \' + $_.Exception.Message) } }"',
    'echo.',
    'where gemini >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [AVISO] O binario "gemini" nao foi encontrado no PATH.',
    '  echo         Feche a sessao atual do Gemini CLI e abra de novo manualmente.',
    '  echo.',
    '  pause',
    '  exit /b 0',
    ')',
    'echo Abrindo uma nova janela do Gemini CLI...',
    'start "Gemini CLI" cmd /k gemini',
    'echo.',
    'echo Se voce ainda tinha uma sessao antiga aberta, feche-a para evitar confusao.',
    'echo Dentro do Gemini CLI novo, rode /mcp para conferir se "gemini-md-export" apareceu.',
    'echo.',
    'pause',
    '',
  ].join('\r\n');

  writeFile(resolve(installDir, 'start-mcp.cmd'), startCmd);
  writeFile(resolve(installDir, 'start-mcp.ps1'), startPs1);
  writeFile(resolve(installDir, 'open-browser-extensions.cmd'), openExtensionsCmd);
  writeFile(resolve(installDir, 'open-gemini.cmd'), openGeminiCmd);
  writeFile(resolve(installDir, 'refresh-browser-extension.cmd'), refreshBrowserCmd);
  writeFile(resolve(installDir, 'restart-gemini-cli.cmd'), restartGeminiCliCmd);
  writeFile(
    resolve(installDir, 'mcp-config.claude.json'),
    JSON.stringify({ mcpServers: { [SERVER_NAME]: mcpServerConfig() } }, null, 2) + '\n',
  );
};

const configureClaude = () => {
  if (options.skipClaude) {
    return { status: 'skipped', reason: '--no-claude' };
  }

  const configPath = claudeConfigPath();
  const configDir = dirname(configPath);
  const shouldConfigure =
    options.forceClaude ||
    existsSync(configPath) ||
    existsSync(configDir);

  if (!shouldConfigure) {
    log('    Claude Desktop nao detectado -- pulando');
    log('    (se instalar depois, rode o instalador de novo com --configure-claude)');
    return {
      status: 'skipped',
      reason: 'Claude Desktop nao detectado',
      configPath,
    };
  }

  log(`    config: ${configPath}`);

  if (options.dryRun) {
    log('    [dry-run] atualizaria claude_desktop_config.json');
    return { status: 'configured', dryRun: true, configPath };
  }

  mkdirSync(configDir, { recursive: true });

  let config;
  try {
    config = readJsonIfExists(configPath);
  } catch (err) {
    fail(err.message);
  }

  if (existsSync(configPath)) {
    const backupPath = `${configPath}.bak-${timestamp()}`;
    copyFileSync(configPath, backupPath);
    log(`    backup: ${backupPath}`);
  }

  config.mcpServers = {
    ...(config.mcpServers || {}),
    [SERVER_NAME]: mcpServerConfig(),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  log('    Claude Desktop configurado. Reinicie o app para ativar o MCP.');
  return { status: 'configured', configPath };
};

const geminiCliDetected = () => {
  // Heuristicas leves: pasta existe, settings existe, ou binario no PATH.
  const configPath = geminiCliConfigPath();
  const configDir = dirname(configPath);
  if (existsSync(configPath) || existsSync(configDir)) return true;
  const probes =
    process.platform === 'win32'
      ? [['where', ['gemini']], ['where', ['gemini.cmd']]]
      : [['which', ['gemini']]];
  for (const [cmd, probeArgs] of probes) {
    const probe = spawnSync(cmd, probeArgs, { stdio: 'ignore' });
    if (probe.status === 0) return true;
  }
  return false;
};

const configureGeminiCli = () => {
  if (options.skipGeminiCli) {
    return { status: 'skipped', reason: '--no-gemini-cli' };
  }

  const configPath = geminiCliConfigPath();
  const configDir = dirname(configPath);
  const shouldConfigure = options.forceGeminiCli || geminiCliDetected();

  if (!shouldConfigure) {
    log('    Gemini CLI nao detectado -- pulando');
    log('    (se instalar depois, rode o instalador de novo com --configure-gemini-cli)');
    return {
      status: 'skipped',
      reason: 'Gemini CLI nao detectado',
      configPath,
    };
  }

  const geminiCommand = findGeminiCommand();
  log(`    config: ${configPath}`);
  log(`    gemini binario: ${geminiCommand || '(nao encontrado no PATH)'}`);

  if (options.dryRun) {
    log(`    [dry-run] rodaria gemini extensions uninstall ${SERVER_NAME}`);
    log(`    [dry-run] removeria ${geminiCliExtensionInstallPath()} antes de instalar novamente`);
    log(
      `    [dry-run] instalaria a extensao Gemini CLI de ${geminiCliExtensionInstallSource} e atualizaria settings.json`,
    );
    return {
      status: 'configured',
      dryRun: true,
      method: 'gemini-extensions-install',
      configPath,
      extensionInstallPath: geminiCliExtensionInstallPath(),
      sourcePath: geminiCliExtensionInstallSource,
    };
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(geminiCliExtensionsRoot(), { recursive: true });

  let config;
  try {
    config = readJsonIfExists(configPath);
  } catch (err) {
    fail(err.message);
  }

  if (existsSync(configPath)) {
    const backupPath = `${configPath}.bak-${timestamp()}`;
    copyFileSync(configPath, backupPath);
    log(`    backup: ${backupPath}`);
  }

  if (config.mcpServers && typeof config.mcpServers === 'object' && config.mcpServers[SERVER_NAME]) {
    delete config.mcpServers[SERVER_NAME];
    log('    Gemini CLI: removida config MCP legada do settings.json para priorizar a extensao');
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
  }

  if (config.mcp && Array.isArray(config.mcp.allowed) && !config.mcp.allowed.includes(SERVER_NAME)) {
    config.mcp.allowed = [...config.mcp.allowed, SERVER_NAME];
    log(`    Gemini CLI: adicionado a mcp.allowed`);
  }

  if (config.mcp && Array.isArray(config.mcp.excluded) && config.mcp.excluded.includes(SERVER_NAME)) {
    config.mcp.excluded = config.mcp.excluded.filter((name) => name !== SERVER_NAME);
    log(`    Gemini CLI: removido de mcp.excluded`);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  patchGeminiCliExtensionBundle(geminiCliExtensionBundlePath);

  if (geminiCommand) {
    log('    Gemini CLI: desinstalando gemini-md-export antes de instalar novamente');
    const uninstallResult = runGeminiCommand(
      geminiCommand,
      ['extensions', 'uninstall', SERVER_NAME],
      'gemini extensions uninstall',
      { ignoreFailure: true },
    );
    if (!uninstallResult.ok) {
      log('    Gemini CLI: uninstall previo ignorado (extensao podia nao existir ou era manual)');
    }
    removeInstalledGeminiCliExtension('pre-install');

    const installArgs = [
      'extensions',
      'install',
      geminiCliExtensionSource,
      `--ref=${geminiCliExtensionRef}`,
      '--auto-update',
      '--consent',
    ];
    const installResult = runGeminiCommand(
      geminiCommand,
      installArgs,
      'gemini extensions install',
      { ignoreFailure: true },
    );
    if (installResult.ok) {
      log(
        `    Gemini CLI configurado via GitHub (${geminiCliExtensionInstallSource}); deve aparecer como atualizavel.`,
      );
      log('    Reinicie a sessao do gemini para ativar.');
      return {
        status: 'configured',
        method: 'gemini-extensions-install',
        configPath,
        extensionInstallPath: geminiCliExtensionInstallPath(),
        sourcePath: geminiCliExtensionInstallSource,
        geminiCommand,
      };
    }

    log('    Gemini CLI: install oficial falhou; usando copia manual como fallback.');
  }

  writeInstalledGeminiCliExtension(geminiCliExtensionInstallPath());
  log('    Gemini CLI configurado via copia manual fallback. Reinicie a sessao do gemini para ativar.');
  return {
    status: 'configured',
    method: 'manual-copy-fallback',
    configPath,
    extensionInstallPath: geminiCliExtensionInstallPath(),
    sourcePath: geminiCliExtensionBundlePath,
    geminiCommand,
    warning: 'Extensao pode aparecer como nao atualizavel porque o comando oficial do Gemini CLI nao foi usado.',
  };
};

const openBrowserExtensions = () => {
  if (!options.openBrowser || options.dryRun) return;
  if (!browserLaunchTarget.binary) {
    log(`Aviso: nao encontrei Chrome/Edge/Brave/Dia automaticamente. Abra manualmente ${browserLaunchTarget.url}`);
    return;
  }
  if (browserLaunchTarget.fallbackFrom) {
    log(`Aviso: ${browserLaunchTarget.fallbackFrom} nao encontrado; abrindo ${browserLaunchTarget.name}.`);
  }
  const command = `start "" ${quoteCmd(browserLaunchTarget.binary)} --new-tab ${quoteCmd(browserLaunchTarget.url)}`;
  const child = spawn(cmdCommand, ['/d', '/s', '/c', command], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
  });
  child.unref();
};

const generatedFilePaths = () => [
  resolve(installDir, 'start-mcp.cmd'),
  resolve(installDir, 'start-mcp.ps1'),
  resolve(installDir, 'mcp-config.claude.json'),
  resolve(installDir, 'open-browser-extensions.cmd'),
  resolve(installDir, 'open-gemini.cmd'),
  resolve(installDir, 'refresh-browser-extension.cmd'),
  resolve(installDir, 'restart-gemini-cli.cmd'),
  resolve(installDir, 'INSTALL-SUMMARY.txt'),
  resolve(installDir, 'INSTALL-MANIFEST.json'),
];

const lastInstallPointerPath = () =>
  resolve(process.env.TEMP || process.env.TMP || installDir, 'gemini-md-export-last-install.env');

const writeLastInstallPointer = () => {
  writeFile(
    lastInstallPointerPath(),
    [
      `installDir=${installDir}`,
      `extensionPath=${extensionPath}`,
      `browserExtensionPath=${geminiCliBrowserExtensionPath}`,
      `summaryPath=${resolve(installDir, 'INSTALL-SUMMARY.txt')}`,
      `manifestPath=${resolve(installDir, 'INSTALL-MANIFEST.json')}`,
      '',
    ].join('\r\n'),
  );
};

const writeInstallManifest = (claudeResult, geminiCliResult) => {
  const manifest = {
    installedAt: new Date().toISOString(),
    serverName: SERVER_NAME,
    sourceProject: ROOT,
    installDir,
    installDirSource: selectedInstallDir.source,
    discoveredInstallDirs,
    discoveredLoadedExtensions,
    syncedLoadedExtensions,
    backupPath: installBackupPath,
    extensionPath,
    browserExtensionPath: geminiCliBrowserExtensionPath,
    geminiCliExtensionBundlePath,
    mcpServerPath,
    runtimeNodeCommand: resolvedNodeCommand,
    exportDirOverride: normalizedExportDir,
    generatedFiles: generatedFilePaths(),
    clients: {
      claudeDesktop: claudeResult,
      geminiCli: geminiCliResult,
    },
  };

  writeFile(resolve(installDir, 'INSTALL-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
};

const writeSummary = (claudeResult, geminiCliResult) => {
  const lines = [
    'Gemini Markdown Export - Windows install summary',
    '',
    `Source project: ${ROOT}`,
    `Installed app: ${installDir}`,
    `Install dir source: ${selectedInstallDir.source}`,
    `Previous install backup: ${installBackupPath || '(none)'}`,
    `Extension path: ${geminiCliBrowserExtensionPath}`,
    `Legacy extension link: ${extensionPath}`,
    `Gemini CLI extension bundle: ${geminiCliExtensionBundlePath}`,
    `MCP server: ${mcpServerPath}`,
    `Browser extensions page: ${browserLaunchTarget.url}`,
    `Browser executable: ${browserLaunchTarget.binary || '(not found automatically)'}`,
    `Export dir override: ${normalizedExportDir || '(none; default is Downloads or folder chosen in modal)'}`,
    `Node: ${resolvedNodeCommand}`,
    '',
    'Discovered existing installs:',
    ...(discoveredInstallDirs.length
      ? discoveredInstallDirs.map((candidate) => `- ${candidate.source}: ${candidate.dir}`)
      : ['- none']),
    '',
    'Loaded unpacked browser extensions detected:',
    ...(discoveredLoadedExtensions.length
      ? discoveredLoadedExtensions.map(
          (item) => `- ${item.browser}/${item.profile}: ${item.extensionPath}`,
        )
      : ['- none']),
    '',
    'Loaded extension sync:',
    ...(syncedLoadedExtensions.length
      ? syncedLoadedExtensions.map(
          (item) =>
            `- ${item.browser}/${item.profile}: ${item.status} (${item.extensionPath})${
              item.error ? ` - ${item.error}` : ''
            }`,
        )
      : ['- none']),
    '',
    'Generated files:',
    ...generatedFilePaths().map((filePath) => `- ${filePath}`),
    '',
    'Browser extension manual step:',
    `1. Open ${browserLaunchTarget.url}.`,
    '2. Enable Developer mode.',
    '3. Click Load unpacked.',
    `4. Select: ${geminiCliBrowserExtensionPath}`,
    '',
    'MCP clients configured:',
    claudeResult.status === 'configured'
      ? `- Claude Desktop: ${claudeResult.configPath}`
      : `- Claude Desktop: not changed (${claudeResult.reason})`,
    geminiCliResult.status === 'configured'
      ? `- Gemini CLI: ${geminiCliResult.configPath} (method: ${geminiCliResult.method || 'unknown'}, source: ${geminiCliResult.sourcePath || geminiCliResult.extensionInstallPath})`
      : `- Gemini CLI: not changed (${geminiCliResult.reason})`,
    '- If using another MCP client, use mcp-config.claude.json as a template.',
    '',
    'Test:',
    '1. Run start-mcp.cmd.',
    '2. Open http://127.0.0.1:47283/healthz.',
    `3. Abra ${GEMINI_APP_URL} ou use open-gemini.cmd, entre numa conversa /app/<id>, recarregue a aba e depois abra http://127.0.0.1:47283/agent/clients.`,
    '',
    'Important:',
    '- The installed copy lives in this folder. If you rerun the installer, it refreshes extension and MCP files here.',
    '- If a previous install was found, selected files were backed up under backups before replacement.',
    '- Restart Claude Desktop / Gemini CLI session after changing MCP config.',
    '',
  ];

  writeFile(resolve(installDir, 'INSTALL-SUMMARY.txt'), lines.join('\r\n'));
};

log(`>> ${SERVER_NAME} Windows installer`);
log(`   projeto: ${ROOT}`);
if (options.dryRun) log('   modo: DRY-RUN (nada sera escrito)');

step('Checando Node.js');
ensureNodeVersion();

step('Localizando instalacao anterior');
log(`    alvo escolhido: ${installDir}`);
log(`    origem: ${selectedInstallDir.source}`);
if (discoveredInstallDirs.length > 0) {
  log('    instalacoes detectadas:');
  for (const candidate of discoveredInstallDirs) {
    log(`      - ${candidate.source}: ${candidate.dir}`);
  }
} else {
  log(`    nenhuma instalacao anterior detectada; usando ${DEFAULT_INSTALL_DIR}`);
}
if (discoveredLoadedExtensions.length > 0) {
  log('    extensoes ja carregadas no browser:');
  for (const item of discoveredLoadedExtensions) {
    log(`      - ${item.browser}/${item.profile}: ${item.extensionPath}`);
  }
} else {
  log('    nenhuma extensao unpacked carregada foi detectada nos perfis Chrome/Edge/Brave/Dia');
}

step('Preparando pasta de export (se configurada)');
if (normalizedExportDir) {
  log(`    GEMINI_MCP_EXPORT_DIR = ${normalizedExportDir}`);
  ensureDir(normalizedExportDir);
} else {
  log('    nenhuma pasta fixa -- o modal deixa voce escolher');
}

step('Instalando dependencias (npm install)');
if (prebuiltPayload) {
  log('    pulado: usando payload precompilado embutido no instalador standalone');
} else {
  run(npmCommand, ['install'], 'npm install');
}

step('Compilando extensao e userscript (npm run build)');
if (prebuiltPayload) {
  log(`    pulado: extensao pronta em ${sourceExtensionPath}`);
  log(`    pulado: runtime MCP pronto em ${sourceMcpRuntimeDir}`);
} else {
  run(npmCommand, ['run', 'build'], 'npm run build');
}

step('Copiando arquivos para a pasta instalada');
stageInstall();

step('Sincronizando extensao ja carregada no browser');
syncLoadedBrowserExtensions();
writeLaunchers();

step('Configurando Claude Desktop (se detectado/solicitado)');
const claudeResult = configureClaude();

step('Configurando Gemini CLI (se detectado/solicitado)');
const geminiCliResult = configureGeminiCli();
linkLegacyBrowserExtensionPath();

step('Escrevendo resumo');
writeInstallManifest(claudeResult, geminiCliResult);
writeSummary(claudeResult, geminiCliResult);
writeLastInstallPointer();
log(`    ${resolve(installDir, 'INSTALL-SUMMARY.txt')}`);
log(`    ${resolve(installDir, 'INSTALL-MANIFEST.json')}`);

if (options.openBrowser && !options.dryRun) {
  log('');
  log(`Abrindo ${browserLaunchTarget.url} no ${browserLaunchTarget.name} para o proximo passo manual...`);
  openBrowserExtensions();
}

log('');
log('============================================================');
log('  Instalacao concluida com sucesso.');
log('============================================================');
log('');
log('Arquivos instalados:');
log(`  app:       ${installDir}`);
log(`  extensao:  ${geminiCliBrowserExtensionPath}`);
log(`  link legado: ${extensionPath}`);
log(`  gemini:    ${geminiCliExtensionBundlePath}`);
log(`  mcp:       ${mcpServerPath}`);
if (normalizedExportDir) log(`  export:    ${normalizedExportDir}`);
log('');
log('Launchers criados em ' + installDir + ':');
log('  start-mcp.cmd             -- sobe o servidor MCP + bridge HTTP');
log('  start-mcp.ps1             -- mesmo, em PowerShell');
log(`  open-browser-extensions.cmd -- abre ${browserLaunchTarget.url}`);
log(`  open-gemini.cmd           -- abre ${GEMINI_APP_URL} no navegador escolhido`);
log('  refresh-browser-extension.cmd -- abre a pagina de extensoes e guia o reload');
log('  restart-gemini-cli.cmd    -- encerra MCPs antigos e abre uma nova sessao gemini');
log('  mcp-config.claude.json    -- template do bloco mcpServers');
if (installBackupPath) log(`  backups\\...               -- copia anterior em ${installBackupPath}`);
if (syncedLoadedExtensions.length > 0) {
  log('');
  log('Extensoes unpacked ja carregadas no browser:');
  for (const item of syncedLoadedExtensions) {
    log(`  ${item.browser}/${item.profile}: ${item.status} -- ${item.extensionPath}`);
  }
}
log('');
log('Claude Desktop: ' +
  (claudeResult.status === 'configured'
    ? 'configurado (reinicie o Claude Desktop para ativar).'
    : `nao alterado (${claudeResult.reason}).`));
log('Gemini CLI:     ' +
  (geminiCliResult.status === 'configured'
    ? `configurado via ${geminiCliResult.method || 'metodo desconhecido'} (${geminiCliResult.sourcePath || geminiCliResult.extensionInstallPath}; reinicie a sessao do gemini para ativar).`
    : `nao alterado (${geminiCliResult.reason}).`));
log('');
log('PROXIMO PASSO MANUAL (obrigatorio):');
log(`  1. ${browserLaunchTarget.url} -- deve ter`);
log('     aberto sozinho se a flag --open-browser rodou.');
log('  2. Ative "Modo do desenvolvedor" / "Developer mode".');
log('  3. Clique em "Carregar sem compactacao" / "Load unpacked".');
log('  4. Selecione a pasta:');
log(`        ${geminiCliBrowserExtensionPath}`);
log('  5. Em upgrades, se o card ja existir, rode refresh-browser-extension.cmd');
log('     e clique no icone de reload da extensao.');
log('  6. Se o Gemini CLI estiver aberto, rode restart-gemini-cli.cmd.');
log(`  7. Abra ${GEMINI_APP_URL} ^(ou rode open-gemini.cmd^) e entre`);
log('     em uma conversa especifica ^(URL /app/<id>^).');
log('  8. Procure o botao de download no canto superior direito da conversa.');
log('');
log(`Detalhes completos: ${resolve(installDir, 'INSTALL-SUMMARY.txt')}`);
log('');
