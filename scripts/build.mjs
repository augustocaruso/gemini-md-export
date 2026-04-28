// Build step: gera:
// - dist/gemini-export.user.js
// - dist/extension/*
// - dist/gemini-cli-extension/*
//
// Ambos reutilizam a mesma shell com src/extract.mjs inlined.
//
// Estratégia:
// 1. Lê src/extract.mjs.
// 2. Remove as declarações `export` (viram apenas `const`/`function`).
// 3. Substitui o marcador em src/userscript-shell.js
//    pelo conteúdo preparado.
// 4. Substitui `__VERSION__` pelo version do package.json.
// 5. Escreve o userscript.
// 6. Reaproveita o mesmo bundle, sem bloco de metadados, como content script
//    de uma extensão MV3 desempacotada.
// 7. Gera manifest.json e service worker mínimos para a extensão.

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));
if (bridgeVersion.extensionVersion !== pkg.version) {
  console.error(
    `[build] bridge-version.json extensionVersion (${bridgeVersion.extensionVersion}) precisa bater com package.json (${pkg.version})`,
  );
  process.exit(1);
}
const extractSrc = readFileSync(resolve(ROOT, 'src/extract.mjs'), 'utf-8');
const notebookReturnPlanSrc = readFileSync(
  resolve(ROOT, 'src/notebook-return-plan.mjs'),
  'utf-8',
);
const batchSessionSrc = readFileSync(resolve(ROOT, 'src/batch-session.mjs'), 'utf-8');
const shellSrc = readFileSync(resolve(ROOT, 'src/userscript-shell.js'), 'utf-8');
const extensionBackgroundSrc = readFileSync(
  resolve(ROOT, 'src/extension-background.js'),
  'utf-8',
);
const geminiCliExtensionContextSrc = readFileSync(
  resolve(ROOT, 'gemini-cli-extension', 'GEMINI.md'),
  'utf-8',
);

// Remove `export` keywords para transformar o módulo em código top-level
// válido dentro do IIFE do userscript. Preserva o resto do código intacto.
const inlineable = extractSrc
  .replace(/^export\s+const\s+/gm, 'const ')
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

const inlineableNotebookReturnPlan = notebookReturnPlanSrc
  .replace(/^export\s+const\s+/gm, 'const ')
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
const inlineableBatchSession = batchSessionSrc
  .replace(/^export\s+const\s+/gm, 'const ')
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

const extractMarker = '/* __INLINE_EXTRACT_MODULE__ */';
const notebookReturnPlanMarker = '/* __INLINE_NOTEBOOK_RETURN_PLAN__ */';
const batchSessionMarker = '/* __INLINE_BATCH_SESSION_MODULE__ */';
if (!shellSrc.includes(extractMarker)) {
  console.error(`[build] marker "${extractMarker}" não encontrado em userscript-shell.js`);
  process.exit(1);
}
if (!shellSrc.includes(notebookReturnPlanMarker)) {
  console.error(
    `[build] marker "${notebookReturnPlanMarker}" não encontrado em userscript-shell.js`,
  );
  process.exit(1);
}
if (!shellSrc.includes(batchSessionMarker)) {
  console.error(`[build] marker "${batchSessionMarker}" não encontrado em userscript-shell.js`);
  process.exit(1);
}

const extractBanner =
  '  // ============================================================\n' +
  '  // Inlined from src/extract.mjs (auto-generated — do not edit)\n' +
  '  // ============================================================\n';
const notebookReturnPlanBanner =
  '  // ============================================================\n' +
  '  // Inlined from src/notebook-return-plan.mjs (auto-generated — do not edit)\n' +
  '  // ============================================================\n';
const batchSessionBanner =
  '  // ============================================================\n' +
  '  // Inlined from src/batch-session.mjs (auto-generated — do not edit)\n' +
  '  // ============================================================\n';
const inlinedExtract =
  extractBanner + inlineable.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedNotebookReturnPlan =
  notebookReturnPlanBanner +
  inlineableNotebookReturnPlan.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedBatchSession =
  batchSessionBanner +
  inlineableBatchSession.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');

// Carimbo de build curto (YYYYMMDD-HHMM) — ajuda a confirmar visualmente
// se a extensão/userscript carregado é a versão recém-compilada (útil quando
// o Chrome mantém cache do content script).
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

const output = shellSrc
  .replace(extractMarker, inlinedExtract)
  .replace(notebookReturnPlanMarker, inlinedNotebookReturnPlan)
  .replace(batchSessionMarker, inlinedBatchSession)
  .replace(/__VERSION__/g, pkg.version)
  .replace(/__EXTENSION_PROTOCOL_VERSION__/g, String(bridgeVersion.protocolVersion))
  .replace(/__BUILD_STAMP__/g, buildStamp);

const distDir = resolve(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const outPath = resolve(distDir, 'gemini-export.user.js');
writeFileSync(outPath, output, 'utf-8');

console.log(`[build] wrote ${outPath} (${output.length} bytes)`);

const metadataBlockRegex =
  /^\/\/ ==UserScript==\n[\s\S]*?^\/\/ ==\/UserScript==\n\n?/m;
const extensionContent = output.replace(metadataBlockRegex, '');

const extensionDir = resolve(distDir, 'extension');
mkdirSync(extensionDir, { recursive: true });

const manifest = {
  manifest_version: 3,
  name: 'Gemini Chat -> Markdown Export',
  version: pkg.version,
  description:
    'Exporta conversas do Gemini web como Markdown e prepara a base para integrações locais.',
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://gemini.google.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['tabs', 'storage'],
  host_permissions: [
    'https://gemini.google.com/*',
    'https://lh3.google.com/*',
    'https://*.googleusercontent.com/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
  action: {
    default_title: 'Gemini Export',
  },
};

writeFileSync(resolve(extensionDir, 'content.js'), extensionContent, 'utf-8');
writeFileSync(
  resolve(extensionDir, 'background.js'),
  extensionBackgroundSrc
    .replace(/__VERSION__/g, pkg.version)
    .replace(/__EXTENSION_PROTOCOL_VERSION__/g, String(bridgeVersion.protocolVersion))
    .replace(/__BUILD_STAMP__/g, buildStamp),
  'utf-8',
);
writeFileSync(
  resolve(extensionDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf-8',
);

console.log(`[build] wrote ${resolve(extensionDir, 'content.js')}`);
console.log(`[build] wrote ${resolve(extensionDir, 'background.js')}`);
console.log(`[build] wrote ${resolve(extensionDir, 'manifest.json')}`);

const geminiCliExtensionDir = resolve(distDir, 'gemini-cli-extension');
rmSync(geminiCliExtensionDir, { recursive: true, force: true });
mkdirSync(resolve(geminiCliExtensionDir, 'src'), { recursive: true });

const geminiCliExtensionManifest = {
  name: 'gemini-md-export',
  version: pkg.version,
  description:
    'Gemini CLI extension that exposes the local Gemini web Markdown exporter MCP and its operational context.',
  contextFileName: 'GEMINI.md',
  mcpServers: {
    'gemini-md-export': {
      command: 'node',
      args: ['${extensionPath}${/}src${/}mcp-server.js'],
      cwd: '${extensionPath}',
    },
  },
};

writeFileSync(
  resolve(geminiCliExtensionDir, 'gemini-extension.json'),
  JSON.stringify(geminiCliExtensionManifest, null, 2) + '\n',
  'utf-8',
);
writeFileSync(resolve(geminiCliExtensionDir, 'GEMINI.md'), geminiCliExtensionContextSrc, 'utf-8');
writeFileSync(
  resolve(geminiCliExtensionDir, 'package.json'),
  JSON.stringify(pkg, null, 2) + '\n',
  'utf-8',
);
writeFileSync(
  resolve(geminiCliExtensionDir, 'bridge-version.json'),
  JSON.stringify(bridgeVersion, null, 2) + '\n',
  'utf-8',
);
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'commands'))) {
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'commands'),
    resolve(geminiCliExtensionDir, 'commands'),
    { recursive: true },
  );
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'hooks'))) {
  cpSync(resolve(ROOT, 'gemini-cli-extension', 'hooks'), resolve(geminiCliExtensionDir, 'hooks'), {
    recursive: true,
  });
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'scripts', 'hooks'))) {
  mkdirSync(resolve(geminiCliExtensionDir, 'scripts'), { recursive: true });
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'scripts', 'hooks'),
    resolve(geminiCliExtensionDir, 'scripts', 'hooks'),
    { recursive: true },
  );
}
cpSync(extensionDir, resolve(geminiCliExtensionDir, 'browser-extension'), {
  recursive: true,
});
cpSync(resolve(ROOT, 'src', 'mcp-server.js'), resolve(geminiCliExtensionDir, 'src', 'mcp-server.js'));
cpSync(
  resolve(ROOT, 'src', 'chrome-extension-guard.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'chrome-extension-guard.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'browser-launch.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'browser-launch.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'recent-chats-policy.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'recent-chats-policy.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'recent-chats-load-more.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'recent-chats-load-more.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'mcp-server-errors.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'mcp-server-errors.mjs'),
);

console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'gemini-extension.json')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'GEMINI.md')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'package.json')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'bridge-version.json')}`);
if (existsSync(resolve(geminiCliExtensionDir, 'hooks'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'hooks')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'scripts', 'hooks'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'scripts', 'hooks')}`);
}
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'browser-extension')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'src', 'mcp-server.js')}`);
