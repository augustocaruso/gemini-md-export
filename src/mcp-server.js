#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';
import {
  buildRecentChatsRefreshPlan,
  DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
} from './recent-chats-policy.mjs';
import {
  MAX_RECENT_CHATS_LOAD_TARGET,
  normalizeRecentChatsLoadMorePlan,
} from './recent-chats-load-more.mjs';
import { formatBridgeListenError } from './mcp-server-errors.mjs';
import { ensureChromeExtensionReady } from './chrome-extension-guard.mjs';
import {
  describeRecentBrowserLaunch,
  launchGeminiBrowser,
  readBrowserLaunchState,
  writeBrowserLaunchState,
} from './browser-launch.mjs';
import {
  buildJobProgressBroadcast,
  setClientJobProgress,
  TERMINAL_JOB_STATUSES,
} from './job-progress-broadcast.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));

const SERVER_NAME = 'gemini-md-export';
const SERVER_VERSION = pkg.version;
const EXTENSION_PROTOCOL_VERSION = Number(bridgeVersion.protocolVersion);
const PROTOCOL_VERSION = '2025-03-26';
const PROCESS_STARTED_AT = new Date();
const DEFAULT_HOST = process.env.GEMINI_MCP_BRIDGE_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.GEMINI_MCP_BRIDGE_PORT || 47283);
const DEFAULT_EXPORT_DIR = process.env.GEMINI_MCP_EXPORT_DIR || resolve(homedir(), 'Downloads');
const CLIENT_STALE_MS = 45_000;
const CLIENT_DEGRADED_HEARTBEAT_MS = Number(
  process.env.GEMINI_MCP_CLIENT_DEGRADED_HEARTBEAT_MS || 20_000,
);
const LONG_POLL_TIMEOUT_MS = 25_000;
const SSE_KEEPALIVE_MS = Number(process.env.GEMINI_MCP_SSE_KEEPALIVE_MS || 15_000);
const COMMAND_TIMEOUT_MS = Number(process.env.GEMINI_MCP_COMMAND_TIMEOUT_MS || 180_000);
const COMMAND_DISPATCH_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_COMMAND_DISPATCH_TIMEOUT_MS || 20_000,
);
const EXTENSION_INFO_COMMAND_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_EXTENSION_INFO_COMMAND_TIMEOUT_MS || 6000,
);
const RELOAD_EXTENSION_COMMAND_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_RELOAD_EXTENSION_COMMAND_TIMEOUT_MS || 25_000,
);
const FOLDER_PICKER_TIMEOUT_MS = 5 * 60_000;
const BRIDGE_ASSET_FETCH_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_ASSET_FETCH_TIMEOUT_MS || 12_000,
);
const BRIDGE_ASSET_FETCH_MAX_BYTES = Math.max(
  1024,
  Math.min(50 * 1024 * 1024, Number(process.env.GEMINI_MCP_ASSET_FETCH_MAX_BYTES || 20 * 1024 * 1024)),
);
const BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES = Math.max(
  0,
  Math.min(1000, Number(process.env.GEMINI_MCP_ASSET_FETCH_CACHE_MAX_ENTRIES || 300)),
);
const ALLOWED_BRIDGE_ORIGIN = 'https://gemini.google.com';
const RECENT_CHATS_CACHE_MAX_AGE_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_CACHE_MAX_AGE_MS || DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
);
const RECENT_CHATS_REFRESH_BUDGET_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_REFRESH_BUDGET_MS || 2500,
);
const RECENT_CHATS_LOAD_MORE_BUDGET_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BUDGET_MS || 6000,
);
const RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS || 3500,
);
const RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS || 12_000,
);
const DIRECT_REEXPORT_MAX_ITEMS = Math.max(
  1,
  Math.min(1000, Number(process.env.GEMINI_MCP_DIRECT_REEXPORT_MAX_ITEMS || 500)),
);
const DIRECT_REEXPORT_DELAY_MS = Math.max(
  0,
  Math.min(
    30_000,
    Number(
      process.env.GEMINI_MCP_DIRECT_REEXPORT_DELAY_MS ||
        (process.platform === 'win32' ? 750 : 250),
    ),
  ),
);
const CHROME_GUARD_CONFIG = {
  profileDirectory:
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY ||
    process.env.GME_CHROME_PROFILE_DIRECTORY ||
    null,
  launchIfClosed: process.env.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED !== 'false',
  initialConnectTimeoutMs: Number(process.env.GEMINI_MCP_CHROME_INITIAL_CONNECT_TIMEOUT_MS || 8000),
  reloadTimeoutMs: Number(process.env.GEMINI_MCP_CHROME_RELOAD_TIMEOUT_MS || 75_000),
  maxReloadAttempts: Number(process.env.GEMINI_MCP_CHROME_MAX_RELOAD_ATTEMPTS || 1),
  useExtensionsReloaderFallback:
    process.env.GEMINI_MCP_USE_EXTENSIONS_RELOADER_FALLBACK === 'true',
};
const BROWSER_STATUS_INITIAL_WAIT_MS = Number(
  process.env.GEMINI_MCP_BROWSER_STATUS_INITIAL_WAIT_MS ||
    CHROME_GUARD_CONFIG.initialConnectTimeoutMs,
);
const BROWSER_LAUNCH_COOLDOWN_MS = Number(
  process.env.GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS || 60_000,
);
const BROWSER_STATUS_WAKE_WAIT_MS = Number(
  process.env.GEMINI_MCP_BROWSER_STATUS_WAKE_WAIT_MS || 8_000,
);
const PRIMARY_BRIDGE_HEALTH_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_PRIMARY_BRIDGE_HEALTH_TIMEOUT_MS || 1200,
);
const PORT_OWNER_DIAGNOSTIC_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_PORT_OWNER_DIAGNOSTIC_TIMEOUT_MS || 1500,
);
const PROCESS_DIAGNOSTIC_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_PROCESS_DIAGNOSTIC_TIMEOUT_MS || 2500,
);
const PROCESS_CLEANUP_WAIT_MS = Number(
  process.env.GEMINI_MCP_PROCESS_CLEANUP_WAIT_MS || 4000,
);
const PROCESS_CLEANUP_TIMEOUT_MS = Number(
  process.env.GEMINI_MCP_PROCESS_CLEANUP_TIMEOUT_MS || 8000,
);
const EXPORTER_PROCESS_RE = /gemini-md-export|mcp-server\.js/i;
const detectExpectedBrowserBuildStamp = () => {
  if (process.env.GEMINI_MCP_EXPECTED_BUILD_STAMP) {
    return process.env.GEMINI_MCP_EXPECTED_BUILD_STAMP;
  }
  if (bridgeVersion.buildStamp) return bridgeVersion.buildStamp;

  const candidates = [
    resolve(ROOT, 'browser-extension', 'background.js'),
    resolve(ROOT, 'dist', 'extension', 'background.js'),
    resolve(ROOT, 'dist', 'extension', 'content.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const source = readFileSync(candidate, 'utf-8');
      const match =
        source.match(/\bbuildStamp:\s*['"](\d{8}-\d{4})['"]/) ||
        source.match(/\bBUILD_STAMP\s*=\s*['"](\d{8}-\d{4})['"]/) ||
        source.match(/\bbuild\s+(\d{8}-\d{4})\b/);
      if (match?.[1]) return match[1];
    } catch {
      // Build stamp ausente não deve impedir o MCP de iniciar.
    }
  }
  return null;
};

const pathContains = (candidate, fragment) =>
  String(candidate || '').replace(/\\/g, '/').toLowerCase().includes(fragment);

const isInsidePath = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

const releaseAutoUpdateDirectoryCwd = () => {
  try {
    const cwd = resolve(process.cwd());
    if (
      isInsidePath(ROOT, cwd) &&
      pathContains(ROOT, '/.gemini/extensions/gemini-md-export')
    ) {
      process.chdir(homedir());
    }
  } catch {
    // CWD release is best-effort; the MCP can still run if chdir is denied.
  }
};

releaseAutoUpdateDirectoryCwd();

const EXPECTED_CHROME_EXTENSION_INFO = {
  extensionVersion: bridgeVersion.extensionVersion || SERVER_VERSION,
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  buildStamp: detectExpectedBrowserBuildStamp(),
};

const clients = new Map();
const pendingCommands = new Map();
const exportJobs = new Map();
let configuredExportDir = DEFAULT_EXPORT_DIR;
let shuttingDown = false;
let bridgeRole = 'starting';
let bridgeListening = false;
let bridgeStartupSettled = false;
let bridgeStartupResolve;
const bridgeStartup = new Promise((resolveStartup) => {
  bridgeStartupResolve = resolveStartup;
});

const writeLog = (...args) => {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
};

const log = (...args) => {
  if (process.env.GEMINI_MCP_LOG_LEVEL === 'info' || process.env.GEMINI_MCP_DEBUG === 'true') {
    writeLog(...args);
  }
};

const errorLog = (...args) => {
  writeLog(...args);
};

const debugLog = (...args) => {
  if (process.env.GEMINI_MCP_DEBUG === 'true') writeLog(...args);
};

const settleBridgeStartup = (role, error = null) => {
  bridgeRole = role;
  if (bridgeStartupSettled) return;
  bridgeStartupSettled = true;
  bridgeStartupResolve?.({ role, error });
};

const waitForBridgeStartup = async (timeoutMs = 1000) => {
  if (bridgeStartupSettled) return { role: bridgeRole };
  return Promise.race([
    bridgeStartup,
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout({ role: bridgeRole, timeout: true }), timeoutMs),
    ),
  ]);
};

const bridgeUrlHost = (host) => {
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
};

const primaryBridgeBaseUrl = () => `http://${bridgeUrlHost(cli.host)}:${cli.port}`;

const summarizeProcess = () => ({
  pid: process.pid,
  ppid: process.ppid,
  platform: process.platform,
  nodeVersion: process.version,
  execPath: process.execPath,
  cwd: process.cwd(),
  argv: process.argv.slice(0, 8),
  root: ROOT,
  startedAt: PROCESS_STARTED_AT.toISOString(),
  uptimeMs: Math.round(process.uptime() * 1000),
  bridgeRole,
  host: cli.host,
  port: cli.port,
});

const execFileText = (command, args = [], { timeoutMs = PORT_OWNER_DIAGNOSTIC_TIMEOUT_MS } = {}) =>
  new Promise((resolveExec) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf-8',
      },
      (error, stdout, stderr) => {
        resolveExec({
          ok: !error,
          command,
          args,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error?.message || null,
          code: error?.code || null,
          signal: error?.signal || null,
        });
      },
    );
  });

const parseInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const diagnoseWindowsPortOwner = async (port) => {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$conn = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $conn) { "{}"; exit 0 }',
    '$proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue',
    '$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue',
    '[pscustomobject]@{',
    '  pid = [int]$conn.OwningProcess;',
    '  processName = $proc.ProcessName;',
    '  path = $proc.Path;',
    '  commandLine = $cim.CommandLine;',
    '  startTime = if ($proc.StartTime) { $proc.StartTime.ToString("o") } else { $null }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await execFileText('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
  if (!result.ok) {
    return {
      ok: false,
      platform: 'win32',
      method: 'Get-NetTCPConnection',
      error: result.error || result.stderr || 'Falha ao consultar dono da porta.',
    };
  }
  try {
    const payload = JSON.parse(result.stdout.trim() || '{}');
    if (!payload?.pid) {
      return { ok: true, platform: 'win32', method: 'Get-NetTCPConnection', found: false };
    }
    return {
      ok: true,
      platform: 'win32',
      method: 'Get-NetTCPConnection',
      found: true,
      pid: parseInteger(payload.pid),
      processName: payload.processName || null,
      path: payload.path || null,
      commandLine: payload.commandLine || null,
      startTime: payload.startTime || null,
    };
  } catch (err) {
    return {
      ok: false,
      platform: 'win32',
      method: 'Get-NetTCPConnection',
      error: err?.message || String(err),
      raw: result.stdout.trim(),
    };
  }
};

const diagnoseUnixPortOwner = async (port) => {
  const lsof = await execFileText('lsof', [
    '-nP',
    `-iTCP:${Number(port)}`,
    '-sTCP:LISTEN',
    '-FpRcL',
  ]);
  if (!lsof.ok) {
    return {
      ok: false,
      platform: process.platform,
      method: 'lsof',
      error: lsof.error || lsof.stderr || 'Falha ao consultar dono da porta.',
    };
  }
  const owner = {};
  for (const line of lsof.stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) owner.pid = parseInteger(line.slice(1));
    if (line.startsWith('R')) owner.ppid = parseInteger(line.slice(1));
    if (line.startsWith('c')) owner.processName = line.slice(1) || null;
    if (line.startsWith('L')) owner.user = line.slice(1) || null;
  }
  if (!owner.pid) {
    return { ok: true, platform: process.platform, method: 'lsof', found: false };
  }
  const ps = await execFileText('ps', ['-p', String(owner.pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'command=']);
  const commandLine = ps.ok
    ? ps.stdout
        .trim()
        .replace(/^\s*\d+\s+\d+\s+/, '')
        .trim()
    : null;
  return {
    ok: true,
    platform: process.platform,
    method: 'lsof',
    found: true,
    ...owner,
    commandLine,
    psError: ps.ok ? null : ps.error || ps.stderr || null,
  };
};

const diagnoseBridgePortOwner = async () => {
  if (process.env.GEMINI_MCP_PORT_OWNER_DIAGNOSTICS === 'false') {
    return { ok: false, disabled: true, error: 'diagnostico desabilitado por ambiente' };
  }
  if (process.platform === 'win32') return diagnoseWindowsPortOwner(cli.port);
  return diagnoseUnixPortOwner(cli.port);
};

const processFromHealthAndOwner = (health, owner) => {
  const payload = health?.payload || {};
  const processInfo = payload.process || {};
  return {
    pid: processInfo.pid ?? payload.pid ?? owner?.pid ?? null,
    ppid: processInfo.ppid ?? payload.ppid ?? owner?.ppid ?? null,
    platform: processInfo.platform ?? payload.platform ?? owner?.platform ?? null,
    processName: owner?.processName || null,
    commandLine: owner?.commandLine || null,
    path: owner?.path || null,
    cwd: processInfo.cwd ?? payload.cwd ?? null,
    startedAt: processInfo.startedAt ?? payload.startedAt ?? null,
    uptimeMs: processInfo.uptimeMs ?? payload.uptimeMs ?? null,
    bridgeRole: processInfo.bridgeRole ?? payload.bridgeRole ?? null,
  };
};

const proxyStateFromMismatch = (mismatch) => {
  if (!mismatch) return 'proxy_healthy';
  if (mismatch.kind === 'unreachable') return 'primary_unreachable';
  if (mismatch.kind === 'name') return 'port_owned_by_other_service';
  return 'primary_incompatible';
};

const trimDiagnosticText = (value, maxLength = 1200) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
};

const parseListeningPort = (value) => {
  const match = String(value || '').match(/:(\d+)(?:\s|$)/);
  return match ? parseInteger(match[1]) : null;
};

const uniqueNumbers = (items) =>
  [...new Set(items.map(parseInteger).filter((item) => Number.isInteger(item)))].sort((a, b) => a - b);

const looksLikeExporterProcess = (processInfo = {}) =>
  EXPORTER_PROCESS_RE.test(
    [
      processInfo.processName,
      processInfo.path,
      processInfo.commandLine,
      processInfo.cwd,
      ...(Array.isArray(processInfo.argv) ? processInfo.argv : []),
    ]
      .filter(Boolean)
      .join('\n'),
  );

const normalizeProcessCandidate = (candidate = {}) => {
  const pid = parseInteger(candidate.pid);
  const ppid = parseInteger(candidate.ppid);
  return {
    pid,
    ppid,
    platform: candidate.platform || process.platform,
    processName: candidate.processName || null,
    path: candidate.path || null,
    commandLine: trimDiagnosticText(candidate.commandLine || ''),
    cwd: candidate.cwd || null,
    startedAt: candidate.startedAt || candidate.startTime || null,
    listeningPorts: uniqueNumbers(candidate.listeningPorts || []),
    source: candidate.source || 'process-scan',
  };
};

const mergeProcessCandidate = (target, candidate) => {
  for (const [key, value] of Object.entries(candidate)) {
    if (key === 'listeningPorts') continue;
    if ((target[key] === null || target[key] === undefined || target[key] === '') && value !== null && value !== undefined && value !== '') {
      target[key] = value;
    }
  }
  target.listeningPorts = uniqueNumbers([...(target.listeningPorts || []), ...(candidate.listeningPorts || [])]);
  target.source = [...new Set([target.source, candidate.source].filter(Boolean).flatMap((item) => String(item).split('+')))].join('+');
  return target;
};

const addProcessCandidate = (map, candidate) => {
  const normalized = normalizeProcessCandidate(candidate);
  if (!normalized.pid) return;
  const existing = map.get(normalized.pid);
  if (existing) {
    mergeProcessCandidate(existing, normalized);
    return;
  }
  map.set(normalized.pid, normalized);
};

const currentProcessCandidate = () =>
  normalizeProcessCandidate({
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    processName: basename(process.execPath),
    path: process.execPath,
    commandLine: process.argv.join(' '),
    cwd: process.cwd(),
    startedAt: PROCESS_STARTED_AT.toISOString(),
    listeningPorts: bridgeListening ? [cli.port] : [],
    source: 'current',
  });

const portOwnerProcessCandidate = (owner) => {
  if (!owner?.pid) return null;
  return normalizeProcessCandidate({
    pid: owner.pid,
    ppid: owner.ppid,
    platform: owner.platform,
    processName: owner.processName,
    path: owner.path,
    commandLine: owner.commandLine,
    startedAt: owner.startTime,
    listeningPorts: [cli.port],
    source: 'port-owner',
  });
};

const listUnixListeningPortsForPid = async (pid) => {
  const result = await execFileText(
    'lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { timeoutMs: PROCESS_DIAGNOSTIC_TIMEOUT_MS },
  );
  if (!result.ok) return [];
  return uniqueNumbers(
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('n'))
      .map((line) => parseListeningPort(line.slice(1))),
  );
};

const listUnixExporterProcesses = async () => {
  const result = await execFileText('ps', ['-axo', 'pid=,ppid=,command='], {
    timeoutMs: PROCESS_DIAGNOSTIC_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      ok: false,
      platform: process.platform,
      method: 'ps',
      error: result.error || result.stderr || 'Falha ao listar processos.',
      processes: [],
    };
  }
  const baseProcesses = result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return null;
      return normalizeProcessCandidate({
        pid: match[1],
        ppid: match[2],
        commandLine: match[3],
        processName: basename(String(match[3]).split(/\s+/)[0] || ''),
        source: 'ps',
      });
    })
    .filter((item) => item?.pid && looksLikeExporterProcess(item));

  const processes = await Promise.all(
    baseProcesses.map(async (item) => ({
      ...item,
      listeningPorts: await listUnixListeningPortsForPid(item.pid),
    })),
  );

  return {
    ok: true,
    platform: process.platform,
    method: 'ps+lsof',
    processes,
  };
};

const listWindowsExporterProcesses = async () => {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$ports = @{}',
    'Get-NetTCPConnection -State Listen | ForEach-Object {',
    '  $ownerPid = [int]$_.OwningProcess;',
    '  if (-not $ports.ContainsKey($ownerPid)) { $ports[$ownerPid] = @() }',
    '  $ports[$ownerPid] = @($ports[$ownerPid] + [int]$_.LocalPort | Sort-Object -Unique)',
    '}',
    '$items = Get-CimInstance Win32_Process | Where-Object {',
    '  ($_.CommandLine -match "gemini-md-export|mcp-server\\.js") -or',
    '  ($_.ExecutablePath -match "gemini-md-export|mcp-server\\.js")',
    '} | ForEach-Object {',
    '  $processId = [int]$_.ProcessId;',
    '  [pscustomobject]@{',
    '    pid = $processId;',
    '    ppid = [int]$_.ParentProcessId;',
    '    processName = $_.Name;',
    '    path = $_.ExecutablePath;',
    '    commandLine = $_.CommandLine;',
    '    startedAt = $null;',
    '    listeningPorts = @($ports[$processId])',
    '  }',
    '}',
    '@($items) | ConvertTo-Json -Compress -Depth 5',
  ].join('; ');
  const result = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: PROCESS_DIAGNOSTIC_TIMEOUT_MS },
  );
  if (!result.ok) {
    return {
      ok: false,
      platform: 'win32',
      method: 'Get-CimInstance',
      error: result.error || result.stderr || 'Falha ao listar processos.',
      processes: [],
    };
  }
  try {
    const payload = JSON.parse(result.stdout.trim() || '[]');
    const items = Array.isArray(payload) ? payload : [payload].filter(Boolean);
    return {
      ok: true,
      platform: 'win32',
      method: 'Get-CimInstance+Get-NetTCPConnection',
      processes: items.map((item) =>
        normalizeProcessCandidate({
          ...item,
          platform: 'win32',
          source: 'cim',
        }),
      ),
    };
  } catch (err) {
    return {
      ok: false,
      platform: 'win32',
      method: 'Get-CimInstance',
      error: err?.message || String(err),
      raw: result.stdout.trim(),
      processes: [],
    };
  }
};

const listExporterProcesses = async () => {
  if (process.env.GEMINI_MCP_PROCESS_DIAGNOSTICS === 'false') {
    return { ok: false, disabled: true, error: 'diagnostico de processos desabilitado', processes: [] };
  }
  if (process.platform === 'win32') return listWindowsExporterProcesses();
  return listUnixExporterProcesses();
};

const fetchJsonWithTimeout = async (url, timeoutMs = PRIMARY_BRIDGE_HEALTH_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { ok: response.ok, status: response.status, payload, text };
  } finally {
    clearTimeout(timer);
  }
};

const primaryBridgeHealth = async () => {
  try {
    return await fetchJsonWithTimeout(`${primaryBridgeBaseUrl()}/healthz`);
  } catch (err) {
    return {
      ok: false,
      status: null,
      payload: null,
      error: err?.name === 'AbortError' ? 'timeout' : err?.message || String(err),
    };
  }
};

const primaryBridgeClients = async () => {
  try {
    return await fetchJsonWithTimeout(`${primaryBridgeBaseUrl()}/agent/clients`);
  } catch (err) {
    return {
      ok: false,
      status: null,
      payload: null,
      error: err?.name === 'AbortError' ? 'timeout' : err?.message || String(err),
    };
  }
};

const primaryBridgeMismatch = (health, owner = null) => {
  const payload = health?.payload || {};
  const process = processFromHealthAndOwner(health, owner);
  if (!health?.ok) {
    return {
      kind: 'unreachable',
      expectedVersion: SERVER_VERSION,
      actualVersion: null,
      expectedProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      actualProtocolVersion: null,
      process,
      portOwner: owner || null,
      detail: health?.error || health?.text || `HTTP ${health?.status ?? 'unknown'}`,
    };
  }
  if (payload.name && payload.name !== SERVER_NAME) {
    return {
      kind: 'name',
      expectedName: SERVER_NAME,
      actualName: payload.name,
      expectedVersion: SERVER_VERSION,
      actualVersion: payload.version || null,
      expectedProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      actualProtocolVersion: payload.protocolVersion ?? null,
      process,
      portOwner: owner || null,
    };
  }
  if (payload.version && payload.version !== SERVER_VERSION) {
    return {
      kind: 'version',
      expectedVersion: SERVER_VERSION,
      actualVersion: payload.version,
      expectedProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      actualProtocolVersion: payload.protocolVersion ?? null,
      process,
      portOwner: owner || null,
    };
  }
  if (
    payload.protocolVersion !== undefined &&
    Number(payload.protocolVersion) !== Number(EXTENSION_PROTOCOL_VERSION)
  ) {
    return {
      kind: 'protocol',
      expectedVersion: SERVER_VERSION,
      actualVersion: payload.version || null,
      expectedProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      actualProtocolVersion: payload.protocolVersion,
      process,
      portOwner: owner || null,
    };
  }
  return null;
};

const primaryBridgeMismatchMessage = (mismatch) => {
  if (!mismatch) return null;
  const pid = mismatch.process?.pid ? ` PID ${mismatch.process.pid}` : '';
  if (mismatch.kind === 'version') {
    return `Outra instância do gemini-md-export${pid} está segurando a porta ${cli.host}:${cli.port} com MCP ${mismatch.actualVersion}, mas esta sessão carregou MCP ${mismatch.expectedVersion}. Feche/reinicie as sessões antigas do Gemini CLI ou encerre o processo antigo do exporter antes de repetir a tool.`;
  }
  if (mismatch.kind === 'protocol') {
    return `Outra instância do gemini-md-export${pid} está segurando a porta ${cli.host}:${cli.port} com protocolo ${mismatch.actualProtocolVersion ?? 'desconhecido'}, mas esta sessão espera protocolo ${mismatch.expectedProtocolVersion}. Reinicie as sessões antigas do Gemini CLI para o bridge primário subir atualizado.`;
  }
  if (mismatch.kind === 'name') {
    return `A porta ${cli.host}:${cli.port} está ocupada por ${mismatch.actualName || 'outro serviço'}${pid}, não pelo ${SERVER_NAME}. Feche esse processo ou altere GEMINI_MCP_BRIDGE_PORT.`;
  }
  return `A porta ${cli.host}:${cli.port} parece ocupada${pid}, mas esta instância não conseguiu consultar o bridge primário (${mismatch.detail || 'sem detalhe'}). Reinicie o Gemini CLI; se persistir, feche o processo dono da porta ou reinicie a máquina.`;
};

const cleanupEligibilityForProcess = (candidate, mismatch, portOwner) => {
  if (!candidate.isPortOwner) {
    return { eligible: false, reason: 'not_port_owner' };
  }
  if (!mismatch) {
    return { eligible: false, reason: 'primary_healthy' };
  }
  if (mismatch.kind === 'name') {
    return { eligible: false, reason: 'port_owner_is_other_service' };
  }
  if (!portOwner?.pid) {
    return { eligible: false, reason: 'port_owner_unknown' };
  }
  if (candidate.pid === process.pid) {
    return { eligible: false, reason: 'current_process_protected' };
  }
  if (candidate.pid === process.ppid) {
    return { eligible: false, reason: 'parent_process_protected' };
  }
  if (!candidate.looksLikeExporter) {
    return { eligible: false, reason: 'process_not_recognized_as_exporter' };
  }
  return {
    eligible: true,
    reason: `stale_primary_${mismatch.kind}`,
    requiresConfirm: true,
  };
};

const recommendedRecoveryAction = (mismatch, cleanupPlan) => {
  if (!mismatch) {
    return 'Modo proxy saudável ou bridge primário compatível; não há processo para limpar.';
  }
  if (cleanupPlan?.eligible) {
    return 'Há um processo primário antigo/travado reconhecido como exporter. Rode gemini_mcp_cleanup_stale_processes sem confirm para dry-run; se o alvo estiver correto, repita com confirm=true.';
  }
  if (mismatch.kind === 'name') {
    return 'A porta está ocupada por outro serviço; não vou encerrar automaticamente. Feche esse app ou use outra GEMINI_MCP_BRIDGE_PORT.';
  }
  return 'Não há alvo seguro para limpeza automática. Use o PID/caminho do diagnóstico para fechar manualmente ou reinicie o Gemini CLI.';
};

const buildProcessDiagnostics = async () => {
  const [health, portOwner, processScan] = await Promise.all([
    primaryBridgeHealth(),
    diagnoseBridgePortOwner(),
    listExporterProcesses(),
  ]);
  const mismatch = primaryBridgeMismatch(health, portOwner);
  const processMap = new Map();

  addProcessCandidate(processMap, currentProcessCandidate());
  for (const item of processScan.processes || []) addProcessCandidate(processMap, item);
  const ownerCandidate = portOwnerProcessCandidate(portOwner);
  if (ownerCandidate) addProcessCandidate(processMap, ownerCandidate);

  const processes = [...processMap.values()]
    .map((item) => {
      const isCurrent = item.pid === process.pid;
      const isParent = item.pid === process.ppid;
      const isPortOwner = item.pid === portOwner?.pid;
      const looksLikeExporter = looksLikeExporterProcess(item);
      const detectedVersion = isCurrent
        ? SERVER_VERSION
        : isPortOwner && health?.payload?.version
          ? health.payload.version
          : null;
      const state = isCurrent
        ? bridgeRole
        : isPortOwner
          ? mismatch
            ? proxyStateFromMismatch(mismatch)
            : 'primary_healthy'
          : 'related_exporter_process';
      const cleanup = cleanupEligibilityForProcess(
        {
          ...item,
          isCurrent,
          isParent,
          isPortOwner,
          looksLikeExporter,
        },
        mismatch,
        portOwner,
      );
      return {
        ...item,
        isCurrent,
        isParent,
        isPortOwner,
        looksLikeExporter,
        detectedVersion,
        state,
        cleanup,
      };
    })
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isPortOwner !== b.isPortOwner) return a.isPortOwner ? -1 : 1;
      return a.pid - b.pid;
    });

  const targets = processes
    .filter((item) => item.cleanup?.eligible)
    .map((item) => ({
      pid: item.pid,
      ppid: item.ppid,
      processName: item.processName,
      path: item.path,
      commandLine: item.commandLine,
      listeningPorts: item.listeningPorts,
      detectedVersion: item.detectedVersion,
      state: item.state,
      reason: item.cleanup.reason,
    }));
  const cleanupPlan = {
    eligible: targets.length > 0,
    targets,
    reason: targets.length > 0 ? 'safe_stale_primary_found' : processes.find((item) => item.isPortOwner)?.cleanup?.reason || 'no_safe_target',
    requiresConfirm: targets.length > 0,
  };

  return {
    ok: true,
    mcp: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      bridgeRole,
      process: summarizeProcess(),
    },
    primaryBridge: {
      ok: health.ok,
      status: health.status,
      health: health.payload || null,
      error: health.error || null,
      process: processFromHealthAndOwner(health, portOwner),
      portOwner,
    },
    proxyState: proxyStateFromMismatch(mismatch),
    problem: mismatch
      ? {
          code: 'primary_bridge_version_mismatch',
          message: primaryBridgeMismatchMessage(mismatch),
          mismatch,
        }
      : null,
    processScan: {
      ok: processScan.ok,
      method: processScan.method || null,
      platform: processScan.platform || process.platform,
      disabled: processScan.disabled === true,
      error: processScan.error || null,
      count: processes.length,
    },
    processes,
    cleanupPlan,
    recommendedAction: recommendedRecoveryAction(mismatch, cleanupPlan),
  };
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const waitForPidExit = async (pid, waitMs) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= waitMs) {
    if (!isPidAlive(pid)) {
      return { exited: true, waitedMs: Date.now() - startedAt };
    }
    await sleep(100);
  }
  return { exited: !isPidAlive(pid), waitedMs: Date.now() - startedAt };
};

const terminateProcessCandidate = async (target, { force = false, waitMs = PROCESS_CLEANUP_WAIT_MS } = {}) => {
  const pid = parseInteger(target?.pid);
  if (!pid || pid <= 0) {
    throw new Error(`PID inválido para cleanup: ${target?.pid}`);
  }
  if (pid === process.pid) {
    throw new Error(`Recusei encerrar o processo MCP atual (PID ${pid}).`);
  }
  if (pid === process.ppid) {
    throw new Error(`Recusei encerrar o processo pai do MCP atual (PID ${pid}).`);
  }

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    const result = await execFileText('taskkill.exe', args, {
      timeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
    });
    const exit = await waitForPidExit(pid, waitMs);
    return {
      pid,
      method: 'taskkill',
      force,
      ok: result.ok || exit.exited,
      exited: exit.exited,
      waitedMs: exit.waitedMs,
      stdout: trimDiagnosticText(result.stdout || ''),
      stderr: trimDiagnosticText(result.stderr || ''),
      error: result.ok ? null : result.error || null,
    };
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err;
  }
  const exit = await waitForPidExit(pid, waitMs);
  return {
    pid,
    method: 'process.kill',
    signal,
    force,
    ok: exit.exited,
    exited: exit.exited,
    waitedMs: exit.waitedMs,
  };
};

const retryBridgeListen = async () => {
  if (bridgeListening) {
    return { attempted: false, ok: true, reason: 'already-listening', bridgeRole };
  }
  return new Promise((resolveRetry) => {
    const cleanup = () => {
      bridgeServer.off('listening', onListening);
      bridgeServer.off('error', onError);
    };
    const onListening = () => {
      cleanup();
      bridgeListening = true;
      settleBridgeStartup('primary');
      resolveRetry({ attempted: true, ok: true, bridgeRole, host: cli.host, port: cli.port });
    };
    const onError = (err) => {
      cleanup();
      resolveRetry({
        attempted: true,
        ok: false,
        bridgeRole,
        error: err?.message || String(err),
        code: err?.code || null,
      });
    };
    bridgeServer.once('listening', onListening);
    bridgeServer.once('error', onError);
    try {
      bridgeServer.listen(cli.port, cli.host);
    } catch (err) {
      cleanup();
      resolveRetry({
        attempted: true,
        ok: false,
        bridgeRole,
        error: err?.message || String(err),
        code: err?.code || null,
      });
    }
  });
};

const cleanupStaleMcpProcesses = async (args = {}) => {
  const diagnosis = await buildProcessDiagnostics();
  const targets = diagnosis.cleanupPlan.targets || [];
  const confirm = args.confirm === true;
  const dryRun = args.dryRun !== undefined ? args.dryRun !== false : !confirm;

  if (targets.length === 0) {
    return {
      ok: false,
      dryRun,
      terminated: [],
      message: 'Nenhum processo MCP/exporter antigo foi considerado seguro para encerramento automático.',
      diagnosis,
    };
  }

  if (dryRun || !confirm) {
    return {
      ok: false,
      dryRun: true,
      wouldTerminate: targets,
      terminated: [],
      message: 'Dry-run: confirme com confirm=true para encerrar apenas os processos listados em wouldTerminate.',
      diagnosis,
    };
  }

  const waitMs = normalizeWaitMs(args.waitMs, PROCESS_CLEANUP_WAIT_MS, 30_000);
  const terminated = [];
  for (const target of targets) {
    try {
      terminated.push({
        target,
        ...(await terminateProcessCandidate(target, {
          force: args.force === true,
          waitMs,
        })),
      });
    } catch (err) {
      terminated.push({
        target,
        pid: target.pid,
        ok: false,
        exited: false,
        error: err?.message || String(err),
      });
    }
  }

  const bridgeRetry = terminated.some((item) => item.ok && item.exited)
    ? await retryBridgeListen()
    : { attempted: false, ok: false, reason: 'no-process-exited' };

  return {
    ok: terminated.every((item) => item.ok && item.exited),
    dryRun: false,
    force: args.force === true,
    terminated,
    bridgeRetry,
    diagnosis,
    message: bridgeRetry.ok
      ? 'Processo antigo encerrado e esta sessão assumiu o bridge local.'
      : 'Cleanup executado; confira bridgeRetry para saber se esta sessão conseguiu assumir a porta.',
  };
};

const parseArgs = (argv) => {
  const out = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--host' && argv[i + 1]) {
      out.host = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[i + 1]);
      i += 1;
    }
  }

  return out;
};

const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  process.stdout.write(
    [
      `${SERVER_NAME} v${SERVER_VERSION}`,
      '',
      'Usage:',
      `  node ${fileURLToPath(import.meta.url)} [--host 127.0.0.1] [--port 47283]`,
      '',
      'This process serves two roles:',
      '  1. MCP server over stdio for the AI client',
      '  2. Local HTTP bridge for the browser extension',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(payload));
};

const isAllowedBridgeOrigin = (origin) => {
  if (!origin) return true;
  try {
    return new URL(origin).origin === ALLOWED_BRIDGE_ORIGIN;
  } catch {
    return false;
  }
};

const bridgeCorsHeaders = (req) => {
  const origin = req.headers.origin;
  if (!origin || !isAllowedBridgeOrigin(origin)) {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    vary: 'origin',
  };
};

const requireAllowedBridgeOrigin = (req) => {
  if (isAllowedBridgeOrigin(req.headers.origin)) return;
  const error = new Error(`Origin não autorizada para o bridge: ${req.headers.origin}`);
  error.statusCode = 403;
  throw error;
};

const sendBridgeJson = (req, res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...bridgeCorsHeaders(req),
  });
  res.end(JSON.stringify(payload));
};

const sendBridgeNoContent = (req, res) => {
  res.writeHead(204, {
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...bridgeCorsHeaders(req),
  });
  res.end();
};

const sendAgentJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const sendNoContent = (res) => {
  res.writeHead(204, {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end();
};

const sseHeaders = (req) => ({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  ...bridgeCorsHeaders(req),
});

const closeEventStream = (client) => {
  if (!client?.eventStream) return;
  try {
    clearInterval(client.eventStream.keepAliveTimer);
    client.eventStream.res.end();
  } catch {
    // ignore stale socket
  }
  client.eventStream = null;
};

const sendClientEvent = (client, event, payload = {}) => {
  if (!client?.eventStream?.res || client.eventStream.res.destroyed) {
    if (client) client.eventStream = null;
    return false;
  }
  try {
    client.eventSeq = (client.eventSeq || 0) + 1;
    client.eventStream.res.write(`id: ${client.eventSeq}\n`);
    client.eventStream.res.write(`event: ${event}\n`);
    client.eventStream.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    client.eventStream.lastSentAt = Date.now();
    return true;
  } catch {
    closeEventStream(client);
    return false;
  }
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
};

const readJsonBody = async (req) => {
  const body = await readBody(req);
  return JSON.parse(body || '{}');
};

const getLiveClients = () => {
  const now = Date.now();
  return Array.from(clients.values())
    .filter((client) => now - client.lastSeenAt <= CLIENT_STALE_MS)
    .sort(
      (a, b) =>
        Number(b.isActiveTab === true) - Number(a.isActiveTab === true) ||
        Number(!!b.eventStream?.res && !b.eventStream.res.destroyed) -
          Number(!!a.eventStream?.res && !a.eventStream.res.destroyed) ||
        Number(!!b.pendingPoll) - Number(!!a.pendingPoll) ||
        b.lastSeenAt - a.lastSeenAt,
    );
};

const removeClient = (clientId) => {
  const client = clients.get(clientId);
  if (!client) return;
  closeEventStream(client);
  if (client.pendingPoll) {
    try {
      clearTimeout(client.pendingPoll.timer);
      sendNoContent(client.pendingPoll.res);
    } catch {
      // ignore stale socket
    }
  }
  clients.delete(clientId);
};

const cleanupStaleClients = () => {
  const now = Date.now();
  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastSeenAt <= CLIENT_STALE_MS) continue;
    removeClient(clientId);
  }
};

const dropClientsAfterExtensionReload = () => {
  for (const clientId of Array.from(clients.keys())) {
    removeClient(clientId);
  }
};

const upsertClient = (payload, meta = {}) => {
  const existing = clients.get(payload.clientId);
  const next = existing || {
    clientId: payload.clientId,
    queue: [],
    pendingPoll: null,
    eventStream: null,
    eventSeq: 0,
  };

  const now = Date.now();
  next.lastSeenAt = now;
  if (meta.heartbeat === true) {
    next.lastHeartbeatAt = now;
    next.lastHeartbeatPayloadBytes = meta.payloadBytes ?? next.lastHeartbeatPayloadBytes ?? null;
  }
  next.capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities
    : next.capabilities || [];
  next.snapshotDirty = payload.snapshotDirty === true;
  next.snapshotHash = payload.snapshotHash || next.snapshotHash || null;
  next.metrics = payload.metrics || next.metrics || null;
  next.tabId = payload.tabId ?? next.tabId ?? null;
  next.windowId = payload.windowId ?? next.windowId ?? null;
  next.isActiveTab = payload.isActiveTab ?? next.isActiveTab ?? null;
  next.extensionVersion = payload.extensionVersion || next.extensionVersion || null;
  next.protocolVersion =
    payload.protocolVersion !== undefined ? payload.protocolVersion : next.protocolVersion ?? null;
  next.buildStamp = payload.buildStamp || payload.page?.buildStamp || next.buildStamp || null;
  next.page = payload.page || next.page || null;
  next.commandPoll = payload.commandPoll || next.commandPoll || null;
  if (Array.isArray(payload.conversations)) {
    next.conversations = payload.conversations;
    next.lastSnapshotAt = now;
    next.lastSnapshotPayloadBytes = meta.payloadBytes ?? next.lastSnapshotPayloadBytes ?? null;
  } else {
    next.conversations = next.conversations || [];
  }
  if (Array.isArray(payload.modalConversations)) {
    next.modalConversations = payload.modalConversations;
  }
  next.summary = payload;

  clients.set(next.clientId, next);
  return next;
};

const upsertClientSnapshot = (payload, meta = {}) => {
  const client = upsertClient(
    {
      clientId: payload.clientId,
      tabId: payload.tabId,
      windowId: payload.windowId,
      isActiveTab: payload.isActiveTab,
      extensionVersion: payload.extensionVersion,
      protocolVersion: payload.protocolVersion,
      buildStamp: payload.buildStamp,
      page: payload.page,
      conversations: payload.conversations,
      modalConversations: payload.modalConversations,
      snapshotHash: payload.snapshotHash,
      capabilities: payload.capabilities,
    },
    {
      ...meta,
      heartbeat: false,
    },
  );
  const now = Date.now();
  client.lastSnapshotAt = now;
  client.lastSnapshotPayloadBytes = meta.payloadBytes ?? null;
  client.snapshotHash = payload.snapshotHash || client.snapshotHash || null;
  client.snapshotDirty = false;
  client.lastSnapshotSummary = {
    observedAt: payload.observedAt || null,
    conversationCount: Array.isArray(payload.conversations) ? payload.conversations.length : 0,
    modalConversationCount: Array.isArray(payload.modalConversations)
      ? payload.modalConversations.length
      : 0,
  };
  return client;
};

const takeQueuedCommand = (client) => {
  if (!client?.queue?.length) return null;
  const command = client.queue.shift();
  const pending = pendingCommands.get(command.id);
  if (pending) {
    pending.dispatchedAt = Date.now();
    if (pending.dispatchTimer) {
      clearTimeout(pending.dispatchTimer);
      pending.dispatchTimer = null;
    }
  }
  return command;
};

const flushQueuedCommand = (client, { allowSse = true } = {}) => {
  if (!client?.queue?.length) return null;
  const command = takeQueuedCommand(client);
  if (!command) return null;
  if (allowSse && sendClientEvent(client, 'command', { command })) {
    return 'sse';
  }
  if (!client.pendingPoll) {
    client.queue.unshift(command);
    const pending = pendingCommands.get(command.id);
    if (pending) pending.dispatchedAt = null;
    return null;
  }
  const { res, timer } = client.pendingPoll;
  clearTimeout(timer);
  client.pendingPoll = null;
  sendJson(res, 200, { command });
  return 'long-poll';
};

const removeQueuedCommand = (clientId, commandId) => {
  const client = clients.get(clientId);
  if (!client?.queue?.length) return;
  client.queue = client.queue.filter((command) => command.id !== commandId);
};

const enqueueCommand = (clientId, type, args = {}, options = {}) => {
  const client = clients.get(clientId);
  if (!client) {
    throw new Error(`Cliente ${clientId} não encontrado.`);
  }

  const command = {
    id: randomUUID(),
    type,
    args,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || COMMAND_TIMEOUT_MS);
    const dispatchTimeoutMs = Math.max(
      0,
      Number(options.dispatchTimeoutMs ?? COMMAND_DISPATCH_TIMEOUT_MS),
    );
    const pending = {
      clientId,
      resolve,
      reject,
      timer: null,
      dispatchTimer: null,
      type,
      dispatchedAt: null,
    };
    const timer = setTimeout(() => {
      pendingCommands.delete(command.id);
      removeQueuedCommand(clientId, command.id);
      if (pending.dispatchTimer) clearTimeout(pending.dispatchTimer);
      const error = new Error(`Timeout aguardando resposta do comando ${type}.`);
      error.code = 'command_timeout';
      error.commandType = type;
      error.commandDispatched = !!pending.dispatchedAt;
      reject(error);
    }, timeoutMs);

    pending.timer = timer;
    if (dispatchTimeoutMs > 0) {
      pending.dispatchTimer = setTimeout(() => {
        if (pending.dispatchedAt) return;
        pendingCommands.delete(command.id);
        removeQueuedCommand(clientId, command.id);
        clearTimeout(pending.timer);
        const error = new Error(
          `A aba do Gemini está conectada, mas não abriu o canal de comandos para ${type}. Recarregue a aba do Gemini e confirme que a extensão está ativa no navegador.`,
        );
        error.code = 'command_dispatch_timeout';
        error.commandType = type;
        error.commandDispatched = false;
        reject(error);
      }, dispatchTimeoutMs);
    }
    pendingCommands.set(command.id, pending);

    client.queue.push(command);
    flushQueuedCommand(client);
  });
};

const resolveCommand = (commandId, result) => {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  if (pending.dispatchTimer) clearTimeout(pending.dispatchTimer);
  pendingCommands.delete(commandId);
  pending.resolve(result);
  return true;
};

const toolTextResult = (structuredContent, { isError = false } = {}) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(structuredContent),
    },
  ],
  structuredContent,
  isError,
});

const requireClient = (clientId) => {
  cleanupStaleClients();
  const liveClients = getLiveClients();
  if (liveClients.length === 0) {
    throw new Error('Nenhuma aba do Gemini conectada à extensão.');
  }

  if (!clientId) return liveClients[0];

  const client = liveClients.find((item) => item.clientId === clientId);
  if (!client) {
    throw new Error(`Cliente ${clientId} não está ativo.`);
  }
  return client;
};

const isNotebookClient = (client) =>
  client?.page?.kind === 'notebook' ||
  String(client?.page?.pathname || '').startsWith('/notebook/') ||
  (client?.conversations || []).some((conversation) => conversation.source === 'notebook');

const requireNotebookClient = (clientId) => {
  if (clientId) {
    const client = requireClient(clientId);
    if (!isNotebookClient(client)) {
      throw new Error(`Cliente ${clientId} não está em uma página de caderno.`);
    }
    return client;
  }

  cleanupStaleClients();
  const client = getLiveClients().find(isNotebookClient);
  if (!client) {
    throw new Error('Nenhuma aba do Gemini Notebook conectada à extensão.');
  }
  return client;
};

let lastBrowserLaunchAt = 0;
let lastBrowserLaunchResult = null;

const launchChromeForGemini = async ({ profileDirectory } = {}) => {
  const now = Date.now();
  const sharedRecentLaunch = describeRecentBrowserLaunch(readBrowserLaunchState(), {
    now,
    cooldownMs: BROWSER_LAUNCH_COOLDOWN_MS,
  });
  if (sharedRecentLaunch) {
    return {
      attempted: false,
      supported: true,
      skipped: true,
      reason: 'shared-launch-cooldown',
      ...sharedRecentLaunch,
    };
  }

  if (
    lastBrowserLaunchResult &&
    BROWSER_LAUNCH_COOLDOWN_MS > 0 &&
    now - lastBrowserLaunchAt < BROWSER_LAUNCH_COOLDOWN_MS
  ) {
    return {
      ...lastBrowserLaunchResult,
      attempted: false,
      skipped: true,
      reason: 'launch-cooldown',
      cooldownMs: BROWSER_LAUNCH_COOLDOWN_MS,
      previousAttemptedAt: new Date(lastBrowserLaunchAt).toISOString(),
    };
  }

  const result = await launchGeminiBrowser({ profileDirectory });
  lastBrowserLaunchAt = now;
  lastBrowserLaunchResult = result;
  try {
    writeBrowserLaunchState({
      source: 'mcp',
      lastAttemptAt: now,
      profileDirectory: profileDirectory || null,
      ...result,
    });
  } catch (err) {
    log('[browser-launch]', 'failed to write shared launch state', err?.message || String(err));
  }
  return result;
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const normalizeWaitMs = (value, fallback, max = 30_000) => {
  const parsed = Number(value ?? fallback);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(0, Math.min(max, safe));
};

const normalizeReloadWaitMs = (value, fallback, max = 120_000) => {
  const parsed = Number(value ?? fallback);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(0, Math.min(max, safe));
};

const waitForLiveClients = async (timeoutMs, pollIntervalMs = 500) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    cleanupStaleClients();
    const liveClients = getLiveClients();
    if (liveClients.length > 0) return liveClients;
    await sleep(pollIntervalMs);
  }
  cleanupStaleClients();
  return getLiveClients();
};

const getChromeExtensionInfo = async (client) => {
  const result = await enqueueCommand(client.clientId, 'get-extension-info', {}, {
    timeoutMs: EXTENSION_INFO_COMMAND_TIMEOUT_MS,
  });
  return result || null;
};

const reloadChromeExtensionForClient = async (client, args = {}) => {
  try {
    const result = await enqueueCommand(client.clientId, 'reload-extension-self', args, {
      timeoutMs: RELOAD_EXTENSION_COMMAND_TIMEOUT_MS,
    });
    return result || null;
  } catch (err) {
    if (/Timeout aguardando resposta/.test(err?.message || '')) {
      if (err.commandDispatched) {
        return {
          ok: true,
          reloading: true,
          assumed: true,
          reason: 'reload-command-result-timeout',
          detail: err.message,
        };
      }
      return {
        ok: false,
        reloading: false,
        reason: 'reload-command-dispatch-timeout',
        detail: err.message,
      };
    }
    throw err;
  }
};

const reloadChromeExtension = async (client, args = {}) => {
  const candidates = [
    client,
    ...getLiveClients().filter((candidate) => candidate.clientId !== client?.clientId),
  ].filter(Boolean);
  const attempts = [];

  for (const candidate of candidates) {
    const result = await reloadChromeExtensionForClient(candidate, args);
    attempts.push({
      client: summarizeClient(candidate),
      result,
    });
    if (result?.ok) {
      dropClientsAfterExtensionReload();
      return {
        ...result,
        attempts,
      };
    }
  }

  return {
    ok: false,
    reloading: false,
    reason: attempts.at(-1)?.result?.reason || 'reload-command-failed',
    attempts,
  };
};

const ensureBrowserExtensionReady = (args = {}, options = {}) =>
  ensureChromeExtensionReady(
    {
      expected: EXPECTED_CHROME_EXTENSION_INFO,
      config: CHROME_GUARD_CONFIG,
      getLiveClients,
      getChromeExtensionInfo,
      reloadChromeExtension,
      launchChromeForGemini,
      log: debugLog,
    },
    {
      clientId: args.clientId || null,
      ...options,
    },
  );

const buildBridgeHealth = (client, now = Date.now()) => {
  if (!client) {
    return {
      status: 'stale',
      blockingIssue: 'no_client',
      action: 'Abra uma aba do Gemini com a extensão ativa.',
    };
  }
  const heartbeatAgeMs = client.lastHeartbeatAt ? now - client.lastHeartbeatAt : null;
  const eventStreamConnected = !!client.eventStream?.res && !client.eventStream.res.destroyed;
  const longPollConnected = !!client.pendingPoll;
  const pagePolling = client.commandPoll?.polling ?? null;
  const queuedCommands = client.queue?.length || 0;
  const versionMatches = clientMatchesExpectedBrowserExtension(client);

  let status = 'healthy';
  let blockingIssue = null;
  let action = 'ok';
  if (!versionMatches) {
    status = 'version_mismatch';
    blockingIssue = 'extension_version_mismatch';
    action = 'Rode gemini_browser_status para tentar recarregar a extensão automaticamente.';
  } else if (heartbeatAgeMs === null || heartbeatAgeMs > CLIENT_STALE_MS) {
    status = 'stale';
    blockingIssue = 'stale_client';
    action = 'Recarregue a aba do Gemini ou chame gemini_browser_status para reconectar.';
  } else if (!eventStreamConnected && !longPollConnected && pagePolling !== true) {
    status = 'command_channel_stuck';
    blockingIssue = 'command_channel_stuck';
    action = 'Use gemini_reload_gemini_tabs se a aba estiver aberta mas não aceitar comandos.';
  } else if (heartbeatAgeMs > CLIENT_DEGRADED_HEARTBEAT_MS) {
    status = 'degraded';
    blockingIssue = 'heartbeat_delayed';
    action = 'Aguarde alguns segundos; se persistir, rode gemini_browser_status.';
  }

  return {
    status,
    blockingIssue,
    action,
    heartbeatAgeMs,
    staleAfterMs: CLIENT_STALE_MS,
    eventStreamConnected,
    longPollConnected,
    pagePolling,
    queuedCommands,
    lastHeartbeatAt: client.lastHeartbeatAt ? new Date(client.lastHeartbeatAt).toISOString() : null,
    lastSnapshotAt: client.lastSnapshotAt ? new Date(client.lastSnapshotAt).toISOString() : null,
    lastHeartbeatPayloadBytes: client.lastHeartbeatPayloadBytes ?? null,
    lastSnapshotPayloadBytes: client.lastSnapshotPayloadBytes ?? null,
    capabilities: client.capabilities || [],
    lastError: client.metrics?.lastError || null,
  };
};

const summarizeClient = (client) => ({
  clientId: client.clientId,
  tabId: client.tabId ?? null,
  windowId: client.windowId ?? null,
  isActiveTab: client.isActiveTab ?? null,
  extensionVersion: client.extensionVersion ?? null,
  protocolVersion: client.protocolVersion ?? null,
  buildStamp: client.buildStamp ?? client.page?.buildStamp ?? null,
  lastSeenAt: new Date(client.lastSeenAt).toISOString(),
  commandChannel: {
    eventStreamConnected: !!client.eventStream?.res && !client.eventStream.res.destroyed,
    eventStreamConnectedAt: client.eventStream?.connectedAt
      ? new Date(client.eventStream.connectedAt).toISOString()
      : null,
    pollConnected: !!client.pendingPoll,
    queuedCommands: client.queue?.length || 0,
    pagePolling: client.commandPoll?.polling ?? null,
    lastPollStartedAt: client.commandPoll?.lastStartedAt || null,
    lastPollEndedAt: client.commandPoll?.lastEndedAt || null,
    lastCommandReceivedAt: client.commandPoll?.lastCommandReceivedAt || null,
  },
  page: client.page || null,
  bridgeHealth: buildBridgeHealth(client),
  listedConversationCount: client.conversations?.length || 0,
  sidebarConversationCount: recentConversationsForClient(client).length,
  notebookConversationCount: notebookConversationsForClient(client).length,
});

const normalizeLimit = (value, fallback = 10, max = 100) => {
  const parsed = Number(value || fallback);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(max, safeValue));
};

const normalizeOffset = (value, max = MAX_RECENT_CHATS_LOAD_TARGET - 1) => {
  const parsed = Number(value || 0);
  const safeValue = Number.isFinite(parsed) ? parsed : 0;
  return Math.max(0, Math.min(max, safeValue));
};

const notebookConversationsForClient = (client) =>
  (client.conversations || []).filter((conversation) => conversation.source === 'notebook');

const recentConversationsForClient = (client) =>
  (client.conversations || []).filter((conversation) => conversation.source !== 'notebook');

const recentConversationCountForClient = (client) => recentConversationsForClient(client).length;

const clientBuildStamp = (client) => client?.buildStamp || client?.page?.buildStamp || null;

const clientMatchesExpectedBrowserExtension = (client) =>
  String(client?.extensionVersion || '') === EXPECTED_CHROME_EXTENSION_INFO.extensionVersion &&
  Number(client?.protocolVersion) === Number(EXPECTED_CHROME_EXTENSION_INFO.protocolVersion) &&
  (!EXPECTED_CHROME_EXTENSION_INFO.buildStamp ||
    String(clientBuildStamp(client) || '') === EXPECTED_CHROME_EXTENSION_INFO.buildStamp);

const requireRecentChatsClient = (clientId) => {
  if (clientId) return requireClient(clientId);

  cleanupStaleClients();
  const liveClients = getLiveClients();
  if (liveClients.length === 0) {
    throw new Error('Nenhuma aba do Gemini conectada à extensão.');
  }

  return [...liveClients].sort(
    (a, b) =>
      Number(clientMatchesExpectedBrowserExtension(b)) -
        Number(clientMatchesExpectedBrowserExtension(a)) ||
      recentConversationCountForClient(b) - recentConversationCountForClient(a) ||
      Number(b.isActiveTab === true) - Number(a.isActiveTab === true) ||
      Number(!!b.pendingPoll) - Number(!!a.pendingPoll) ||
      b.lastSeenAt - a.lastSeenAt,
  )[0];
};

const recentChatsReachedEndForClient = (client) =>
  client?.lastSnapshot?.reachedSidebarEnd === true || client?.page?.reachedSidebarEnd === true;

const enrichNotebookConversation = (conversation, index) => ({
  ...conversation,
  index: index + 1,
  urlKnown: !!conversation.chatId && String(conversation.url || '').includes('/app/'),
  cachedOrLearned: !!conversation.chatId,
});

const stripGeminiPrefix = (value) => String(value || '').replace(/^c_/, '');

const extractChatIdFromUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/app\/([a-f0-9]{12,})/i);
    return match?.[1] || null;
  } catch {
    const match = value.match(/\/app\/([a-f0-9]{12,})/i);
    return match?.[1] || null;
  }
};

const normalizeConversationChatId = (conversation = {}) => {
  const candidates = [
    stripGeminiPrefix(conversation.chatId || ''),
    extractChatIdFromUrl(conversation.url),
    stripGeminiPrefix(conversation.id || ''),
  ];
  return candidates.find((candidate) => /^[a-f0-9]{12,}$/i.test(candidate || '')) || '';
};

const resolveOutputDir = (outputDir) => {
  if (!outputDir) return configuredExportDir;
  const expanded = String(outputDir).replace(/^~(?=\/|$)/, homedir());
  return resolve(expanded);
};

const safeFilename = (filename) => {
  const raw = String(filename || '').trim().replace(/\\/g, '/');
  if (
    !raw ||
    raw.startsWith('/') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.includes('\0') ||
    raw.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Nome de arquivo inválido retornado pela extensão.');
  }
  return raw;
};

const existingFileStat = (filePath) => {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
};

const existingMarkdownExportForConversation = (conversation, { outputDir } = {}) => {
  const chatId = normalizeConversationChatId(conversation);
  if (!chatId) return null;

  const directory = resolveOutputDir(outputDir);
  const filename = safeFilename(`${chatId}.md`);
  const filePath = resolve(directory, filename);
  const relativePath = relative(directory, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || isAbsolute(relativePath)) {
    throw new Error('Caminho de arquivo inválido ao verificar export existente.');
  }

  const stat = existingFileStat(filePath);
  if (!stat) return null;

  return {
    outputDir: directory,
    filename,
    filePath,
    bytes: stat.size,
    chatId,
  };
};

const VAULT_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.obsidian',
  '.trash',
  '.gemini-md-export-repair',
  'node_modules',
]);
const VAULT_SCAN_MAX_MARKDOWN_FILES = Math.max(
  1,
  Math.min(200_000, Number(process.env.GEMINI_MCP_VAULT_SCAN_MAX_MARKDOWN_FILES || 50_000)),
);
const FRONTMATTER_FIELD_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/gm;

const parseSimpleFrontmatterFields = (text) => {
  if (!String(text || '').startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  const frontmatter = text.slice(4, end);
  const fields = {};
  for (const match of frontmatter.matchAll(FRONTMATTER_FIELD_RE)) {
    fields[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return fields;
};

const chatIdFromText = (value) => {
  const text = String(value || '');
  const prefixed = text.match(/\bc_([a-f0-9]{12,})\b/i);
  if (prefixed) return prefixed[1].toLowerCase();
  const app = text.match(/\/app\/([a-f0-9]{12,})/i);
  if (app) return app[1].toLowerCase();
  const bare = text.match(/\b([a-f0-9]{12,})\b/i);
  return bare?.[1]?.toLowerCase() || '';
};

const looksLikeRawGeminiExport = (text, fields) =>
  fields.source === 'gemini-web' ||
  !!chatIdFromText(fields.chat_id) ||
  /^##\s+(?:🧑\s*)?(?:Usuário|Usuario)\b/im.test(text) ||
  /^##\s+(?:🤖\s*)?Gemini\b/im.test(text);

const walkVaultMarkdownFiles = (rootDir, out = []) => {
  if (out.length >= VAULT_SCAN_MAX_MARKDOWN_FILES) return out;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (VAULT_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
      walkVaultMarkdownFiles(resolve(rootDir, entry.name), out);
      if (out.length >= VAULT_SCAN_MAX_MARKDOWN_FILES) break;
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(resolve(rootDir, entry.name));
      if (out.length >= VAULT_SCAN_MAX_MARKDOWN_FILES) break;
    }
  }
  return out;
};

const scanDownloadedGeminiExportsInVault = (vaultDir) => {
  const rootDir = resolveOutputDir(vaultDir);
  const stat = statSync(rootDir);
  if (!stat.isDirectory()) {
    throw new Error(`O caminho do vault não é uma pasta: ${rootDir}`);
  }

  const chatIds = new Map();
  const markdownFiles = walkVaultMarkdownFiles(rootDir);
  let matchedFiles = 0;
  let truncated = markdownFiles.length >= VAULT_SCAN_MAX_MARKDOWN_FILES;

  for (const filePath of markdownFiles) {
    let text = '';
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fields = parseSimpleFrontmatterFields(text);
    if (!looksLikeRawGeminiExport(text, fields)) continue;
    matchedFiles += 1;

    const candidates = [
      { value: fields.chat_id, source: 'frontmatter.chat_id' },
      { value: fields.url, source: 'frontmatter.url' },
      { value: basename(filePath, '.md'), source: 'filename' },
    ];
    for (const candidate of candidates) {
      const chatId = chatIdFromText(candidate.value);
      if (!chatId) continue;
      if (!chatIds.has(chatId)) chatIds.set(chatId, []);
      chatIds.get(chatId).push({
        filePath,
        relativePath: relative(rootDir, filePath),
        source: candidate.source,
      });
    }
  }

  return {
    rootDir,
    markdownFilesScanned: markdownFiles.length,
    rawExportFilesMatched: matchedFiles,
    uniqueChatIds: chatIds.size,
    truncated,
    chatIds,
  };
};

const summarizeVaultScan = (scan) =>
  scan
    ? {
        rootDir: scan.rootDir,
        markdownFilesScanned: scan.markdownFilesScanned,
        rawExportFilesMatched: scan.rawExportFilesMatched,
        uniqueChatIds: scan.uniqueChatIds,
        truncated: scan.truncated,
      }
    : null;

const normalizeReportPath = (filePath) => {
  if (!filePath) return null;
  return resolveOutputDir(filePath);
};

const normalizeReportItemChatId = (item = {}) =>
  normalizeConversationChatId(item) ||
  chatIdFromText(item.chatId) ||
  chatIdFromText(item.url) ||
  chatIdFromText(item.filename) ||
  chatIdFromText(item.filePath) ||
  '';

const compactReportItems = (items, kind) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      const chatId = normalizeReportItemChatId(item);
      if (!chatId) return null;
      return {
        kind,
        index: item.index ?? null,
        chatId: chatId.toLowerCase(),
        title: item.title || null,
        filename: item.filename || null,
        filePath: item.filePath || null,
        relativePath: item.relativePath || null,
        bytes: item.bytes ?? null,
        reason: item.reason || kind,
        mediaFileCount: item.mediaFileCount ?? null,
        mediaFailureCount: item.mediaFailureCount ?? null,
        turns: item.turns ?? null,
        overwritten: item.overwritten ?? null,
        error: item.error || null,
      };
    })
    .filter(Boolean);

const loadRecentChatsResumeCheckpoint = (filePath) => {
  const reportFile = normalizeReportPath(filePath);
  if (!reportFile) return null;
  const report = readJsonFile(reportFile);
  if (report?.job?.type && report.job.type !== 'recent-chats-export') {
    throw new Error(`Relatório não é de exportação de histórico recente: ${reportFile}`);
  }

  const previousSuccesses = compactReportItems(report.successes, 'success');
  const previousSkipped = compactReportItems(report.skippedExisting, 'skipped');
  const previousFailures = compactReportItems(report.failures, 'failure');
  const completedChatIds = new Set();
  for (const item of [...previousSuccesses, ...previousSkipped]) {
    if (item.chatId) completedChatIds.add(item.chatId);
  }

  return {
    enabled: true,
    reportFile,
    reportFilename: basename(reportFile),
    previousJobId: report?.job?.jobId || null,
    previousStatus: report?.job?.status || null,
    previousUpdatedAt: report?.job?.updatedAt || null,
    previousFinishedAt: report?.job?.finishedAt || null,
    previousOutputDir: report?.outputDir || null,
    previousExistingScanDir: report?.existingScanDir || null,
    previousSuccesses,
    previousSkipped,
    previousFailures,
    completedChatIds,
    completedCount: completedChatIds.size,
    previousSuccessCount: previousSuccesses.length,
    previousSkippedCount: previousSkipped.length,
    previousFailureCount: previousFailures.length,
    previousCounters: {
      webConversationCount: report.webConversationCount ?? null,
      existingVaultCount: report.existingVaultCount ?? 0,
      missingCount: report.missingCount ?? null,
      reachedEnd: report.reachedEnd ?? null,
      truncated: report.truncated ?? null,
      fullHistoryVerified: report.job?.fullHistoryVerified ?? null,
    },
  };
};

const writeExportPayload = (payload, { outputDir } = {}) => {
  if (!payload?.content && !payload?.contentBase64) {
    throw new Error('A extensão não retornou conteúdo para salvar.');
  }

  const directory = resolveOutputDir(outputDir);
  const filename = safeFilename(payload.filename || `${payload.chatId || 'gemini-chat'}.md`);
  const filePath = resolve(directory, filename);
  const relativePath = relative(directory, filePath);
  if (relativePath.startsWith('..') || relativePath === '' || isAbsolute(relativePath)) {
    throw new Error('Caminho de arquivo inválido retornado pela extensão.');
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const existed = existsSync(filePath);
  const content = payload.contentBase64
    ? Buffer.from(payload.contentBase64, 'base64')
    : String(payload.content);
  writeFileSync(filePath, content, payload.contentBase64 ? undefined : 'utf-8');

  return {
    outputDir: directory,
    filename,
    filePath,
    bytes: Buffer.isBuffer(content)
      ? content.length
      : Buffer.byteLength(content, 'utf-8'),
    overwritten: existed,
  };
};

const writeExportPayloadBundle = (payload, { outputDir } = {}) => {
  const savedMarkdown = writeExportPayload(payload, { outputDir });
  const mediaFiles = Array.isArray(payload?.mediaFiles) ? payload.mediaFiles : [];
  const savedMediaFiles = mediaFiles.map((file) => writeExportPayload(file, { outputDir }));
  const mediaFailures = Array.isArray(payload?.mediaFailures) ? payload.mediaFailures : [];

  return {
    ...savedMarkdown,
    mediaFiles: savedMediaFiles,
    mediaFileCount: savedMediaFiles.length,
    mediaFailures,
    mediaFailureCount: mediaFailures.length,
  };
};

const timestampForFilename = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');

const writeExportReport = (kind, report, { outputDir } = {}) => {
  const directory = resolveOutputDir(outputDir);
  mkdirSync(directory, { recursive: true });
  const filename = `gemini-md-export-${kind}-${timestampForFilename()}-${randomUUID().slice(0, 8)}.json`;
  const filePath = resolve(directory, filename);
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return { reportFile: filePath, reportFilename: filename };
};

const overwriteExportReport = (filePath, report) => {
  if (!filePath) return;
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
};

const readJsonFile = (filePath) => JSON.parse(readFileSync(filePath, 'utf-8'));

const writeExportFiles = (payload = {}) => {
  const files = Array.isArray(payload.files)
    ? payload.files
    : payload.filename && payload.content
      ? [payload]
      : [];

  if (files.length === 0) {
    throw new Error('Nenhum arquivo recebido para salvar.');
  }
  if (files.length > 200) {
    throw new Error('Muitos arquivos em uma única requisição; limite atual: 200.');
  }

  return files.map((file) =>
    writeExportPayload(file, {
      outputDir: payload.outputDir,
    }),
  );
};

const isPrivateNetworkHostname = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
};

const bridgeAssetCache = new Map();
const bridgeAssetInFlight = new Map();

const rememberBridgeAsset = (key, value) => {
  if (BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES <= 0) return;
  if (bridgeAssetCache.has(key)) bridgeAssetCache.delete(key);
  bridgeAssetCache.set(key, {
    ...value,
    cachedAt: new Date().toISOString(),
  });
  while (bridgeAssetCache.size > BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES) {
    bridgeAssetCache.delete(bridgeAssetCache.keys().next().value);
  }
};

const fetchAssetForBridge = async (source) => {
  const url = new URL(String(source || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('URL de mídia inválida.');
  }
  if (isPrivateNetworkHostname(url.hostname)) {
    throw new Error('URL de mídia local/privada não permitida.');
  }

  const cacheKey = url.href;
  const cached = bridgeAssetCache.get(cacheKey);
  if (cached) {
    bridgeAssetCache.delete(cacheKey);
    bridgeAssetCache.set(cacheKey, cached);
    return {
      ...cached,
      cacheHit: true,
      inFlightDeduped: false,
    };
  }
  if (bridgeAssetInFlight.has(cacheKey)) {
    const result = await bridgeAssetInFlight.get(cacheKey);
    return {
      ...result,
      cacheHit: false,
      inFlightDeduped: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_ASSET_FETCH_TIMEOUT_MS);
  const fetchPromise = (async () => {
    const response = await fetch(url.href, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://gemini.google.com/',
        'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > BRIDGE_ASSET_FETCH_MAX_BYTES) {
      throw new Error(`Mídia muito grande (${contentLength} bytes).`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > BRIDGE_ASSET_FETCH_MAX_BYTES) {
      throw new Error(`Mídia muito grande (${buffer.length} bytes).`);
    }

    return {
      ok: true,
      source: url.href,
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      contentBase64: buffer.toString('base64'),
      bytes: buffer.length,
      cacheHit: false,
      inFlightDeduped: false,
    };
  })();

  bridgeAssetInFlight.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    rememberBridgeAsset(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timer);
    bridgeAssetInFlight.delete(cacheKey);
  }
};

const chooseExportDirectoryMac = async () => {
  const script =
    'POSIX path of (choose folder with prompt "Escolha a pasta para salvar os exports do Gemini")';

  return new Promise((resolvePromise, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: FOLDER_PICKER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const message = String(stderr || err.message || '').trim();
          // -128 é o código universal de cancelamento do AppleScript;
          // cobre qualquer locale (pt-BR: "Cancelado pelo usuário", en:
          // "User canceled", es: "Cancelado por el usuario" etc.). As
          // palavras-chave ficam como fallback para saídas atípicas.
          if (
            /-128\b|user canceled|cancelled|canceled|cancelado|annul|abgebrochen/i.test(
              message,
            )
          ) {
            resolvePromise({ cancelled: true });
            return;
          }
          reject(new Error(`Falha ao abrir seletor de pasta: ${message || err.message}`));
          return;
        }

        const selectedPath = String(stdout || '').trim();
        if (!selectedPath) {
          reject(new Error('O seletor nativo não retornou uma pasta.'));
          return;
        }

        const outputDir = resolveOutputDir(selectedPath);
        resolvePromise({ cancelled: false, outputDir });
      },
    );
  });
};

const chooseExportDirectoryWindows = async () => {
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class GeminiFolderPicker
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private static readonly Guid ShellItemGuid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        out IShellItem ppv);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    public static string Pick(IntPtr owner, string initialPath)
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST);
        dialog.SetTitle("Escolha a pasta para salvar os exports do Gemini");

        if (!String.IsNullOrWhiteSpace(initialPath))
        {
            try
            {
                IShellItem initialFolder;
                SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ShellItemGuid, out initialFolder);
                dialog.SetFolder(initialFolder);
            }
            catch
            {
            }
        }

        int hr = dialog.Show(owner);
        if (hr == unchecked((int)0x800704C7))
        {
            return "";
        }
        if (hr != 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }

        IShellItem result;
        dialog.GetResult(out result);
        IntPtr selectedPathPtr;
        result.GetDisplayName(SIGDN_FILESYSPATH, out selectedPathPtr);
        try
        {
            return Marshal.PtrToStringUni(selectedPathPtr);
        }
        finally
        {
            Marshal.FreeCoTaskMem(selectedPathPtr);
        }
    }
}
"@

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "Gemini Markdown Export"
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.StartPosition = "CenterScreen"
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0.01
$owner.Show()
$owner.Activate()
$owner.BringToFront()

try {
  $selected = [GeminiFolderPicker]::Pick($owner.Handle, $env:GEMINI_MCP_PICKER_INITIAL_DIR)
  if ($selected) {
    [Console]::Out.WriteLine($selected)
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}
`;
  const powershellPath = process.env.SystemRoot
    ? resolve(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';

  return new Promise((resolvePromise, reject) => {
    execFile(
      powershellPath,
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        timeout: FOLDER_PICKER_TIMEOUT_MS,
        windowsHide: false,
        env: {
          ...process.env,
          GEMINI_MCP_PICKER_INITIAL_DIR: resolveOutputDir(),
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const message = String(stderr || err.message || '').trim();
          reject(new Error(`Falha ao abrir seletor de pasta no Windows: ${message || err.message}`));
          return;
        }

        const selectedPath = String(stdout || '').trim();
        if (!selectedPath) {
          resolvePromise({ cancelled: true });
          return;
        }

        const outputDir = resolveOutputDir(selectedPath);
        resolvePromise({ cancelled: false, outputDir });
      },
    );
  });
};

const chooseExportDirectory = async () => {
  if (process.platform === 'darwin') return chooseExportDirectoryMac();
  if (process.platform === 'win32') return chooseExportDirectoryWindows();
  throw new Error('A escolha nativa de pasta via bridge está implementada apenas no macOS e Windows por enquanto.');
};

const resolveConversationRequest = (client, args = {}) => {
  const conversations = recentConversationsForClient(client);

  if (args.index !== undefined && args.index !== null) {
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error('index precisa ser um inteiro a partir de 1.');
    }
    const item = conversations[index - 1];
    if (!item) {
      throw new Error(`A conversa na posição ${index} não está carregada no sidebar.`);
    }
    return item;
  }

  const requestedChatId =
    stripGeminiPrefix(args.chatId) ||
    extractChatIdFromUrl(args.url) ||
    stripGeminiPrefix(args.id);

  if (requestedChatId) {
    const item = conversations.find((conversation) => {
      const chatId = stripGeminiPrefix(conversation.chatId);
      const id = stripGeminiPrefix(conversation.id);
      return chatId === requestedChatId || id === requestedChatId;
    });
    if (item) return item;

    return {
      id: requestedChatId,
      chatId: requestedChatId,
      title: requestedChatId,
      url: `https://gemini.google.com/app/${requestedChatId}`,
      current: false,
      source: 'direct-url',
    };
  }

  const current = conversations.find((conversation) => conversation.current);
  if (current) return current;

  if (client.page?.chatId) {
    return {
      id: client.page.chatId,
      chatId: client.page.chatId,
      title: client.page.title || client.page.chatId,
      url: client.page.url,
      current: true,
    };
  }

  throw new Error('Informe index ou chatId para escolher a conversa.');
};

const resolveNotebookConversationRequest = (client, args = {}) => {
  const conversations = notebookConversationsForClient(client);
  if (conversations.length === 0) {
    throw new Error('Nenhuma conversa de caderno está carregada nesta aba.');
  }

  if (args.index !== undefined && args.index !== null) {
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error('index precisa ser um inteiro a partir de 1.');
    }
    const item = conversations[index - 1];
    if (!item) {
      throw new Error(`A conversa de caderno na posição ${index} não está carregada.`);
    }
    return item;
  }

  const requestedChatId =
    stripGeminiPrefix(args.chatId) ||
    extractChatIdFromUrl(args.url) ||
    stripGeminiPrefix(args.id);

  if (requestedChatId) {
    const item = conversations.find((conversation) => {
      const chatId = stripGeminiPrefix(conversation.chatId);
      const id = stripGeminiPrefix(conversation.id);
      return chatId === requestedChatId || id === requestedChatId;
    });
    if (item) return item;
    throw new Error(`A conversa de caderno ${requestedChatId} não está carregada.`);
  }

  if (args.title) {
    const query = String(args.title).toLowerCase();
    const exact = conversations.find(
      (conversation) => String(conversation.title || '').toLowerCase() === query,
    );
    if (exact) return exact;
    const partial = conversations.find((conversation) =>
      String(conversation.title || '').toLowerCase().includes(query),
    );
    if (partial) return partial;
    throw new Error(`Nenhuma conversa de caderno encontrada para o título "${args.title}".`);
  }

  throw new Error('Informe index, chatId ou title para escolher a conversa do caderno.');
};

const downloadConversationItemForClient = async (client, conversation, args = {}) => {
  const result = await enqueueCommand(client.clientId, 'get-chat-by-id', {
    item: conversation,
    returnToOriginal: args.returnToOriginal !== false,
    notebookReturnMode: args.notebookReturnMode || null,
  });

  if (!result?.ok) {
    throw new Error(result?.error || 'Falha ao exportar conversa no browser.');
  }

  const expectedChatId = normalizeConversationChatId(conversation);
  const payloadChatId = stripGeminiPrefix(result.payload?.chatId || '');
  if (expectedChatId && payloadChatId && expectedChatId !== payloadChatId) {
    throw new Error(
      `Exportacao abortada: o browser retornou o chat ${payloadChatId}, mas o MCP pediu ${expectedChatId}. Nenhum arquivo foi salvo.`,
    );
  }
  if (expectedChatId && !payloadChatId) {
    throw new Error(
      `Exportacao abortada: a extensao nao retornou chatId para confirmar a conversa ${expectedChatId}. Nenhum arquivo foi salvo.`,
    );
  }

  const saved = writeExportPayloadBundle(result.payload, { outputDir: args.outputDir });
  return {
    client: summarizeClient(client),
    conversation: result.conversation || conversation,
    chatId: result.payload?.chatId || conversation.chatId || null,
    title: result.payload?.title || conversation.title || null,
    turns: Array.isArray(result.payload?.turns) ? result.payload.turns.length : null,
    hydration: result.payload?.hydration || null,
    returnedToOriginal: result.returnedToOriginal ?? null,
    returnError: result.returnError || null,
    ...saved,
  };
};

const downloadChatForClient = async (client, args = {}) => {
  const conversation = resolveConversationRequest(client, args);
  return downloadConversationItemForClient(client, conversation, args);
};

const refreshClientConversations = async (client, args = {}) => {
  const result = await enqueueCommand(client.clientId, 'list-conversations', {
    ensureSidebar: args.ensureSidebar !== false,
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'Falha ao atualizar lista de conversas no browser.');
  }
  if (Array.isArray(result.conversations)) {
    client.conversations = result.conversations;
  }
  if (result.snapshot) {
    client.lastSnapshot = result.snapshot;
  }
  return result;
};

const loadMoreRecentChatsForClient = async (client, requestedLimit, args = {}) => {
  let latestSnapshot = client.lastSnapshot || null;
  let reachedEnd = recentChatsReachedEndForClient(client);
  const initialCount = recentConversationsForClient(client).length;
  const plan = normalizeRecentChatsLoadMorePlan(initialCount, requestedLimit, {
    loadMoreRounds: args.loadMoreRounds,
    loadMoreAttempts: args.loadMoreAttempts,
    reachedEnd,
  });

  if (!plan.shouldLoadMore) {
    return {
      attempted: false,
      loadedAny: false,
      roundsCompleted: 0,
      reachedEnd,
      snapshot: latestSnapshot,
      conversations: recentConversationsForClient(client),
    };
  }

  let loadedAny = false;
  let timedOut = false;
  let roundsCompleted = 0;
  let previousCount = initialCount;

  for (let round = 0; round < plan.rounds; round += 1) {
    const browserTimeoutMs = Math.max(
      500,
      Number(args.loadMoreBrowserTimeoutMs || RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS),
    );
    const commandTimeoutMs = Math.max(
      browserTimeoutMs + 1500,
      Number(
        args.loadMoreCommandTimeoutMs ||
          args.loadMoreTimeoutMs ||
          RECENT_CHATS_LOAD_MORE_BUDGET_MS,
      ),
    );
    const result = await enqueueCommand(
      client.clientId,
      'load-more-conversations',
      {
        ensureSidebar: true,
        attempts: plan.attemptsPerRound,
        targetCount: plan.targetCount,
        fastMode: true,
        maxRounds: 4,
        timeoutMs: browserTimeoutMs,
      },
      { timeoutMs: commandTimeoutMs },
    );

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar mais conversas no browser.');
    }

    if (Array.isArray(result.conversations)) {
      client.conversations = result.conversations;
    }
    if (result.snapshot) {
      client.lastSnapshot = result.snapshot;
      latestSnapshot = result.snapshot;
    }

    reachedEnd = result.reachedEnd === true || recentChatsReachedEndForClient(client);
    const currentCount = recentConversationsForClient(client).length;
    roundsCompleted += 1;
    loadedAny = loadedAny || result.loadedAny === true || currentCount > previousCount;
    timedOut = timedOut || result.timedOut === true;

    if (currentCount >= plan.targetCount) break;
    if (reachedEnd) break;
    if (timedOut) break;
    if (currentCount <= previousCount && result.loadedAny !== true) break;

    previousCount = currentCount;
  }

  return {
    attempted: true,
    loadedAny,
    timedOut,
    roundsCompleted,
    reachedEnd,
    snapshot: latestSnapshot,
    conversations: recentConversationsForClient(client),
  };
};

const loadAllRecentChatsForClient = async (client, args = {}) => {
  let latestSnapshot = client.lastSnapshot || null;
  let reachedEnd =
    args.trustCachedReachedEnd === true ? recentChatsReachedEndForClient(client) : false;
  let loadedAny = false;
  let timedOut = false;
  let roundsCompleted = 0;
  let noGrowthRounds = 0;
  const loadTrace = [];
  let previousCount = recentConversationsForClient(client).length;
  const batchSize = Math.max(10, Math.min(200, Number(args.batchSize || 50)));
  let adaptiveBatchSize = batchSize;
  const adaptiveLoad = args.adaptiveLoad !== false;
  const maxRounds = Math.max(1, Math.min(500, Number(args.maxLoadMoreRounds || args.loadMoreRounds || 200)));
  const attempts = Math.max(1, Math.min(5, Number(args.loadMoreAttempts || 3)));
  const maxNoGrowthRounds = Math.max(1, Math.min(20, Number(args.maxNoGrowthRounds || 8)));
  const browserMaxRounds = Math.max(
    1,
    Math.min(20, Number(args.loadMoreBrowserRounds || args.browserMaxRounds || 12)),
  );
  const browserTimeoutMs = Math.max(
    500,
    Math.min(
      30_000,
      Number(
        args.loadMoreBrowserTimeoutMs ||
          args.loadMoreTimeoutMs ||
          RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS,
      ),
    ),
  );
  const commandTimeoutMs = Math.max(
    browserTimeoutMs + 1500,
    Number(args.loadMoreCommandTimeoutMs || args.loadMoreTimeoutMs || COMMAND_TIMEOUT_MS),
  );

  for (let round = 0; round < maxRounds && !reachedEnd; round += 1) {
    if (args.shouldStop?.()) break;

    const beforeCount = previousCount;
    const targetCount = previousCount + adaptiveBatchSize;
    const roundStartedAt = Date.now();
    const result = await enqueueCommand(
      client.clientId,
      'load-more-conversations',
      {
        ensureSidebar: true,
        attempts,
        targetCount,
        fastMode: true,
        untilEnd: args.untilEndInBrowser !== false,
        ignoreFailureCap: true,
        endFailureThreshold: maxNoGrowthRounds,
        resetReachedEnd: round === 0 && args.trustCachedReachedEnd !== true,
        maxRounds: browserMaxRounds,
        timeoutMs: browserTimeoutMs,
        includeConversations: true,
        includeModalConversations: false,
        includeSnapshot: false,
      },
      { timeoutMs: commandTimeoutMs },
    );

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar historico completo no browser.');
    }

    if (Array.isArray(result.conversations)) {
      client.conversations = result.conversations;
    }
    if (result.snapshot) {
      client.lastSnapshot = result.snapshot;
      latestSnapshot = result.snapshot;
    }

    const currentCount = Math.max(
      recentConversationsForClient(client).length,
      Number(result.afterCount || 0),
    );
    reachedEnd = result.reachedEnd === true || recentChatsReachedEndForClient(client);
    roundsCompleted += 1;
    timedOut = timedOut || result.timedOut === true;
    const grew = result.loadedAny === true || currentCount > previousCount;
    loadedAny = loadedAny || grew;
    const delta = Math.max(0, currentCount - beforeCount);
    const elapsedMs = Date.now() - roundStartedAt;

    if (grew) {
      noGrowthRounds = 0;
      previousCount = currentCount;
    } else {
      noGrowthRounds += 1;
    }

    loadTrace.push({
      round: round + 1,
      beforeCount,
      targetCount,
      afterCount: currentCount,
      batchSize: adaptiveBatchSize,
      adaptiveLoad,
      delta,
      loadedAny: result.loadedAny === true,
      grew,
      reachedEnd,
      timedOut: result.timedOut === true,
      noGrowthRounds,
      browserTimeoutMs,
      browserMaxRounds,
      commandTimeoutMs,
      attempts,
      elapsedMs,
      browserTrace: Array.isArray(result.loadTrace) ? result.loadTrace : [],
    });

    if (adaptiveLoad) {
      if (result.timedOut === true || !grew) {
        adaptiveBatchSize = Math.max(10, Math.floor(adaptiveBatchSize / 2));
      } else if (delta >= adaptiveBatchSize && elapsedMs < browserTimeoutMs * 0.65) {
        adaptiveBatchSize = Math.min(200, Math.ceil(adaptiveBatchSize * 1.5));
      }
    }

    if (!grew && noGrowthRounds >= maxNoGrowthRounds) break;
  }

  try {
    await refreshClientConversations(client, { ensureSidebar: false });
    latestSnapshot = client.lastSnapshot || latestSnapshot;
    reachedEnd = recentChatsReachedEndForClient(client);
  } catch {
    // Se a leitura final falhar, ainda preservamos o estado/cache já conhecido.
  }

  return {
    attempted: roundsCompleted > 0,
    loadedAny,
    timedOut,
    noGrowthRounds,
    roundsCompleted,
    loadTrace,
    reachedEnd,
    snapshot: latestSnapshot,
    conversations: recentConversationsForClient(client),
  };
};

const parseOptionalBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
};

const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout após ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const listRecentChatsForClient = async (client, args = {}) => {
  const limit = normalizeLimit(args.limit, 10, 100);
  const offset = normalizeOffset(args.offset);
  const targetCount = Math.min(MAX_RECENT_CHATS_LOAD_TARGET, offset + limit);
  let refresh = null;
  let loadMore = null;
  const refreshPlan = buildRecentChatsRefreshPlan(client, args, {
    maxAgeMs: RECENT_CHATS_CACHE_MAX_AGE_MS,
    requestedCount: targetCount,
  });
  if (refreshPlan.shouldRefresh) {
    try {
      const refreshPromise = refreshClientConversations(client, { ensureSidebar: true });
      refresh = refreshPlan.preferFastRefresh
        ? await withTimeout(refreshPromise, RECENT_CHATS_REFRESH_BUDGET_MS)
        : await refreshPromise;
    } catch (err) {
      refresh = {
        ok: false,
        error: err.message,
        timedOut: err.message.includes('Timeout após'),
      };
    }
  }
  if (recentConversationsForClient(client).length < targetCount) {
    try {
      const loadMorePromise = loadMoreRecentChatsForClient(client, targetCount, args);
      loadMore = await withTimeout(
        loadMorePromise,
        Math.max(1000, Number(args.loadMoreTimeoutMs || RECENT_CHATS_LOAD_MORE_BUDGET_MS)),
      );
    } catch (err) {
      loadMore = {
        attempted: true,
        loadedAny: false,
        roundsCompleted: 0,
        reachedEnd: recentChatsReachedEndForClient(client),
        snapshot: client.lastSnapshot || null,
        conversations: recentConversationsForClient(client),
        ok: false,
        error: err.message,
        timedOut:
          err.message.includes('Timeout após') ||
          err.code === 'command_timeout',
      };
    }
  }
  const conversations = recentConversationsForClient(client);
  const page = conversations.slice(offset, offset + limit);
  const reachedEnd = loadMore?.reachedEnd === true || recentChatsReachedEndForClient(client);
  const nextOffset = offset + page.length;
  return {
    client: summarizeClient(client),
    refreshAttempted: refreshPlan.shouldRefresh,
    refreshed: refresh?.ok === true,
    refreshTimedOut: refresh?.timedOut === true,
    refreshError: refresh?.ok === false ? refresh.error : null,
    loadMoreAttempted: loadMore?.attempted === true,
    loadMoreLoadedAny: loadMore?.loadedAny === true,
    loadMoreRoundsCompleted: loadMore?.roundsCompleted || 0,
    loadMoreReachedEnd: reachedEnd,
    loadMoreTimedOut: loadMore?.timedOut === true,
    loadMoreError: loadMore?.ok === false ? loadMore.error : null,
    snapshot: loadMore?.snapshot || refresh?.snapshot || client.lastSnapshot || null,
    pagination: {
      offset,
      limit,
      returned: page.length,
      loadedCount: conversations.length,
      maxLoadTarget: MAX_RECENT_CHATS_LOAD_TARGET,
      nextOffset: page.length > 0 ? nextOffset : null,
      hasMoreLoaded: nextOffset < conversations.length,
      reachedEnd,
      canLoadMore: !reachedEnd && conversations.length < MAX_RECENT_CHATS_LOAD_TARGET,
    },
    conversations: page,
  };
};

const summarizeExportJob = (job) => ({
  jobId: job.jobId,
  type: job.type,
  status: job.status,
  phase: job.phase,
  ...(job.type === 'recent-chats-export'
    ? recentChatsExportScope(job)
    : directChatsExportScope(job)),
  clientId: job.clientId,
  outputDir: job.outputDir,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  finishedAt: job.finishedAt || null,
  startIndex: job.startIndex ?? null,
  exportAll: job.exportAll ?? false,
  maxChats: job.maxChats ?? null,
  loadedCount: job.loadedCount ?? 0,
  inputCount: job.inputCount ?? (Array.isArray(job.items) ? job.items.length : null),
  requested: job.requested,
  completed: job.completed,
  successCount: job.successCount,
  failureCount: job.failureCount,
  skippedCount: job.skippedCount || 0,
  exportMissingOnly: job.exportMissingOnly === true,
  existingScanDir: job.existingScanDir || null,
  vaultScan: job.vaultScan || null,
  webConversationCount: job.webConversationCount ?? null,
  existingVaultCount: job.existingVaultCount ?? 0,
  missingCount: job.missingCount ?? null,
  reachedEnd: job.reachedEnd ?? null,
  truncated: job.truncated ?? false,
  cancelRequested: job.cancelRequested,
  cancelledAt: job.cancelledAt || null,
  current: job.current || null,
  reportFile: job.reportFile || null,
  reportFilename: job.reportFilename || null,
  resume: job.resume
    ? {
        enabled: true,
        reportFile: job.resume.reportFile,
        previousJobId: job.resume.previousJobId,
        previousStatus: job.resume.previousStatus,
        previousExistingScanDir: job.resume.previousExistingScanDir,
        previousSuccessCount: job.resume.previousSuccessCount,
        previousSkippedCount: job.resume.previousSkippedCount,
        previousFailureCount: job.resume.previousFailureCount,
        resumedCompletedCount: job.resumedCompletedCount || 0,
        remainingAfterResume: job.remainingAfterResume ?? null,
      }
    : { enabled: false },
  error: job.error || null,
  refreshError: job.refreshError || null,
  loadWarning: job.loadWarning || null,
  loadMoreRoundsCompleted: job.loadMoreRoundsCompleted || 0,
  loadMoreTimedOut: job.loadMoreTimedOut === true,
  loadMoreTrace: Array.isArray(job.loadMoreTrace) ? job.loadMoreTrace.slice(-20) : [],
  recentSuccesses: job.recentSuccesses.slice(-10),
  recentSkipped: Array.isArray(job.recentSkipped) ? job.recentSkipped.slice(-10) : [],
  failures: job.failures.slice(-20),
});

const touchExportJob = (job) => {
  job.updatedAt = new Date().toISOString();
};

const isTerminalExportJobStatus = (status) =>
  ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);

const findRunningBrowserExportJob = (clientId) =>
  Array.from(exportJobs.values()).find(
    (job) =>
      ['recent-chats-export', 'direct-chats-export'].includes(job.type) &&
      job.clientId === clientId &&
      !isTerminalExportJobStatus(job.status),
  );

const recentChatsExportScope = (job) => {
  const fullHistoryRequested = job.exportAll === true;
  const fullHistoryVerified =
    fullHistoryRequested && job.reachedEnd === true && job.truncated !== true;
  return {
    scope: fullHistoryRequested ? 'all-history' : 'partial',
    fullHistoryRequested,
    fullHistoryVerified,
    partialLimit: fullHistoryRequested ? null : job.maxChats,
  };
};

const directChatsExportScope = (job) => ({
  scope: 'explicit-chat-ids',
  fullHistoryRequested: false,
  fullHistoryVerified: false,
  partialLimit: job.requested || job.inputCount || null,
});

const setClientJobProgressAndNotify = (client, payload) => {
  setClientJobProgress(client, payload);
  if (payload) {
    sendClientEvent(client, 'jobProgress', payload);
  }
};

const buildRecentChatsExportReport = (job, client, successes, failures) => ({
  job: {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    phase: job.phase,
    ...recentChatsExportScope(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    cancelRequested: job.cancelRequested,
    cancelledAt: job.cancelledAt || null,
  },
  client: summarizeClient(client),
  outputDir: job.outputDir,
  startIndex: job.startIndex,
  exportAll: job.exportAll,
  maxChats: job.maxChats,
  loadedCount: job.loadedCount,
  requested: job.requested,
  completed: job.completed,
  successCount: successes.length,
  failureCount: failures.length,
  skippedCount: job.skippedCount || 0,
  skipExisting: job.skipExisting === true,
  exportMissingOnly: job.exportMissingOnly === true,
  existingScanDir: job.existingScanDir || null,
  vaultScan: job.vaultScan || null,
  webConversationCount: job.webConversationCount ?? null,
  existingVaultCount: job.existingVaultCount ?? 0,
  missingCount: job.missingCount ?? null,
  reachedEnd: job.reachedEnd,
  truncated: job.truncated,
  loadWarning: job.loadWarning || null,
  loadMoreRoundsCompleted: job.loadMoreRoundsCompleted || 0,
  loadMoreTimedOut: job.loadMoreTimedOut === true,
  loadMoreTrace: Array.isArray(job.loadMoreTrace) ? job.loadMoreTrace : [],
  current: job.current || null,
  successes,
  skippedExisting: Array.isArray(job.skippedExisting) ? job.skippedExisting : [],
  resume: job.resume
    ? {
        enabled: true,
        reportFile: job.resume.reportFile,
        reportFilename: job.resume.reportFilename,
        previousJobId: job.resume.previousJobId,
        previousStatus: job.resume.previousStatus,
        previousUpdatedAt: job.resume.previousUpdatedAt,
        previousFinishedAt: job.resume.previousFinishedAt,
        previousExistingScanDir: job.resume.previousExistingScanDir,
        previousSuccessCount: job.resume.previousSuccessCount,
        previousSkippedCount: job.resume.previousSkippedCount,
        previousFailureCount: job.resume.previousFailureCount,
        previousCounters: job.resume.previousCounters,
        completedChatIds: [...job.resume.completedChatIds],
        previousFailures: job.resume.previousFailures,
        resumedCompletedCount: job.resumedCompletedCount || 0,
        remainingAfterResume: job.remainingAfterResume ?? null,
      }
    : { enabled: false },
  failures,
});

const persistRecentChatsExportReport = (job, client, successes, failures) => {
  if (!job.reportFile) {
    const reportFile = writeExportReport(
      'recent-chats',
      buildRecentChatsExportReport(job, client, successes, failures),
      { outputDir: job.outputDir },
    );
    job.reportFile = reportFile.reportFile;
    job.reportFilename = reportFile.reportFilename;
    return;
  }
  overwriteExportReport(job.reportFile, buildRecentChatsExportReport(job, client, successes, failures));
};

const normalizeDirectReexportItems = (args = {}) => {
  const rawItems = [];
  if (Array.isArray(args.chatIds)) {
    for (const chatId of args.chatIds) rawItems.push({ chatId });
  }
  if (Array.isArray(args.items)) {
    for (const item of args.items) rawItems.push(item);
  }
  if (args.chatId) rawItems.push({ chatId: args.chatId, title: args.title });

  if (rawItems.length === 0) {
    throw new Error('Informe chatIds ou items para reexportar.');
  }
  if (rawItems.length > DIRECT_REEXPORT_MAX_ITEMS) {
    throw new Error(`Muitos chats em um job; limite atual: ${DIRECT_REEXPORT_MAX_ITEMS}.`);
  }

  const seen = new Set();
  const normalized = [];
  for (const raw of rawItems) {
    const item = typeof raw === 'string' ? { chatId: raw } : raw || {};
    const idLike = item.chatId || item.id || '';
    const chatId =
      extractChatIdFromUrl(item.url) ||
      extractChatIdFromUrl(idLike) ||
      stripGeminiPrefix(idLike);
    if (!/^[a-f0-9]{12,}$/i.test(chatId || '')) {
      throw new Error(`chatId inválido para reexportação: ${String(item.chatId || item.url || item.id || raw)}`);
    }

    const key = chatId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const title = String(item.title || item.label || chatId).slice(0, 240);
    normalized.push({
      id: key,
      chatId: key,
      title,
      url: `https://gemini.google.com/app/${key}`,
      current: false,
      source: 'direct-url',
      request: {
        title,
        sourcePath: item.sourcePath || item.path || null,
        originalIndex: normalized.length + 1,
      },
    });
  }

  if (normalized.length === 0) {
    throw new Error('Nenhum chatId único válido para reexportar.');
  }

  return normalized;
};

const buildDirectChatsExportReport = (job, client, successes, failures) => ({
  job: {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    phase: job.phase,
    ...directChatsExportScope(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    cancelRequested: job.cancelRequested,
    cancelledAt: job.cancelledAt || null,
  },
  client: summarizeClient(client),
  outputDir: job.outputDir,
  inputCount: job.inputCount,
  requested: job.requested,
  completed: job.completed,
  successCount: successes.length,
  failureCount: failures.length,
  delayMs: job.delayMs,
  current: job.current || null,
  items: job.items.map((item, index) => ({
    index: index + 1,
    chatId: item.chatId,
    title: item.title || null,
    sourcePath: item.request?.sourcePath || null,
    url: item.url,
  })),
  successes,
  failures,
});

const persistDirectChatsExportReport = (job, client, successes, failures) => {
  if (!job.reportFile) {
    const reportFile = writeExportReport(
      'direct-chats',
      buildDirectChatsExportReport(job, client, successes, failures),
      { outputDir: job.outputDir },
    );
    job.reportFile = reportFile.reportFile;
    job.reportFilename = reportFile.reportFilename;
    return;
  }
  overwriteExportReport(job.reportFile, buildDirectChatsExportReport(job, client, successes, failures));
};

const broadcastRecentChatsJobProgress = (job, client, patch = {}) => {
  if (!client) return;
  const total = patch.total ?? Math.max(job.requested || 0, job.completed || 0, 1);
  const current = patch.current ?? job.completed ?? 0;
  const errorCount = patch.errorCount ?? job.failureCount ?? 0;
  const status = patch.status ?? job.status ?? 'running';
  const phase = patch.phase ?? job.phase ?? null;
  let label = patch.label;
  if (!label) {
    if (status === 'cancelled') {
      label = 'Exportação cancelada.';
    } else if (status === 'completed') {
      label = 'Exportação concluída.';
    } else if (status === 'completed_with_errors') {
      label = `Exportação concluída com ${errorCount} erro${errorCount === 1 ? '' : 's'}.`;
    } else if (status === 'failed') {
      label = 'Exportação falhou.';
    } else if (phase === 'loading-history') {
      label = 'MCP carregando histórico do sidebar...';
    } else if (phase === 'scanning-vault') {
      label = 'MCP cruzando histórico do Gemini com o vault...';
    } else if (phase === 'exporting' && job.current?.skippedExisting) {
      const indexLabel = job.current.index ? ` (${job.current.index})` : '';
      label = `MCP pulando${indexLabel}: ${job.current.title || job.current.chatId}`;
    } else if (phase === 'exporting' && job.current?.title) {
      const indexLabel = job.current.index ? ` (${job.current.index})` : '';
      label = `MCP exportando${indexLabel}: ${job.current.title}`;
    } else if (phase === 'exporting') {
      label = 'MCP exportando conversas...';
    } else if (phase === 'writing-report') {
      label = 'MCP gravando relatório...';
    } else {
      label = 'MCP preparando exportação...';
    }
  }
  setClientJobProgressAndNotify(client, {
    source: 'mcp',
    kind: 'recent-chats-export',
    jobId: job.jobId,
    status,
    phase,
    total,
    current,
    errorCount,
    label,
    skippedCount: job.skippedCount || 0,
    title: job.current?.title || null,
    chatId: job.current?.chatId || null,
  });
};

const broadcastDirectChatsJobProgress = (job, client, patch = {}) => {
  if (!client) return;
  const total = patch.total ?? Math.max(job.requested || 0, job.completed || 0, 1);
  const current = patch.current ?? job.completed ?? 0;
  const errorCount = patch.errorCount ?? job.failureCount ?? 0;
  const status = patch.status ?? job.status ?? 'running';
  const phase = patch.phase ?? job.phase ?? null;
  let label = patch.label;
  if (!label) {
    if (status === 'cancelled') {
      label = 'Reexportação cancelada.';
    } else if (status === 'completed') {
      label = 'Reexportação concluída.';
    } else if (status === 'completed_with_errors') {
      label = `Reexportação concluída com ${errorCount} erro${errorCount === 1 ? '' : 's'}.`;
    } else if (status === 'failed') {
      label = 'Reexportação falhou.';
    } else if (phase === 'exporting' && job.current?.title) {
      label = `MCP reexportando (${job.current.index}/${total}): ${job.current.title}`;
    } else {
      label = 'MCP reexportando chats selecionados...';
    }
  }
  setClientJobProgressAndNotify(client, {
    source: 'mcp',
    kind: 'direct-chats-export',
    jobId: job.jobId,
    status,
    phase,
    total,
    current,
    errorCount,
    label,
    title: job.current?.title || null,
    chatId: job.current?.chatId || null,
  });
};

const runRecentChatsExportJob = async (job, client, args = {}) => {
  const successes = job.resume ? [...job.resume.previousSuccesses] : [];
  const failures = [];
  const resumedCompletedChatIds = job.resume?.completedChatIds || new Set();
  const resumedCompletedCount = resumedCompletedChatIds.size;
  job.successCount = successes.length;
  job.skippedCount = Array.isArray(job.skippedExisting) ? job.skippedExisting.length : 0;
  job.resumedCompletedCount = resumedCompletedCount;
  job.completed = resumedCompletedCount;
  try {
    job.phase = 'loading-history';
    touchExportJob(job);
    persistRecentChatsExportReport(job, client, successes, failures);
    broadcastRecentChatsJobProgress(job, client);

    if (job.exportAll) {
      const refreshPlan = buildRecentChatsRefreshPlan(client, args, {
        maxAgeMs: RECENT_CHATS_CACHE_MAX_AGE_MS,
      });
      if (refreshPlan.shouldRefresh) {
        try {
          const refreshPromise = refreshClientConversations(client, { ensureSidebar: true });
          const refresh = refreshPlan.preferFastRefresh
            ? await withTimeout(refreshPromise, RECENT_CHATS_REFRESH_BUDGET_MS)
            : await refreshPromise;
          if (refresh?.snapshot) {
            client.lastSnapshot = refresh.snapshot;
          }
        } catch (err) {
          job.refreshError = err.message;
        }
      }
      const loadMore = await loadAllRecentChatsForClient(client, {
        ...args,
        shouldStop: () => job.cancelRequested === true,
      });
      job.loadMoreRoundsCompleted = loadMore.roundsCompleted;
      job.loadMoreTimedOut = loadMore.timedOut === true;
      job.loadMoreTrace = Array.isArray(loadMore.loadTrace) ? loadMore.loadTrace : [];
    } else {
      const targetCount = Math.min(MAX_RECENT_CHATS_LOAD_TARGET, job.startIndex - 1 + job.maxChats);
      await listRecentChatsForClient(client, {
        ...args,
        limit: 1,
        offset: Math.max(0, targetCount - 1),
        refresh: args.refresh,
      });
    }

    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.phase = 'cancelled';
      return;
    }

    const conversations = recentConversationsForClient(client);
    job.loadedCount = conversations.length;
    job.reachedEnd = recentChatsReachedEndForClient(client);
    job.truncated = job.exportAll
      ? !job.reachedEnd
      : !job.reachedEnd && conversations.length >= MAX_RECENT_CHATS_LOAD_TARGET;
    if (job.exportAll && job.truncated) {
      job.loadWarning =
        'Nao consegui confirmar que cheguei ao fim do historico do Gemini. Exportei as conversas carregadas, mas o lote pode estar incompleto.';
    }

    const seen = new Set();
    const requestedSlice = job.exportAll
      ? conversations.slice(job.startIndex - 1)
      : conversations.slice(job.startIndex - 1, job.startIndex - 1 + job.maxChats);
    const loadedItems = requestedSlice
      .map((conversation, sliceIndex) => ({
        conversation,
        index: job.startIndex + sliceIndex,
      }))
      .filter(({ conversation }) => {
        const key =
          normalizeConversationChatId(conversation) ||
          stripGeminiPrefix(conversation.chatId || conversation.id) ||
          conversation.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    job.webConversationCount = loadedItems.length;
    let selected = loadedItems;

    if (job.exportMissingOnly) {
      job.phase = 'scanning-vault';
      touchExportJob(job);
      persistRecentChatsExportReport(job, client, successes, failures);
      broadcastRecentChatsJobProgress(job, client);

      const vaultScan = scanDownloadedGeminiExportsInVault(job.existingScanDir);
      job.vaultScan = summarizeVaultScan(vaultScan);

      const missing = [];
      const existingInVault = [];
      for (const item of loadedItems) {
        const chatId = normalizeConversationChatId(item.conversation).toLowerCase();
        if (chatId && vaultScan.chatIds.has(chatId)) {
          const evidence = vaultScan.chatIds.get(chatId)?.[0] || null;
          existingInVault.push({
            index: item.index,
            chatId,
            title: item.conversation.title || null,
            filePath: evidence?.filePath || null,
            relativePath: evidence?.relativePath || null,
            reason: 'existing-vault-export',
          });
          continue;
        }
        missing.push(item);
      }

      selected = missing;
      job.existingVaultCount = existingInVault.length;
      job.missingCount = missing.length;
      const alreadySkipped = new Set(
        job.skippedExisting.map((item) => normalizeReportItemChatId(item)).filter(Boolean),
      );
      for (const item of existingInVault) {
        if (item.chatId && alreadySkipped.has(item.chatId)) continue;
        job.skippedExisting.push(item);
        if (item.chatId) alreadySkipped.add(item.chatId);
      }
      job.recentSkipped = job.skippedExisting.slice(-10);
      job.skippedCount = job.skippedExisting.length;
    } else {
      job.missingCount = loadedItems.length;
    }

    if (resumedCompletedChatIds.size > 0) {
      selected = selected.filter((item) => {
        const chatId = normalizeConversationChatId(item.conversation).toLowerCase();
        return !chatId || !resumedCompletedChatIds.has(chatId);
      });
      job.remainingAfterResume = selected.length;
    }

    job.requested = resumedCompletedCount + selected.length;
    job.completed = resumedCompletedCount;
    if (selected.length === 0) {
      job.status =
        job.truncated || job.loadMoreTimedOut || job.vaultScan?.truncated
          ? 'completed_with_errors'
          : 'completed';
      job.phase = 'done';
      return;
    }

    job.phase = 'exporting';
    touchExportJob(job);
    persistRecentChatsExportReport(job, client, successes, failures);
    broadcastRecentChatsJobProgress(job, client);

    for (let i = 0; i < selected.length; i += 1) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.phase = 'cancelled';
        break;
      }

      const { conversation, index } = selected[i];
      job.current = {
        index,
        title: conversation.title || null,
        chatId: conversation.chatId || conversation.id || null,
      };
      touchExportJob(job);
      broadcastRecentChatsJobProgress(job, client);

      try {
        if (job.skipExisting) {
          const existing = existingMarkdownExportForConversation(conversation, {
            outputDir: job.outputDir,
          });
          if (existing) {
            const skipped = {
              index,
              chatId: existing.chatId,
              title: conversation.title || null,
              filename: existing.filename,
              filePath: existing.filePath,
              bytes: existing.bytes,
              reason: 'existing-file',
            };
            job.current = {
              ...job.current,
              chatId: existing.chatId,
              skippedExisting: true,
            };
            job.skippedExisting.push(skipped);
            job.recentSkipped.push(skipped);
            job.recentSkipped = job.recentSkipped.slice(-10);
            job.skippedCount = job.skippedExisting.length;
            continue;
          }
        }

        const result = await downloadConversationItemForClient(client, conversation, {
          ...args,
          outputDir: job.outputDir,
          returnToOriginal: false,
        });
        const success = {
          index,
          chatId: result.chatId,
          title: result.title,
          filename: result.filename,
          filePath: result.filePath,
          bytes: result.bytes,
          mediaFileCount: result.mediaFileCount || 0,
          mediaFailureCount: result.mediaFailureCount || 0,
          turns: result.turns,
          overwritten: result.overwritten,
        };
        successes.push(success);
        job.recentSuccesses.push(success);
        job.recentSuccesses = job.recentSuccesses.slice(-10);
        job.successCount = successes.length;
      } catch (err) {
        const failure = {
          index,
          chatId: conversation.chatId || conversation.id || null,
          title: conversation.title || null,
          error: err.message,
        };
        failures.push(failure);
        job.failures.push(failure);
        job.failures = job.failures.slice(-20);
        job.failureCount = failures.length;
      } finally {
        job.completed = resumedCompletedCount + i + 1;
        touchExportJob(job);
        persistRecentChatsExportReport(job, client, successes, failures);
        broadcastRecentChatsJobProgress(job, client);
      }
    }

    if (!job.cancelRequested) {
      job.phase = 'writing-report';
      touchExportJob(job);
      broadcastRecentChatsJobProgress(job, client);
      job.status =
        failures.length > 0 || job.truncated || job.loadMoreTimedOut || job.vaultScan?.truncated
          ? 'completed_with_errors'
          : 'completed';
      job.phase = 'done';
    }
  } catch (err) {
    job.status = 'failed';
    job.phase = 'failed';
    job.error = err.message;
    try {
      persistRecentChatsExportReport(job, client, successes, failures);
    } catch {
      // Se nem o relatório de falha puder ser gravado, o status em memória ainda explica o erro.
    }
  } finally {
    job.current = null;
    job.finishedAt = new Date().toISOString();
    touchExportJob(job);
    try {
      persistRecentChatsExportReport(job, client, successes, failures);
    } catch {
      // Status em memória permanece disponível mesmo se o relatório final falhar.
    }
    broadcastRecentChatsJobProgress(job, client);
  }
};

const startRecentChatsExportJob = (client, args = {}) => {
  const running = findRunningBrowserExportJob(client.clientId);
  if (running) {
    throw new Error(
      `Já existe um job de exportação em andamento para esta aba: ${running.jobId}. Consulte o status ou cancele antes de iniciar outro.`,
    );
  }

  const resumeReportFile = args.resumeReportFile || args.reportFile || null;
  const resume = resumeReportFile ? loadRecentChatsResumeCheckpoint(resumeReportFile) : null;
  const outputDir = resolveOutputDir(args.outputDir || resume?.previousOutputDir);
  const exportMissingOnly = args.exportMissingOnly === true;
  const existingScanDir =
    args.existingScanDir || args.vaultDir || (exportMissingOnly ? resume?.previousExistingScanDir : null);
  if (exportMissingOnly && !existingScanDir) {
    throw new Error('Informe vaultDir/existingScanDir ou resumeReportFile com existingScanDir para cruzar o histórico do Gemini com o vault.');
  }
  const hasExplicitMaxChats = args.maxChats !== undefined || args.limit !== undefined;
  const skipExisting =
    typeof args.skipExisting === 'boolean' ? args.skipExisting : !hasExplicitMaxChats;
  const job = {
    jobId: randomUUID(),
    type: 'recent-chats-export',
    status: 'running',
    phase: 'queued',
    clientId: client.clientId,
    outputDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    startIndex: normalizeLimit(args.startIndex, 1, 20000),
    exportAll: !hasExplicitMaxChats,
    maxChats: hasExplicitMaxChats
      ? normalizeLimit(args.maxChats ?? args.limit, MAX_RECENT_CHATS_LOAD_TARGET, MAX_RECENT_CHATS_LOAD_TARGET)
      : null,
    loadedCount: 0,
    requested: 0,
    completed: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    exportMissingOnly,
    existingScanDir: existingScanDir ? resolveOutputDir(existingScanDir) : null,
    vaultScan: null,
    webConversationCount: null,
    existingVaultCount: 0,
    missingCount: null,
    skipExisting,
    reachedEnd: false,
    truncated: false,
    cancelRequested: false,
    cancelledAt: null,
    current: null,
    reportFile: resume?.reportFile || null,
    reportFilename: resume?.reportFilename || null,
    resume,
    resumedCompletedCount: resume?.completedCount || 0,
    remainingAfterResume: null,
    error: null,
    refreshError: null,
    loadWarning: null,
    loadMoreRoundsCompleted: 0,
    loadMoreTimedOut: false,
    loadMoreTrace: [],
    recentSuccesses: resume?.previousSuccesses?.slice(-10) || [],
    recentSkipped: resume?.previousSkipped?.slice(-10) || [],
    skippedExisting: resume?.previousSkipped ? [...resume.previousSkipped] : [],
    failures: [],
  };
  exportJobs.set(job.jobId, job);
  void runRecentChatsExportJob(job, client, args);
  return summarizeExportJob(job);
};

const runDirectChatsExportJob = async (job, client, args = {}) => {
  const successes = [];
  const failures = [];
  try {
    job.phase = 'exporting';
    touchExportJob(job);
    persistDirectChatsExportReport(job, client, successes, failures);
    broadcastDirectChatsJobProgress(job, client);

    for (let i = 0; i < job.items.length; i += 1) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.phase = 'cancelled';
        break;
      }

      const conversation = job.items[i];
      const index = i + 1;
      job.current = {
        index,
        title: conversation.title || null,
        chatId: conversation.chatId,
        sourcePath: conversation.request?.sourcePath || null,
      };
      touchExportJob(job);
      broadcastDirectChatsJobProgress(job, client);

      try {
        const result = await downloadConversationItemForClient(client, conversation, {
          ...args,
          outputDir: job.outputDir,
          returnToOriginal: false,
        });
        const success = {
          index,
          chatId: result.chatId,
          title: result.title,
          filename: result.filename,
          filePath: result.filePath,
          bytes: result.bytes,
          mediaFileCount: result.mediaFileCount || 0,
          mediaFailureCount: result.mediaFailureCount || 0,
          turns: result.turns,
          overwritten: result.overwritten,
          sourcePath: conversation.request?.sourcePath || null,
        };
        successes.push(success);
        job.recentSuccesses.push(success);
        job.recentSuccesses = job.recentSuccesses.slice(-10);
        job.successCount = successes.length;
      } catch (err) {
        const failure = {
          index,
          chatId: conversation.chatId,
          title: conversation.title || null,
          sourcePath: conversation.request?.sourcePath || null,
          error: err.message,
        };
        failures.push(failure);
        job.failures.push(failure);
        job.failures = job.failures.slice(-20);
        job.failureCount = failures.length;
      } finally {
        job.completed = i + 1;
        touchExportJob(job);
        persistDirectChatsExportReport(job, client, successes, failures);
        broadcastDirectChatsJobProgress(job, client);
      }

      if (!job.cancelRequested && job.delayMs > 0 && i < job.items.length - 1) {
        await sleep(job.delayMs);
      }
    }

    if (!job.cancelRequested) {
      job.phase = 'writing-report';
      touchExportJob(job);
      broadcastDirectChatsJobProgress(job, client);
      job.status = failures.length > 0 ? 'completed_with_errors' : 'completed';
      job.phase = 'done';
    }
  } catch (err) {
    job.status = 'failed';
    job.phase = 'failed';
    job.error = err.message;
    try {
      persistDirectChatsExportReport(job, client, successes, failures);
    } catch {
      // O status em memória ainda mostra a falha se o relatório não puder ser gravado.
    }
  } finally {
    job.current = null;
    job.finishedAt = new Date().toISOString();
    touchExportJob(job);
    try {
      persistDirectChatsExportReport(job, client, successes, failures);
    } catch {
      // Status em memória permanece disponível mesmo se o relatório final falhar.
    }
    broadcastDirectChatsJobProgress(job, client);
  }
};

const startDirectChatsExportJob = (client, args = {}) => {
  const running = findRunningBrowserExportJob(client.clientId);
  if (running) {
    throw new Error(
      `Já existe um job de exportação em andamento para esta aba: ${running.jobId}. Consulte o status ou cancele antes de iniciar outro.`,
    );
  }

  const items = normalizeDirectReexportItems(args);
  const outputDir = resolveOutputDir(args.outputDir);
  const delayMs = Math.max(
    0,
    Math.min(30_000, Number(args.delayMs ?? DIRECT_REEXPORT_DELAY_MS)),
  );
  const job = {
    jobId: randomUUID(),
    type: 'direct-chats-export',
    status: 'running',
    phase: 'queued',
    clientId: client.clientId,
    outputDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    items,
    inputCount: items.length,
    requested: items.length,
    completed: 0,
    successCount: 0,
    failureCount: 0,
    cancelRequested: false,
    cancelledAt: null,
    current: null,
    reportFile: null,
    reportFilename: null,
    error: null,
    delayMs,
    recentSuccesses: [],
    failures: [],
  };
  exportJobs.set(job.jobId, job);
  void runDirectChatsExportJob(job, client, args);
  return summarizeExportJob(job);
};

const downloadNotebookChatForClient = async (client, args = {}) => {
  const conversation = resolveNotebookConversationRequest(client, args);
  return downloadConversationItemForClient(client, conversation, args);
};

const exportNotebookForClient = async (client, args = {}) => {
  const limit = args.limit ? normalizeLimit(args.limit, 100, 500) : null;
  const startIndex = Math.max(1, Number(args.startIndex || 1));
  const conversations = notebookConversationsForClient(client).slice(startIndex - 1);
  const selected = limit ? conversations.slice(0, limit) : conversations;
  if (selected.length === 0) {
    throw new Error('Nenhuma conversa de caderno carregada para exportar.');
  }

  const total = selected.length;
  const broadcast = (current, errorCount, label, status = 'running') => {
    setClientJobProgressAndNotify(client, {
      source: 'mcp',
      kind: 'notebook-export',
      status,
      total,
      current,
      errorCount,
      label,
    });
  };

  broadcast(0, 0, 'MCP exportando caderno...');

  const successes = [];
  const failures = [];
  try {
    for (let i = 0; i < selected.length; i += 1) {
      const conversation = selected[i];
      const indexLabel = startIndex + i;
      const titleLabel = conversation?.title ? `: ${conversation.title}` : '';
      broadcast(
        i,
        failures.length,
        `MCP exportando caderno (${indexLabel}/${total + startIndex - 1})${titleLabel}`,
      );
      try {
        const result = await downloadConversationItemForClient(client, conversation, {
          ...args,
          returnToOriginal: true,
          notebookReturnMode: 'direct',
        });
        successes.push({
          index: indexLabel,
          ...result,
        });
      } catch (err) {
        failures.push({
          index: indexLabel,
          conversation,
          error: err.message,
        });
      } finally {
        broadcast(
          i + 1,
          failures.length,
          `MCP caderno: ${i + 1}/${total} concluído(s)`,
        );
      }
    }
    broadcast(
      total,
      failures.length,
      failures.length > 0
        ? `Caderno exportado com ${failures.length} erro${failures.length === 1 ? '' : 's'}.`
        : 'Caderno exportado.',
      failures.length > 0 ? 'completed_with_errors' : 'completed',
    );
  } catch (err) {
    broadcast(
      Math.min(successes.length + failures.length, total),
      failures.length,
      `Falha ao exportar caderno: ${err.message}`,
      'failed',
    );
    throw err;
  }

  return {
    client: summarizeClient(client),
    notebookId: client.page?.notebookId || null,
    outputDir: resolveOutputDir(args.outputDir),
    requested: selected.length,
    successCount: successes.length,
    failureCount: failures.length,
    successes,
    failures,
  };
};

const reloadGeminiTabs = async (args = {}) => {
  const delayMs = Math.max(0, Math.min(10_000, Number(args.delayMs || 500)));
  const liveClients = getLiveClients();
  if (liveClients.length === 0) {
    return {
      ok: false,
      reloaded: 0,
      error: 'Nenhuma aba viva do Gemini conectada à extensão.',
    };
  }

  if (args.clientId) {
    const client = requireClient(args.clientId);
    const result = await enqueueCommand(client.clientId, 'reload-page', { delayMs });
    return {
      ok: !!result?.ok,
      mode: 'single-tab',
      requested: 1,
      reloaded: result?.ok ? 1 : 0,
      client: summarizeClient(client),
      result,
    };
  }

  const controller = liveClients[0];
  const result = await enqueueCommand(controller.clientId, 'reload-gemini-tabs', {
    reason: args.reason || 'mcp-command',
  });

  if (result?.ok) {
    return {
      ok: true,
      mode: 'extension-tabs-api',
      requested: liveClients.length,
      reloaded: result.reloaded ?? liveClients.length,
      controller: summarizeClient(controller),
      result,
    };
  }

  const settled = await Promise.allSettled(
    liveClients.map((client) =>
      enqueueCommand(client.clientId, 'reload-page', { delayMs }).then((itemResult) => ({
        client: summarizeClient(client),
        result: itemResult,
      })),
    ),
  );
  const successes = settled
    .filter((item) => item.status === 'fulfilled' && item.value?.result?.ok)
    .map((item) => item.value);
  const failures = settled
    .filter((item) => item.status === 'rejected' || !item.value?.result?.ok)
    .map((item) =>
      item.status === 'rejected'
        ? { error: item.reason?.message || String(item.reason) }
        : item.value,
    );

  return {
    ok: failures.length === 0,
    mode: 'per-client-fallback',
    requested: liveClients.length,
    reloaded: successes.length,
    controllerResult: result,
    successes,
    failures,
  };
};

const rawTools = [
  {
    name: 'gemini_browser_status',
    description:
      'Lista as abas do Gemini conectadas à extensão e acorda o navegador se nenhuma aba estiver conectada.',
    inputSchema: {
      type: 'object',
      properties: {
        wakeBrowser: {
          type: 'boolean',
          description:
            'Quando true ou omitido, tenta abrir Chrome/Edge/Brave/Dia se nenhuma aba Gemini estiver conectada.',
        },
        waitMs: {
          type: 'number',
          description: 'Tempo máximo para aguardar a extensão conectar após abrir o navegador.',
        },
        initialWaitMs: {
          type: 'number',
          description:
            'Tempo para aguardar uma aba Gemini já aberta reconectar antes de tentar abrir o navegador.',
        },
        selfHeal: {
          type: 'boolean',
          description:
            'Quando true ou omitido, tenta validar versão/protocolo/build e pedir reload automático da extensão se ela estiver stale.',
        },
        allowReload: {
          type: 'boolean',
          description:
            'Quando true ou omitido, permite que o status peça reload automático da extensão Chrome se detectar versão/build antigos.',
        },
        reloadWaitMs: {
          type: 'number',
          description:
            'Tempo máximo para aguardar a extensão reconectar depois de um reload automático.',
        },
        diagnostics: {
          type: 'boolean',
          description:
            'Quando true, destaca latência, transportes e saúde da bridge MCP/Chrome por aba.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      cleanupStaleClients();
      let launchResult = null;
      let waitedMs = 0;
      const wakeBrowser = args.wakeBrowser !== false;
      const selfHealEnabled = args.selfHeal !== false;
      let selfHeal = {
        attempted: false,
        reason: selfHealEnabled ? 'not-needed' : 'disabled',
      };

      if (selfHealEnabled) {
        try {
          const ready = await ensureBrowserExtensionReady(
            {
              clientId: args.clientId || null,
            },
            {
              allowLaunchChrome: wakeBrowser,
              allowReload: args.allowReload !== false,
              config: {
                initialConnectTimeoutMs: normalizeWaitMs(
                  args.initialWaitMs,
                  BROWSER_STATUS_INITIAL_WAIT_MS,
                ),
                reloadTimeoutMs: normalizeReloadWaitMs(
                  args.reloadWaitMs,
                  CHROME_GUARD_CONFIG.reloadTimeoutMs,
                ),
              },
            },
          );
          selfHeal = {
            attempted: true,
            ok: true,
            reloadAttempts: ready.reloadAttempts || 0,
            launchedChrome: ready.launchedChrome === true,
            client: summarizeClient(ready.client),
            info: ready.info || null,
          };
        } catch (err) {
          selfHeal = {
            attempted: true,
            ok: false,
            error: err.message,
            code: err.code || null,
            data: err.data || null,
          };
        }
      }

      cleanupStaleClients();
      let liveClients = getLiveClients();

      if (wakeBrowser && liveClients.length === 0 && CHROME_GUARD_CONFIG.launchIfClosed) {
        liveClients = await waitForLiveClients(
          normalizeWaitMs(args.initialWaitMs, BROWSER_STATUS_INITIAL_WAIT_MS),
          CHROME_GUARD_CONFIG.pollIntervalMs || 500,
        );
      }

      if (wakeBrowser && liveClients.length === 0 && CHROME_GUARD_CONFIG.launchIfClosed) {
        launchResult = await launchChromeForGemini({
          profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
        });
        const waitMs = normalizeWaitMs(args.waitMs, BROWSER_STATUS_WAKE_WAIT_MS);
        const startedAt = Date.now();
        liveClients = await waitForLiveClients(waitMs, CHROME_GUARD_CONFIG.pollIntervalMs || 500);
        waitedMs = Date.now() - startedAt;
      }

      const matchingClients = liveClients.filter(clientMatchesExpectedBrowserExtension);
      const summarizedClients = liveClients.map(summarizeClient);
      return toolTextResult({
        ready: matchingClients.length > 0,
        blockingIssue:
          liveClients.length === 0
            ? 'no_connected_clients'
            : matchingClients.length === 0
              ? 'extension_version_mismatch'
              : null,
        expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
        matchingClientCount: matchingClients.length,
        connectedClients: summarizedClients,
        bridgeHealth: summarizedClients.map((client) => ({
          clientId: client.clientId,
          tabId: client.tabId,
          ...client.bridgeHealth,
        })),
        selfHeal,
        browserWake: launchResult
          ? {
              ...launchResult,
              waitedMs,
              connectedAfterWake: liveClients.length,
            }
          : {
              attempted: false,
              reason:
                liveClients.length > 0
                  ? 'already-connected'
                  : wakeBrowser
                    ? 'launch-disabled'
                    : 'wake-disabled',
            },
      });
    },
  },
  {
    name: 'gemini_mcp_diagnose_processes',
    description:
      'Diagnostica processos MCP/exporter locais, dono da porta do bridge, versão/protocolo do primário e se há alvo seguro para cleanup.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    call: async () => toolTextResult(await buildProcessDiagnostics()),
  },
  {
    name: 'gemini_mcp_cleanup_stale_processes',
    description:
      'Encerra somente processo primário antigo/travado reconhecido como gemini-md-export. Por segurança, exige confirm=true; sem isso faz dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description:
            'Obrigatório true para encerrar processos. Sem confirm=true, a tool retorna apenas wouldTerminate.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Quando true, nunca encerra processos. Default: true se confirm não for true.',
        },
        force: {
          type: 'boolean',
          description:
            'Quando true, usa SIGKILL no macOS/Linux ou taskkill /F no Windows. Default: false.',
        },
        waitMs: {
          type: 'integer',
          minimum: 100,
          maximum: 30000,
          description: 'Tempo para aguardar o processo sair após o sinal. Default: 4000.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const result = await cleanupStaleMcpProcesses(args);
      return toolTextResult(result, { isError: args.confirm === true && !result.ok });
    },
  },
  {
    name: 'gemini_get_export_dir',
    description: 'Retorna o diretório local padrão usado pelo MCP para salvar exports.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    call: async () =>
      toolTextResult({
        outputDir: resolveOutputDir(),
        defaultExportDir: DEFAULT_EXPORT_DIR,
      }),
  },
  {
    name: 'gemini_set_export_dir',
    description:
      'Define o diretório local padrão do MCP para salvar exports nesta sessão do servidor.',
    inputSchema: {
      type: 'object',
      properties: {
        outputDir: {
          type: 'string',
          description: 'Diretório local. Aceita ~. Se omitido com reset=true, volta ao default.',
        },
        reset: {
          type: 'boolean',
          description: 'Volta para ~/Downloads ou GEMINI_MCP_EXPORT_DIR.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      configuredExportDir = args.reset ? DEFAULT_EXPORT_DIR : resolveOutputDir(args.outputDir);
      mkdirSync(configuredExportDir, { recursive: true });
      return toolTextResult({
        outputDir: configuredExportDir,
        reset: !!args.reset,
      });
    },
  },
  {
    name: 'gemini_list_recent_chats',
    description:
      'Retorna uma página das conversas visíveis/carregáveis no sidebar do Gemini. Sem clientId, usa a aba viva com mais histórico já carregado.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Tamanho da página. Para centenas de conversas, use 25-50 e avance pelo offset.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 999,
          description:
            'Quantidade de conversas a pular antes de retornar a página. Use 0, 50, 100... para paginar.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Se true, força atualizar o sidebar antes de responder. Se false, usa o cache atual mesmo que esteja velho.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireRecentChatsClient(args.clientId);
      return toolTextResult(await listRecentChatsForClient(client, args));
    },
  },
  {
    name: 'gemini_list_notebook_chats',
    description:
      'Retorna as conversas carregadas no caderno Gemini Notebook da aba conectada.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireNotebookClient(args.clientId);
      const limit = normalizeLimit(args.limit, 100, 500);
      const conversations = notebookConversationsForClient(client)
        .slice(0, limit)
        .map(enrichNotebookConversation);
      return toolTextResult({
        client: summarizeClient(client),
        notebookId: client.page?.notebookId || null,
        conversations,
      });
    },
  },
  {
    name: 'gemini_get_current_chat',
    description:
      'Solicita à aba ativa do Gemini o conteúdo completo da conversa atual em Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'get-current-chat');
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      });
    },
  },
  {
    name: 'gemini_download_chat',
    description:
      'Exporta uma conversa do Gemini visível no sidebar e salva o Markdown em disco. Use index para posição 1-based da lista recente ou chatId para um chat específico.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        index: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Posição 1-based na lista retornada por gemini_list_recent_chats.',
        },
        chatId: {
          type: 'string',
          description: 'Chat ID hex da URL do Gemini. Precisa estar visível no sidebar carregado.',
        },
        outputDir: {
          type: 'string',
          description: 'Diretório local de destino. Default: ~/Downloads ou GEMINI_MCP_EXPORT_DIR.',
        },
        returnToOriginal: {
          type: 'boolean',
          description: 'Volta para a conversa original depois de exportar. Default: true.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      const result = await downloadChatForClient(client, args);
      return toolTextResult(result);
    },
  },
  {
    name: 'gemini_download_notebook_chat',
    description:
      'Exporta uma conversa carregada no caderno Gemini Notebook por index, chatId ou título.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        index: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Posição 1-based na lista retornada por gemini_list_notebook_chats.',
        },
        chatId: { type: 'string' },
        title: { type: 'string' },
        outputDir: {
          type: 'string',
          description: 'Diretório local de destino. Default: diretório MCP configurado.',
        },
        returnToOriginal: {
          type: 'boolean',
          description: 'Volta para o caderno depois de exportar. Default: true.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireNotebookClient(args.clientId);
      const result = await downloadNotebookChatForClient(client, args);
      return toolTextResult(result);
    },
  },
  {
    name: 'gemini_export_recent_chats',
    description:
      'Inicia um job em background para exportar o historico recente carregavel do sidebar do Gemini em arquivos Markdown, sem listar centenas de conversas na resposta.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        outputDir: {
          type: 'string',
          description: 'Diretório local de destino. Default: diretório MCP configurado.',
        },
        resumeReportFile: {
          type: 'string',
          description:
            'Relatório JSON de gemini-md-export-recent-chats anterior. O job continua no mesmo relatório e pula chats já concluídos.',
        },
        reportFile: {
          type: 'string',
          description: 'Alias de resumeReportFile.',
        },
        startIndex: {
          type: 'integer',
          minimum: 1,
          description: 'Primeira posição 1-based do sidebar a exportar. Default: 1.',
        },
        maxChats: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description:
            'Quantidade máxima de conversas a exportar. Se omitido, exporta até o fim carregável do sidebar.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Alias de maxChats para compatibilidade.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Se true, força atualizar o sidebar antes de carregar o histórico. Default segue a política de cache.',
        },
        skipExisting: {
          type: 'boolean',
          description:
            'Se true, pula arquivos <chatId>.md não vazios que já existem no destino. Default: true quando maxChats/limit é omitido; false em export parcial.',
        },
        batchSize: {
          type: 'integer',
          minimum: 10,
          maximum: 200,
          description:
            'Diagnóstico: quantidade alvo de novas conversas por rodada de carregamento. Default: 50.',
        },
        adaptiveLoad: {
          type: 'boolean',
          description:
            'Quando true ou omitido, ajusta batchSize durante o lazy-load conforme o Gemini responde.',
        },
        maxLoadMoreRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description:
            'Diagnóstico: máximo de rodadas para puxar histórico completo. Default: 200.',
        },
        loadMoreAttempts: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description:
            'Diagnóstico: tentativas de scroll por rodada. Default: 3.',
        },
        maxNoGrowthRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            'Diagnóstico: rodadas consecutivas sem crescimento antes de parar. Default: 8.',
        },
        loadMoreBrowserRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            'Diagnóstico: máximo de ciclos de scroll dentro da aba por rodada MCP. Default: 12.',
        },
        loadMoreBrowserTimeoutMs: {
          type: 'integer',
          minimum: 500,
          maximum: 30000,
          description:
            'Diagnóstico: tempo máximo dentro da aba para cada rodada de lazy-load. Default: 12000.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      return toolTextResult(startRecentChatsExportJob(client, args));
    },
  },
  {
    name: 'gemini_export_missing_chats',
    description:
      'Inicia um job em background que carrega todo o histórico recente do Gemini web, cruza os chatIds com exports raw já presentes no vault, e baixa apenas as conversas faltantes.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        vaultDir: {
          type: 'string',
          description:
            'Pasta do vault/folder a escanear recursivamente por Markdown raw exportado do Gemini. Obrigatório.',
        },
        outputDir: {
          type: 'string',
          description:
            'Diretório local onde salvar os chats faltantes. Default: vaultDir, para manter Markdown e assets dentro do vault.',
        },
        resumeReportFile: {
          type: 'string',
          description:
            'Relatório JSON anterior. Permite retomar e reaproveitar existingScanDir/outputDir gravados no relatório.',
        },
        reportFile: {
          type: 'string',
          description: 'Alias de resumeReportFile.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Se true, força atualizar o sidebar antes de carregar o histórico. Default segue a política de cache.',
        },
        batchSize: {
          type: 'integer',
          minimum: 10,
          maximum: 200,
          description:
            'Diagnóstico: quantidade alvo de novas conversas por rodada de carregamento. Default: 50.',
        },
        adaptiveLoad: {
          type: 'boolean',
          description:
            'Quando true ou omitido, ajusta batchSize durante o lazy-load conforme o Gemini responde.',
        },
        maxLoadMoreRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description:
            'Diagnóstico: máximo de rodadas para puxar histórico completo. Default: 200.',
        },
        loadMoreAttempts: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description:
            'Diagnóstico: tentativas de scroll por rodada. Default: 3.',
        },
        maxNoGrowthRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            'Diagnóstico: rodadas consecutivas sem crescimento antes de parar. Default: 8.',
        },
        loadMoreBrowserRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            'Diagnóstico: máximo de ciclos de scroll dentro da aba por rodada MCP. Default: 12.',
        },
        loadMoreBrowserTimeoutMs: {
          type: 'integer',
          minimum: 500,
          maximum: 30000,
          description:
            'Diagnóstico: tempo máximo dentro da aba para cada rodada de lazy-load. Default: 12000.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      return toolTextResult(
        startRecentChatsExportJob(client, {
          ...args,
          outputDir: args.outputDir || args.vaultDir,
          existingScanDir: args.vaultDir,
          exportMissingOnly: true,
          skipExisting: true,
        }),
      );
    },
  },
  {
    name: 'gemini_reexport_chats',
    description:
      'Inicia um job em background para reexportar uma lista explicita de chatIds do Gemini, salvando Markdown em disco e relatorio incremental sem bloquear o agente em dezenas de downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        outputDir: {
          type: 'string',
          description: 'Diretório local de destino. Default: diretório MCP configurado.',
        },
        chatId: {
          type: 'string',
          description: 'Atalho para reexportar um único chatId.',
        },
        chatIds: {
          type: 'array',
          maxItems: 500,
          items: { type: 'string' },
          description: 'Lista de chatIds hex ou URLs /app/<chatId> para reexportar.',
        },
        items: {
          type: 'array',
          maxItems: 500,
          items: {
            type: 'object',
            properties: {
              chatId: { type: 'string' },
              url: { type: 'string' },
              id: { type: 'string' },
              title: { type: 'string' },
              label: { type: 'string' },
              sourcePath: { type: 'string' },
              path: { type: 'string' },
            },
            additionalProperties: false,
          },
          description:
            'Itens com chatId/url e metadados opcionais para rastrear a nota original no relatório.',
        },
        delayMs: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          description:
            'Pausa entre chats para dar fôlego ao navegador. Default: 750ms no Windows, 250ms nos demais.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      return toolTextResult(startDirectChatsExportJob(client, args));
    },
  },
  {
    name: 'gemini_export_job_status',
    description:
      'Consulta o andamento de um job de exportacao em lote iniciado por gemini_export_recent_chats, gemini_export_missing_chats ou gemini_reexport_chats.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'ID retornado por gemini_export_recent_chats, gemini_export_missing_chats ou gemini_reexport_chats.',
        },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const job = exportJobs.get(args.jobId);
      if (!job) {
        return toolTextResult({ error: `Job não encontrado: ${args.jobId}` }, { isError: true });
      }
      return toolTextResult(summarizeExportJob(job), {
        isError: job.status === 'failed',
      });
    },
  },
  {
    name: 'gemini_export_job_cancel',
    description:
      'Solicita cancelamento de um job de exportacao/reexportacao em lote. O job para antes da proxima conversa, preservando arquivos e relatório já gravados.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'ID retornado por gemini_export_recent_chats, gemini_export_missing_chats ou gemini_reexport_chats.',
        },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const job = exportJobs.get(args.jobId);
      if (!job) {
        return toolTextResult({ error: `Job não encontrado: ${args.jobId}` }, { isError: true });
      }
      if (!isTerminalExportJobStatus(job.status)) {
        job.cancelRequested = true;
        job.cancelledAt = new Date().toISOString();
        job.status = 'cancel_requested';
        touchExportJob(job);
      }
      return toolTextResult(summarizeExportJob(job));
    },
  },
  {
    name: 'gemini_export_notebook',
    description:
      'Exporta em lote todas as conversas carregadas no caderno Gemini Notebook da aba conectada.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        outputDir: {
          type: 'string',
          description: 'Diretório local de destino. Default: diretório MCP configurado.',
        },
        startIndex: {
          type: 'integer',
          minimum: 1,
          description: 'Primeira posição 1-based a exportar. Default: 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Quantidade máxima de conversas carregadas a exportar.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireNotebookClient(args.clientId);
      const result = await exportNotebookForClient(client, args);
      return toolTextResult(result, { isError: result.failureCount > 0 });
    },
  },
  {
    name: 'gemini_cache_status',
    description:
      'Inspeciona o cache aprendido pela extensão para mapear conversas de caderno a URLs /app/<chatId>.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'cache-status');
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      });
    },
  },
  {
    name: 'gemini_clear_cache',
    description:
      'Limpa o cache aprendido de conversas de caderno na extensão conectada.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        notebookId: {
          type: 'string',
          description: 'Opcional: limpa apenas entradas deste caderno.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'clear-cache', {
        notebookId: args.notebookId || null,
      });
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      });
    },
  },
  {
    name: 'gemini_open_chat',
    description:
      'Navega a aba conectada para uma conversa por chatId/url ou por index/título quando a lista atual for sidebar ou caderno.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        index: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Posição 1-based na lista atual da aba.',
        },
        chatId: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        notebook: {
          type: 'boolean',
          description: 'Quando true, escolhe automaticamente uma aba de caderno.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = args.notebook ? requireNotebookClient(args.clientId) : requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'open-chat', args);
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      }, { isError: !result?.ok });
    },
  },
  {
    name: 'gemini_reload_gemini_tabs',
    description:
      'Recarrega abas abertas do Gemini conectadas à extensão. Útil como comando manual; após reload do card da extensão, o service worker já tenta fazer isso automaticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'Opcional: recarrega apenas uma aba específica. Sem isso, tenta recarregar todas as abas Gemini.',
        },
        delayMs: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          description: 'Atraso antes do reload no fallback por aba. Default: 500.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const result = await reloadGeminiTabs(args);
      return toolTextResult(result, { isError: !result.ok });
    },
  },
  {
    name: 'gemini_snapshot',
    description:
      'Pede para a aba conectada retornar um snapshot de debug do estado atual do Gemini.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'snapshot');
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      });
    },
  },
];

const BROWSER_DEPENDENT_TOOL_NAMES = new Set([
  'gemini_list_recent_chats',
  'gemini_list_notebook_chats',
  'gemini_get_current_chat',
  'gemini_download_chat',
  'gemini_download_notebook_chat',
  'gemini_export_recent_chats',
  'gemini_export_missing_chats',
  'gemini_reexport_chats',
  'gemini_export_notebook',
  'gemini_cache_status',
  'gemini_clear_cache',
  'gemini_open_chat',
  'gemini_reload_gemini_tabs',
  'gemini_snapshot',
]);

const LOCAL_PROXY_TOOL_NAMES = new Set([
  'gemini_mcp_diagnose_processes',
  'gemini_mcp_cleanup_stale_processes',
]);

const withChromeExtensionGuard = (tool) => ({
  ...tool,
  call: async (args = {}) => {
    await ensureBrowserExtensionReady(args);
    return tool.call(args);
  },
});

const tools = rawTools.map((tool) =>
  BROWSER_DEPENDENT_TOOL_NAMES.has(tool.name) ? withChromeExtensionGuard(tool) : tool,
);

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

const executeToolCall = async (name, args = {}) => {
  const tool = toolByName.get(name);

  if (!tool) {
    return toolTextResult({ error: `Tool desconhecida: ${name}` }, { isError: true });
  }

  try {
    return await tool.call(args);
  } catch (err) {
    return toolTextResult(
      {
        error: err.message,
        code: err.code || null,
        data: err.data || null,
      },
      { isError: true },
    );
  }
};

const proxyToolCallToPrimary = async (name, args = {}) => {
  const health = await primaryBridgeHealth();
  const portOwner = await diagnoseBridgePortOwner();
  const mismatch = primaryBridgeMismatch(health, portOwner);
  if (mismatch) {
    const error = new Error(primaryBridgeMismatchMessage(mismatch));
    error.code = 'primary_bridge_version_mismatch';
    error.data = {
      bridgeRole,
      currentMcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      primaryBridge: health.payload || null,
      portOwner,
      mismatch,
    };
    throw error;
  }

  const response = await fetch(`${primaryBridgeBaseUrl()}/agent/mcp-tool-call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: args }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // HTTP/proxy errors can be plain text when the primary is old or unhealthy.
  }

  if (!response.ok || !payload?.result) {
    const detail = payload?.error || text || `HTTP ${response.status}`;
    throw new Error(
      `Outra instância do gemini-md-export já está rodando, mas não consegui encaminhar esta tool para ela (${detail}). Feche as abas antigas do Gemini CLI e abra de novo depois de atualizar a extensão.`,
    );
  }

  return payload.result;
};

const proxyBrowserStatus = async () => {
  const health = await primaryBridgeHealth();
  const clients = await primaryBridgeClients();
  const portOwner = await diagnoseBridgePortOwner();
  const mismatch = primaryBridgeMismatch(health, portOwner);
  const primaryProcess = processFromHealthAndOwner(health, portOwner);
  const proxyState = proxyStateFromMismatch(mismatch);

  return toolTextResult(
    {
      mcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        bridgeRole,
        proxyingToPrimary: !mismatch,
        proxyState,
        process: summarizeProcess(),
      },
      primaryBridge: {
        ok: health.ok,
        status: health.status,
        health: health.payload || null,
        error: health.error || null,
        process: primaryProcess,
        portOwner,
      },
      expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
      connectedClients: Array.isArray(clients.payload?.connectedClients)
        ? clients.payload.connectedClients
        : [],
      browserWake: {
        attempted: false,
        reason: mismatch ? proxyState : 'proxy-mode',
      },
      problem: mismatch
        ? {
            code: 'primary_bridge_version_mismatch',
            message: primaryBridgeMismatchMessage(mismatch),
            mismatch,
            portOwner,
          }
        : null,
      installCheck:
        mismatch?.kind === 'unreachable'
          ? 'Se o healthz tambem falhar, confirme que a extensao gemini-md-export aparece em `gemini extensions list` e reinicie o Gemini CLI.'
          : null,
    },
    { isError: !!mismatch },
  );
};

const bridgeServer = createServer(async (req, res) => {
  cleanupStaleClients();

  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'missing request metadata' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') {
    if (url.pathname === '/bridge/pick-directory' || url.pathname === '/bridge/save-files') {
      if (!isAllowedBridgeOrigin(req.headers.origin)) {
        sendBridgeJson(req, res, 403, { error: 'origin not allowed' });
        return;
      }
      sendBridgeNoContent(req, res);
      return;
    }
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const processInfo = summarizeProcess();
    sendJson(res, 200, {
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      mcpProtocolVersion: PROTOCOL_VERSION,
      bridgeRole,
      host: cli.host,
      port: cli.port,
      pid: processInfo.pid,
      ppid: processInfo.ppid,
      platform: processInfo.platform,
      nodeVersion: processInfo.nodeVersion,
      uptimeMs: processInfo.uptimeMs,
      startedAt: processInfo.startedAt,
      cwd: processInfo.cwd,
      argv: processInfo.argv,
      process: processInfo,
      clients: getLiveClients().length,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/clients') {
    const diagnostics = url.searchParams.get('diagnostics') === '1';
    const connectedClients = getLiveClients().map(summarizeClient);
    sendAgentJson(res, 200, {
      expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
      mcp: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        bridgeRole,
        process: summarizeProcess(),
      },
      connectedClients,
      ...(diagnostics
        ? {
            bridgeHealth: connectedClients.map((client) => ({
              clientId: client.clientId,
              tabId: client.tabId,
              ...client.bridgeHealth,
            })),
          }
        : {}),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/agent/mcp-tool-call') {
    try {
      const payload = await readJsonBody(req);
      const name = payload?.name;
      if (!name || typeof name !== 'string') {
        sendAgentJson(res, 400, {
          ok: false,
          error: 'name is required',
        });
        return;
      }

      const result = await executeToolCall(name, payload.arguments || payload.args || {});
      sendAgentJson(res, 200, {
        ok: true,
        result,
      });
    } catch (err) {
      sendAgentJson(res, 500, {
        ok: false,
        error: err.message,
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/ensure-browser-extension-ready') {
    try {
      const ready = await ensureBrowserExtensionReady(
        {
          clientId: url.searchParams.get('clientId') || undefined,
        },
        {
          allowLaunchChrome: parseOptionalBoolean(url.searchParams.get('allowLaunchChrome')),
          allowReload: parseOptionalBoolean(url.searchParams.get('allowReload')),
        },
      );
      sendAgentJson(res, 200, {
        ok: true,
        expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
        client: summarizeClient(ready.client),
        info: ready.info,
        launchedChrome: ready.launchedChrome,
        reloadAttempts: ready.reloadAttempts,
      });
    } catch (err) {
      sendAgentJson(res, 503, {
        ok: false,
        error: err.message,
        code: err.code || null,
        data: err.data || null,
        expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
        connectedClients: getLiveClients().map(summarizeClient),
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-dir') {
    sendAgentJson(res, 200, {
      outputDir: resolveOutputDir(),
      defaultExportDir: DEFAULT_EXPORT_DIR,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/set-export-dir') {
    try {
      configuredExportDir =
        url.searchParams.get('reset') === 'true'
          ? DEFAULT_EXPORT_DIR
          : resolveOutputDir(url.searchParams.get('outputDir'));
      mkdirSync(configuredExportDir, { recursive: true });
      sendAgentJson(res, 200, {
        outputDir: configuredExportDir,
        reset: url.searchParams.get('reset') === 'true',
      });
    } catch (err) {
      sendAgentJson(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/recent-chats') {
    try {
      const client = requireRecentChatsClient(url.searchParams.get('clientId'));
      sendAgentJson(
        res,
        200,
        await listRecentChatsForClient(client, {
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
          refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-recent-chats') {
    try {
      const client = requireClient(url.searchParams.get('clientId'));
      sendAgentJson(
        res,
        202,
        startRecentChatsExportJob(client, {
          outputDir: url.searchParams.get('outputDir'),
          resumeReportFile: url.searchParams.get('resumeReportFile') || url.searchParams.get('reportFile') || undefined,
          startIndex: url.searchParams.get('startIndex'),
          maxChats: url.searchParams.get('maxChats') || url.searchParams.get('limit'),
          refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
          batchSize: url.searchParams.get('batchSize') || undefined,
          adaptiveLoad: parseOptionalBoolean(url.searchParams.get('adaptiveLoad')),
          maxLoadMoreRounds: url.searchParams.get('maxLoadMoreRounds') || undefined,
          loadMoreAttempts: url.searchParams.get('loadMoreAttempts') || undefined,
          maxNoGrowthRounds: url.searchParams.get('maxNoGrowthRounds') || undefined,
          loadMoreBrowserRounds: url.searchParams.get('loadMoreBrowserRounds') || undefined,
          loadMoreBrowserTimeoutMs: url.searchParams.get('loadMoreBrowserTimeoutMs') || undefined,
          skipExisting: parseOptionalBoolean(url.searchParams.get('skipExisting')),
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-missing-chats') {
    try {
      const client = requireClient(url.searchParams.get('clientId'));
      sendAgentJson(
        res,
        202,
        startRecentChatsExportJob(client, {
          vaultDir: url.searchParams.get('vaultDir') || url.searchParams.get('existingScanDir'),
          existingScanDir: url.searchParams.get('existingScanDir') || url.searchParams.get('vaultDir'),
          outputDir:
            url.searchParams.get('outputDir') ||
            url.searchParams.get('vaultDir') ||
            url.searchParams.get('existingScanDir') ||
            undefined,
          resumeReportFile: url.searchParams.get('resumeReportFile') || url.searchParams.get('reportFile') || undefined,
          exportMissingOnly: true,
          refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
          batchSize: url.searchParams.get('batchSize') || undefined,
          adaptiveLoad: parseOptionalBoolean(url.searchParams.get('adaptiveLoad')),
          maxLoadMoreRounds: url.searchParams.get('maxLoadMoreRounds') || undefined,
          loadMoreAttempts: url.searchParams.get('loadMoreAttempts') || undefined,
          maxNoGrowthRounds: url.searchParams.get('maxNoGrowthRounds') || undefined,
          loadMoreBrowserRounds: url.searchParams.get('loadMoreBrowserRounds') || undefined,
          loadMoreBrowserTimeoutMs: url.searchParams.get('loadMoreBrowserTimeoutMs') || undefined,
          skipExisting: true,
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/reexport-chats') {
    try {
      const chatIds = [
        ...url.searchParams.getAll('chatId'),
        ...String(url.searchParams.get('chatIds') || '')
          .split(/[,\s]+/)
          .filter(Boolean),
      ];
      const itemsText = url.searchParams.get('items');
      const items = itemsText ? JSON.parse(itemsText) : undefined;
      const client = requireClient(url.searchParams.get('clientId'));
      sendAgentJson(
        res,
        202,
        startDirectChatsExportJob(client, {
          outputDir: url.searchParams.get('outputDir') || undefined,
          chatIds,
          items,
          delayMs: url.searchParams.get('delayMs') || undefined,
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-job-status') {
    const jobId = url.searchParams.get('jobId');
    const job = exportJobs.get(jobId);
    if (!job) {
      sendAgentJson(res, 404, { error: `Job não encontrado: ${jobId}` });
      return;
    }
    sendAgentJson(res, 200, summarizeExportJob(job));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-job-cancel') {
    const jobId = url.searchParams.get('jobId');
    const job = exportJobs.get(jobId);
    if (!job) {
      sendAgentJson(res, 404, { error: `Job não encontrado: ${jobId}` });
      return;
    }
    if (!isTerminalExportJobStatus(job.status)) {
      job.cancelRequested = true;
      job.cancelledAt = new Date().toISOString();
      job.status = 'cancel_requested';
      touchExportJob(job);
    }
    sendAgentJson(res, 200, summarizeExportJob(job));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/notebook-chats') {
    try {
      const limit = normalizeLimit(url.searchParams.get('limit'), 100, 500);
      const client = requireNotebookClient(url.searchParams.get('clientId'));
      sendAgentJson(res, 200, {
        client: summarizeClient(client),
        notebookId: client.page?.notebookId || null,
        conversations: notebookConversationsForClient(client)
          .slice(0, limit)
          .map(enrichNotebookConversation),
      });
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/current-chat') {
    try {
      const client = requireClient(url.searchParams.get('clientId'));
      const result = await enqueueCommand(client.clientId, 'get-current-chat');
      sendAgentJson(res, 200, {
        client: summarizeClient(client),
        ...result,
      });
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/download-chat') {
    try {
      const args = {
        clientId: url.searchParams.get('clientId') || undefined,
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        outputDir: url.searchParams.get('outputDir') || undefined,
        returnToOriginal: url.searchParams.get('returnToOriginal') !== 'false',
      };
      const client = requireClient(args.clientId);
      const result = await downloadChatForClient(client, args);
      sendAgentJson(res, 200, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/download-notebook-chat') {
    try {
      const args = {
        clientId: url.searchParams.get('clientId') || undefined,
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        title: url.searchParams.get('title') || undefined,
        outputDir: url.searchParams.get('outputDir') || undefined,
        returnToOriginal: url.searchParams.get('returnToOriginal') !== 'false',
      };
      const client = requireNotebookClient(args.clientId);
      const result = await downloadNotebookChatForClient(client, args);
      sendAgentJson(res, 200, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-notebook') {
    try {
      const args = {
        clientId: url.searchParams.get('clientId') || undefined,
        outputDir: url.searchParams.get('outputDir') || undefined,
        startIndex: url.searchParams.has('startIndex')
          ? Number(url.searchParams.get('startIndex'))
          : undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      };
      const client = requireNotebookClient(args.clientId);
      const result = await exportNotebookForClient(client, args);
      sendAgentJson(res, result.failureCount > 0 ? 207 : 200, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/cache-status') {
    try {
      const client = requireClient(url.searchParams.get('clientId'));
      const result = await enqueueCommand(client.clientId, 'cache-status');
      sendAgentJson(res, 200, {
        client: summarizeClient(client),
        ...result,
      });
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/clear-cache') {
    try {
      const client = requireClient(url.searchParams.get('clientId'));
      const result = await enqueueCommand(client.clientId, 'clear-cache', {
        notebookId: url.searchParams.get('notebookId') || null,
      });
      sendAgentJson(res, 200, {
        client: summarizeClient(client),
        ...result,
      });
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/open-chat') {
    try {
      const args = {
        clientId: url.searchParams.get('clientId') || undefined,
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        url: url.searchParams.get('url') || undefined,
        title: url.searchParams.get('title') || undefined,
        notebook: url.searchParams.get('notebook') === 'true',
      };
      const client = args.notebook ? requireNotebookClient(args.clientId) : requireClient(args.clientId);
      const result = await enqueueCommand(client.clientId, 'open-chat', args);
      sendAgentJson(res, result?.ok ? 200 : 503, {
        client: summarizeClient(client),
        ...result,
      });
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/reload-tabs') {
    try {
      const result = await reloadGeminiTabs({
        clientId: url.searchParams.get('clientId') || undefined,
        delayMs: url.searchParams.has('delayMs') ? Number(url.searchParams.get('delayMs')) : undefined,
        reason: url.searchParams.get('reason') || 'agent-endpoint',
      });
      sendAgentJson(res, result.ok ? 200 : 503, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/inspect-media') {
    try {
      const clientId = url.searchParams.get('clientId') || undefined;
      const client = requireClient(clientId);
      const result = await enqueueCommand(client.clientId, 'inspect-media');
      sendJson(res, 200, {
        client: summarizeClient(client),
        ...result,
      });
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/pick-directory') {
    try {
      requireAllowedBridgeOrigin(req);
      await readJsonBody(req);
      const picked = await chooseExportDirectory();
      sendBridgeJson(req, res, 200, {
        ok: true,
        cancelled: picked.cancelled,
        outputDir: picked.outputDir || null,
      });
    } catch (err) {
      sendBridgeJson(req, res, err.statusCode || 400, {
        ok: false,
        error: err.message,
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/save-files') {
    try {
      requireAllowedBridgeOrigin(req);
      const payload = await readJsonBody(req);
      const files = writeExportFiles(payload);
      sendBridgeJson(req, res, 200, {
        ok: true,
        outputDir: files[0]?.outputDir || resolveOutputDir(payload.outputDir),
        files,
      });
    } catch (err) {
      sendBridgeJson(req, res, err.statusCode || 400, {
        ok: false,
        error: err.message,
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/fetch-asset') {
    try {
      requireAllowedBridgeOrigin(req);
      const payload = await readJsonBody(req);
      sendBridgeJson(req, res, 200, await fetchAssetForBridge(payload.source));
    } catch (err) {
      sendBridgeJson(req, res, err.statusCode || 400, {
        ok: false,
        error: err.message,
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/bridge/events') {
    try {
      requireAllowedBridgeOrigin(req);
      const clientId = url.searchParams.get('clientId');
      if (!clientId) {
        sendBridgeJson(req, res, 400, { error: 'clientId is required' });
        return;
      }

      const client = clients.get(clientId) || upsertClient({ clientId });
      closeEventStream(client);
      res.writeHead(200, sseHeaders(req));
      res.write(': connected\n\n');

      client.eventStream = {
        res,
        connectedAt: Date.now(),
        lastSentAt: Date.now(),
        keepAliveTimer: setInterval(() => {
          sendClientEvent(client, 'ping', {
            serverTime: new Date().toISOString(),
          });
        }, SSE_KEEPALIVE_MS),
      };
      client.lastSeenAt = Date.now();
      sendClientEvent(client, 'hello', {
        ok: true,
        clientId,
        serverTime: new Date().toISOString(),
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
      });
      flushQueuedCommand(client);
      req.on('close', () => {
        if (client.eventStream?.res === res) {
          closeEventStream(client);
        }
      });
    } catch (err) {
      if (!res.headersSent) {
        sendBridgeJson(req, res, err.statusCode || 400, {
          ok: false,
          error: err.message,
        });
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/snapshot') {
    try {
      requireAllowedBridgeOrigin(req);
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.clientId) {
        sendBridgeJson(req, res, 400, { error: 'clientId is required' });
        return;
      }
      const client = upsertClientSnapshot(payload, {
        payloadBytes: Buffer.byteLength(body, 'utf8'),
      });
      flushQueuedCommand(client);
      sendBridgeJson(req, res, 200, {
        ok: true,
        clientId: client.clientId,
        serverTime: new Date().toISOString(),
        snapshotHash: client.snapshotHash || null,
        bridgeHealth: buildBridgeHealth(client),
      });
    } catch (err) {
      sendBridgeJson(req, res, err.statusCode || 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/heartbeat') {
    try {
      requireAllowedBridgeOrigin(req);
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.clientId) {
        sendBridgeJson(req, res, 400, { error: 'clientId is required' });
        return;
      }

      const client = upsertClient(payload, {
        payloadBytes: Buffer.byteLength(body, 'utf8'),
        heartbeat: true,
      });
      const commandDelivery = flushQueuedCommand(client);
      const heartbeatCommand = commandDelivery ? null : takeQueuedCommand(client);
      const eventStreamConnected = !!client.eventStream?.res && !client.eventStream.res.destroyed;
      const snapshotRequested =
        payload.snapshotDirty === true ||
        !client.lastSnapshotAt ||
        (!!payload.snapshotHash && payload.snapshotHash !== client.snapshotHash);
      const jobProgress = eventStreamConnected ? null : buildJobProgressBroadcast(client);
      sendBridgeJson(req, res, 200, {
        ok: true,
        clientId: client.clientId,
        serverTime: new Date().toISOString(),
        command: heartbeatCommand,
        commandDelivery: heartbeatCommand
          ? 'heartbeat'
          : commandDelivery
            ? commandDelivery
            : null,
        transport: {
          eventsConnected: eventStreamConnected,
          longPollConnected: !!client.pendingPoll,
        },
        commandPollRequired: !client.pendingPoll && !eventStreamConnected,
        queuedCommands: client.queue?.length || 0,
        snapshotRequested,
        bridgeHealth: buildBridgeHealth(client),
        jobProgress,
      });
    } catch (err) {
      sendBridgeJson(req, res, err.statusCode || 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/bridge/command') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) {
      sendJson(res, 400, { error: 'clientId is required' });
      return;
    }

    const client = clients.get(clientId);
    if (!client) {
      sendNoContent(res);
      return;
    }

    client.lastSeenAt = Date.now();

    const queuedCommand = takeQueuedCommand(client);
    if (queuedCommand) {
      sendJson(res, 200, { command: queuedCommand });
      return;
    }

    if (client.pendingPoll) {
      try {
        clearTimeout(client.pendingPoll.timer);
        sendNoContent(client.pendingPoll.res);
      } catch {
        // ignore stale socket
      }
    }

    const timer = setTimeout(() => {
      if (client.pendingPoll?.res === res) {
        client.pendingPoll = null;
      }
      sendNoContent(res);
    }, LONG_POLL_TIMEOUT_MS);

    client.pendingPoll = { res, timer };
    req.on('close', () => {
      if (client.pendingPoll?.res === res) {
        clearTimeout(timer);
        client.pendingPoll = null;
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/command-result') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.commandId) {
        sendJson(res, 400, { error: 'commandId is required' });
        return;
      }

      const resolved = resolveCommand(payload.commandId, payload.result || null);
      sendJson(res, 200, { ok: true, duplicate: !resolved });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

bridgeServer.listen(cli.port, cli.host, () => {
  bridgeListening = true;
  settleBridgeStartup('primary');
  log(`bridge HTTP escutando em http://${cli.host}:${cli.port}`);
});

const shutdown = (reason, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) log(reason);

  for (const client of clients.values()) {
    if (!client.pendingPoll) continue;
    try {
      clearTimeout(client.pendingPoll.timer);
      sendNoContent(client.pendingPoll.res);
    } catch {
      // ignore stale socket
    }
    client.pendingPoll = null;
  }

  if (!bridgeListening) {
    process.exit(exitCode);
    return;
  }

  const forceExitTimer = setTimeout(() => {
    if (typeof bridgeServer.closeAllConnections === 'function') {
      try {
        bridgeServer.closeAllConnections();
      } catch {
        // ignore close races
      }
    }
    process.exit(exitCode);
  }, 1000);
  forceExitTimer.unref?.();

  bridgeServer.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  });
};

bridgeServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    settleBridgeStartup('proxy', error);
    debugLog(
      `bridge HTTP já está em uso em ${cli.host}:${cli.port}; esta instância MCP vai encaminhar tools para a instância primária.`,
    );
    return;
  }
  settleBridgeStartup('failed', error);
  errorLog(formatBridgeListenError(error, { host: cli.host, port: cli.port }));
  shutdown('Encerrando MCP por falha no bridge HTTP.', 1);
});

process.on('SIGINT', () => {
  shutdown('Recebido SIGINT; encerrando MCP.', 0);
});

process.on('SIGTERM', () => {
  shutdown('Recebido SIGTERM; encerrando MCP.', 0);
});

const writeRpcMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id, result) => {
  writeRpcMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
};

const respondError = (id, code, message, data) => {
  writeRpcMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
};

const handleRequest = async (message) => {
  const { id, method, params } = message;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    respond(id, {});
    return;
  }

  if (method === 'tools/list') {
    respond(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
    return;
  }

  if (method === 'resources/list') {
    respond(id, { resources: [] });
    return;
  }

  if (method === 'prompts/list') {
    respond(id, { prompts: [] });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    try {
      await waitForBridgeStartup();
      let result;
      if (
        bridgeRole === 'proxy' &&
        process.env.GEMINI_MCP_PROXY_TO_PRIMARY !== 'false' &&
        !LOCAL_PROXY_TOOL_NAMES.has(name)
      ) {
        result =
          name === 'gemini_browser_status'
            ? await proxyBrowserStatus(args)
            : await proxyToolCallToPrimary(name, args);
      } else {
        result = await executeToolCall(name, args);
      }
      respond(id, result);
    } catch (err) {
      respond(
        id,
        toolTextResult(
          {
            error: err.message,
            code: err.code || null,
            data: err.data || null,
          },
          { isError: true },
        ),
      );
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
};

const handleMessage = async (message) => {
  if (Array.isArray(message)) {
    for (const item of message) {
      await handleMessage(item);
    }
    return;
  }

  if (!message || typeof message !== 'object') return;
  if (!('id' in message)) return;
  await handleRequest(message);
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const message = JSON.parse(trimmed);
    await handleMessage(message);
  } catch (err) {
    respondError(null, -32700, `Parse error: ${err.message}`);
  }
});

rl.on('close', () => {
  shutdown('STDIN do cliente MCP foi fechado; encerrando processo.', 0);
});
