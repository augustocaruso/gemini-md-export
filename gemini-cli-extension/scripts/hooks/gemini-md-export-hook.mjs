#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] || '';
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(__dirname, '..', '..');
let wroteOutput = false;
const earlyNonNegativeInt = (value, fallback, max = 60_000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
};
const HARD_EXIT_MS = earlyNonNegativeInt(
  process.env.GEMINI_MCP_HOOK_HARD_EXIT_MS,
  mode === 'before-tool' ? 18_000 : mode === 'session-start' ? 2500 : 750,
);
const hardExit = setTimeout(() => {
  writeHookDiagnostic({
    stage: 'hard-exit',
    elapsedMs: Date.now() - RUN_STARTED_AT,
  });
  if (!wroteOutput) {
    process.stdout.write(`${JSON.stringify({ suppressOutput: true })}\n`);
  }
  process.exit(0);
}, HARD_EXIT_MS);

const SESSION_CONTEXT = [
  'Gemini MD Export: use the compact gemini-md-export MCP tools: gemini_ready, gemini_tabs, gemini_chats, gemini_export, gemini_job, gemini_config, and gemini_support.',
  'Treat media as complete only when mediaFailureCount is 0. If a media warning appears and mediaFileCount is 0, investigate before saying images were imported.',
  'Forbidden paths for this project: Gemini cookies, private/internal Gemini APIs, chrome.debugger, captureVisibleTab, screenshot/crop media fallbacks, and new browser permissions.',
].join('\n');

const BLOCK_REASON =
  'Bloqueado pelo gemini-md-export: este caminho esta fora do escopo combinado. Use DOM atual, data/blob, fetch permitido, bridge/background existente ou lightbox controlado; se nao houver bytes legiveis, mantenha um warning honesto.';

const MEDIA_WARNING_RE =
  /\[!warning\]\s*M[ií]dia n[aã]o importada|M[ií]dia n[aã]o exportada|media n(?:ao|ão) importad/i;

const GEMINI_APP_URL = 'https://gemini.google.com/app';
const DEFAULT_BROWSER_LAUNCH_COOLDOWN_MS = 60000;
const DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS = 180;
const DEFAULT_HOOK_STDIN_TIMEOUT_MS = 120;
const DEFAULT_HOOK_LAUNCH_OBSERVE_MS = 120;
const DEFAULT_HOOK_CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_HOOK_CONNECT_POLL_MS = 350;
const DEFAULT_SESSION_BRIDGE_WAIT_MS = 1200;
const DEFAULT_LAUNCH_LOCK_GRACE_MS = 2_000;
const MAX_STDIN_BYTES = 1024 * 1024;
const HOOK_BROWSER_STATE_FILENAME = 'hook-browser-launch.json';
const HOOK_LAST_RUN_FILENAME = 'hook-last-run.json';
const WINDOWS_RESTORE_FOCUS_SCRIPT_FILENAME = 'open-gemini-restore-focus.ps1';
const RUN_STARTED_AT = Date.now();
let diagnosticState = {
  pid: process.pid,
  mode,
  startedAt: new Date(RUN_STARTED_AT).toISOString(),
  hardExitMs: HARD_EXIT_MS,
  stageDurations: {},
};

const BROWSER_DEPENDENT_EXPORTER_TOOL_ACTIONS = {
  gemini_ready: new Set(['status']),
  gemini_tabs: new Set(['list', 'claim', 'reload']),
  gemini_chats: new Set(['list', 'current', 'open', 'download']),
  gemini_config: new Set(['cache_status', 'clear_cache']),
  gemini_support: new Set(['snapshot']),
};

const DEFAULT_EXPORTER_TOOL_ACTION = {
  gemini_ready: 'check',
  gemini_tabs: 'list',
  gemini_chats: 'list',
  gemini_export: 'recent',
  gemini_config: 'get_export_dir',
  gemini_support: 'diagnose',
};

const normalizeExporterToolName = (toolName) =>
  String(toolName || '')
    .replace(/^mcp__gemini[-_]md[-_]export__/, '')
    .replace(/^mcp[_-]gemini[_-]md[_-]export[_-]/, '')
    .replace(/^gemini-md-export[_-]/, '');

const isBrowserDependentExporterTool = (input) => {
  const normalized = normalizeExporterToolName(getToolName(input));
  const toolName = normalized.replace(/-/g, '_');
  const allowedActions = BROWSER_DEPENDENT_EXPORTER_TOOL_ACTIONS[toolName];
  if (!allowedActions) return false;
  const toolInput = getToolInput(input);
  const action = String(toolInput?.action || DEFAULT_EXPORTER_TOOL_ACTION[toolName] || '').replace(
    /-/g,
    '_',
  );
  return allowedActions.has(action);
};

const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const isDisabled = (value) => String(value || '').trim().toLowerCase() === 'false';

const isEnabled = (value) => /^(1|true|yes|sim)$/i.test(String(value || '').trim());

const currentPlatform = () => process.env.GEMINI_MCP_HOOK_PLATFORM || process.platform;

const quotePowerShellString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const normalizeBrowserKey = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'chrome';
  if (/^(google[-_\s]*)?chrome$|chrome\.exe$/.test(text)) return 'chrome';
  if (/^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$/.test(text)) return 'edge';
  if (/^brave$|brave[-_\s]*browser|brave(\.exe)?$/.test(text)) return 'brave';
  if (/^dia$|dia(\.exe)?$/.test(text)) return 'dia';
  return text;
};

const firstExisting = (paths) => paths.filter(Boolean).find((candidate) => existsSync(candidate));

const windowsBrowserConfigs = (env = process.env) => {
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return {
    chrome: {
      name: 'Chrome',
      fallbackCommand: 'chrome.exe',
      explicit: env.GEMINI_MCP_CHROME_EXE || env.GME_CHROME_EXE,
      paths: [
        localAppData && win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
    },
    edge: {
      name: 'Edge',
      fallbackCommand: 'msedge.exe',
      explicit: env.GEMINI_MCP_EDGE_EXE || env.GME_EDGE_EXE,
      paths: [
        localAppData && win32.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
    brave: {
      name: 'Brave',
      fallbackCommand: 'brave.exe',
      explicit: env.GEMINI_MCP_BRAVE_EXE || env.GME_BRAVE_EXE,
      paths: [
        localAppData &&
          win32.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        win32.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        win32.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ],
    },
    dia: {
      name: 'Dia',
      fallbackCommand: 'dia.exe',
      explicit: env.GEMINI_MCP_DIA_EXE || env.GME_DIA_EXE,
      paths: [
        localAppData && win32.join(localAppData, 'Programs', 'Dia', 'Dia.exe'),
        env.APPDATA && win32.join(env.APPDATA, 'Dia', 'Application', 'Dia.exe'),
      ],
    },
  };
};

const browserOrder = (preferredKey) => [
  preferredKey,
  ...['chrome', 'edge', 'brave', 'dia'].filter((key) => key !== preferredKey),
];

const resolveWindowsBrowserForHook = (env = process.env) => {
  const preferredKey = normalizeBrowserKey(env.GEMINI_MCP_BROWSER || env.GME_BROWSER || 'chrome');
  const configs = windowsBrowserConfigs(env);

  for (const key of browserOrder(preferredKey)) {
    const config = configs[key];
    if (!config) continue;
    const command = config.explicit || firstExisting(config.paths) || config.fallbackCommand;
    if (!command) continue;
    return {
      browserKey: key,
      browserName: config.name,
      command,
      fallbackFrom: key === preferredKey ? null : configs[preferredKey]?.name || preferredKey,
    };
  }

  return {
    browserKey: preferredKey,
    browserName: configs[preferredKey]?.name || preferredKey,
    command: 'chrome.exe',
    fallbackFrom: null,
  };
};

const hookStateDir = () =>
  process.env.GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR ||
  process.env.GEMINI_MCP_HOOK_STATE_DIR ||
  resolve(process.env.TEMP || process.env.TMP || tmpdir(), 'gemini-md-export');

const hookStatePath = () => resolve(hookStateDir(), HOOK_BROWSER_STATE_FILENAME);

const hookLastRunPath = () => resolve(hookStateDir(), HOOK_LAST_RUN_FILENAME);

const windowsRestoreFocusScriptPath = () =>
  resolve(hookStateDir(), WINDOWS_RESTORE_FOCUS_SCRIPT_FILENAME);

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
};

const readHookState = () => {
  return readJsonFile(hookStatePath());
};

const writeHookState = (state) => {
  try {
    mkdirSync(hookStateDir(), { recursive: true });
    writeFileSync(hookStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.error(`[gemini-md-export-hook] failed to write launch state: ${err.message}`);
  }
};

const writeHookDiagnostic = (patch) => {
  diagnosticState = {
    ...diagnosticState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(hookStateDir(), { recursive: true });
    writeFileSync(hookLastRunPath(), `${JSON.stringify(diagnosticState, null, 2)}\n`, 'utf-8');
  } catch {
    // Diagnostics must never make the advisory hook noisy or blocking.
  }
};

const recordStageDuration = (stage, startedAt) => {
  diagnosticState.stageDurations = {
    ...(diagnosticState.stageDurations || {}),
    [stage]: Date.now() - startedAt,
  };
};

const withStageTiming = async (stage, fn) => {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordStageDuration(stage, startedAt);
  }
};

const currentConnectTimeoutMs = () =>
  parseNonNegativeInt(
    process.env.GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS,
    DEFAULT_HOOK_CONNECT_TIMEOUT_MS,
  );

const currentConnectPollMs = () =>
  parseNonNegativeInt(
    process.env.GEMINI_MCP_HOOK_CONNECT_POLL_MS,
    DEFAULT_HOOK_CONNECT_POLL_MS,
  );

const buildLaunchId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const secondsText = (ms) => {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 100) / 10);
  if (seconds === 1) return '1s';
  return `${seconds}s`;
};

const bridgeReasonText = (status) => {
  if (!status) return 'sem detalhe';
  if (status.reason) return status.reason;
  if (status.statusCode) return `HTTP ${status.statusCode}`;
  return 'sem detalhe';
};

const browserNameFromLaunch = (launch) =>
  launch?.browserName || launch?.plan?.browserName || launch?.browserKey || 'navegador';

const manualBrowserRecoveryMessage =
  'Rode gemini_ready { action: "status" } para acionar o auto-reload da extensao; se houver abas conectadas mas travadas, use gemini_tabs { action: "reload" }. Recarregar o card em chrome://extensions ou edge://extensions e o ultimo recurso.';

const systemMessageForConnectWait = (connectWait, launch, { reusedLaunch = false } = {}) => {
  const browserName = browserNameFromLaunch(launch);
  if (connectWait?.connected) {
    if (reusedLaunch) {
      return `Gemini Exporter: outra chamada ja estava acordando o navegador; a aba Gemini conectou em ${secondsText(connectWait.waitedMs)}.`;
    }
    return `Gemini Exporter: abri ${browserName} e a aba Gemini conectou em ${secondsText(connectWait.waitedMs)}.`;
  }

  const waitedMs = connectWait?.timeoutMs ?? connectWait?.waitedMs ?? currentConnectTimeoutMs();
  if (reusedLaunch) {
    return `Gemini Exporter: outra chamada ja tentou abrir o navegador, mas a extensao nao conectou em ${secondsText(waitedMs)}. ${manualBrowserRecoveryMessage}`;
  }
  return `Gemini Exporter: abri ${browserName}, mas a extensao nao conectou em ${secondsText(waitedMs)}. ${manualBrowserRecoveryMessage}`;
};

const buildWindowsRestoreFocusLaunchScript = (
  command,
  args = [],
  { restoreDelayMs = 900 } = {},
) => {
  const argArray = args.map(quotePowerShellString).join(', ');
  return [
    '# Generated by gemini-md-export. Opens Gemini with separate argv items, then restores the previous foreground window.',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class GeminiMdExportWin32 {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    '$previousWindow = [GeminiMdExportWin32]::GetForegroundWindow()',
    `$browser = ${quotePowerShellString(command)}`,
    `$arguments = @(${argArray})`,
    'Start-Process -FilePath $browser -ArgumentList $arguments -WindowStyle Minimized',
    `Start-Sleep -Milliseconds ${Math.max(0, Math.min(5000, Number(restoreDelayMs) || 0))}`,
    'if ($previousWindow -ne [IntPtr]::Zero) {',
    '  [GeminiMdExportWin32]::ShowWindowAsync($previousWindow, 9) | Out-Null',
    '  [GeminiMdExportWin32]::SetForegroundWindow($previousWindow) | Out-Null',
    '}',
    '',
  ].join('\r\n');
};

const writeWindowsRestoreFocusLaunchScript = (command, args = []) => {
  mkdirSync(hookStateDir(), { recursive: true });
  const scriptPath = windowsRestoreFocusScriptPath();
  writeFileSync(
    scriptPath,
    buildWindowsRestoreFocusLaunchScript(command, args, {
      restoreDelayMs: parseNonNegativeInt(
        process.env.GEMINI_MCP_BROWSER_RESTORE_FOCUS_DELAY_MS,
        900,
      ),
    }),
    'utf-8',
  );
  return scriptPath;
};

const currentLaunchCooldownMs = () =>
  parseNonNegativeInt(
    process.env.GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS,
    DEFAULT_BROWSER_LAUNCH_COOLDOWN_MS,
  );

const launchLockGraceMs = () =>
  parseNonNegativeInt(process.env.GEMINI_MCP_HOOK_LAUNCH_LOCK_GRACE_MS, DEFAULT_LAUNCH_LOCK_GRACE_MS);

const buildLaunchLockExpiry = (now) => now + currentConnectTimeoutMs() + launchLockGraceMs();

const activeLaunchLock = (state, now) =>
  state?.status === 'launching' && Number(state.expiresAt || 0) > now;

const shouldSkipBrowserLaunchForCooldown = (state, now) => {
  if (isEnabled(process.env.GEMINI_MCP_HOOK_ALWAYS_LAUNCH_BROWSER)) return false;
  const cooldownMs = currentLaunchCooldownMs();
  if (cooldownMs === 0) return false;
  const lastAttemptAt = Number(state?.lastAttemptAt || 0);
  return lastAttemptAt > 0 && now - lastAttemptAt < cooldownMs;
};

const queryConnectedBrowserClients = () =>
  new Promise((resolveResult) => {
    if (isDisabled(process.env.GEMINI_MCP_HOOK_BRIDGE_CHECK)) {
      resolveResult({ checked: false, connectedCount: null, reason: 'disabled' });
      return;
    }

    const timeoutMs = parseNonNegativeInt(
      process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS,
      DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS,
    );
    const port = parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveResult({ checked: true, ...result });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/agent/clients',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const connectedClients = Array.isArray(parsed.connectedClients)
              ? parsed.connectedClients
              : [];
            finish({
              reachable: res.statusCode >= 200 && res.statusCode < 300,
              statusCode: res.statusCode,
              connectedCount: connectedClients.length,
            });
          } catch (err) {
            finish({
              reachable: false,
              statusCode: res.statusCode,
              connectedCount: null,
              reason: `invalid-json: ${err.message}`,
            });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ reachable: false, connectedCount: null, reason: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ reachable: false, connectedCount: null, reason: err.message });
    });
    req.end();
  });

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const firstFiniteNumber = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const inferBrowserReadyBlockingIssue = ({
  connectedCount = 0,
  matchingClientCount = 0,
  selectableTabCount = 0,
  commandReadyClientCount = 0,
} = {}) => {
  if (connectedCount === 0) return 'no_connected_clients';
  if (matchingClientCount === 0) return 'extension_version_mismatch';
  if (selectableTabCount === 0) return 'no_selectable_gemini_tab';
  if (commandReadyClientCount === 0) return 'command_channel_not_ready';
  return null;
};

const normalizeBrowserReadyResponse = (
  parsed,
  { statusCode = null, endpoint = '/agent/ready', fallbackFromReady = null } = {},
) => {
  const connectedClients = Array.isArray(parsed?.connectedClients) ? parsed.connectedClients : [];
  const connectedCount = firstFiniteNumber(parsed?.connectedClientCount, connectedClients.length);
  const selectableTabCount = firstFiniteNumber(parsed?.selectableTabCount, connectedCount);
  const matchingClientCount = firstFiniteNumber(parsed?.matchingClientCount, connectedCount);
  const commandReadyClientCount = firstFiniteNumber(
    parsed?.commandReadyClientCount,
    matchingClientCount,
  );
  const hasSemanticReady = hasOwn(parsed, 'ready') || hasOwn(parsed, 'ok');
  const ready = hasSemanticReady
    ? parsed?.ready === true ||
      (parsed?.ready !== false &&
        parsed?.ok === true &&
        selectableTabCount > 0 &&
        matchingClientCount > 0 &&
        commandReadyClientCount > 0)
    : connectedCount > 0;
  const blockingIssue = ready
    ? null
    : parsed?.blockingIssue ||
      inferBrowserReadyBlockingIssue({
        connectedCount,
        matchingClientCount,
        selectableTabCount,
        commandReadyClientCount,
      });

  return {
    checked: true,
    reachable: statusCode >= 200 && statusCode < 300,
    statusCode,
    endpoint,
    ready,
    connectedCount,
    selectableTabCount,
    matchingClientCount,
    commandReadyClientCount,
    blockingIssue,
    mode: parsed?.mode || null,
    fallbackFromReady,
  };
};

const queryBrowserReadiness = () =>
  new Promise((resolveResult) => {
    if (isDisabled(process.env.GEMINI_MCP_HOOK_BRIDGE_CHECK)) {
      resolveResult({
        checked: false,
        reachable: false,
        ready: false,
        connectedCount: null,
        reason: 'disabled',
      });
      return;
    }

    const timeoutMs = parseNonNegativeInt(
      process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS,
      DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS,
    );
    const port = parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283);
    let done = false;
    const fallbackToClients = async (readyStatus) => {
      if (done) return;
      done = true;
      const clientStatus = await queryConnectedBrowserClients();
      resolveResult({
        ...normalizeBrowserReadyResponse(
          {
            connectedClientCount: clientStatus.connectedCount,
            connectedClients:
              clientStatus.connectedCount > 0
                ? Array.from({ length: clientStatus.connectedCount }, (_, index) => ({
                    clientId: `compat-${index + 1}`,
                  }))
                : [],
          },
          {
            statusCode: clientStatus.statusCode ?? null,
            endpoint: '/agent/clients',
            fallbackFromReady: readyStatus,
          },
        ),
        checked: clientStatus.checked,
        reachable: clientStatus.reachable,
        reason: clientStatus.reason,
      });
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveResult({ checked: true, ...result });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/agent/ready?wakeBrowser=false&selfHeal=false',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          if (res.statusCode === 404) {
            fallbackToClients({ checked: true, reachable: true, statusCode: res.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            finish(normalizeBrowserReadyResponse(parsed, { statusCode: res.statusCode }));
          } catch (err) {
            finish({
              reachable: false,
              statusCode: res.statusCode,
              ready: false,
              connectedCount: null,
              reason: `invalid-json: ${err.message}`,
              endpoint: '/agent/ready',
            });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({
        reachable: false,
        ready: false,
        connectedCount: null,
        reason: 'timeout',
        endpoint: '/agent/ready',
      });
    });
    req.on('error', (err) => {
      finish({
        reachable: false,
        ready: false,
        connectedCount: null,
        reason: err.message,
        endpoint: '/agent/ready',
      });
    });
    req.end();
  });

const queryBridgeHealth = () =>
  new Promise((resolveResult) => {
    const timeoutMs = parseNonNegativeInt(
      process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS,
      DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS,
    );
    const port = parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveResult({ checked: true, ...result });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/healthz',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = null;
          }
          finish({
            reachable: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: parsed,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ reachable: false, reason: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ reachable: false, reason: err.message });
    });
    req.end();
  });

const queryEnvironmentDiagnostics = () =>
  new Promise((resolveResult) => {
    const timeoutMs = parseNonNegativeInt(
      process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS,
      DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS,
    );
    const port = parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolveResult({ checked: true, ...result });
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/agent/diagnostics',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 262144) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            finish({
              reachable: res.statusCode >= 200 && res.statusCode < 300,
              statusCode: res.statusCode,
              status: parsed.status || null,
              nextAction: parsed.nextAction || null,
              connectedClientCount: parsed.extension?.connectedClientCount ?? null,
              matchingClientCount: parsed.extension?.matchingClientCount ?? null,
              outputDir: parsed.export?.outputDir || null,
            });
          } catch (err) {
            finish({
              reachable: false,
              statusCode: res.statusCode,
              reason: `invalid-json: ${err.message}`,
            });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ reachable: false, reason: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ reachable: false, reason: err.message });
    });
    req.end();
  });

const bridgeServerPath = () => {
  const candidates = [
    resolve(EXTENSION_ROOT, 'src', 'bridge-server.js'),
    resolve(EXTENSION_ROOT, 'src', 'mcp-server.js'),
    resolve(EXTENSION_ROOT, '..', 'src', 'bridge-server.js'),
    resolve(EXTENSION_ROOT, '..', 'src', 'mcp-server.js'),
  ];
  return firstExisting(candidates);
};

const waitForBridgeHealth = async (timeoutMs) => {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await queryBridgeHealth();
    if (last.reachable) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  return last || { checked: true, reachable: false, reason: 'timeout' };
};

const sessionStartBridgeWarmup = async () => {
  writeHookDiagnostic({
    stage: 'session-start-bridge-warmup',
  });
  if (isDisabled(process.env.GEMINI_MCP_HOOK_SESSION_BRIDGE_WARMUP)) return silent();

  const health = await withStageTiming('bridgeHealth', queryBridgeHealth);
  if (health.reachable) {
    writeHookDiagnostic({
      stage: 'session-start-bridge-ready',
      bridgeHealth: health,
    });
    return silent();
  }

  const serverPath = bridgeServerPath();
  if (!serverPath) {
    return silent('Gemini Exporter: nao encontrei bridge-server.js para aquecer a bridge local.');
  }

  const port = parseNonNegativeInt(process.env.GEMINI_MCP_BRIDGE_PORT, 47283);
  const keepAliveMs = parseNonNegativeInt(
    process.env.GEMINI_MD_EXPORT_BRIDGE_KEEP_ALIVE_MS ||
      process.env.GEMINI_MCP_BRIDGE_KEEP_ALIVE_MS,
    15 * 60_000,
  );
  const serverArgs = serverPath.endsWith('mcp-server.js')
    ? [serverPath, '--bridge-only', '--host', '127.0.0.1', '--port', String(port)]
    : [serverPath, '--host', '127.0.0.1', '--port', String(port)];
  serverArgs.push('--exit-when-idle', '--keep-alive-ms', String(keepAliveMs));

  const state = {
    source: 'session-start',
    status: 'launching',
    serverPath,
    serverArgs,
    port,
    keepAliveMs,
    startedAt: new Date().toISOString(),
  };

  if (isEnabled(process.env.GEMINI_MCP_HOOK_DRY_RUN)) {
    writeHookDiagnostic({
      stage: 'session-start-bridge-dry-run',
      bridgeWarmup: state,
    });
    return silent('Gemini Exporter: dry-run do SessionStart montou o warmup da bridge sem iniciar processo.');
  }

  try {
    const child = spawn(process.execPath, serverArgs, {
      cwd: tmpdir(),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
      },
    });
    child.unref?.();
    state.pid = child.pid || null;
    writeHookDiagnostic({
      stage: 'session-start-bridge-spawned',
      bridgeWarmup: state,
    });
  } catch (err) {
    return silent(`Gemini Exporter: nao consegui iniciar a bridge no SessionStart (${err.message}).`);
  }

  const waitMs = parseNonNegativeInt(
    process.env.GEMINI_MCP_HOOK_SESSION_BRIDGE_WAIT_MS,
    DEFAULT_SESSION_BRIDGE_WAIT_MS,
  );
  const ready = await withStageTiming('bridgeWarmupWait', () => waitForBridgeHealth(waitMs));
  writeHookDiagnostic({
    stage: ready.reachable ? 'session-start-bridge-warmed' : 'session-start-bridge-timeout',
    bridgeWarmup: state,
    bridgeHealth: ready,
  });

  if (ready.reachable) return silent();
  return silent(
    `Gemini Exporter: tentei iniciar a bridge no inicio da sessao, mas /healthz ainda nao respondeu (${ready.reason || 'timeout'}).`,
  );
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const waitForConnectedBrowserClient = async () => {
  const timeoutMs = currentConnectTimeoutMs();
  const pollMs = currentConnectPollMs();
  const startedAt = Date.now();
  let lastStatus = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastStatus = await queryBrowserReadiness();
    if (lastStatus.ready) {
      return {
        connected: true,
        waitedMs: Date.now() - startedAt,
        status: lastStatus,
      };
    }
    if (timeoutMs === 0) break;
    await sleep(Math.max(25, pollMs));
  }

  return {
    connected: false,
    waitedMs: Date.now() - startedAt,
    status: lastStatus,
    timeoutMs,
  };
};

const buildWindowsBrowserStartCommand = () => {
  const browser = resolveWindowsBrowserForHook(process.env);
  const profileDirectory =
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY || process.env.GME_CHROME_PROFILE_DIRECTORY || '';
  const browserArgs = [
    profileDirectory ? `--profile-directory=${profileDirectory}` : null,
    '--new-tab',
    GEMINI_APP_URL,
  ].filter(Boolean);
  return {
    ...browser,
    method: 'windows-powershell-minimized-restore-focus',
    command: 'powershell.exe',
    args: null,
    directMethod: 'windows-direct-spawn',
    directCommand: browser.command,
    directArgs: browserArgs,
    browserCommand: browser.command,
    browserArgs,
    profileDirectory: profileDirectory || null,
    url: GEMINI_APP_URL,
  };
};

const observeDetachedSpawn = (command, args, observeMs) =>
  new Promise((resolveObserve) => {
    let child = null;
    let settled = false;
    let timer = null;
    const startedAt = Date.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveObserve({
        command,
        args,
        pid: child?.pid || null,
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
    };

    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err), phase: 'spawn-throw' });
      return;
    }

    child.on?.('error', (err) => {
      finish({ ok: false, error: err?.message || String(err), phase: 'spawn-error' });
    });
    child.on?.('exit', (code, signal) => {
      if (code === 0 || code === null) {
        finish({ ok: true, exited: true, exitCode: code, signal: signal || null });
      } else {
        finish({ ok: false, exited: true, exitCode: code, signal: signal || null });
      }
    });
    child.unref?.();

    timer = setTimeout(() => {
      finish({ ok: true, exited: false });
    }, parseNonNegativeInt(process.env.GEMINI_MCP_HOOK_LAUNCH_OBSERVE_MS, observeMs));
  });

const prelaunchBrowserDetached = async (input) => {
  if (isDisabled(process.env.GEMINI_MCP_HOOK_LAUNCH_BROWSER)) return;
  if (!isBrowserDependentExporterTool(input)) return;
  if (currentPlatform() !== 'win32') return;

  const now = Date.now();
  const toolName = getToolName(input) || null;
  const sessionId = input?.session_id || input?.sessionId || null;
  const lockStartedAt = Date.now();
  const previousState = readHookState();

  if (activeLaunchLock(previousState, now)) {
    recordStageDuration('cooldownLock', lockStartedAt);
    const connectWait = await withStageTiming('connectWait', waitForConnectedBrowserClient);
    writeHookState({
      ...previousState,
      status: connectWait.connected ? 'connected' : 'timeout',
      lockObservedByPid: process.pid,
      lockObservedAt: new Date(now).toISOString(),
      connectWait,
      updatedAt: new Date().toISOString(),
    });
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: 'active-launch-lock',
      toolName,
      sessionId,
      connectWait,
    });
    return systemMessageForConnectWait(connectWait, previousState.launch, { reusedLaunch: true });
  }

  if (shouldSkipBrowserLaunchForCooldown(previousState, now)) {
    recordStageDuration('cooldownLock', lockStartedAt);
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: 'cooldown',
      toolName,
      sessionId,
      lastAttemptAt: previousState?.lastAttemptAt || null,
      cooldownMs: currentLaunchCooldownMs(),
    });
    if (['failed', 'timeout', 'skipped'].includes(String(previousState?.status || ''))) {
      return `Gemini Exporter: uma tentativa recente ainda esta em cooldown (${secondsText(currentLaunchCooldownMs())}); nao abri outra aba para evitar duplicatas. Ultimo estado: ${previousState.status}. ${manualBrowserRecoveryMessage}`;
    }
    return;
  }
  recordStageDuration('cooldownLock', lockStartedAt);

  const bridgeStatus = await withStageTiming('bridgeCheck', queryBrowserReadiness);
  if (bridgeStatus.ready) {
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: 'already-ready',
      bridgeStatus,
    });
    return;
  }

  if ((bridgeStatus.connectedCount || 0) > 0 && bridgeStatus.blockingIssue !== 'no_connected_clients') {
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: 'connected-but-not-ready',
      bridgeStatus,
    });
    return;
  }

  if (!bridgeStatus.reachable) {
    writeHookState({
      source: 'hook',
      status: 'skipped',
      reason: bridgeStatus.checked ? 'bridge-unreachable' : 'bridge-check-disabled',
      toolName,
      sessionId,
      bridgeStatus,
      lastFailureAt: now,
      updatedAt: new Date(now).toISOString(),
      expiresAt: now,
    });
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: bridgeStatus.checked ? 'bridge-unreachable' : 'bridge-check-disabled',
      toolName,
      sessionId,
      bridgeStatus,
    });
    return `Gemini Exporter: o bridge MCP local nao respondeu (${bridgeReasonText(bridgeStatus)}); nao abri o navegador as cegas. Reinicie o Gemini CLI ou rode gemini_ready { action: "status" } de novo depois que o MCP subir.`;
  }

  const launch = buildWindowsBrowserStartCommand();
  let restoreFocusScriptPath = null;
  try {
    restoreFocusScriptPath = writeWindowsRestoreFocusLaunchScript(
      launch.browserCommand,
      launch.browserArgs,
    );
    launch.args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      restoreFocusScriptPath,
    ];
    launch.restoreFocusScriptPath = restoreFocusScriptPath;
  } catch (err) {
    launch.restoreFocusScriptError = err?.message || String(err);
  }
  const allowFocusingFallback = isEnabled(process.env.GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK);
  if (!launch.args && allowFocusingFallback) {
    launch.method = launch.directMethod;
    launch.command = launch.directCommand;
    launch.args = launch.directArgs;
  }
  const launchId = buildLaunchId();
  const state = {
    source: 'hook',
    launchId,
    status: 'launching',
    lastAttemptAt: now,
    startedAt: new Date(now).toISOString(),
    expiresAt: buildLaunchLockExpiry(now),
    toolName,
    sessionId,
    bridgeStatus,
    launch: {
      plan: {
        method: launch.method,
        browserKey: launch.browserKey,
        browserName: launch.browserName,
        fallbackFrom: launch.fallbackFrom,
        command: launch.command,
        args: launch.args,
        browserCommand: launch.browserCommand,
        browserArgs: launch.browserArgs,
        profileDirectory: launch.profileDirectory,
        restoreFocusScriptPath: launch.restoreFocusScriptPath || null,
        restoreFocusScriptError: launch.restoreFocusScriptError || null,
        focusingFallbackAllowed: allowFocusingFallback,
      },
    },
  };
  writeHookState(state);
  writeHookDiagnostic({
    stage: 'browser-prelaunch',
    bridgeStatus,
    launchId,
    toolName,
    sessionId,
    launch: state.launch.plan,
  });

  if (isEnabled(process.env.GEMINI_MCP_HOOK_DRY_RUN)) {
    writeHookState({ ...state, status: 'dry-run', dryRun: true, updatedAt: new Date().toISOString() });
    return `Gemini Exporter: dry-run do hook montou o launch de ${launch.browserName} sem abrir o navegador.`;
  }

  if (!launch.args) {
    writeHookState({
      ...state,
      status: 'failed',
      lastFailureAt: Date.now(),
      error:
        launch.restoreFocusScriptError ||
        'PowerShell launcher unavailable and focusing fallback is disabled.',
      updatedAt: new Date().toISOString(),
    });
    return `Gemini Exporter: nao consegui montar o launcher do navegador pelo hook (${launch.restoreFocusScriptError || 'PowerShell indisponivel'}). ${manualBrowserRecoveryMessage}`;
  }

  const direct = await withStageTiming('launch', () =>
    observeDetachedSpawn(launch.command, launch.args, DEFAULT_HOOK_LAUNCH_OBSERVE_MS),
  );
  if (direct.ok) {
    const connectWait = await withStageTiming('connectWait', waitForConnectedBrowserClient);
    writeHookState({
      ...state,
      status: connectWait.connected ? 'connected' : 'timeout',
      launch: {
        ...state.launch,
        result: direct,
      },
      connectWait,
      updatedAt: new Date().toISOString(),
    });
    return systemMessageForConnectWait(connectWait, launch);
  }

  let directBrowser = null;
  if (allowFocusingFallback && launch.command !== launch.directCommand) {
    directBrowser = await withStageTiming('launchFallback', () =>
      observeDetachedSpawn(launch.directCommand, launch.directArgs, DEFAULT_HOOK_LAUNCH_OBSERVE_MS),
    );
    if (directBrowser.ok) {
      const connectWait = await withStageTiming('connectWait', waitForConnectedBrowserClient);
      writeHookState({
        ...state,
        status: connectWait.connected ? 'connected' : 'timeout',
        launch: {
          ...state.launch,
          result: direct,
          fallbackResult: directBrowser,
          fallbackPlan: {
            method: launch.directMethod,
            command: launch.directCommand,
            args: launch.directArgs,
          },
        },
        connectWait,
        updatedAt: new Date().toISOString(),
      });
      return systemMessageForConnectWait(connectWait, {
        ...launch,
        browserName: `${launch.browserName} via fallback opt-in`,
      });
    }
  }

  const nextState = {
    ...state,
    status: 'failed',
    launch: {
      ...state.launch,
      result: direct,
      fallbackResult: directBrowser,
    },
  };
  nextState.lastFailureAt = Date.now();
  nextState.error =
    directBrowser?.error ||
    direct.error ||
    `exit ${directBrowser?.exitCode ?? direct.exitCode ?? 'unknown'}`;
  console.error(`[gemini-md-export-hook] browser prelaunch error: ${nextState.error}`);
  try {
    writeHookState(nextState);
  } catch (err) {
    writeHookState({
      ...state,
      lastFailureAt: Date.now(),
      error: err.message,
    });
  }
  return `Gemini Exporter: nao consegui abrir o navegador pelo hook (${nextState.error}). ${manualBrowserRecoveryMessage}`;
};

const parseHookInput = (raw) => {
  if (!raw.trim()) return { input: {}, status: 'empty', bytes: raw.length };
  try {
    return {
      input: JSON.parse(raw),
      status: 'ok',
      bytes: raw.length,
    };
  } catch (err) {
    return {
      input: {},
      status: 'invalid-json',
      bytes: raw.length,
      error: err.message,
    };
  }
};

const readInput = async () =>
  new Promise((resolveInput) => {
    const readStartedAt = Date.now();
    const timeoutMs = parseNonNegativeInt(
      process.env.GEMINI_MCP_HOOK_STDIN_TIMEOUT_MS,
      DEFAULT_HOOK_STDIN_TIMEOUT_MS,
    );
    let raw = '';
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        // Best effort only. The process exits right after writing hook JSON.
      }
      if (result.status === 'invalid-json') {
        console.error(`[gemini-md-export-hook] invalid JSON stdin: ${result.error}`);
      }
      recordStageDuration('stdin', readStartedAt);
      writeHookDiagnostic({
        stage: 'stdin-read',
        stdinStatus: result.status,
        stdinBytes: result.bytes,
        stdinError: result.error || null,
      });
      resolveInput(result.input);
    };

    const timer = setTimeout(() => {
      finish({
        input: {},
        status: raw ? 'timeout-after-data' : 'timeout',
        bytes: raw.length,
      });
    }, timeoutMs);

    try {
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_STDIN_BYTES) {
          finish({
            input: {},
            status: 'too-large',
            bytes: raw.length,
            error: `stdin exceeded ${MAX_STDIN_BYTES} bytes`,
          });
          return;
        }

        const parsed = parseHookInput(raw);
        if (parsed.status === 'ok') {
          finish(parsed);
        }
      });
      process.stdin.on('end', () => {
        finish(parseHookInput(raw));
      });
      process.stdin.on('error', (err) => {
        console.error(`[gemini-md-export-hook] failed to read stdin: ${err.message}`);
        finish({
          input: {},
          status: 'error',
          bytes: raw.length,
          error: err.message,
        });
      });
      process.stdin.resume();
    } catch (err) {
      console.error(`[gemini-md-export-hook] failed to initialize stdin read: ${err.message}`);
      finish({
        input: {},
        status: 'error',
        bytes: raw.length,
        error: err.message,
      });
    }
  });

const writeJson = (payload) => {
  const outputStartedAt = Date.now();
  wroteOutput = true;
  recordStageDuration('output', outputStartedAt);
  writeHookDiagnostic({
    stage: 'write-output',
    elapsedMs: Date.now() - RUN_STARTED_AT,
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const silent = (systemMessage = '') => {
  const output = { suppressOutput: true };
  if (systemMessage) output.systemMessage = systemMessage;
  return output;
};

const contextOutput = (additionalContext) => ({
  suppressOutput: true,
  hookSpecificOutput: {
    hookEventName: hookEventNameForMode(),
    additionalContext,
  },
});

const hookEventNameForMode = () => {
  if (mode === 'session-start') return 'SessionStart';
  if (mode === 'after-tool') return 'AfterTool';
  if (mode === 'before-tool') return 'BeforeTool';
  if (mode === 'diagnose') return 'Unknown';
  return 'Unknown';
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getToolName = (input) =>
  input?.tool_name ||
  input?.toolName ||
  input?.tool?.name ||
  input?.original_request_name ||
  input?.originalRequestName ||
  '';

const getToolInput = (input) =>
  input?.tool_input ||
  input?.toolInput ||
  input?.tool?.input ||
  input?.arguments ||
  input?.args ||
  {};

const getToolResponse = (input) =>
  input?.tool_response ||
  input?.toolResponse ||
  input?.response ||
  input?.result ||
  {};

const collectText = (value, out = []) => {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectText(item, out);
  }
  return out;
};

const parseJsonLikeStrings = (value) => {
  const parsed = [];
  for (const text of collectText(value)) {
    const trimmed = text.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Some tool fields are regular prose. Advisory hooks must fail open.
    }
  }
  return parsed;
};

const responseCandidates = (response) => {
  const candidates = [response];
  if (response?.structuredContent) candidates.push(response.structuredContent);
  if (response?.llmContent) candidates.push(response.llmContent);
  if (response?.returnDisplay) candidates.push(response.returnDisplay);
  if (Array.isArray(response?.content)) {
    for (const item of response.content) {
      if (item?.text) candidates.push(item.text);
    }
  }
  for (const parsed of parseJsonLikeStrings(response)) candidates.push(parsed);
  return candidates;
};

const findFirstNumber = (value, keys) => {
  if (value == null) return null;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumber(item, keys);
      if (found != null) return found;
    }
    return null;
  }

  for (const key of keys) {
    const current = value[key];
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.length;
  }

  for (const item of Object.values(value)) {
    const found = findFirstNumber(item, keys);
    if (found != null) return found;
  }
  return null;
};

const hasMediaWarning = (value) => collectText(value).some((text) => MEDIA_WARNING_RE.test(text));

const hasBrowserBridgeProblem = (value) => {
  const text = collectText(value).join('\n').toLowerCase();
  return (
    text.includes('chrome_extension_') ||
    text.includes('build_mismatch') ||
    text.includes('bridge_unreachable') ||
    text.includes('nenhuma aba do gemini conectada') ||
    text.includes('extensao do navegador') ||
    text.includes('extensao chrome')
  );
};

const analyzeToolResponse = (response) => {
  const candidates = responseCandidates(response);
  let mediaFailureCount = null;
  let mediaFileCount = null;
  let mediaWarning = false;
  let bridgeProblem = false;

  for (const candidate of candidates) {
    if (mediaFailureCount == null) {
      mediaFailureCount = findFirstNumber(candidate, ['mediaFailureCount', 'mediaFailures']);
    }
    if (mediaFileCount == null) {
      mediaFileCount = findFirstNumber(candidate, ['mediaFileCount', 'mediaFiles']);
    }
    mediaWarning = mediaWarning || hasMediaWarning(candidate);
    bridgeProblem = bridgeProblem || hasBrowserBridgeProblem(candidate);
  }

  return {
    mediaFailureCount: mediaFailureCount ?? 0,
    mediaFileCount: mediaFileCount ?? 0,
    mediaWarning,
    bridgeProblem,
  };
};

const afterTool = (input) => {
  const toolName = getToolName(input);
  const response = getToolResponse(input);
  const analysis = analyzeToolResponse(response);

  const notes = [];
  if (analysis.mediaFailureCount > 0) {
    notes.push(
      `A tool ${toolName || 'gemini-md-export'} retornou mediaFailureCount=${analysis.mediaFailureCount}. Nao declare que as imagens foram importadas sem explicar esses warnings e, se fizer sentido, inspecione status/snapshot antes de concluir.`,
    );
  }
  if (analysis.mediaWarning && analysis.mediaFileCount === 0) {
    notes.push(
      `A tool ${toolName || 'gemini-md-export'} gerou warning de midia e mediaFileCount=0. Trate isso como falha real de importacao de imagens, nao como sucesso parcial.`,
    );
  }
  if (analysis.bridgeProblem) {
    notes.push(
      'A resposta sugere problema de bridge/extensao do navegador. Antes de repetir a mesma exportacao ou pedir acao manual, cheque gemini_ready { action: "status" }: ele tenta auto-reload da extensao stale. Se o problema for modo proxy/porta ocupada, use gemini_support { action: "processes" } antes de cleanup ou restart manual. Se houver abas conectadas mas presas, use gemini_tabs { action: "reload" }. Reload manual do card da extensao e ultimo recurso.',
    );
  }

  if (notes.length === 0) return silent();
  return contextOutput(notes.join('\n'));
};

const normalizedPayloadText = (input) => {
  const toolName = getToolName(input);
  const toolInput = getToolInput(input);
  const prompt = input?.prompt || input?.user_prompt || input?.message || '';
  return `${toolName}\n${safeStringify(toolInput)}\n${prompt}`.toLowerCase();
};

const forbiddenReason = (input) => {
  const text = normalizedPayloadText(input);

  if (/\bchrome\.debugger\b|chrome-debugger|debugger permission/.test(text)) {
    return BLOCK_REASON;
  }

  if (/capturevisibletab|capture-visible-tab|imageelementscreenshottoasset/.test(text)) {
    return BLOCK_REASON;
  }

  if (
    /(screenshot|captura visual|captura de tela|fallback visual|crop|recorte)/.test(text) &&
    /(gemini|midia|media|imagem|image|export)/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /(cookie|cookies)/.test(text) &&
    /(gemini|googleusercontent|lh3|bard|google)/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /bardfrontendservice|batchexecute|snlm0e|internal api|api interna|private gemini api/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /["']?(permissions|optional_permissions)["']?\s*:\s*\[[\s\S]{0,500}\b(debugger|downloads|cookies|webrequest|declarativenetrequest)\b/.test(
      text,
    )
  ) {
    return BLOCK_REASON;
  }

  return null;
};

const beforeTool = async (input) => {
  writeHookDiagnostic({
    stage: 'before-tool',
    toolName: getToolName(input) || null,
  });
  const reason = forbiddenReason(input);
  if (!reason) {
    const systemMessage = await prelaunchBrowserDetached(input);
    return silent(systemMessage);
  }
  return {
    suppressOutput: true,
    decision: 'deny',
    reason,
  };
};

const diagnose = async () => {
  const [bridgeHealth, bridgeStatus, environmentDiagnostics] = await Promise.all([
    queryBridgeHealth(),
    queryBrowserReadiness(),
    queryEnvironmentDiagnostics(),
  ]);
  const launch = currentPlatform() === 'win32' ? buildWindowsBrowserStartCommand() : null;
  return {
    ok: true,
    mode: 'diagnose',
    platform: currentPlatform(),
    pid: process.pid,
    stateDir: hookStateDir(),
    files: {
      lastRun: hookLastRunPath(),
      browserLaunch: hookStatePath(),
    },
    timeouts: {
      hardExitMs: HARD_EXIT_MS,
      stdinMs: parseNonNegativeInt(
        process.env.GEMINI_MCP_HOOK_STDIN_TIMEOUT_MS,
        DEFAULT_HOOK_STDIN_TIMEOUT_MS,
      ),
      bridgeMs: parseNonNegativeInt(
        process.env.GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS,
        DEFAULT_HOOK_BRIDGE_CHECK_TIMEOUT_MS,
      ),
      connectMs: currentConnectTimeoutMs(),
      connectPollMs: currentConnectPollMs(),
      launchObserveMs: parseNonNegativeInt(
        process.env.GEMINI_MCP_HOOK_LAUNCH_OBSERVE_MS,
        DEFAULT_HOOK_LAUNCH_OBSERVE_MS,
      ),
      cooldownMs: currentLaunchCooldownMs(),
      lockGraceMs: launchLockGraceMs(),
    },
    bridgeHealth,
    bridgeStatus,
    environmentDiagnostics,
    lastRun: readJsonFile(hookLastRunPath()),
    lastBrowserLaunch: readJsonFile(hookStatePath()),
    launchPlan: launch
      ? {
          method: launch.method,
          browserName: launch.browserName,
          browserCommand: launch.browserCommand,
          browserArgs: launch.browserArgs,
          profileDirectory: launch.profileDirectory,
          focusingFallbackAllowed: isEnabled(process.env.GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK),
        }
      : null,
  };
};

const run = async () => {
  writeHookDiagnostic({
    stage: 'start',
    platform: currentPlatform(),
    argv: process.argv.slice(2),
  });
  if (mode === 'session-start') return sessionStartBridgeWarmup();
  if (mode === 'diagnose') return diagnose();
  const input = await readInput();
  if (mode === 'after-tool') return afterTool(input);
  if (mode === 'before-tool') return beforeTool(input);
  return silent();
};

try {
  writeJson(await run());
  clearTimeout(hardExit);
  process.exit(0);
} catch (err) {
  console.error(`[gemini-md-export-hook] unexpected failure: ${err.message}`);
  writeJson(silent());
  clearTimeout(hardExit);
  process.exit(0);
}
