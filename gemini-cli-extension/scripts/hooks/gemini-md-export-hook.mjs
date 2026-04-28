#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const mode = process.argv[2] || '';
let wroteOutput = false;
const hardExit = setTimeout(() => {
  writeHookDiagnostic({
    stage: 'hard-exit',
    elapsedMs: Date.now() - RUN_STARTED_AT,
  });
  if (!wroteOutput) {
    process.stdout.write(`${JSON.stringify({ suppressOutput: true })}\n`);
  }
  process.exit(0);
}, 750);

const SESSION_CONTEXT = [
  'Gemini MD Export: use the gemini-md-export MCP tools for browser status, listing, downloads, and batch exports.',
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
const MAX_STDIN_BYTES = 1024 * 1024;
const HOOK_BROWSER_STATE_FILENAME = 'hook-browser-launch.json';
const HOOK_LAST_RUN_FILENAME = 'hook-last-run.json';
const RUN_STARTED_AT = Date.now();
let diagnosticState = {
  pid: process.pid,
  mode,
  startedAt: new Date(RUN_STARTED_AT).toISOString(),
};

const BROWSER_DEPENDENT_EXPORTER_TOOLS = new Set([
  'gemini_browser_status',
  'gemini_list_recent_chats',
  'gemini_list_notebook_chats',
  'gemini_get_current_chat',
  'gemini_download_chat',
  'gemini_download_notebook_chat',
  'gemini_export_recent_chats',
  'gemini_export_notebook',
  'gemini_cache_status',
  'gemini_clear_cache',
  'gemini_open_chat',
  'gemini_reload_gemini_tabs',
  'gemini_snapshot',
]);

const normalizeExporterToolName = (toolName) =>
  String(toolName || '')
    .replace(/^mcp__gemini-md-export__/, '')
    .replace(/^mcp[_-]gemini[_-]md[_-]export[_-]/, '')
    .replace(/^gemini-md-export[_-]/, '');

const isBrowserDependentExporterTool = (input) => {
  const normalized = normalizeExporterToolName(getToolName(input));
  if (BROWSER_DEPENDENT_EXPORTER_TOOLS.has(normalized)) return true;
  return BROWSER_DEPENDENT_EXPORTER_TOOLS.has(normalized.replace(/-/g, '_'));
};

const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const isDisabled = (value) => String(value || '').trim().toLowerCase() === 'false';

const isEnabled = (value) => /^(1|true|yes|sim)$/i.test(String(value || '').trim());

const currentPlatform = () => process.env.GEMINI_MCP_HOOK_PLATFORM || process.platform;

const quoteCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;

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
        localAppData && resolve(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
    },
    edge: {
      name: 'Edge',
      fallbackCommand: 'msedge.exe',
      explicit: env.GEMINI_MCP_EDGE_EXE || env.GME_EDGE_EXE,
      paths: [
        localAppData && resolve(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        resolve(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        resolve(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
    brave: {
      name: 'Brave',
      fallbackCommand: 'brave.exe',
      explicit: env.GEMINI_MCP_BRAVE_EXE || env.GME_BRAVE_EXE,
      paths: [
        localAppData &&
          resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        resolve(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        resolve(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ],
    },
    dia: {
      name: 'Dia',
      fallbackCommand: 'dia.exe',
      explicit: env.GEMINI_MCP_DIA_EXE || env.GME_DIA_EXE,
      paths: [
        localAppData && resolve(localAppData, 'Programs', 'Dia', 'Dia.exe'),
        env.APPDATA && resolve(env.APPDATA, 'Dia', 'Application', 'Dia.exe'),
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
  process.env.GEMINI_MCP_HOOK_STATE_DIR ||
  resolve(process.env.TEMP || process.env.TMP || tmpdir(), 'gemini-md-export');

const hookStatePath = () => resolve(hookStateDir(), HOOK_BROWSER_STATE_FILENAME);

const hookLastRunPath = () => resolve(hookStateDir(), HOOK_LAST_RUN_FILENAME);

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

const shouldSkipBrowserLaunchForCooldown = (now) => {
  if (isEnabled(process.env.GEMINI_MCP_HOOK_ALWAYS_LAUNCH_BROWSER)) return false;
  const cooldownMs = parseNonNegativeInt(
    process.env.GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS,
    DEFAULT_BROWSER_LAUNCH_COOLDOWN_MS,
  );
  if (cooldownMs === 0) return false;
  const lastAttemptAt = Number(readHookState().lastAttemptAt || 0);
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
              connectedCount: connectedClients.length,
            });
          } catch (err) {
            finish({ reachable: false, connectedCount: null, reason: `invalid-json: ${err.message}` });
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

const buildWindowsBrowserStartCommand = () => {
  const browser = resolveWindowsBrowserForHook(process.env);
  const profileDirectory =
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY || process.env.GME_CHROME_PROFILE_DIRECTORY || '';
  const browserArgs = [
    profileDirectory ? `--profile-directory=${profileDirectory}` : null,
    '--new-tab',
    GEMINI_APP_URL,
  ].filter(Boolean);
  const startCommand = `start "" ${quoteCmd(browser.command)} ${browserArgs.map(quoteCmd).join(' ')}`;
  return {
    ...browser,
    method: 'windows-cmd-start',
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', startCommand],
    browserCommand: browser.command,
    browserArgs,
    profileDirectory: profileDirectory || null,
    url: GEMINI_APP_URL,
  };
};

const prelaunchBrowserDetached = async (input) => {
  if (isDisabled(process.env.GEMINI_MCP_HOOK_LAUNCH_BROWSER)) return;
  if (isDisabled(process.env.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED)) return;
  if (!isBrowserDependentExporterTool(input)) return;
  if (currentPlatform() !== 'win32') return;

  const now = Date.now();
  if (shouldSkipBrowserLaunchForCooldown(now)) {
    writeHookDiagnostic({ stage: 'browser-prelaunch-skipped', reason: 'cooldown' });
    return;
  }

  const bridgeStatus = await queryConnectedBrowserClients();
  if (bridgeStatus.connectedCount > 0) {
    writeHookDiagnostic({
      stage: 'browser-prelaunch-skipped',
      reason: 'already-connected',
      bridgeStatus,
    });
    return;
  }

  const launch = buildWindowsBrowserStartCommand();
  const state = {
    lastAttemptAt: now,
    bridgeStatus,
    ...launch,
  };
  writeHookState(state);
  writeHookDiagnostic({
    stage: 'browser-prelaunch',
    bridgeStatus,
    launch: {
      method: launch.method,
      browserName: launch.browserName,
      browserCommand: launch.browserCommand,
      args: launch.args,
    },
  });

  if (isEnabled(process.env.GEMINI_MCP_HOOK_DRY_RUN)) {
    writeHookState({ ...state, dryRun: true });
    return;
  }

  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on?.('error', (err) => {
      writeHookState({
        ...state,
        lastFailureAt: Date.now(),
        error: err.message,
      });
      console.error(`[gemini-md-export-hook] browser prelaunch error: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    writeHookState({
      ...state,
      lastFailureAt: Date.now(),
      error: err.message,
    });
    console.error(`[gemini-md-export-hook] failed to prelaunch browser: ${err.message}`);
  }
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
  wroteOutput = true;
  writeHookDiagnostic({
    stage: 'write-output',
    elapsedMs: Date.now() - RUN_STARTED_AT,
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const silent = () => ({ suppressOutput: true });

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
      'A resposta sugere problema de bridge/extensao do navegador. Antes de repetir a mesma exportacao, cheque gemini_browser_status e considere update/restart do Gemini CLI ou reload manual do card da extensao.',
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
    await prelaunchBrowserDetached(input);
    return silent();
  }
  return {
    suppressOutput: true,
    decision: 'deny',
    reason,
  };
};

const diagnose = async () => {
  const bridgeStatus = await queryConnectedBrowserClients();
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
    bridgeStatus,
    lastRun: readJsonFile(hookLastRunPath()),
    lastBrowserLaunch: readJsonFile(hookStatePath()),
    launchPlan: launch
      ? {
          method: launch.method,
          browserName: launch.browserName,
          browserCommand: launch.browserCommand,
          args: launch.args,
          profileDirectory: launch.profileDirectory,
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
  if (mode === 'session-start') return contextOutput(SESSION_CONTEXT);
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
