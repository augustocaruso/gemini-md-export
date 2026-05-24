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
// 3. Substitui o marcador no shell gerado de src/userscript-shell.ts
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
const readUtf8 = (...parts) => readFileSync(resolve(ROOT, ...parts), 'utf-8');

const pkg = JSON.parse(readUtf8('package.json'));
const bridgeVersion = JSON.parse(readUtf8('bridge-version.json'));
if (bridgeVersion.extensionVersion !== pkg.version) {
  console.error(
    `[build] bridge-version.json extensionVersion (${bridgeVersion.extensionVersion}) precisa bater com package.json (${pkg.version})`,
  );
  process.exit(1);
}
const extractSrc = readUtf8('src/extract.mjs');
const notebookReturnPlanSrc = readUtf8('src/notebook-return-plan.mjs');
const batchSessionSrc = readUtf8('src/batch-session.mjs');
const domRunnerSrc = readUtf8('src/dom-runner.mjs');
const hostPaletteSrc = readUtf8('build', 'ts', 'browser', 'shared', 'host-palette.js');
const nativeStyleProfileSrc = readUtf8('build', 'ts', 'browser', 'shared', 'native-style-profile.js');
const modalVirtualListSrc = readUtf8('build', 'ts', 'browser', 'shared', 'modal-virtual-list.js');
const progressDockUiSrc = readUtf8('build', 'ts', 'browser', 'shared', 'progress-dock-ui.js');
const progressStateSrc = readUtf8('build', 'ts', 'browser', 'shared', 'progress-state.js');
const progressPortSrc = readUtf8('build', 'ts', 'browser', 'shared', 'progress-port.js');
const tabCommandsSrc = readUtf8('build', 'ts', 'browser', 'shared', 'tab-commands.js');
const bridgeClientSrc = readUtf8('build', 'ts', 'browser', 'shared', 'bridge-client.js');
const pageBlockerSrc = readUtf8('build', 'ts', 'browser', 'shared', 'page-blocker.js');
const coreChatIdSrc = readUtf8('build', 'ts', 'core', 'chat-id.js');
const geminiDomAdapterSrc = readUtf8(
  'build',
  'ts',
  'browser',
  'dom-adapter',
  'gemini-web-current.js',
);
const navigationEngineSrc = readUtf8('build', 'ts', 'browser', 'navigation', 'navigation-engine.js');
const hydrationProgressSrc = readUtf8('build', 'ts', 'browser', 'navigation', 'hydration-progress.js');
const shellGeneratedSrc = readUtf8('build', 'ts', 'userscript-shell.js');
const artifactCaptureSrc = readUtf8('src/artifact-capture.js');
const activityContentScriptGeneratedSrc = readUtf8('build', 'ts', 'activity-content-script.js');
const googleBlockerContentScriptGeneratedSrc = readUtf8(
  'build',
  'ts',
  'google-blocker-content-script.js',
);
const extensionBackgroundSrc = readUtf8('build', 'ts', 'extension-background.js');
const geminiCliExtensionContextSrc = readUtf8('gemini-cli-extension', 'GEMINI.md');

// Remove `export` keywords para transformar o módulo em código top-level
// válido dentro do IIFE do userscript. Preserva o resto do código intacto.
const stripModuleSyntax = (source) =>
  source
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+class\s+/gm, 'class ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

const shellSrc = stripModuleSyntax(shellGeneratedSrc);
const activityContentScriptSrc = stripModuleSyntax(activityContentScriptGeneratedSrc);
const inlineable = stripModuleSyntax(extractSrc);

const inlineableNotebookReturnPlan = stripModuleSyntax(notebookReturnPlanSrc);
const inlineableBatchSession = stripModuleSyntax(batchSessionSrc);
const inlineableDomRunner = stripModuleSyntax(domRunnerSrc);
const inlineableHostPalette = stripModuleSyntax(hostPaletteSrc);
const inlineableNativeStyleProfile = stripModuleSyntax(nativeStyleProfileSrc);
const inlineableModalVirtualList = stripModuleSyntax(modalVirtualListSrc);
const inlineableProgressDockUi = stripModuleSyntax(progressDockUiSrc);
const inlineableProgressState = stripModuleSyntax(progressStateSrc);
const inlineableProgressPort = stripModuleSyntax(progressPortSrc);
const inlineableTabCommands = stripModuleSyntax(tabCommandsSrc);
const inlineableBridgeClient = stripModuleSyntax(bridgeClientSrc);
const inlineableCoreChatId = stripModuleSyntax(coreChatIdSrc);
const inlineableGeminiDomAdapter = stripModuleSyntax(geminiDomAdapterSrc);
const inlineableNavigationEngine = stripModuleSyntax(navigationEngineSrc);
const inlineableHydrationProgress = stripModuleSyntax(hydrationProgressSrc);

const extractMarker = '/* __INLINE_EXTRACT_MODULE__ */';
const notebookReturnPlanMarker = '/* __INLINE_NOTEBOOK_RETURN_PLAN__ */';
const batchSessionMarker = '/* __INLINE_BATCH_SESSION_MODULE__ */';
const domRunnerMarker = '/* __INLINE_DOM_RUNNER_MODULE__ */';
const progressDockUiMarker = '/* __INLINE_PROGRESS_DOCK_UI__ */';
const progressPortMarker = '/* __INLINE_PROGRESS_PORT__ */';
const tabCommandsMarker = '/* __INLINE_TAB_COMMANDS__ */';
const bridgeClientMarker = '/* __INLINE_BRIDGE_CLIENT__ */';
const pageBlockerMarker = '/* __INLINE_PAGE_BLOCKER__ */';
const browserNavigationStackMarker = '/* __INLINE_BROWSER_NAVIGATION_STACK__ */';
if (!shellSrc.includes(extractMarker)) {
  console.error(`[build] marker "${extractMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(notebookReturnPlanMarker)) {
  console.error(
    `[build] marker "${notebookReturnPlanMarker}" não encontrado em userscript-shell.ts`,
  );
  process.exit(1);
}
if (!shellSrc.includes(batchSessionMarker)) {
  console.error(`[build] marker "${batchSessionMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(domRunnerMarker)) {
  console.error(`[build] marker "${domRunnerMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(progressDockUiMarker)) {
  console.error(`[build] marker "${progressDockUiMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(progressPortMarker)) {
  console.error(`[build] marker "${progressPortMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(tabCommandsMarker)) {
  console.error(`[build] marker "${tabCommandsMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(bridgeClientMarker)) {
  console.error(`[build] marker "${bridgeClientMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(pageBlockerMarker)) {
  console.error(`[build] marker "${pageBlockerMarker}" não encontrado em userscript-shell.ts`);
  process.exit(1);
}
if (!shellSrc.includes(browserNavigationStackMarker)) {
  console.error(
    `[build] marker "${browserNavigationStackMarker}" não encontrado em userscript-shell.ts`,
  );
  process.exit(1);
}
if (!activityContentScriptSrc.includes(progressDockUiMarker)) {
  console.error(
    `[build] marker "${progressDockUiMarker}" não encontrado em activity-content-script.ts`,
  );
  process.exit(1);
}
if (!activityContentScriptSrc.includes(progressPortMarker)) {
  console.error(
    `[build] marker "${progressPortMarker}" não encontrado em activity-content-script.ts`,
  );
  process.exit(1);
}
if (!activityContentScriptSrc.includes(tabCommandsMarker)) {
  console.error(
    `[build] marker "${tabCommandsMarker}" não encontrado em activity-content-script.ts`,
  );
  process.exit(1);
}
if (!activityContentScriptSrc.includes(bridgeClientMarker)) {
  console.error(
    `[build] marker "${bridgeClientMarker}" não encontrado em activity-content-script.ts`,
  );
  process.exit(1);
}
if (!googleBlockerContentScriptGeneratedSrc.includes(bridgeClientMarker)) {
  console.error(
    `[build] marker "${bridgeClientMarker}" não encontrado em google-blocker-content-script.ts`,
  );
  process.exit(1);
}
if (!googleBlockerContentScriptGeneratedSrc.includes(pageBlockerMarker)) {
  console.error(
    `[build] marker "${pageBlockerMarker}" não encontrado em google-blocker-content-script.ts`,
  );
  process.exit(1);
}

const banner = (source) =>
  `  // ============================================================\n  // Inlined from ${source} (auto-generated — do not edit)\n  // ============================================================\n`;
const extractBanner = banner('src/extract.mjs');
const notebookReturnPlanBanner = banner('src/notebook-return-plan.mjs');
const batchSessionBanner = banner('src/batch-session.mjs');
const domRunnerBanner = banner('src/dom-runner.mjs');
const progressDockUiBanner = banner('src/browser/shared/progress-dock-ui.ts');
const progressStateBanner = banner('src/browser/shared/progress-state.ts');
const hostPaletteBanner = banner('src/browser/shared/host-palette.ts');
const nativeStyleProfileBanner = banner('src/browser/shared/native-style-profile.ts');
const modalVirtualListBanner = banner('src/browser/shared/modal-virtual-list.ts');
const progressPortBanner = banner('src/browser/shared/progress-port.ts');
const tabCommandsBanner = banner('src/browser/shared/tab-commands.ts');
const bridgeClientBanner = banner('src/browser/shared/bridge-client.ts');
const pageBlockerBanner = banner('src/browser/shared/page-blocker.ts');
const browserNavigationStackBanner = banner('src/core/chat-id.ts + browser DOM/navigation modules');
const inlinedExtract =
  extractBanner + inlineable.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedNotebookReturnPlan =
  notebookReturnPlanBanner +
  inlineableNotebookReturnPlan.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedBatchSession =
  batchSessionBanner +
  inlineableBatchSession.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedDomRunner =
  domRunnerBanner +
  inlineableDomRunner.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedProgressDockUi =
  hostPaletteBanner +
  inlineableHostPalette.split('\n').map((l) => (l ? '  ' + l : l)).join('\n') +
  '\n' +
  nativeStyleProfileBanner +
  inlineableNativeStyleProfile.split('\n').map((l) => (l ? '  ' + l : l)).join('\n') +
  '\n' +
  modalVirtualListBanner +
  inlineableModalVirtualList.split('\n').map((l) => (l ? '  ' + l : l)).join('\n') +
  '\n' +
  progressStateBanner +
  inlineableProgressState.split('\n').map((l) => (l ? '  ' + l : l)).join('\n') +
  '\n' +
  progressDockUiBanner +
  inlineableProgressDockUi.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedProgressPort =
  progressPortBanner +
  inlineableProgressPort.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedTabCommands =
  tabCommandsBanner +
  inlineableTabCommands.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedBridgeClient =
  bridgeClientBanner +
  inlineableBridgeClient.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlineablePageBlocker = stripModuleSyntax(pageBlockerSrc);
const inlinedPageBlocker =
  pageBlockerBanner +
  inlineablePageBlocker.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
const inlinedBrowserNavigationStack =
  browserNavigationStackBanner +
  [
    inlineableCoreChatId,
    inlineableGeminiDomAdapter,
    inlineableNavigationEngine,
    inlineableHydrationProgress,
  ]
    .join('\n')
    .split('\n')
    .map((l) => (l ? '  ' + l : l))
    .join('\n');

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
  .replace(domRunnerMarker, inlinedDomRunner)
  .replace(progressDockUiMarker, inlinedProgressDockUi)
  .replace(progressPortMarker, inlinedProgressPort)
  .replace(tabCommandsMarker, inlinedTabCommands)
  .replace(bridgeClientMarker, inlinedBridgeClient)
  .replace(pageBlockerMarker, inlinedPageBlocker)
  .replace(browserNavigationStackMarker, inlinedBrowserNavigationStack)
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
    {
      matches: ['https://myactivity.google.com/product/gemini*'],
      js: ['activity-content-script.js'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://www.google.com/sorry/*', 'https://accounts.google.com/*'],
      js: ['google-blocker-content-script.js'],
      run_at: 'document_idle',
    },
    {
      matches: [
        'https://*.usercontent.goog/gemini-code-immersive/*',
        'https://*.googleusercontent.com/gemini-code-immersive/*',
      ],
      js: ['artifact-capture.js'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
  permissions: [
    'tabs',
    'storage',
    'tabGroups',
    'scripting',
    'nativeMessaging',
    'offscreen',
    'debugger',
  ],
  host_permissions: [
    'https://gemini.google.com/*',
    'https://myactivity.google.com/*',
    'https://www.google.com/sorry/*',
    'https://accounts.google.com/*',
    'https://lh3.google.com/*',
    'https://*.googleusercontent.com/*',
    'https://*.usercontent.goog/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
  action: {
    default_title: 'Gemini Export',
  },
};

writeFileSync(resolve(extensionDir, 'content.js'), extensionContent, 'utf-8');
writeFileSync(resolve(extensionDir, 'artifact-capture.js'), artifactCaptureSrc, 'utf-8');
writeFileSync(
  resolve(extensionDir, 'activity-content-script.js'),
  activityContentScriptSrc
    .replace(progressDockUiMarker, inlinedProgressDockUi)
    .replace(progressPortMarker, inlinedProgressPort)
    .replace(tabCommandsMarker, inlinedTabCommands)
    .replace(bridgeClientMarker, inlinedBridgeClient)
    .replace(/__VERSION__/g, pkg.version)
    .replace(/__EXTENSION_PROTOCOL_VERSION__/g, String(bridgeVersion.protocolVersion))
    .replace(/__BUILD_STAMP__/g, buildStamp),
  'utf-8',
);
writeFileSync(
  resolve(extensionDir, 'google-blocker-content-script.js'),
  stripModuleSyntax(googleBlockerContentScriptGeneratedSrc)
    .replace(bridgeClientMarker, inlinedBridgeClient)
    .replace(pageBlockerMarker, inlinedPageBlocker)
    .replace(/__VERSION__/g, pkg.version)
    .replace(/__EXTENSION_PROTOCOL_VERSION__/g, String(bridgeVersion.protocolVersion))
    .replace(/__BUILD_STAMP__/g, buildStamp),
  'utf-8',
);
cpSync(resolve(ROOT, 'src', 'offscreen.html'), resolve(extensionDir, 'offscreen.html'));
cpSync(resolve(ROOT, 'src', 'offscreen.js'), resolve(extensionDir, 'offscreen.js'));
cpSync(
  resolve(ROOT, 'build', 'ts', 'browser'),
  resolve(extensionDir, 'browser'),
  { recursive: true },
);
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
console.log(`[build] wrote ${resolve(extensionDir, 'artifact-capture.js')}`);
console.log(`[build] wrote ${resolve(extensionDir, 'activity-content-script.js')}`);
console.log(`[build] wrote ${resolve(extensionDir, 'google-blocker-content-script.js')}`);
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
      env: {
        GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
      },
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
  JSON.stringify({ ...bridgeVersion, buildStamp }, null, 2) + '\n',
  'utf-8',
);
if (existsSync(resolve(ROOT, 'build', 'ts'))) {
  cpSync(resolve(ROOT, 'build', 'ts'), resolve(geminiCliExtensionDir, 'build', 'ts'), {
    recursive: true,
  });
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'commands'))) {
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'commands'),
    resolve(geminiCliExtensionDir, 'commands'),
    { recursive: true },
  );
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'agents'))) {
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'agents'),
    resolve(geminiCliExtensionDir, 'agents'),
    { recursive: true },
  );
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'skills'))) {
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'skills'),
    resolve(geminiCliExtensionDir, 'skills'),
    { recursive: true },
  );
}
const bundledReferenceDocsDir = resolve(ROOT, 'docs', 'reference');
if (existsSync(bundledReferenceDocsDir)) {
  mkdirSync(resolve(geminiCliExtensionDir, 'docs'), { recursive: true });
  cpSync(bundledReferenceDocsDir, resolve(geminiCliExtensionDir, 'docs', 'reference'), {
    recursive: true,
  });
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'hooks'))) {
  cpSync(resolve(ROOT, 'gemini-cli-extension', 'hooks'), resolve(geminiCliExtensionDir, 'hooks'), {
    recursive: true,
  });
}
if (existsSync(resolve(ROOT, 'gemini-cli-extension', 'scripts'))) {
  cpSync(
    resolve(ROOT, 'gemini-cli-extension', 'scripts'),
    resolve(geminiCliExtensionDir, 'scripts'),
    { recursive: true },
  );
}
if (existsSync(resolve(ROOT, 'bin'))) {
  cpSync(resolve(ROOT, 'bin'), resolve(geminiCliExtensionDir, 'bin'), {
    recursive: true,
  });
}
mkdirSync(resolve(geminiCliExtensionDir, 'scripts'), { recursive: true });
cpSync(
  resolve(ROOT, 'scripts', 'bridge-smoke.mjs'),
  resolve(geminiCliExtensionDir, 'scripts', 'bridge-smoke.mjs'),
);
cpSync(
  resolve(ROOT, 'scripts', 'smoke-export-integrity.mjs'),
  resolve(geminiCliExtensionDir, 'scripts', 'smoke-export-integrity.mjs'),
);
cpSync(
  resolve(ROOT, 'scripts', 'native-host-manifest.mjs'),
  resolve(geminiCliExtensionDir, 'scripts', 'native-host-manifest.mjs'),
);
cpSync(extensionDir, resolve(geminiCliExtensionDir, 'browser-extension'), {
  recursive: true,
});
cpSync(resolve(ROOT, 'src', 'mcp-server.js'), resolve(geminiCliExtensionDir, 'src', 'mcp-server.js'));
cpSync(resolve(ROOT, 'src', 'bridge-server.js'), resolve(geminiCliExtensionDir, 'src', 'bridge-server.js'));
cpSync(
  resolve(ROOT, 'src', 'chrome-extension-guard.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'chrome-extension-guard.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'browser-launch.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'browser-launch.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'browser-diagnostics.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'browser-diagnostics.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'recent-chats-policy.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'recent-chats-policy.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'mcp-server-errors.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'mcp-server-errors.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'job-progress-broadcast.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'job-progress-broadcast.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'job-trace.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'job-trace.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'tab-session.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'tab-session.mjs'),
);
cpSync(
  resolve(ROOT, 'src', 'timeout-diagnostics.mjs'),
  resolve(geminiCliExtensionDir, 'src', 'timeout-diagnostics.mjs'),
);
cpSync(resolve(ROOT, 'src', 'telemetry.mjs'), resolve(geminiCliExtensionDir, 'src', 'telemetry.mjs'));
if (existsSync(resolve(ROOT, '.telemetry-defaults.json'))) {
  cpSync(
    resolve(ROOT, '.telemetry-defaults.json'),
    resolve(geminiCliExtensionDir, 'telemetry.defaults.json'),
  );
}
if (existsSync(resolve(ROOT, 'telemetry.defaults.example.json'))) {
  cpSync(
    resolve(ROOT, 'telemetry.defaults.example.json'),
    resolve(geminiCliExtensionDir, 'telemetry.defaults.example.json'),
  );
}
cpSync(resolve(ROOT, 'src', 'native-host.mjs'), resolve(geminiCliExtensionDir, 'src', 'native-host.mjs'));
if (existsSync(resolve(ROOT, 'native-messaging'))) {
  cpSync(
    resolve(ROOT, 'native-messaging'),
    resolve(geminiCliExtensionDir, 'native-messaging'),
    { recursive: true },
  );
}

console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'gemini-extension.json')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'GEMINI.md')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'package.json')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'bridge-version.json')}`);
if (existsSync(resolve(geminiCliExtensionDir, 'hooks'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'hooks')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'agents'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'agents')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'skills'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'skills')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'docs'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'docs')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'build', 'ts'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'build', 'ts')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'scripts'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'scripts')}`);
}
if (existsSync(resolve(geminiCliExtensionDir, 'bin'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'bin')}`);
}
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'browser-extension')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'src', 'mcp-server.js')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'src', 'bridge-server.js')}`);
console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'src', 'native-host.mjs')}`);
if (existsSync(resolve(geminiCliExtensionDir, 'native-messaging'))) {
  console.log(`[build] wrote ${resolve(geminiCliExtensionDir, 'native-messaging')}`);
}
