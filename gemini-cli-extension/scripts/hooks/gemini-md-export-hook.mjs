#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const mode = process.argv[2] || '';
let wroteOutput = false;
const hardExit = setTimeout(() => {
  if (!wroteOutput) {
    process.stdout.write(`${JSON.stringify({ suppressOutput: true })}\n`);
  }
  process.exit(0);
}, 1500);

const SESSION_CONTEXT = [
  'Gemini MD Export: use the gemini-md-export MCP tools for browser status, listing, downloads, and batch exports.',
  'Treat media as complete only when mediaFailureCount is 0. If a media warning appears and mediaFileCount is 0, investigate before saying images were imported.',
  'Forbidden paths for this project: Gemini cookies, private/internal Gemini APIs, chrome.debugger, captureVisibleTab, screenshot/crop media fallbacks, and new browser permissions.',
].join('\n');

const BLOCK_REASON =
  'Bloqueado pelo gemini-md-export: este caminho esta fora do escopo combinado. Use DOM atual, data/blob, fetch permitido, bridge/background existente ou lightbox controlado; se nao houver bytes legiveis, mantenha um warning honesto.';

const MEDIA_WARNING_RE =
  /\[!warning\]\s*M[ií]dia n[aã]o importada|M[ií]dia n[aã]o exportada|media n(?:ao|ão) importad/i;

const GEMINI_URL = 'https://gemini.google.com/app';

const BROWSER_DEPENDENT_EXPORTER_TOOLS = new Set([
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

const normalizeBrowserKey = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'chrome';
  if (/^(google[-_\s]*)?chrome$|chrome\.exe$/.test(text)) return 'chrome';
  if (/^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$/.test(text)) return 'edge';
  if (/^brave$|brave[-_\s]*browser|brave(\.exe)?$/.test(text)) return 'brave';
  if (/^dia$|dia(\.exe)?$/.test(text)) return 'dia';
  return text;
};

const browserOrder = (preferredKey) => [
  preferredKey,
  ...['chrome', 'edge', 'brave', 'dia'].filter((key) => key !== preferredKey),
];

const quoteCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;

const hookLaunchStatePath = () =>
  resolve(tmpdir(), 'gemini-md-export', 'hook-browser-launch.json');

const readHookLaunchState = () => {
  try {
    return JSON.parse(readFileSync(hookLaunchStatePath(), 'utf-8'));
  } catch {
    return {};
  }
};

const writeHookLaunchState = (state) => {
  try {
    const filePath = hookLaunchStatePath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.error(`[gemini-md-export-hook] failed to write launch state: ${err.message}`);
  }
};

const hookLaunchInCooldown = () => {
  const cooldownMs = Number(process.env.GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS || 60_000);
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
  const lastAttemptAt = Number(readHookLaunchState().lastAttemptAt || 0);
  return lastAttemptAt > 0 && Date.now() - lastAttemptAt < cooldownMs;
};

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

const windowsBrowserCandidates = () => {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return {
    chrome: [
      process.env.GEMINI_MCP_CHROME_EXE,
      process.env.GME_CHROME_EXE,
      localAppData && resolve(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      resolve(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      resolve(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean),
    edge: [
      process.env.GEMINI_MCP_EDGE_EXE,
      process.env.GME_EDGE_EXE,
      localAppData && resolve(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      resolve(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      resolve(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean),
    brave: [
      process.env.GEMINI_MCP_BRAVE_EXE,
      process.env.GME_BRAVE_EXE,
      localAppData &&
        resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      resolve(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      resolve(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ].filter(Boolean),
    dia: [
      process.env.GEMINI_MCP_DIA_EXE,
      process.env.GME_DIA_EXE,
      localAppData && resolve(localAppData, 'Programs', 'Dia', 'Dia.exe'),
      process.env.APPDATA && resolve(process.env.APPDATA, 'Dia', 'Application', 'Dia.exe'),
    ].filter(Boolean),
  };
};

const resolveWindowsBrowser = () => {
  const preferredKey = normalizeBrowserKey(process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER);
  const candidates = windowsBrowserCandidates();
  for (const key of browserOrder(preferredKey)) {
    const existing = (candidates[key] || []).find((candidate) => existsSync(candidate));
    if (existing) return { browserKey: key, command: existing };
  }
  const aliases = {
    chrome: 'chrome.exe',
    edge: 'msedge.exe',
    brave: 'brave.exe',
    dia: 'dia.exe',
  };
  return { browserKey: preferredKey, command: aliases[preferredKey] || aliases.chrome };
};

const prelaunchBrowserDetached = (input) => {
  if (process.env.GEMINI_MCP_HOOK_LAUNCH_BROWSER === 'false') return;
  if (!isBrowserDependentExporterTool(input)) return;
  if (hookLaunchInCooldown()) return;

  const profileArg =
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY || process.env.GME_CHROME_PROFILE_DIRECTORY
      ? `--profile-directory=${
          process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY || process.env.GME_CHROME_PROFILE_DIRECTORY
        }`
      : null;

  try {
    if (process.platform === 'win32') {
      const browser = resolveWindowsBrowser();
      const browserArgs = ['--new-tab', GEMINI_URL];
      if (profileArg) browserArgs.unshift(profileArg);
      const command = `start "" ${quoteCmd(browser.command)} ${browserArgs.map(quoteCmd).join(' ')}`;
      const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      writeHookLaunchState({
        lastAttemptAt: Date.now(),
        platform: process.platform,
        browserKey: browser.browserKey,
        method: 'cmd-start',
      });
      return;
    }

    if (process.platform === 'darwin') {
      const preferredKey = normalizeBrowserKey(
        process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER,
      );
      const appByKey = {
        chrome: process.env.GEMINI_MCP_CHROME_APP || process.env.GME_CHROME_APP || 'Google Chrome',
        edge: process.env.GEMINI_MCP_EDGE_APP || process.env.GME_EDGE_APP || 'Microsoft Edge',
        brave: process.env.GEMINI_MCP_BRAVE_APP || process.env.GME_BRAVE_APP || 'Brave Browser',
        dia: process.env.GEMINI_MCP_DIA_APP || process.env.GME_DIA_APP || 'Dia',
      };
      const app = appByKey[preferredKey] || appByKey.chrome;
      const args = ['-g', '-a', app, GEMINI_URL];
      if (profileArg) args.push('--args', profileArg);
      const child = spawn('open', args, { detached: true, stdio: 'ignore' });
      child.unref();
      writeHookLaunchState({
        lastAttemptAt: Date.now(),
        platform: process.platform,
        browserKey: preferredKey,
        method: 'open-g-app',
      });
      return;
    }

    if (process.platform === 'linux') {
      const command = process.env.BROWSER || 'xdg-open';
      const child = spawn(command, [GEMINI_URL], { detached: true, stdio: 'ignore' });
      child.unref();
      writeHookLaunchState({
        lastAttemptAt: Date.now(),
        platform: process.platform,
        browserKey: command,
        method: process.env.BROWSER ? 'browser-env' : 'xdg-open',
      });
    }
  } catch (err) {
    console.error(`[gemini-md-export-hook] browser prelaunch failed: ${err.message}`);
  }
};

const readInput = () => {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch (err) {
    console.error(`[gemini-md-export-hook] failed to read stdin: ${err.message}`);
    return {};
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[gemini-md-export-hook] invalid JSON stdin: ${err.message}`);
    return {};
  }
};

const writeJson = (payload) => {
  wroteOutput = true;
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

const beforeTool = (input) => {
  const reason = forbiddenReason(input);
  if (!reason) {
    prelaunchBrowserDetached(input);
    return silent();
  }
  return {
    suppressOutput: true,
    decision: 'deny',
    reason,
  };
};

const run = () => {
  const input = readInput();
  if (mode === 'session-start') return contextOutput(SESSION_CONTEXT);
  if (mode === 'after-tool') return afterTool(input);
  if (mode === 'before-tool') return beforeTool(input);
  return silent();
};

try {
  writeJson(run());
  clearTimeout(hardExit);
  process.exit(0);
} catch (err) {
  console.error(`[gemini-md-export-hook] unexpected failure: ${err.message}`);
  writeJson(silent());
  clearTimeout(hardExit);
  process.exit(0);
}
