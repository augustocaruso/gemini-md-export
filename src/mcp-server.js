#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';
import {
  buildRecentChatsRefreshPlan,
  DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
  inferRecentChatsCountStatus,
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
  resolveGeminiBrowserLaunchPlan,
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
const PROCESS_SESSION_ID =
  process.env.GEMINI_MCP_SESSION_ID ||
  process.env.GEMINI_CLI_SESSION_ID ||
  process.env.CODEX_SESSION_ID ||
  `mcp-${process.pid}-${PROCESS_STARTED_AT.getTime().toString(36)}`;
const DEFAULT_HOST = process.env.GEMINI_MCP_BRIDGE_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.GEMINI_MCP_BRIDGE_PORT || 47283);
const DEFAULT_EXPORT_DIR = process.env.GEMINI_MCP_EXPORT_DIR || resolve(homedir(), 'Downloads');
const DIAGNOSTIC_DIR =
  process.env.GEMINI_MCP_DIAGNOSTIC_DIR || resolve(homedir(), '.gemini-md-export');
const FLIGHT_RECORDER_FILE = resolve(DIAGNOSTIC_DIR, 'flight-recorder.jsonl');
const FLIGHT_RECORDER_MAX_BYTES = Math.max(
  64 * 1024,
  Math.min(20 * 1024 * 1024, Number(process.env.GEMINI_MCP_FLIGHT_RECORDER_MAX_BYTES || 2 * 1024 * 1024)),
);
const FLIGHT_RECORDER_MEMORY_LIMIT = Math.max(
  20,
  Math.min(1000, Number(process.env.GEMINI_MCP_FLIGHT_RECORDER_MEMORY_LIMIT || 200)),
);
const CLIENT_STALE_MS = 45_000;
const DEFAULT_BRIDGE_KEEP_ALIVE_MS = Math.max(
  1000,
  Math.min(
    24 * 60 * 60_000,
    Number(
      process.env.GEMINI_MD_EXPORT_BRIDGE_KEEP_ALIVE_MS ||
        process.env.GEMINI_MCP_BRIDGE_KEEP_ALIVE_MS ||
        15 * 60_000,
    ),
  ),
);
const TAB_CLAIM_DEFAULT_TTL_MS = Math.max(
  60_000,
  Math.min(24 * 60 * 60_000, Number(process.env.GEMINI_MCP_TAB_CLAIM_TTL_MS || 45 * 60_000)),
);
const TAB_CLAIM_MIN_VISIBLE_MS = Math.max(
  0,
  Math.min(15_000, Number(process.env.GEMINI_MCP_TAB_CLAIM_MIN_VISIBLE_MS || 5000)),
);
const TAB_CLAIM_COLORS = ['green', 'blue', 'yellow', 'purple', 'cyan', 'orange', 'pink'];
const TAB_CLAIM_LABEL_PREFIX = 'GME';
const CLIENT_DEGRADED_HEARTBEAT_MS = Number(
  process.env.GEMINI_MCP_CLIENT_DEGRADED_HEARTBEAT_MS || 20_000,
);
const COMMAND_CHANNEL_FAILURE_COOLDOWN_MS = Math.max(
  0,
  Math.min(300_000, Number(process.env.GEMINI_MCP_COMMAND_CHANNEL_FAILURE_COOLDOWN_MS || 60_000)),
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
const BRIDGE_ASSET_FETCH_MAX_IN_FLIGHT = Math.max(
  1,
  Math.min(20, Number(process.env.GEMINI_MCP_ASSET_FETCH_MAX_IN_FLIGHT || 4)),
);
const BRIDGE_ASSET_FETCH_CACHE_TTL_MS = Math.max(
  0,
  Math.min(
    24 * 60 * 60_000,
    Number(process.env.GEMINI_MCP_ASSET_FETCH_CACHE_TTL_MS || 30 * 60_000),
  ),
);
const BRIDGE_ASSET_HOST_BACKOFF_FAILURE_THRESHOLD = Math.max(
  1,
  Math.min(20, Number(process.env.GEMINI_MCP_ASSET_HOST_BACKOFF_FAILURE_THRESHOLD || 3)),
);
const BRIDGE_ASSET_HOST_BACKOFF_BASE_MS = Math.max(
  100,
  Math.min(60_000, Number(process.env.GEMINI_MCP_ASSET_HOST_BACKOFF_BASE_MS || 2000)),
);
const BRIDGE_ASSET_HOST_BACKOFF_MAX_MS = Math.max(
  BRIDGE_ASSET_HOST_BACKOFF_BASE_MS,
  Math.min(10 * 60_000, Number(process.env.GEMINI_MCP_ASSET_HOST_BACKOFF_MAX_MS || 30_000)),
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
  process.env.GEMINI_MCP_RECENT_CHATS_EXPORT_ALL_LOAD_MORE_BROWSER_TIMEOUT_MS || 30_000,
);
const RECENT_CHATS_CLIENT_RECOVERY_WAIT_MS = Math.max(
  0,
  Math.min(120_000, Number(process.env.GEMINI_MCP_RECENT_CHATS_CLIENT_RECOVERY_WAIT_MS || 30_000)),
);
const RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT = Math.max(
  1,
  Math.min(10, Number(process.env.GEMINI_MCP_RECENT_CHATS_BUSY_RETRY_LIMIT || 5)),
);
const RECENT_CHATS_TRANSIENT_BUSY_RETRY_BASE_MS = Math.max(
  100,
  Math.min(10_000, Number(process.env.GEMINI_MCP_RECENT_CHATS_BUSY_RETRY_BASE_MS || 600)),
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
const tabClaims = new Map();
const sessionClaims = new Map();
const CLI_BIN_PATH = resolve(ROOT, 'bin', 'gemini-md-export.mjs');
let configuredExportDir = DEFAULT_EXPORT_DIR;
let shuttingDown = false;
let bridgeRole = 'starting';
let bridgeListening = false;
let bridgeStartupSettled = false;
let bridgeStartupResolve;
let activeBridgeRequests = 0;
let lastBridgeActivityAt = Date.now();
let lastChromeHeartbeatAt = 0;
let idleShutdownTimer = null;
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

const flightEvents = [];
const REDACTED_FLIGHT_KEYS = /content|contentBase64|markdown|body|html|prompt|response|raw|text/i;

const sanitizeFlightValue = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code || null,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeFlightValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = REDACTED_FLIGHT_KEYS.test(key)
        ? '[redacted]'
        : sanitizeFlightValue(child, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }
  return value;
};

const rotateFlightRecorderIfNeeded = () => {
  try {
    if (!existsSync(FLIGHT_RECORDER_FILE)) return;
    const stat = statSync(FLIGHT_RECORDER_FILE);
    if (stat.size < FLIGHT_RECORDER_MAX_BYTES) return;
    renameSync(FLIGHT_RECORDER_FILE, resolve(DIAGNOSTIC_DIR, 'flight-recorder.previous.jsonl'));
  } catch {
    // Flight recorder não deve derrubar o MCP.
  }
};

const recordFlightEvent = (type, data = {}) => {
  const event = {
    ts: new Date().toISOString(),
    type,
    sessionId: PROCESS_SESSION_ID,
    pid: process.pid,
    data: sanitizeFlightValue(data),
  };
  flightEvents.push(event);
  while (flightEvents.length > FLIGHT_RECORDER_MEMORY_LIMIT) flightEvents.shift();
  try {
    mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
    rotateFlightRecorderIfNeeded();
    appendFileSync(FLIGHT_RECORDER_FILE, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch {
    // Observabilidade é best-effort e nunca deve bloquear exportação.
  }
  return event;
};

const readFlightRecorderTail = (limit = 100) => {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit || 100)));
  try {
    if (!existsSync(FLIGHT_RECORDER_FILE)) return flightEvents.slice(-safeLimit);
    const lines = readFileSync(FLIGHT_RECORDER_FILE, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-safeLimit);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return flightEvents.slice(-safeLimit);
  }
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

const activeExportJobs = () =>
  Array.from(exportJobs.values()).filter((job) => !isTerminalExportJobStatus(job.status));

const touchBridgeActivity = () => {
  lastBridgeActivityAt = Date.now();
};

const bridgeIdleLifecycleSnapshot = () => {
  const now = Date.now();
  const activeJobs = activeExportJobs();
  const liveClientCount = getLiveClients().length;
  const heartbeatAgeMs = lastChromeHeartbeatAt ? now - lastChromeHeartbeatAt : null;
  const idleForMs = Math.max(0, now - lastBridgeActivityAt);
  const blockedBy = [];
  if (activeBridgeRequests > 0) blockedBy.push('active_request');
  if (activeJobs.length > 0) blockedBy.push('active_job');
  if (liveClientCount > 0) blockedBy.push('recent_extension_heartbeat');

  return {
    enabled: cli.exitWhenIdle === true,
    keepAliveMs: cli.keepAliveMs,
    idleForMs,
    activeRequestCount: activeBridgeRequests,
    activeJobCount: activeJobs.length,
    liveClientCount,
    lastActivityAt: new Date(lastBridgeActivityAt).toISOString(),
    lastChromeHeartbeatAt: lastChromeHeartbeatAt
      ? new Date(lastChromeHeartbeatAt).toISOString()
      : null,
    heartbeatAgeMs,
    blockedBy,
    exitsWhenIdle: cli.exitWhenIdle === true && blockedBy.length === 0,
    remainingMs:
      cli.exitWhenIdle === true && blockedBy.length === 0
        ? Math.max(0, cli.keepAliveMs - idleForMs)
        : null,
  };
};

const scheduleIdleShutdownCheck = () => {
  if (!cli.exitWhenIdle || shuttingDown) return;
  if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
  const snapshot = bridgeIdleLifecycleSnapshot();
  const delayMs =
    snapshot.blockedBy.length > 0
      ? Math.min(30_000, Math.max(1000, cli.keepAliveMs))
      : Math.max(1000, Math.min(30_000, snapshot.remainingMs || 0));
  idleShutdownTimer = setTimeout(() => {
    maybeShutdownIdleBridge();
  }, delayMs);
  idleShutdownTimer.unref?.();
};

const maybeShutdownIdleBridge = () => {
  if (!cli.exitWhenIdle || shuttingDown) return;
  cleanupStaleClients();
  const snapshot = bridgeIdleLifecycleSnapshot();
  if (snapshot.blockedBy.length > 0 || snapshot.idleForMs < cli.keepAliveMs) {
    scheduleIdleShutdownCheck();
    return;
  }
  recordFlightEvent('bridge_idle_shutdown', snapshot);
  shutdown(
    `Bridge local idle por ${snapshot.idleForMs}ms; encerrando processo bridge-only iniciado pela CLI.`,
    0,
  );
};

const trackBridgeRequestLifecycle = (req, res) => {
  activeBridgeRequests += 1;
  touchBridgeActivity();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    activeBridgeRequests = Math.max(0, activeBridgeRequests - 1);
    touchBridgeActivity();
    scheduleIdleShutdownCheck();
  };
  res.once('finish', finish);
  res.once('close', finish);
  req.once('error', finish);
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
  bridgeOnly: cli.bridgeOnly === true,
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
    return 'Há um processo primário antigo/travado reconhecido como exporter. Rode gemini_support { action: "cleanup_processes" } sem confirm para dry-run; se o alvo estiver correto, repita com confirm=true.';
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

const latestExportReportsInDirectory = (directory, limit = 5) => {
  try {
    return readdirSync(directory)
      .filter((name) => /^gemini-md-export-.*\.json$/.test(name))
      .map((name) => {
        const filePath = resolve(directory, name);
        const stat = statSync(filePath);
        return {
          filename: name,
          filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
      .slice(0, limit);
  } catch (err) {
    return {
      error: err?.message || String(err),
      reports: [],
    };
  }
};

const summarizeRecentExportJobs = (limit = 5) =>
  [...exportJobs.values()]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
    .map(summarizeExportJob);

const clientsFromPrimaryPayload = (payload) =>
  Array.isArray(payload?.connectedClients) ? payload.connectedClients : [];

const connectedClientsForDiagnostics = async () => {
  cleanupStaleClients();
  const localClients = getLiveClients().map(summarizeClient);
  if (bridgeRole !== 'proxy') {
    return {
      source: 'local',
      connectedClients: localClients,
      primaryClientsFetch: { attempted: false },
    };
  }

  const primaryClientsFetch = await primaryBridgeClients();
  return {
    source: primaryClientsFetch.ok ? 'primary-bridge' : 'local-proxy',
    connectedClients: primaryClientsFetch.ok
      ? clientsFromPrimaryPayload(primaryClientsFetch.payload)
      : localClients,
    primaryClientsFetch: {
      attempted: true,
      ok: primaryClientsFetch.ok,
      status: primaryClientsFetch.status,
      error: primaryClientsFetch.error || null,
    },
  };
};

const clientMatchesExpectedInfo = (client) =>
  String(client?.extensionVersion || '') === EXPECTED_CHROME_EXTENSION_INFO.extensionVersion &&
  Number(client?.protocolVersion) === Number(EXPECTED_CHROME_EXTENSION_INFO.protocolVersion) &&
  (!EXPECTED_CHROME_EXTENSION_INFO.buildStamp ||
    String(client?.buildStamp || client?.page?.buildStamp || '') ===
      EXPECTED_CHROME_EXTENSION_INFO.buildStamp);

const compactUnique = (items) => [
  ...new Set(items.filter((item) => item !== null && item !== undefined && item !== '')),
];

const extensionMismatchForClient = (client, expected = EXPECTED_CHROME_EXTENSION_INFO) => {
  if (!client) return { kind: 'missing_client' };
  if (Number(client.protocolVersion) !== Number(expected.protocolVersion)) {
    return {
      kind: 'protocol',
      actual: client.protocolVersion ?? null,
      expected: expected.protocolVersion,
    };
  }
  if (String(client.extensionVersion || '') !== String(expected.extensionVersion || '')) {
    return {
      kind: 'version',
      actual: client.extensionVersion ?? null,
      expected: expected.extensionVersion,
    };
  }
  const actualBuildStamp = client.buildStamp || client.page?.buildStamp || null;
  if (expected.buildStamp && String(actualBuildStamp || '') !== String(expected.buildStamp)) {
    return {
      kind: 'build',
      actual: actualBuildStamp,
      expected: expected.buildStamp,
    };
  }
  return null;
};

const buildExtensionReadiness = ({
  connectedClients = [],
  matchingClients = [],
  selfHeal = null,
  expected = EXPECTED_CHROME_EXTENSION_INFO,
} = {}) => {
  const clients = Array.isArray(connectedClients) ? connectedClients : [];
  const matching = Array.isArray(matchingClients) ? matchingClients : [];
  const serviceWorkerInfo = selfHeal?.info || null;
  const serviceWorkerSource = serviceWorkerInfo?.source || null;
  const serviceWorkerConfirmed =
    serviceWorkerInfo?.ok === true && serviceWorkerSource !== 'heartbeat-fallback';
  const serviceWorkerStatus = serviceWorkerConfirmed
    ? 'alive'
    : selfHeal?.attempted && selfHeal?.ok === false
      ? 'unreachable'
      : serviceWorkerSource === 'heartbeat-fallback'
        ? 'unknown_heartbeat_fallback'
        : 'unknown';
  const mismatches = clients
    .map((client) => ({
      clientId: client.clientId,
      tabId: client.tabId ?? null,
      windowId: client.windowId ?? null,
      isActiveTab: client.isActiveTab ?? null,
      mismatch: extensionMismatchForClient(client, expected),
      extensionVersion: client.extensionVersion ?? null,
      protocolVersion: client.protocolVersion ?? null,
      buildStamp: client.buildStamp ?? client.page?.buildStamp ?? null,
    }))
    .filter((item) => item.mismatch);
  const reloadAttempts = Number(selfHeal?.reloadAttempts || 0);
  const reloadWorked = selfHeal?.ok === true && reloadAttempts > 0;
  const manualReloadRequired =
    selfHeal?.ok === false &&
    [
      'chrome_extension_version_mismatch',
      'chrome_extension_build_mismatch',
      'chrome_extension_protocol_mismatch',
      'chrome_extension_reload_failed',
      'chrome_extension_reload_timeout',
    ].includes(selfHeal.code || '');
  const status =
    clients.length === 0
      ? 'no_content_script'
      : matching.length === 0
        ? 'version_or_build_mismatch'
        : serviceWorkerStatus === 'unreachable'
          ? 'service_worker_unreachable'
          : 'ready';

  return {
    status,
    expected,
    serviceWorker: {
      status: serviceWorkerStatus,
      source: serviceWorkerSource,
      version: serviceWorkerInfo?.extensionVersion || serviceWorkerInfo?.version || null,
      protocolVersion: serviceWorkerInfo?.protocolVersion ?? null,
      buildStamp: serviceWorkerInfo?.buildStamp || null,
      lastError: selfHeal?.ok === false ? selfHeal.error || null : null,
    },
    contentScript: {
      status: clients.length > 0 ? 'connected' : 'missing',
      connectedClientCount: clients.length,
      matchingClientCount: matching.length,
    },
    geminiTab: {
      status: clients.length > 0 ? 'connected' : 'missing',
      activeClientCount: clients.filter((client) => client.isActiveTab === true).length,
      tabIds: compactUnique(clients.map((client) => client.tabId ?? null)),
      windowIds: compactUnique(clients.map((client) => client.windowId ?? null)),
    },
    buildStamp: {
      expected: expected.buildStamp || null,
      running: compactUnique(clients.map((client) => client.buildStamp || client.page?.buildStamp || null)),
    },
    reload: {
      attempted: selfHeal?.attempted === true && reloadAttempts > 0,
      selfHealAttempted: selfHeal?.attempted === true,
      ok: selfHeal?.ok ?? null,
      attempts: reloadAttempts,
      worked: reloadWorked,
      manualReloadRequired,
      message: manualReloadRequired
        ? 'O reload automático foi tentado ou não conseguiu resolver; agora vale pedir reload manual no card da extensão unpacked.'
        : reloadWorked
          ? 'Reload automático funcionou; a extensão voltou com versão/protocolo/build esperados.'
          : 'Nenhum reload automático foi necessário.',
    },
    mismatches,
    topBar: {
      statusByClient: clients.map((client) => ({
        clientId: client.clientId,
        tabId: client.tabId ?? null,
        status: client.page?.topBar?.status || null,
        route: client.page?.topBar?.route || null,
        matchedBy: client.page?.topBar?.matchedBy || null,
        warning: client.page?.topBar?.warning || null,
        candidateCount: client.page?.topBar?.topBarCandidateCount ?? null,
        visibleCandidateCount: client.page?.topBar?.visibleTopBarCandidateCount ?? null,
      })),
    },
  };
};

const environmentNextAction = ({ processDiagnostics, clients, matchingClients }) => {
  if (processDiagnostics?.problem) {
    return {
      code: 'process_or_port_problem',
      message: processDiagnostics.recommendedAction,
    };
  }
  if (!clients.length) {
    return {
      code: 'no_gemini_tab_connected',
      message:
        'Abra uma aba do Gemini Web ou rode gemini_ready { action: "status", diagnostic: true } para tentar acordar o navegador e reconectar a extensão.',
    };
  }
  if (!matchingClients.length) {
    return {
      code: 'extension_version_mismatch',
      message:
        'A extensão Chrome conectada não bate com a versão/protocolo/build esperados. Rode gemini_ready { action: "status", diagnostic: true } para tentar self-heal antes de pedir reload manual.',
    };
  }
  const unhealthy = matchingClients.find((client) => client.bridgeHealth?.blockingIssue);
  if (unhealthy) {
    return {
      code: unhealthy.bridgeHealth.blockingIssue,
      message: unhealthy.bridgeHealth.action || 'Rode gemini_ready { action: "status", diagnostic: true } para diagnóstico da aba.',
    };
  }
  return {
    code: 'ready',
    message: 'Bridge, extensão e aba Gemini parecem prontos.',
  };
};

const buildEnvironmentDiagnostics = async () => {
  const [processDiagnostics, clientState] = await Promise.all([
    buildProcessDiagnostics(),
    connectedClientsForDiagnostics(),
  ]);
  const connectedClients = clientState.connectedClients || [];
  const matchingClients = connectedClients.filter(clientMatchesExpectedInfo);
  const outputDir = resolveOutputDir();
  const latestReports = latestExportReportsInDirectory(outputDir);
  const browserLaunchPlan = resolveGeminiBrowserLaunchPlan();
  const nextAction = environmentNextAction({
    processDiagnostics,
    clients: connectedClients,
    matchingClients,
  });

  return {
    ok: nextAction.code === 'ready',
    generatedAt: new Date().toISOString(),
    status: nextAction.code,
    nextAction,
    bridge: {
      host: cli.host,
      port: cli.port,
      url: primaryBridgeBaseUrl(),
      role: bridgeRole,
      listening: bridgeListening,
      health: processDiagnostics.primaryBridge?.health || null,
    },
    mcp: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      process: summarizeProcess(),
    },
    browser: {
      launchIfClosed: CHROME_GUARD_CONFIG.launchIfClosed,
      profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
      configuredBrowser:
        process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER || browserLaunchPlan.browserKey,
      launchPlan: browserLaunchPlan,
      recentLaunch: describeRecentBrowserLaunch(readBrowserLaunchState(), {
        cooldownMs: BROWSER_LAUNCH_COOLDOWN_MS,
      }),
    },
    extension: {
      expected: EXPECTED_CHROME_EXTENSION_INFO,
      source: clientState.source,
      primaryClientsFetch: clientState.primaryClientsFetch,
      connectedClientCount: connectedClients.length,
      matchingClientCount: matchingClients.length,
      tabClaims: summarizeTabClaims(),
      readiness: buildExtensionReadiness({
        connectedClients,
        matchingClients,
        selfHeal: { attempted: false, reason: 'not-run-in-environment-diagnostics' },
      }),
      connectedClients,
    },
    export: {
      outputDir,
      defaultExportDir: DEFAULT_EXPORT_DIR,
      bridgeAssetFetch: snapshotBridgeAssetMetrics(),
      runningJobCount: [...exportJobs.values()].filter((job) => !isTerminalExportJobStatus(job.status))
        .length,
      recentJobs: summarizeRecentExportJobs(5),
      latestReports: Array.isArray(latestReports) ? latestReports : [],
      latestReportError: Array.isArray(latestReports) ? null : latestReports.error,
    },
    processDiagnostics,
  };
};

const buildSupportBundle = async (args = {}) => {
  const outputDir = args.outputDir ? resolveOutputDir(args.outputDir) : DIAGNOSTIC_DIR;
  mkdirSync(outputDir, { recursive: true });
  const diagnostics = await buildEnvironmentDiagnostics();
  const flightRecorder = readFlightRecorderTail(args.flightLimit || 200);
  const payload = {
    generatedAt: new Date().toISOString(),
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    privacy:
      'Este bundle não inclui conteúdo de conversas por padrão; eventos do flight recorder são sanitizados.',
    diagnostics,
    flightRecorder: {
      file: FLIGHT_RECORDER_FILE,
      eventCount: flightRecorder.length,
      events: flightRecorder,
    },
  };
  const filename = `gemini-md-export-support-${timestampForFilename()}-${randomUUID().slice(0, 8)}.json`;
  const filePath = resolve(outputDir, filename);
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  recordFlightEvent('support_bundle_created', {
    filePath,
    eventCount: flightRecorder.length,
  });
  return {
    ok: true,
    filePath,
    filename,
    outputDir,
    eventCount: flightRecorder.length,
    includesChatContent: false,
    diagnosticsStatus: diagnostics.status,
    nextAction: diagnostics.nextAction,
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
    bridgeOnly: process.env.GEMINI_MD_EXPORT_BRIDGE_ONLY === 'true',
    exitWhenIdle:
      process.env.GEMINI_MD_EXPORT_EXIT_WHEN_IDLE === 'true' ||
      process.env.GEMINI_MCP_BRIDGE_EXIT_WHEN_IDLE === 'true',
    keepAliveMs: DEFAULT_BRIDGE_KEEP_ALIVE_MS,
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
      continue;
    }
    if (arg === '--bridge-only') {
      out.bridgeOnly = true;
      continue;
    }
    if (arg === '--exit-when-idle') {
      out.exitWhenIdle = true;
      continue;
    }
    if (arg === '--no-exit-when-idle') {
      out.exitWhenIdle = false;
      continue;
    }
    if (arg === '--keep-alive-ms' && argv[i + 1]) {
      out.keepAliveMs = Math.max(1000, Number(argv[i + 1]) || DEFAULT_BRIDGE_KEEP_ALIVE_MS);
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
      `  node ${fileURLToPath(import.meta.url)} --bridge-only [--host 127.0.0.1] [--port 47283]`,
      `  node ${fileURLToPath(import.meta.url)} --bridge-only --exit-when-idle --keep-alive-ms 900000`,
      '',
      'This process serves two roles:',
      '  1. MCP server over stdio for the AI client',
      '  2. Local HTTP bridge for the browser extension',
      '',
      'Use --bridge-only to run only the local HTTP bridge without MCP stdio.',
      'Use --exit-when-idle for CLI-started bridges that should close after inactivity.',
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

const clientSelectorFromSearchParams = (searchParams) => ({
  clientId: searchParams.get('clientId') || undefined,
  tabId: searchParams.get('tabId') || undefined,
  claimId: searchParams.get('claimId') || undefined,
  sessionId: searchParams.get('sessionId') || undefined,
  preferActive: parseOptionalBoolean(searchParams.get('preferActive')),
});

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

const hasPendingCommandForClient = (clientId) =>
  Array.from(pendingCommands.values()).some((pending) => pending.clientId === clientId);

const cleanupStaleClients = () => {
  const now = Date.now();
  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastSeenAt <= CLIENT_STALE_MS) continue;
    if (hasPendingCommandForClient(clientId)) {
      client.lastSeenAt = now;
      client.lastSeenAtExtendedByCommandAt = new Date(now).toISOString();
      continue;
    }
    removeClient(clientId);
  }
};

const dropClientsAfterExtensionReload = () => {
  for (const clientId of Array.from(clients.keys())) {
    removeClient(clientId);
  }
};

const emptyPayloadMetric = () => ({
  count: 0,
  totalBytes: 0,
  lastBytes: null,
  maxBytes: 0,
  lastAt: null,
});

const recordPayloadMetric = (client, kind, bytes) => {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return;
  client.payloadMetrics = client.payloadMetrics || {};
  const metric = client.payloadMetrics[kind] || emptyPayloadMetric();
  metric.count += 1;
  metric.totalBytes += size;
  metric.lastBytes = size;
  metric.maxBytes = Math.max(metric.maxBytes || 0, size);
  metric.lastAt = new Date().toISOString();
  client.payloadMetrics[kind] = metric;
};

const summarizePayloadMetric = (metric) => {
  if (!metric || metric.count <= 0) {
    return {
      count: 0,
      lastBytes: null,
      avgBytes: null,
      maxBytes: 0,
      lastAt: null,
    };
  }
  return {
    count: metric.count,
    lastBytes: metric.lastBytes ?? null,
    avgBytes: Math.round(metric.totalBytes / metric.count),
    maxBytes: metric.maxBytes || 0,
    lastAt: metric.lastAt || null,
  };
};

const summarizePayloadMetrics = (client) => ({
  heartbeat: summarizePayloadMetric(client?.payloadMetrics?.heartbeat),
  snapshot: summarizePayloadMetric(client?.payloadMetrics?.snapshot),
});

const normalizeSessionId = (value) => {
  const text = String(value || '').trim();
  return text || PROCESS_SESSION_ID;
};

const normalizeClaimId = (value) => {
  const text = String(value || '').trim();
  return text || randomUUID();
};

const normalizeTabId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const normalizeClaimTtlMs = (value) => {
  const parsed = Number(value || TAB_CLAIM_DEFAULT_TTL_MS);
  const safe = Number.isFinite(parsed) ? parsed : TAB_CLAIM_DEFAULT_TTL_MS;
  return Math.max(30_000, Math.min(24 * 60 * 60_000, safe));
};

const colorForSession = (sessionId) => {
  let hash = 0;
  for (const char of String(sessionId || PROCESS_SESSION_ID)) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return TAB_CLAIM_COLORS[Math.abs(hash) % TAB_CLAIM_COLORS.length] || 'green';
};

const labelForSession = (sessionId, provided) => {
  const text = String(provided || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 16);
  const suffix = String(sessionId || PROCESS_SESSION_ID)
    .replace(/[^a-z0-9]/gi, '')
    .slice(-4)
    .toUpperCase();
  return `${TAB_CLAIM_LABEL_PREFIX}${suffix ? ` ${suffix}` : ''}`.slice(0, 16);
};

const clientSelectorProperties = () => ({
  clientId: { type: 'string' },
  tabId: {
    type: 'integer',
    description: 'ID da aba do navegador retornado por gemini_tabs/gemini_ready.',
  },
  claimId: {
    type: 'string',
    description: 'Claim explícita retornada por gemini_tabs { action: "claim" }.',
  },
  sessionId: {
    type: 'string',
    description:
      'Identificador lógico da sessão/agente. Se omitido, o MCP usa a sessão atual do processo/proxy.',
  },
});

const normalizeClientSelector = (selector) => {
  if (typeof selector === 'string') {
    return {
      clientId: selector || null,
      tabId: null,
      claimId: null,
      sessionId: PROCESS_SESSION_ID,
    };
  }
  const input = selector && typeof selector === 'object' ? selector : {};
  return {
    clientId: input.clientId || null,
    tabId: normalizeTabId(input.tabId),
    claimId: input.claimId || null,
    sessionId: normalizeSessionId(input.sessionId || input._proxySessionId),
  };
};

const isLiveClient = (client, now = Date.now()) =>
  !!client && now - client.lastSeenAt <= CLIENT_STALE_MS;

const cleanupExpiredTabClaims = () => {
  const now = Date.now();
  for (const [claimId, claim] of tabClaims.entries()) {
    if (claim.expiresAtMs > now) continue;
    tabClaims.delete(claimId);
    if (sessionClaims.get(claim.sessionId) === claimId) {
      sessionClaims.delete(claim.sessionId);
    }
  }
};

const liveClientForClaim = (claim) => {
  if (!claim) return null;
  const client = clients.get(claim.clientId);
  if (isLiveClient(client)) return client;
  const replacement = findReplacementClientForClaim(claim);
  return replacement ? rebindTabClaimToClient(claim, replacement, 'client-reconnected') : null;
};

const clientTabClaim = (client) => client?.tabClaim || client?.summary?.tabClaim || null;

const clientCarriesClaim = (client, claim) => {
  if (!client || !claim) return false;
  const tabClaim = clientTabClaim(client);
  if (tabClaim?.claimId && tabClaim.claimId === claim.claimId) return true;
  if (
    tabClaim?.sessionId &&
    claim.sessionId &&
    tabClaim.sessionId === claim.sessionId &&
    claim.tabId !== null &&
    claim.tabId !== undefined &&
    client.tabId !== null &&
    client.tabId !== undefined &&
    Number(client.tabId) === Number(claim.tabId)
  ) {
    return true;
  }
  return false;
};

const findReplacementClientForClaim = (claim) => {
  if (!claim) return null;
  const liveClients = getSelectableGeminiClients();
  const claimClient = liveClients.find((client) => clientCarriesClaim(client, claim));
  if (claimClient) return claimClient;
  if (claim.tabId !== null && claim.tabId !== undefined) {
    const sameTab = liveClients.find(
      (client) =>
        client.tabId !== null &&
        client.tabId !== undefined &&
        Number(client.tabId) === Number(claim.tabId),
    );
    if (sameTab) return sameTab;
  }
  return null;
};

const rebindTabClaimToClient = (claim, client, reason = 'client-reconnected') => {
  if (!claim || !client) return null;
  if (claim.clientId !== client.clientId) {
    recordFlightEvent('tab_claim_rebound', {
      claimId: claim.claimId,
      previousClientId: claim.clientId || null,
      nextClientId: client.clientId,
      tabId: client.tabId ?? claim.tabId ?? null,
      reason,
    });
  }
  claim.clientId = client.clientId;
  claim.tabId = client.tabId ?? claim.tabId ?? null;
  claim.windowId = client.windowId ?? claim.windowId ?? null;
  claim.renewedAt = new Date().toISOString();
  return client;
};

const summarizeTabClaim = (claim) => {
  if (!claim) return null;
  const client = clients.get(claim.clientId);
  return {
    claimId: claim.claimId,
    sessionId: claim.sessionId,
    clientId: claim.clientId,
    tabId: claim.tabId ?? null,
    windowId: claim.windowId ?? null,
    label: claim.label,
    color: claim.color,
    status: isLiveClient(client) ? 'active' : 'client-missing',
    createdAt: claim.createdAt,
    renewedAt: claim.renewedAt,
    expiresAt: new Date(claim.expiresAtMs).toISOString(),
    visual: claim.visual || null,
  };
};

const summarizeTabClaims = () => {
  cleanupExpiredTabClaims();
  return [...tabClaims.values()].map(summarizeTabClaim);
};

const claimForSession = (sessionId) => {
  cleanupExpiredTabClaims();
  const claimId = sessionClaims.get(normalizeSessionId(sessionId));
  return claimId ? tabClaims.get(claimId) || null : null;
};

const claimForClient = (client) => {
  cleanupExpiredTabClaims();
  const claim =
    [...tabClaims.values()].find(
      (item) => item.clientId === client?.clientId || clientCarriesClaim(client, item),
    ) || null;
  if (claim && client?.clientId && claim.clientId !== client.clientId) {
    rebindTabClaimToClient(claim, client, 'client-tab-claim-heartbeat');
  }
  return claim;
};

const removeTabClaim = (claimId) => {
  const claim = tabClaims.get(claimId);
  if (!claim) return null;
  tabClaims.delete(claimId);
  if (sessionClaims.get(claim.sessionId) === claimId) {
    sessionClaims.delete(claim.sessionId);
  }
  return claim;
};

const ambiguousTabsError = (liveClients, selector = {}) => {
  const error = new Error(
    'Há várias abas do Gemini conectadas. Pela CLI, rode `gemini-md-export tabs list --plain` e depois `gemini-md-export tabs claim --index <n> --plain`. Nao chame gemini_tabs como fallback se a meta era evitar JSON na tela.',
  );
  error.code = 'ambiguous_gemini_tabs';
  error.data = {
    sessionId: normalizeSessionId(selector.sessionId),
    connectedTabs: liveClients.map((client) => ({
      clientId: client.clientId,
      tabId: client.tabId ?? null,
      windowId: client.windowId ?? null,
      isActiveTab: client.isActiveTab ?? null,
      title: client.page?.title || null,
      url: client.page?.url || null,
      chatId: client.page?.chatId || null,
      tabClaim: summarizeTabClaim(claimForClient(client)),
    })),
    claims: summarizeTabClaims(),
  };
  return error;
};

const reconnectSourceForClient = (client) => {
  if (!client) return null;
  return Array.from(clients.values())
    .filter((candidate) => candidate.clientId !== client.clientId)
    .filter((candidate) => {
      const sameTab =
        client.tabId !== null &&
        client.tabId !== undefined &&
        candidate.tabId !== null &&
        candidate.tabId !== undefined &&
        Number(client.tabId) === Number(candidate.tabId);
      if (sameTab) return true;
      const claim = claimForClient(candidate);
      return claim ? clientCarriesClaim(client, claim) : false;
    })
    .sort((a, b) => (b.conversations?.length || 0) - (a.conversations?.length || 0))[0] || null;
};

const preserveReconnectConversationCache = (client, payload = {}) => {
  const source = reconnectSourceForClient(client);
  if (!source?.conversations?.length) return;
  const incomingCount = Array.isArray(payload.conversations) ? payload.conversations.length : 0;
  const currentCount = client.conversations?.length || 0;
  if (Math.max(incomingCount, currentCount) >= source.conversations.length) return;
  client.conversations = source.conversations;
  client.modalConversations = source.modalConversations || client.modalConversations || [];
  client.lastSnapshot = source.lastSnapshot || client.lastSnapshot || null;
  client.lastSnapshotAt = source.lastSnapshotAt || client.lastSnapshotAt || null;
  client.lastSnapshotPayloadBytes =
    source.lastSnapshotPayloadBytes ?? client.lastSnapshotPayloadBytes ?? null;
  client.snapshotHash = source.snapshotHash || client.snapshotHash || null;
  recordFlightEvent('client_reconnect_cache_preserved', {
    previousClientId: source.clientId,
    nextClientId: client.clientId,
    tabId: client.tabId ?? null,
    conversationCount: source.conversations.length,
  });
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
  if (!existing) {
    recordFlightEvent('client_connected', {
      clientId: payload.clientId,
      tabId: payload.tabId ?? null,
      windowId: payload.windowId ?? null,
      extensionVersion: payload.extensionVersion || null,
      protocolVersion: payload.protocolVersion ?? null,
      buildStamp: payload.buildStamp || payload.page?.buildStamp || null,
    });
  }

  const now = Date.now();
  next.lastSeenAt = now;
  if (meta.heartbeat === true) {
    next.lastHeartbeatAt = now;
    next.lastHeartbeatPayloadBytes = meta.payloadBytes ?? next.lastHeartbeatPayloadBytes ?? null;
    recordPayloadMetric(next, 'heartbeat', meta.payloadBytes);
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
  next.tabClaim = payload.tabClaim || next.tabClaim || null;
  next.page = payload.page || next.page || null;
  next.commandPoll = payload.commandPoll || next.commandPoll || null;
  preserveReconnectConversationCache(next, payload);
  if (Array.isArray(payload.conversations)) {
    next.conversations =
      (next.conversations?.length || 0) > payload.conversations.length
        ? next.conversations
        : payload.conversations;
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
  const claim = claimForClient(next);
  if (claim) rebindTabClaimToClient(claim, next, 'client-upsert');
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
      tabClaim: payload.tabClaim,
    },
    {
      ...meta,
      heartbeat: false,
    },
  );
  const now = Date.now();
  client.lastSnapshotAt = now;
  client.lastSnapshotPayloadBytes = meta.payloadBytes ?? null;
  recordPayloadMetric(client, 'snapshot', meta.payloadBytes);
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

const markClientCommandTimeout = (clientId, type, { dispatched = false, code = 'command_timeout' } = {}) => {
  const client = clients.get(clientId);
  if (!client) return;
  const now = Date.now();
  client.lastCommandTimeoutAt = now;
  client.lastCommandTimeoutIso = new Date(now).toISOString();
  client.lastCommandTimeoutType = type || null;
  client.lastCommandTimeoutDispatched = dispatched === true;
  client.lastCommandTimeoutCode = code;
};

const clearClientCommandTimeout = (client) => {
  if (!client) return;
  client.lastCommandTimeoutAt = null;
  client.lastCommandTimeoutIso = null;
  client.lastCommandTimeoutType = null;
  client.lastCommandTimeoutDispatched = null;
  client.lastCommandTimeoutCode = null;
};

const clientHasRecentCommandFailure = (client, now = Date.now()) =>
  !!client?.lastCommandTimeoutAt &&
  now - Number(client.lastCommandTimeoutAt) <= COMMAND_CHANNEL_FAILURE_COOLDOWN_MS;

const enqueueCommand = (clientId, type, args = {}, options = {}) => {
  const client = clients.get(clientId);
  if (!client) {
    const error = new Error(`Cliente ${clientId} não encontrado.`);
    error.code = 'client_not_found';
    error.clientId = clientId;
    error.commandType = type;
    throw error;
  }

  const command = {
    id: randomUUID(),
    type,
    args,
    createdAt: new Date().toISOString(),
  };
  recordFlightEvent('command_enqueued', {
    commandId: command.id,
    clientId,
    type,
    timeoutMs: options.timeoutMs || COMMAND_TIMEOUT_MS,
    dispatchTimeoutMs: options.dispatchTimeoutMs ?? COMMAND_DISPATCH_TIMEOUT_MS,
  });

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
      markClientCommandTimeout(clientId, type, {
        dispatched: !!pending.dispatchedAt,
        code: 'command_timeout',
      });
      recordFlightEvent('command_timeout', {
        commandId: command.id,
        clientId,
        type,
        dispatched: !!pending.dispatchedAt,
      });
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
        markClientCommandTimeout(clientId, type, {
          dispatched: false,
          code: 'command_dispatch_timeout',
        });
        recordFlightEvent('command_dispatch_timeout', {
          commandId: command.id,
          clientId,
          type,
        });
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
  const client = clients.get(pending.clientId);
  if (client) {
    client.lastSeenAt = Date.now();
    client.lastCommandResultAt = new Date().toISOString();
    clearClientCommandTimeout(client);
  }
  recordFlightEvent('command_resolved', {
    commandId,
    clientId: pending.clientId,
    type: pending.type,
    dispatched: !!pending.dispatchedAt,
  });
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

const requireClient = (selector = {}) => {
  cleanupStaleClients();
  cleanupExpiredTabClaims();
  const normalized = normalizeClientSelector(selector);
  const selectableClients = getSelectableGeminiClients();
  if (selectableClients.length === 0) {
    throw new Error('Nenhuma aba do Gemini conectada à extensão.');
  }

  if (normalized.claimId) {
    const claim = tabClaims.get(normalized.claimId);
    const claimClient = liveClientForClaim(claim);
    if (!claim || !claimClient) {
      throw new Error(`Claim ${normalized.claimId} não está ativa.`);
    }
    return claimClient;
  }

  if (normalized.clientId) {
    const client = selectableClients.find((item) => item.clientId === normalized.clientId);
    if (!client) {
      throw new Error(`Cliente ${normalized.clientId} não está ativo.`);
    }
    return client;
  }

  if (normalized.tabId !== null) {
    const client = selectableClients.find((item) => Number(item.tabId) === normalized.tabId);
    if (!client) {
      throw new Error(`Aba ${normalized.tabId} não está ativa.`);
    }
    return client;
  }

  const sessionClaim = claimForSession(normalized.sessionId);
  const sessionClaimClient = liveClientForClaim(sessionClaim);
  if (sessionClaimClient) return sessionClaimClient;

  if (selectableClients.length === 1) {
    return selectableClients[0];
  }

  throw ambiguousTabsError(selectableClients, normalized);
};

const isNotebookClient = (client) =>
  client?.page?.kind === 'notebook' ||
  String(client?.page?.pathname || '').startsWith('/notebook/') ||
  (client?.conversations || []).some((conversation) => conversation.source === 'notebook');

const requireNotebookClient = (selector = {}) => {
  const normalized = normalizeClientSelector(selector);
  if (normalized.clientId || normalized.tabId !== null || normalized.claimId) {
    const client = requireClient(normalized);
    if (!isNotebookClient(client)) {
      throw new Error(`Cliente ${client.clientId} não está em uma página de caderno.`);
    }
    return client;
  }

  cleanupStaleClients();
  cleanupExpiredTabClaims();
  const sessionClaim = claimForSession(normalized.sessionId);
  const sessionClaimClient = liveClientForClaim(sessionClaim);
  if (sessionClaimClient) {
    if (!isNotebookClient(sessionClaimClient)) {
      throw new Error(`Cliente ${sessionClaimClient.clientId} não está em uma página de caderno.`);
    }
    return sessionClaimClient;
  }

  const notebookClients = getSelectableGeminiClients().filter(isNotebookClient);
  if (notebookClients.length > 1) {
    throw ambiguousTabsError(notebookClients, normalized);
  }
  const client = notebookClients[0];
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

const selectClaimableClient = async (args = {}) => {
  cleanupStaleClients();
  cleanupExpiredTabClaims();
  let liveClients = getSelectableGeminiClients();
  const openIfMissing = args.openIfMissing !== false && args.wakeBrowser !== false;

  if (liveClients.length === 0 && openIfMissing) {
    await launchChromeForGemini({
      profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
    });
    await waitForLiveClients(
      normalizeWaitMs(args.waitMs, BROWSER_STATUS_WAKE_WAIT_MS),
      CHROME_GUARD_CONFIG.pollIntervalMs || 500,
    );
    liveClients = getSelectableGeminiClients();
  }

  if (Number.isInteger(Number(args.index))) {
    const index = Number(args.index);
    if (index < 1 || index > liveClients.length) {
      throw new Error(`Índice de aba inválido: ${args.index}.`);
    }
    return liveClients[index - 1];
  }

  const chatId = String(args.chatId || '').trim().toLowerCase();
  if (chatId) {
    const match = liveClients.find(
      (client) =>
        String(client.page?.chatId || '').toLowerCase() === chatId ||
        (client.conversations || []).some(
          (conversation) => String(conversation.chatId || '').toLowerCase() === chatId,
        ),
    );
    if (match) return match;
    throw new Error(`Nenhuma aba conectada corresponde ao chatId ${chatId}.`);
  }

  return requireClient(args);
};

const claimTabForClient = async (client, args = {}) => {
  cleanupExpiredTabClaims();
  const sessionId = normalizeSessionId(args.sessionId || args._proxySessionId);
  const ttlMs = normalizeClaimTtlMs(args.ttlMs);
  const now = Date.now();
  const existingSessionClaim = claimForSession(sessionId);
  const existingClientClaim = claimForClient(client);

  if (
    existingSessionClaim &&
    existingSessionClaim.clientId !== client.clientId &&
    args.force !== true
  ) {
    const error = new Error(
      'Esta sessão já reivindicou outra aba Gemini. Libere a claim atual ou use force=true para trocar.',
    );
    error.code = 'tab_claim_conflict';
    error.data = {
      currentClaim: summarizeTabClaim(existingSessionClaim),
      requestedClient: summarizeClient(client),
    };
    throw error;
  }

  if (
    existingSessionClaim &&
    existingSessionClaim.clientId !== client.clientId &&
    args.force === true
  ) {
    await releaseTabClaim({ claimId: existingSessionClaim.claimId, reason: 'claim-replaced' });
  }

  if (
    existingClientClaim &&
    existingClientClaim.sessionId !== sessionId &&
    args.force !== true
  ) {
    const error = new Error(
      'Esta aba Gemini já está reivindicada por outra sessão. Escolha outra aba ou use force=true para tomar a claim.',
    );
    error.code = 'tab_claim_conflict';
    error.data = {
      currentClaim: summarizeTabClaim(existingClientClaim),
      requestedSessionId: sessionId,
    };
    throw error;
  }

  if (
    existingClientClaim &&
    existingClientClaim.sessionId !== sessionId &&
    args.force === true
  ) {
    await releaseTabClaim({ claimId: existingClientClaim.claimId, reason: 'claim-taken-over' });
  }

  const claimId =
    existingSessionClaim?.clientId === client.clientId
      ? existingSessionClaim.claimId
      : normalizeClaimId(args.claimId);
  const label = labelForSession(sessionId, args.label);
  const color = args.color || colorForSession(sessionId);
  const expiresAtMs = now + ttlMs;

  const ready = await ensureBrowserExtensionReady(
    { clientId: client.clientId },
    {
      allowLaunchChrome: false,
      allowReload: args.allowReload !== false,
    },
  );
  const readyClient = ready.client || client;

  const visual = await enqueueCommand(
    readyClient.clientId,
    'claim-tab',
    {
      claimId,
      sessionId,
      label,
      color,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    {
      timeoutMs: 10_000,
      dispatchTimeoutMs: 5000,
    },
  );

  if (!visual?.ok) {
    const error = new Error(
      `Não consegui aplicar o indicador visual na aba Gemini (${visual?.reason || visual?.error || 'sem resposta'}).`,
    );
    error.code = 'tab_claim_visual_failed';
    error.data = { visual, client: summarizeClient(readyClient) };
    throw error;
  }

  const claim = {
    claimId,
    sessionId,
    clientId: readyClient.clientId,
    tabId: readyClient.tabId ?? null,
    windowId: readyClient.windowId ?? null,
    label,
    color,
    visual: visual.visual || visual,
    createdAt: existingSessionClaim?.createdAt || new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAtMs,
  };
  tabClaims.set(claimId, claim);
  sessionClaims.set(sessionId, claimId);

  return {
    ok: true,
    client: summarizeClient(readyClient),
    claim: summarizeTabClaim(claim),
    visual,
    reloadAttempts: ready.reloadAttempts || 0,
  };
};

const releaseTabClaim = async (args = {}) => {
  cleanupExpiredTabClaims();
  const sessionId = normalizeSessionId(args.sessionId || args._proxySessionId);
  const claimId = args.claimId || sessionClaims.get(sessionId);
  if (!claimId) {
    return {
      ok: false,
      reason: 'no-claim-for-session',
      sessionId,
      claims: summarizeTabClaims(),
    };
  }

  const claim = tabClaims.get(claimId);
  if (!claim) {
    sessionClaims.delete(sessionId);
    return {
      ok: false,
      reason: 'claim-not-found',
      claimId,
      sessionId,
      claims: summarizeTabClaims(),
    };
  }

  let visual = null;
  let client = liveClientForClaim(claim);
  if (!client) {
    const recoveredClient = await waitForContinuationClient(
      {
        clientId: claim.clientId,
        tabId: claim.tabId,
        sessionId: claim.sessionId,
      },
      {
        claimId,
        tabId: claim.tabId,
        sessionId: claim.sessionId,
      },
    );
    client = isLiveClient(clients.get(recoveredClient?.clientId))
      ? clients.get(recoveredClient.clientId)
      : null;
  }
  if (client) {
    try {
      visual = await enqueueCommand(
        client.clientId,
        'release-tab-claim',
        {
          claimId,
          reason: args.reason || 'mcp-release',
        },
        {
          timeoutMs: 8000,
          dispatchTimeoutMs: 4000,
        },
      );
    } catch (err) {
      visual = {
        ok: false,
        error: err?.message || String(err),
        code: err?.code || null,
      };
    }
  }
  if (visual?.ok !== true && claim.tabId !== null && claim.tabId !== undefined) {
    const controllers = getSelectableGeminiClients().filter(
      (candidate) => candidate.clientId !== client?.clientId,
    );
    for (const controller of controllers) {
      try {
        visual = await enqueueCommand(
          controller.clientId,
          'release-tab-claim-by-tab-id',
          {
            tabId: claim.tabId,
            claimId,
            reason: args.reason || 'mcp-release-by-tab-id',
          },
          {
            timeoutMs: 8000,
            dispatchTimeoutMs: 4000,
          },
        );
        if (visual?.ok) break;
      } catch (err) {
        visual = {
          ok: false,
          error: err?.message || String(err),
          code: err?.code || null,
        };
      }
    }
  }

  const removed = removeTabClaim(claimId);
  return {
    ok: true,
    released: summarizeTabClaim(removed),
    visual,
    client: client ? summarizeClient(client) : null,
  };
};

const shouldAutoReleaseTabClaim = (args = {}) =>
  args.autoReleaseClaim !== false && args.keepClaim !== true;

const tabClaimMinVisibleMs = (args = {}) => {
  const parsed = Number(args.claimMinVisibleMs ?? TAB_CLAIM_MIN_VISIBLE_MS);
  if (!Number.isFinite(parsed) || parsed < 0) return TAB_CLAIM_MIN_VISIBLE_MS;
  return Math.min(15_000, parsed);
};

const waitForTabClaimMinimumVisibility = async (claimedAtMs, args = {}) => {
  if (!claimedAtMs) return;
  const remainingMs = tabClaimMinVisibleMs(args) - (Date.now() - claimedAtMs);
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
};

const autoReleaseTabClaimForJob = async (job, reason) => {
  if (!job?.autoReleaseTabClaim || !job.tabClaimId || job.tabClaimRelease) {
    return job?.tabClaimRelease || null;
  }
  try {
    job.tabClaimRelease = await releaseTabClaim({
      claimId: job.tabClaimId,
      reason,
    });
  } catch (err) {
    job.tabClaimRelease = {
      ok: false,
      claimId: job.tabClaimId,
      error: err?.message || String(err),
      code: err?.code || null,
    };
  }
  return job.tabClaimRelease;
};

const ensureTabClaimForJob = async (client, args = {}, label = 'GME Job') => {
  const sessionId = normalizeSessionId(args.sessionId || args._proxySessionId);
  const existingSessionClaim = claimForSession(sessionId);
  if (existingSessionClaim?.clientId === client.clientId && args.renewExistingClaim === false) {
    return summarizeTabClaim(existingSessionClaim);
  }
  if (args.autoClaim === false) {
    return existingSessionClaim?.clientId === client.clientId
      ? summarizeTabClaim(existingSessionClaim)
      : null;
  }
  const result = await claimTabForClient(client, {
    ...args,
    sessionId,
    label: args.label || label,
  });
  return result.claim;
};

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
    action = 'Rode gemini_ready { action: "status", diagnostic: true } para tentar recarregar a extensão automaticamente.';
  } else if (heartbeatAgeMs === null || heartbeatAgeMs > CLIENT_STALE_MS) {
    status = 'stale';
    blockingIssue = 'stale_client';
    action = 'Recarregue a aba do Gemini ou chame gemini_ready { action: "status", diagnostic: true } para reconectar.';
  } else if (!eventStreamConnected && !longPollConnected && pagePolling !== true) {
    status = 'command_channel_stuck';
    blockingIssue = 'command_channel_stuck';
    action = 'Use gemini_tabs { action: "reload", intent: "tab_management" } se a aba estiver aberta mas não aceitar comandos.';
  } else if (clientHasRecentCommandFailure(client, now)) {
    status = 'command_channel_stuck';
    blockingIssue = 'command_timeout_recent';
    action = 'Esta aba acabou de ignorar um comando; a CLI deve preferir outra aba Gemini saudável.';
  } else if (heartbeatAgeMs > CLIENT_DEGRADED_HEARTBEAT_MS) {
    status = 'degraded';
    blockingIssue = 'heartbeat_delayed';
    action = 'Aguarde alguns segundos; se persistir, rode gemini_ready { action: "status", diagnostic: true }.';
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
    payloadMetrics: summarizePayloadMetrics(client),
    capabilities: client.capabilities || [],
    lastError: client.metrics?.lastError || null,
    lastCommandTimeoutAt: client.lastCommandTimeoutIso || null,
    lastCommandTimeoutType: client.lastCommandTimeoutType || null,
    lastCommandTimeoutCode: client.lastCommandTimeoutCode || null,
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
    lastCommandTimeoutAt: client.lastCommandTimeoutIso || null,
    lastCommandTimeoutType: client.lastCommandTimeoutType || null,
    lastCommandTimeoutCode: client.lastCommandTimeoutCode || null,
  },
  page: client.page || null,
  tabClaim: client.tabClaim || null,
  serverClaim: summarizeTabClaim(claimForClient(client)),
  bridgeHealth: buildBridgeHealth(client),
  payloadMetrics: summarizePayloadMetrics(client),
  listedConversationCount: client.conversations?.length || 0,
  sidebarConversationCount: recentConversationsForClient(client).length,
  notebookConversationCount: notebookConversationsForClient(client).length,
});

const clientHasOpenCommandChannel = (client) =>
  (!!client?.eventStream?.res && !client.eventStream.res.destroyed) ||
  !!client?.pendingPoll ||
  client?.commandPoll?.polling === true;

const commandChannelReadyForClient = (client) =>
  clientHasOpenCommandChannel(client) && !clientHasRecentCommandFailure(client);

const browserReadyBlockingIssue = ({
  allLiveClients = [],
  selectableClients = [],
  matchingClients = [],
  commandReadyClients = [],
} = {}) => {
  if (allLiveClients.length === 0) return 'no_connected_clients';
  if (matchingClients.length === 0) return 'extension_version_mismatch';
  if (selectableClients.length === 0) return 'no_selectable_gemini_tab';
  if (commandReadyClients.length === 0) return 'command_channel_not_ready';
  return null;
};

const buildLightweightBrowserReady = async (args = {}) => {
  const startedAt = Date.now();
  cleanupStaleClients();
  let selfHeal = {
    attempted: false,
    reason: args.selfHeal === true ? 'not-run' : 'disabled',
  };
  let launchResult = null;
  let waitedMs = 0;

  if (args.selfHeal === true) {
    try {
      const ready = await ensureBrowserExtensionReady(
        {
          clientId: args.clientId || null,
        },
        {
          allowLaunchChrome: args.wakeBrowser !== false,
          allowReload: args.allowReload !== false,
          config: {
            initialConnectTimeoutMs: normalizeWaitMs(args.initialWaitMs, 1000),
            reloadTimeoutMs: normalizeReloadWaitMs(args.reloadWaitMs, 30_000),
          },
        },
      );
      selfHeal = {
        attempted: true,
        ok: true,
        reloadAttempts: ready.reloadAttempts || 0,
        launchedChrome: ready.launchedChrome === true,
        timings: ready.timings || null,
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

  let allLiveClients = getLiveClients();
  let selectableClients = getSelectableGeminiClients();
  if (
    selectableClients.length === 0 &&
    args.wakeBrowser === true &&
    CHROME_GUARD_CONFIG.launchIfClosed
  ) {
    launchResult = await launchChromeForGemini({
      profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
    });
    const waitStartedAt = Date.now();
    await waitForLiveClients(
      normalizeWaitMs(args.waitMs, BROWSER_STATUS_WAKE_WAIT_MS),
      CHROME_GUARD_CONFIG.pollIntervalMs || 500,
    );
    waitedMs = Math.max(0, Date.now() - waitStartedAt);
    allLiveClients = getLiveClients();
    selectableClients = getSelectableGeminiClients();
  }

  const matchingClients = allLiveClients.filter(clientMatchesExpectedBrowserExtension);
  const commandReadyClients = matchingClients.filter(commandChannelReadyForClient);
  const mode =
    (selfHeal.reloadAttempts || 0) > 0
      ? 'post-update'
      : launchResult?.attempted || waitedMs > 0 || (selfHeal.timings?.initialWaitMs || 0) > 0
        ? 'cold'
        : 'hot';
  const ready = selectableClients.length > 0 && commandReadyClients.length > 0;
  const blockingIssue = ready
    ? null
    : browserReadyBlockingIssue({
        allLiveClients,
        selectableClients,
        matchingClients,
        commandReadyClients,
      });
  const summarizedClients = selectableClients.map(summarizeClient);
  const summarizedMatchingClients = matchingClients.map(summarizeClient);
  return {
    ok: ready,
    ready,
    blockingIssue,
    mode,
    generatedAt: new Date().toISOString(),
    expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
    sessionId: PROCESS_SESSION_ID,
    connectedClientCount: allLiveClients.length,
    selectableTabCount: selectableClients.length,
    matchingClientCount: matchingClients.length,
    commandReadyClientCount: commandReadyClients.length,
    timings: {
      totalMs: Math.max(0, Date.now() - startedAt),
      bridgeReadyMs: 0,
      extensionInfoMs: selfHeal.timings?.extensionInfoMs ?? 0,
      reloadMs: selfHeal.timings?.reloadMs ?? 0,
      firstHeartbeatMs: waitedMs || selfHeal.timings?.initialWaitMs || 0,
      firstSnapshotMs: null,
      commandChannelReadyMs: commandReadyClients.length > 0 ? 0 : null,
      guard: selfHeal.timings || null,
    },
    clients: summarizedClients,
    diagnosticClients: tabSelectionDiagnostics(allLiveClients, selectableClients),
    extensionReadiness: buildExtensionReadiness({
      connectedClients: allLiveClients.map(summarizeClient),
      matchingClients: summarizedMatchingClients,
      selfHeal,
    }),
    selfHeal,
    browserWake: launchResult
      ? {
          ...launchResult,
          waitedMs,
          connectedAfterWake: allLiveClients.length,
        }
      : {
          attempted: false,
          reason: selectableClients.length > 0 ? 'already-connected' : 'wake-disabled',
        },
  };
};

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

const clientHasConcreteTabIdentity = (client) =>
  client?.tabId !== undefined && client?.tabId !== null;

const clientIsSelectableGeminiTab = (client) =>
  isLiveClient(client) &&
  clientHasConcreteTabIdentity(client) &&
  clientMatchesExpectedBrowserExtension(client);

const getSelectableGeminiClients = () => {
  const liveClients = getLiveClients();
  const healthyTabs = liveClients.filter(clientIsSelectableGeminiTab);
  if (healthyTabs.length > 0) return healthyTabs;
  const matchingClients = liveClients.filter(clientMatchesExpectedBrowserExtension);
  return matchingClients.length > 0 ? matchingClients : liveClients;
};

const tabSelectionDiagnostics = (liveClients, selectableClients) => {
  const selectableIds = new Set(selectableClients.map((client) => client.clientId));
  return liveClients
    .filter((client) => !selectableIds.has(client.clientId))
    .map((client) => ({
      ...summarizeClient(client),
      demotedFromTabSelection: true,
      demotionReason: !clientHasConcreteTabIdentity(client)
        ? 'missing-tab-id'
        : !clientMatchesExpectedBrowserExtension(client)
          ? 'version-or-build-mismatch'
          : 'not-selected',
    }));
};

const requireRecentChatsClient = (selector = {}) => {
  const normalized = normalizeClientSelector(selector);
  if (normalized.clientId || normalized.tabId !== null || normalized.claimId) {
    return requireClient(normalized);
  }

  cleanupStaleClients();
  cleanupExpiredTabClaims();
  const liveClients = getSelectableGeminiClients();
  if (liveClients.length === 0) {
    throw new Error('Nenhuma aba do Gemini conectada à extensão.');
  }
  const commandReadyClients = liveClients.filter(commandChannelReadyForClient);
  const selectableClients = commandReadyClients.length > 0 ? commandReadyClients : liveClients;
  const usefulRecentClients = selectableClients.filter(
    (client) => recentConversationCountForClient(client) > 0 || !!client.page?.chatId,
  );
  const candidateClients = usefulRecentClients.length > 0 ? usefulRecentClients : selectableClients;

  const sessionClaim = claimForSession(normalized.sessionId);
  const sessionClaimClient = liveClientForClaim(sessionClaim);
  if (sessionClaimClient) return sessionClaimClient;

  if (selector.preferActive === true) {
    const activeClients = candidateClients.filter((client) => client.isActiveTab === true);
    if (activeClients.length === 1) return activeClients[0];
  }

  if (candidateClients.length > 1) {
    throw ambiguousTabsError(candidateClients, normalized);
  }

  return [...candidateClients].sort(
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

const SYNC_STATE_DIR = '.gemini-md-export';
const SYNC_STATE_FILENAME = 'sync-state.json';
const DEFAULT_SYNC_BOUNDARY_KNOWN_SEQUENCE = Math.max(
  3,
  Math.min(100, Number(process.env.GEMINI_MCP_SYNC_BOUNDARY_KNOWN_SEQUENCE || 25)),
);

const resolveVaultSyncStateFile = (vaultDir, syncStateFile = null) => {
  if (syncStateFile) return resolveOutputDir(syncStateFile);
  const rootDir = resolveOutputDir(vaultDir);
  return resolve(rootDir, SYNC_STATE_DIR, SYNC_STATE_FILENAME);
};

const readVaultSyncState = (vaultDir, syncStateFile = null) => {
  const filePath = resolveVaultSyncStateFile(vaultDir, syncStateFile);
  try {
    if (!existsSync(filePath)) {
      return {
        filePath,
        exists: false,
        state: null,
      };
    }
    const state = readJsonFile(filePath);
    return {
      filePath,
      exists: true,
      state,
    };
  } catch (err) {
    return {
      filePath,
      exists: false,
      state: null,
      error: err.message,
    };
  }
};

const writeVaultSyncState = (vaultDir, state, syncStateFile = null) => {
  const filePath = resolveVaultSyncStateFile(vaultDir, syncStateFile);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return filePath;
};

const syncBoundaryChatIds = (state = {}) => {
  const ids = new Set();
  const add = (value) => {
    const chatId = chatIdFromText(value);
    if (chatId) ids.add(chatId);
  };
  add(state?.topChatId);
  for (const chatId of Array.isArray(state?.boundaryChatIds) ? state.boundaryChatIds : []) add(chatId);
  return ids;
};

const findSyncBoundary = (conversations = [], { vaultScan, syncState, knownSequenceCount } = {}) => {
  const stateBoundaryIds = syncBoundaryChatIds(syncState);
  const knownTarget = Math.max(1, Number(knownSequenceCount || DEFAULT_SYNC_BOUNDARY_KNOWN_SEQUENCE));
  let knownRunStart = null;
  let knownRunLength = 0;

  for (let index = 0; index < conversations.length; index += 1) {
    const chatId = normalizeConversationChatId(conversations[index]).toLowerCase();
    if (!chatId) {
      knownRunStart = null;
      knownRunLength = 0;
      continue;
    }
    if (stateBoundaryIds.has(chatId)) {
      return {
        found: true,
        type: 'sync-state-boundary',
        chatId,
        index,
        knownSequenceLength: knownRunLength,
      };
    }
    if (vaultScan?.chatIds?.has(chatId)) {
      if (knownRunStart === null) knownRunStart = index;
      knownRunLength += 1;
      if (knownRunLength >= knownTarget) {
        return {
          found: true,
          type: 'known-vault-sequence',
          chatId,
          index: knownRunStart,
          knownSequenceLength: knownRunLength,
        };
      }
    } else {
      knownRunStart = null;
      knownRunLength = 0;
    }
  }

  return {
    found: false,
    type: 'not-found',
    chatId: null,
    index: null,
    knownSequenceLength: knownRunLength,
  };
};

const loadRecentChatsUntilSyncBoundaryForClient = async (client, args = {}, { vaultScan, syncState } = {}) => {
  let activeClient = resolveContinuationClient(client, args);
  let targetCount = Math.max(10, Math.min(200, Number(args.batchSize || 50)));
  const maxRounds = Math.max(1, Math.min(500, Number(args.maxLoadMoreRounds || 200)));
  const attempts = Math.max(1, Math.min(5, Number(args.loadMoreAttempts || 3)));
  const knownSequenceCount = Math.max(
    1,
    Math.min(100, Number(args.knownBoundaryCount || DEFAULT_SYNC_BOUNDARY_KNOWN_SEQUENCE)),
  );
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
  const loadTrace = [];
  let boundary = { found: false, type: 'not-found' };
  let reachedEnd = recentChatsReachedEndForClient(activeClient);
  let timedOut = false;
  let roundsCompleted = 0;
  let previousCount = recentConversationsForClient(activeClient).length;
  let noGrowthRounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    if (args.shouldStop?.()) break;
    activeClient = resolveContinuationClient(activeClient, args);
    const beforeCount = recentConversationsForClient(activeClient).length;
    const startedAt = Date.now();
    const command = await enqueueCommandWithClientRecovery(
      activeClient,
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
      args,
    );
    activeClient = command.client;
    const { result } = command;

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar histórico até a fronteira do sync.');
    }

    if (Array.isArray(result.conversations)) {
      activeClient.conversations = result.conversations;
    }
    if (result.snapshot) {
      activeClient.lastSnapshot = result.snapshot;
    }

    const conversations = recentConversationsForClient(activeClient);
    boundary = findSyncBoundary(conversations, {
      vaultScan,
      syncState,
      knownSequenceCount,
    });
    reachedEnd = result.reachedEnd === true || recentChatsReachedEndForClient(activeClient);
    timedOut = timedOut || result.timedOut === true;
    roundsCompleted += 1;
    const afterCount = Math.max(conversations.length, Number(result.afterCount || 0));
    const delta = Math.max(0, afterCount - beforeCount);
    const grew = result.loadedAny === true || afterCount > previousCount;
    noGrowthRounds = grew ? 0 : noGrowthRounds + 1;
    loadTrace.push({
      round: round + 1,
      beforeCount,
      targetCount,
      afterCount,
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
      boundary,
      browserTrace: Array.isArray(result.loadTrace) ? result.loadTrace : [],
      elapsedMs: Date.now() - startedAt,
    });

    if (boundary.found || reachedEnd) break;
    if (!grew && noGrowthRounds >= maxNoGrowthRounds) break;
    if (afterCount > previousCount) previousCount = afterCount;
    targetCount = Math.min(MAX_RECENT_CHATS_LOAD_TARGET, targetCount + Math.max(10, Number(args.batchSize || 50)));
    if (targetCount >= MAX_RECENT_CHATS_LOAD_TARGET && afterCount >= MAX_RECENT_CHATS_LOAD_TARGET) break;
  }

  return {
    attempted: roundsCompleted > 0,
    roundsCompleted,
    reachedEnd,
    timedOut,
    noGrowthRounds,
    loadTrace,
    boundary,
    conversations: recentConversationsForClient(activeClient),
    client: activeClient,
  };
};

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
const bridgeAssetHostBackoff = new Map();
const bridgeAssetFetchQueue = [];
let bridgeAssetActiveFetches = 0;
const bridgeAssetMetrics = {
  requests: 0,
  fetched: 0,
  queued: 0,
  cacheHits: 0,
  cacheExpired: 0,
  inFlightDeduped: 0,
  failures: 0,
  backoffHits: 0,
  bytesFetched: 0,
  byHost: new Map(),
};

const bridgeAssetHostMetric = (host) => {
  const key = host || 'unknown';
  const metric =
    bridgeAssetMetrics.byHost.get(key) ||
    {
      requests: 0,
      fetched: 0,
      queued: 0,
      cacheHits: 0,
      cacheExpired: 0,
      inFlightDeduped: 0,
      failures: 0,
      backoffHits: 0,
      bytesFetched: 0,
      lastError: null,
      backoffUntil: null,
    };
  bridgeAssetMetrics.byHost.set(key, metric);
  return metric;
};

const recordBridgeAssetMetric = (host, kind, details = {}) => {
  if (bridgeAssetMetrics[kind] !== undefined) {
    bridgeAssetMetrics[kind] += details.delta ?? 1;
  }
  const hostMetric = bridgeAssetHostMetric(host);
  if (hostMetric[kind] !== undefined) {
    hostMetric[kind] += details.delta ?? 1;
  }
  if (details.bytes) {
    bridgeAssetMetrics.bytesFetched += details.bytes;
    hostMetric.bytesFetched += details.bytes;
  }
  if (details.error) {
    hostMetric.lastError = details.error;
  }
  if (details.backoffUntil) {
    hostMetric.backoffUntil = details.backoffUntil;
  }
};

const topBridgeAssetHosts = () =>
  Array.from(bridgeAssetMetrics.byHost.entries())
    .map(([host, metric]) => ({ host, ...metric }))
    .sort(
      (a, b) =>
        b.requests - a.requests ||
        b.failures - a.failures ||
        b.bytesFetched - a.bytesFetched,
    )
    .slice(0, 20);

const snapshotBridgeAssetMetrics = () => ({
  requests: bridgeAssetMetrics.requests,
  fetched: bridgeAssetMetrics.fetched,
  queued: bridgeAssetMetrics.queued,
  cacheHits: bridgeAssetMetrics.cacheHits,
  cacheExpired: bridgeAssetMetrics.cacheExpired,
  inFlightDeduped: bridgeAssetMetrics.inFlightDeduped,
  failures: bridgeAssetMetrics.failures,
  backoffHits: bridgeAssetMetrics.backoffHits,
  bytesFetched: bridgeAssetMetrics.bytesFetched,
  cacheEntries: bridgeAssetCache.size,
  inFlight: bridgeAssetInFlight.size,
  maxInFlight: BRIDGE_ASSET_FETCH_MAX_IN_FLIGHT,
  activeFetches: bridgeAssetActiveFetches,
  queuedFetches: bridgeAssetFetchQueue.length,
  topHosts: topBridgeAssetHosts(),
});

const diffBridgeAssetMetrics = (baseline = {}) => {
  const current = snapshotBridgeAssetMetrics();
  const fields = [
    'requests',
    'fetched',
    'queued',
    'cacheHits',
    'cacheExpired',
    'inFlightDeduped',
    'failures',
    'backoffHits',
    'bytesFetched',
  ];
  const delta = {};
  for (const field of fields) {
    delta[field] = Math.max(0, (current[field] || 0) - (baseline[field] || 0));
  }
  return {
    ...delta,
    cacheEntries: current.cacheEntries,
    inFlight: current.inFlight,
    activeFetches: bridgeAssetActiveFetches,
    queuedFetches: bridgeAssetFetchQueue.length,
    topHosts: current.topHosts,
  };
};

const runNextBridgeAssetFetch = () => {
  if (bridgeAssetActiveFetches >= BRIDGE_ASSET_FETCH_MAX_IN_FLIGHT) return;
  const next = bridgeAssetFetchQueue.shift();
  if (!next) return;
  bridgeAssetActiveFetches += 1;
  next();
};

const withBridgeAssetFetchSlot = (host, fn) =>
  new Promise((resolvePromise, reject) => {
    const run = () => {
      Promise.resolve()
        .then(fn)
        .then(resolvePromise, reject)
        .finally(() => {
          bridgeAssetActiveFetches = Math.max(0, bridgeAssetActiveFetches - 1);
          runNextBridgeAssetFetch();
        });
    };
    if (bridgeAssetActiveFetches < BRIDGE_ASSET_FETCH_MAX_IN_FLIGHT) {
      bridgeAssetActiveFetches += 1;
      run();
      return;
    }
    recordBridgeAssetMetric(host, 'queued');
    bridgeAssetFetchQueue.push(run);
  });

const rememberBridgeAsset = (key, value) => {
  if (BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES <= 0) return;
  if (bridgeAssetCache.has(key)) bridgeAssetCache.delete(key);
  bridgeAssetCache.set(key, {
    ...value,
    cachedAt: new Date().toISOString(),
    cachedAtMs: Date.now(),
  });
  while (bridgeAssetCache.size > BRIDGE_ASSET_FETCH_CACHE_MAX_ENTRIES) {
    bridgeAssetCache.delete(bridgeAssetCache.keys().next().value);
  }
};

const readBridgeAssetCache = (cacheKey, host) => {
  const cached = bridgeAssetCache.get(cacheKey);
  if (!cached) return null;
  const cachedAtMs = Number(cached.cachedAtMs || Date.parse(cached.cachedAt || ''));
  const ageMs = Number.isFinite(cachedAtMs) ? Date.now() - cachedAtMs : Infinity;
  if (BRIDGE_ASSET_FETCH_CACHE_TTL_MS > 0 && ageMs > BRIDGE_ASSET_FETCH_CACHE_TTL_MS) {
    bridgeAssetCache.delete(cacheKey);
    recordBridgeAssetMetric(host, 'cacheExpired');
    return null;
  }
  bridgeAssetCache.delete(cacheKey);
  bridgeAssetCache.set(cacheKey, cached);
  recordBridgeAssetMetric(host, 'cacheHits');
  return {
    ...cached,
    cacheHit: true,
    inFlightDeduped: false,
    cacheAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
  };
};

const assertBridgeAssetHostNotBackedOff = (host) => {
  const state = bridgeAssetHostBackoff.get(host);
  if (!state?.untilMs || Date.now() >= state.untilMs) return;
  const until = new Date(state.untilMs).toISOString();
  recordBridgeAssetMetric(host, 'backoffHits', { backoffUntil: until });
  throw new Error(`Host de mídia temporariamente em backoff até ${until}.`);
};

const recordBridgeAssetHostSuccess = (host) => {
  bridgeAssetHostBackoff.delete(host);
};

const recordBridgeAssetHostFailure = (host, error) => {
  const previous = bridgeAssetHostBackoff.get(host) || { failures: 0, untilMs: 0 };
  const failures = previous.failures + 1;
  let untilMs = previous.untilMs || 0;
  if (failures >= BRIDGE_ASSET_HOST_BACKOFF_FAILURE_THRESHOLD) {
    const exponent = failures - BRIDGE_ASSET_HOST_BACKOFF_FAILURE_THRESHOLD;
    const waitMs = Math.min(
      BRIDGE_ASSET_HOST_BACKOFF_MAX_MS,
      BRIDGE_ASSET_HOST_BACKOFF_BASE_MS * 2 ** Math.min(8, exponent),
    );
    untilMs = Date.now() + waitMs;
  }
  const backoffUntil = untilMs ? new Date(untilMs).toISOString() : null;
  bridgeAssetHostBackoff.set(host, { failures, untilMs, lastError: error });
  recordBridgeAssetMetric(host, 'failures', {
    error,
    backoffUntil,
  });
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
  const host = url.hostname.toLowerCase();
  recordBridgeAssetMetric(host, 'requests');
  assertBridgeAssetHostNotBackedOff(host);
  const cached = readBridgeAssetCache(cacheKey, host);
  if (cached) {
    return cached;
  }
  if (bridgeAssetInFlight.has(cacheKey)) {
    const result = await bridgeAssetInFlight.get(cacheKey);
    recordBridgeAssetMetric(host, 'inFlightDeduped');
    return {
      ...result,
      cacheHit: false,
      inFlightDeduped: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_ASSET_FETCH_TIMEOUT_MS);
  const fetchPromise = withBridgeAssetFetchSlot(host, async () => {
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
  });

  bridgeAssetInFlight.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    recordBridgeAssetHostSuccess(host);
    recordBridgeAssetMetric(host, 'fetched', { bytes: result.bytes || 0 });
    rememberBridgeAsset(cacheKey, result);
    return result;
  } catch (err) {
    recordBridgeAssetHostFailure(host, err?.message || String(err));
    throw err;
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
  const commandStartedAt = Date.now();
  const command = await enqueueCommandWithClientRecovery(
    client,
    'get-chat-by-id',
    {
      item: conversation,
      returnToOriginal: args.returnToOriginal !== false,
      notebookReturnMode: args.notebookReturnMode || null,
    },
    {},
    args,
  );
  const activeClient = command.client;
  const { result } = command;
  const browserCommandMs = Date.now() - commandStartedAt;

  if (!result?.ok) {
    const error = new Error(result?.error || 'Falha ao exportar conversa no browser.');
    error.code = result?.code || null;
    error.data = result || null;
    throw error;
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

  const saveStartedAt = Date.now();
  const saved = writeExportPayloadBundle(result.payload, { outputDir: args.outputDir });
  const saveFilesMs = Date.now() - saveStartedAt;
  const savedMediaBytes = Array.isArray(saved.mediaFiles)
    ? saved.mediaFiles.reduce((sum, file) => sum + Number(file.bytes || 0), 0)
    : 0;
  const payloadMetrics = result.payload?.metrics || {};
  const metrics = {
    version: 1,
    timings: {
      browserCommandMs,
      saveFilesMs,
      ...(payloadMetrics.timings || {}),
    },
    counters: {
      ...(payloadMetrics.counters || {}),
      mediaFileCount: saved.mediaFileCount || 0,
      mediaFailureCount: saved.mediaFailureCount || 0,
      savedBytes: saved.bytes || 0,
      savedMediaBytes,
    },
    hydration: result.payload?.hydration || null,
    navigation: result.payload?.hydration?.navigation || null,
    media: payloadMetrics.media || null,
  };
  return {
    client: summarizeClient(activeClient),
    conversation: result.conversation || conversation,
    chatId: result.payload?.chatId || conversation.chatId || null,
    title: result.payload?.title || conversation.title || null,
    turns: Array.isArray(result.payload?.turns) ? result.payload.turns.length : null,
    hydration: result.payload?.hydration || null,
    returnedToOriginal: result.returnedToOriginal ?? null,
    returnError: result.returnError || null,
    metrics,
    ...saved,
  };
};

const isTransientTabBusyError = (err) =>
  err?.code === 'tab_operation_in_progress' ||
  err?.data?.code === 'tab_operation_in_progress' ||
  /tab_operation_in_progress|aba do Gemini já está ocupada|outro comando pesado|tab operation/i.test(
    String(err?.message || ''),
  );

const isRecoverableClientDisconnectError = (err) =>
  err?.code === 'client_not_found' ||
  (err?.code === 'command_timeout' && err.commandDispatched !== true) ||
  /Cliente [\w-]+ não encontrado|Cliente [\w-]+ não está ativo|Claim [\w-]+ não está ativa/i.test(
    String(err?.message || ''),
  );

const continuationSelectorForClient = (client, args = {}) => {
  const existingClaim = args.claimId ? tabClaims.get(args.claimId) : claimForClient(client);
  return {
    claimId:
      args.claimId ||
      existingClaim?.claimId ||
      clientTabClaim(client)?.claimId ||
      undefined,
    tabId:
      args.tabId ??
      existingClaim?.tabId ??
      client?.tabId ??
      undefined,
    sessionId: args.sessionId || args._proxySessionId || existingClaim?.sessionId || undefined,
  };
};

const resolveContinuationClient = (client, args = {}) => {
  cleanupStaleClients();
  cleanupExpiredTabClaims();
  const current = client?.clientId ? clients.get(client.clientId) : null;
  if (isLiveClient(current)) return current;

  const selector = continuationSelectorForClient(client, args);
  if (selector.claimId) {
    const claimClient = liveClientForClaim(tabClaims.get(selector.claimId));
    if (claimClient) return claimClient;
  }
  if (selector.tabId !== undefined && selector.tabId !== null) {
    const tabId = normalizeTabId(selector.tabId);
    const sameTab = getSelectableGeminiClients().find(
      (candidate) =>
        candidate.tabId !== null &&
        candidate.tabId !== undefined &&
        Number(candidate.tabId) === tabId,
    );
    if (sameTab) return sameTab;
  }
  const sessionClaimClient = liveClientForClaim(claimForSession(selector.sessionId));
  return sessionClaimClient || current || client;
};

const waitForContinuationClient = async (client, args = {}, waitMs = RECENT_CHATS_CLIENT_RECOVERY_WAIT_MS) => {
  const startedAt = Date.now();
  let recovered = resolveContinuationClient(client, args);
  if (recovered?.clientId && isLiveClient(clients.get(recovered.clientId))) return recovered;
  while (Date.now() - startedAt < waitMs) {
    await sleep(500);
    recovered = resolveContinuationClient(client, args);
    if (recovered?.clientId && isLiveClient(clients.get(recovered.clientId))) return recovered;
  }
  return recovered;
};

const enqueueCommandWithClientRecovery = async (
  client,
  type,
  commandArgs = {},
  options = {},
  selector = {},
) => {
  let activeClient = resolveContinuationClient(client, selector);
  try {
    const result = await enqueueCommand(activeClient.clientId, type, commandArgs, options);
    return { client: activeClient, result, recovered: activeClient.clientId !== client?.clientId };
  } catch (err) {
    if (!isRecoverableClientDisconnectError(err)) throw err;
    const recoveredClient = await waitForContinuationClient(activeClient, selector);
    if (!recoveredClient?.clientId || !isLiveClient(clients.get(recoveredClient.clientId))) {
      throw err;
    }
    const result = await enqueueCommand(recoveredClient.clientId, type, commandArgs, options);
    return { client: recoveredClient, result, recovered: true };
  }
};

const downloadConversationItemWithRetry = async (job, client, conversation, args = {}) => {
  let lastError = null;
  for (let attempt = 1; attempt <= RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT; attempt += 1) {
    try {
      return await downloadConversationItemForClient(client, conversation, args);
    } catch (err) {
      lastError = err;
      if (!isTransientTabBusyError(err) || attempt >= RECENT_CHATS_TRANSIENT_BUSY_RETRY_LIMIT) {
        throw err;
      }
      const retryDelayMs = RECENT_CHATS_TRANSIENT_BUSY_RETRY_BASE_MS * attempt;
      job.current = {
        ...(job.current || {}),
        retrying: true,
        retryAttempt: attempt,
        retryDelayMs,
        retryReason: 'tab_operation_in_progress',
      };
      touchExportJob(job);
      broadcastRecentChatsJobProgress(job, client);
      await sleep(retryDelayMs);
    }
  }
  throw lastError || new Error('Falha ao exportar conversa no browser.');
};

const downloadChatForClient = async (client, args = {}) => {
  const conversation = resolveConversationRequest(client, args);
  return downloadConversationItemForClient(client, conversation, args);
};

const refreshClientConversations = async (client, args = {}) => {
  const {
    client: activeClient,
    result,
  } = await enqueueCommandWithClientRecovery(
    client,
    'list-conversations',
    {
      ensureSidebar: args.ensureSidebar !== false,
    },
    {},
    args,
  );
  if (!result?.ok) {
    throw new Error(result?.error || 'Falha ao atualizar lista de conversas no browser.');
  }
  if (Array.isArray(result.conversations)) {
    activeClient.conversations = result.conversations;
  }
  if (result.snapshot) {
    activeClient.lastSnapshot = result.snapshot;
  }
  result.client = activeClient;
  return result;
};

const loadMoreRecentChatsForClient = async (client, requestedLimit, args = {}) => {
  let activeClient = resolveContinuationClient(client, args);
  let latestSnapshot = activeClient.lastSnapshot || null;
  let reachedEnd = recentChatsReachedEndForClient(activeClient);
  const initialCount = recentConversationsForClient(activeClient).length;
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
      conversations: recentConversationsForClient(activeClient),
      client: activeClient,
    };
  }

  let loadedAny = false;
  let timedOut = false;
  let roundsCompleted = 0;
  let previousCount = initialCount;

  for (let round = 0; round < plan.rounds; round += 1) {
    activeClient = resolveContinuationClient(activeClient, args);
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
    const command = await enqueueCommandWithClientRecovery(
      activeClient,
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
      args,
    );
    activeClient = command.client;
    const { result } = command;

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar mais conversas no browser.');
    }

    if (Array.isArray(result.conversations)) {
      activeClient.conversations = result.conversations;
    }
    if (result.snapshot) {
      activeClient.lastSnapshot = result.snapshot;
      latestSnapshot = result.snapshot;
    }

    reachedEnd = result.reachedEnd === true || recentChatsReachedEndForClient(activeClient);
    const currentCount = recentConversationsForClient(activeClient).length;
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
    conversations: recentConversationsForClient(activeClient),
    client: activeClient,
  };
};

const loadAllRecentChatsForClient = async (client, args = {}) => {
  let activeClient = resolveContinuationClient(client, args);
  let latestSnapshot = activeClient.lastSnapshot || null;
  let reachedEnd =
    args.trustCachedReachedEnd === true ? recentChatsReachedEndForClient(activeClient) : false;
  let loadedAny = false;
  let timedOut = false;
  let roundsCompleted = 0;
  let noGrowthRounds = 0;
  const loadTrace = [];
  let previousCount = recentConversationsForClient(activeClient).length;
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

    activeClient = resolveContinuationClient(activeClient, args);
    const beforeCount = previousCount;
    const targetCount = previousCount + adaptiveBatchSize;
    const roundStartedAt = Date.now();
    const command = await enqueueCommandWithClientRecovery(
      activeClient,
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
      args,
    );
    activeClient = command.client;
    const { result } = command;

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar historico completo no browser.');
    }

    if (Array.isArray(result.conversations)) {
      activeClient.conversations = result.conversations;
    }
    if (result.snapshot) {
      activeClient.lastSnapshot = result.snapshot;
      latestSnapshot = result.snapshot;
    }

    const currentCount = Math.max(
      recentConversationsForClient(activeClient).length,
      Number(result.afterCount || 0),
    );
    reachedEnd = result.reachedEnd === true || recentChatsReachedEndForClient(activeClient);
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
    const refresh = await refreshClientConversations(activeClient, { ...args, ensureSidebar: false });
    activeClient = refresh.client || activeClient;
    latestSnapshot = activeClient.lastSnapshot || latestSnapshot;
    reachedEnd = recentChatsReachedEndForClient(activeClient);
  } catch {
    // Se a leitura final falhar, ainda preservamos o estado/cache já conhecido.
  }

  return {
    client: activeClient,
    attempted: roundsCompleted > 0,
    loadedAny,
    timedOut,
    noGrowthRounds,
    roundsCompleted,
    loadTrace,
    reachedEnd,
    snapshot: latestSnapshot,
    conversations: recentConversationsForClient(activeClient),
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
  const countOnly = args.countOnly === true || args.action === 'count';
  const untilEnd = args.untilEnd === true || args.countAll === true || args.action === 'count';
  const baseRefreshPlan = buildRecentChatsRefreshPlan(client, args, {
    maxAgeMs: RECENT_CHATS_CACHE_MAX_AGE_MS,
    requestedCount: targetCount,
  });
  const forceCountRefresh = countOnly && untilEnd && args.refresh !== false;
  const refreshPlan = forceCountRefresh
    ? {
        ...baseRefreshPlan,
        shouldRefresh: true,
        preferFastRefresh: recentConversationsForClient(client).length > 0,
      }
    : baseRefreshPlan;
  if (refreshPlan.shouldRefresh) {
    try {
      const refreshPromise = refreshClientConversations(client, { ensureSidebar: true });
      refresh = refreshPlan.preferFastRefresh
        ? await withTimeout(refreshPromise, RECENT_CHATS_REFRESH_BUDGET_MS)
        : await refreshPromise;
      if (refresh?.client) client = refresh.client;
    } catch (err) {
      refresh = {
        ok: false,
        error: err.message,
        timedOut: err.message.includes('Timeout após'),
      };
    }
  }
  if (untilEnd) {
    try {
      const totalLoadMoreTimeoutMs = Math.max(
        1000,
        Number(args.loadMoreTimeoutMs || COMMAND_TIMEOUT_MS),
      );
      const { loadMoreTimeoutMs: _totalLoadMoreTimeoutMs, ...loadAllArgs } = args;
      const loadAllPromise = loadAllRecentChatsForClient(client, {
        ...loadAllArgs,
        trustCachedReachedEnd: args.trustCachedReachedEnd === true,
      });
      loadMore = await withTimeout(
        loadAllPromise,
        totalLoadMoreTimeoutMs,
      );
      if (loadMore?.client) client = loadMore.client;
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
  } else if (recentConversationsForClient(client).length < targetCount) {
    try {
      const loadMorePromise = loadMoreRecentChatsForClient(client, targetCount, args);
      loadMore = await withTimeout(
        loadMorePromise,
        Math.max(1000, Number(args.loadMoreTimeoutMs || RECENT_CHATS_LOAD_MORE_BUDGET_MS)),
      );
      if (loadMore?.client) client = loadMore.client;
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
  const loadMoreBusy =
    loadMore?.ok === false &&
    isTransientTabBusyError({ message: loadMore.error, code: loadMore.code, data: loadMore.data });
  const loadMoreIncomplete =
    loadMore?.timedOut === true ||
    (loadMore?.ok === false && !loadMoreBusy);
  const countInference = inferRecentChatsCountStatus(client, conversations.length, {
    reachedEnd,
    allowDomCountConfirmation: !loadMoreBusy && !loadMoreIncomplete,
  });
  const nextOffset = offset + page.length;
  const totalKnown = countInference.totalKnown === true;
  const totalCount = countInference.totalCount;
  const canLoadMore = !totalKnown && conversations.length < MAX_RECENT_CHATS_LOAD_TARGET;
  const countStatus = totalKnown
    ? 'complete'
    : loadMore?.timedOut === true || loadMore?.ok === false
      ? 'incomplete'
      : countInference.countStatus;
  const countWarning = totalKnown
    ? null
    : `Contagem parcial: carreguei pelo menos ${conversations.length} conversa(s), mas ainda nao confirmei o fim do historico. Nao informe esse numero como "ao todo".`;
  return {
    client: summarizeClient(client),
    countStatus,
    countIsTotal: totalKnown,
    totalKnown,
    totalCount,
    countSource: countInference.countSource,
    countConfidence: countInference.countConfidence,
    countEvidence: countInference.countEvidence,
    knownLoadedCount: conversations.length,
    minimumKnownCount: conversations.length,
    countWarning,
    answer: totalKnown
      ? countInference.countSource === 'browser_dom_count_match'
        ? `${conversations.length} conversa(s) confirmada(s) pelo DOM do sidebar.`
        : `${conversations.length} conversa(s) confirmada(s) no total carregavel.`
      : `Pelo menos ${conversations.length} conversa(s); total ainda nao confirmado.`,
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
      countIsTotal: totalKnown,
      totalKnown,
      totalCount,
      countSource: countInference.countSource,
      countConfidence: countInference.countConfidence,
      knownLoadedCount: conversations.length,
      minimumKnownCount: conversations.length,
      countStatus,
      maxLoadTarget: MAX_RECENT_CHATS_LOAD_TARGET,
      nextOffset: page.length > 0 ? nextOffset : null,
      hasMoreLoaded: nextOffset < conversations.length,
      reachedEnd,
      canLoadMore,
    },
    conversations: countOnly ? [] : page,
    nextAction: totalKnown
      ? null
      : {
          code: 'count_incomplete',
          message:
            'A lista ainda nao chegou ao fim. Pare aqui: responda "pelo menos N" e explique que o fim do historico nao foi confirmado. Nao chame gemini_chats/gemini_ready/gemini_tabs como fallback, porque isso disputa a aba e polui a UI com JSON.',
          command: null,
        },
  };
};

const emptyTimingBucket = () => ({
  count: 0,
  totalMs: 0,
  minMs: null,
  maxMs: 0,
  lastMs: null,
});

const createExportJobMetrics = () => ({
  version: 1,
  timings: {},
  counters: {
    mediaFiles: 0,
    mediaWarnings: 0,
    skippedExisting: 0,
    browserTimeouts: 0,
    assetTimeouts: 0,
    failedConversations: 0,
    savedBytes: 0,
  },
  conversations: [],
  assetBaseline: snapshotBridgeAssetMetrics(),
});

const ensureExportJobMetrics = (job) => {
  job.metrics = job.metrics || createExportJobMetrics();
  job.metrics.timings = job.metrics.timings || {};
  job.metrics.counters = job.metrics.counters || {};
  job.metrics.conversations = job.metrics.conversations || [];
  job.metrics.assetBaseline = job.metrics.assetBaseline || snapshotBridgeAssetMetrics();
  return job.metrics;
};

const recordJobTiming = (job, name, elapsedMs) => {
  const elapsed = Math.max(0, Math.round(Number(elapsedMs) || 0));
  const metrics = ensureExportJobMetrics(job);
  const bucket = metrics.timings[name] || emptyTimingBucket();
  bucket.count += 1;
  bucket.totalMs += elapsed;
  bucket.minMs = bucket.minMs === null ? elapsed : Math.min(bucket.minMs, elapsed);
  bucket.maxMs = Math.max(bucket.maxMs || 0, elapsed);
  bucket.lastMs = elapsed;
  metrics.timings[name] = bucket;
  return elapsed;
};

const recordJobTimingFrom = (job, name, startedAt) =>
  recordJobTiming(job, name, Date.now() - startedAt);

const measureJobTiming = async (job, name, fn) => {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordJobTimingFrom(job, name, startedAt);
  }
};

const recordJobCounter = (job, name, delta = 1) => {
  const metrics = ensureExportJobMetrics(job);
  metrics.counters[name] = (metrics.counters[name] || 0) + delta;
};

const summarizeTimingBucket = (bucket) => {
  if (!bucket || bucket.count <= 0) {
    return {
      count: 0,
      totalMs: 0,
      avgMs: null,
      minMs: null,
      maxMs: 0,
      lastMs: null,
    };
  }
  return {
    count: bucket.count,
    totalMs: bucket.totalMs,
    avgMs: Math.round(bucket.totalMs / bucket.count),
    minMs: bucket.minMs,
    maxMs: bucket.maxMs,
    lastMs: bucket.lastMs,
  };
};

const summarizeTimingBuckets = (timings = {}) =>
  Object.fromEntries(
    Object.entries(timings).map(([name, bucket]) => [name, summarizeTimingBucket(bucket)]),
  );

const summarizeLoadMoreMetrics = (trace = []) => {
  const rounds = Array.isArray(trace) ? trace : [];
  const elapsed = rounds.map((item) => Number(item.elapsedMs || 0)).filter((item) => item >= 0);
  const deltas = rounds.map((item) => Number(item.delta || 0)).filter((item) => item >= 0);
  const totalElapsedMs = elapsed.reduce((sum, item) => sum + item, 0);
  const totalDelta = deltas.reduce((sum, item) => sum + item, 0);
  const last = rounds[rounds.length - 1] || null;
  return {
    rounds: rounds.length,
    totalElapsedMs,
    avgRoundMs: rounds.length ? Math.round(totalElapsedMs / rounds.length) : null,
    maxRoundMs: elapsed.length ? Math.max(...elapsed) : 0,
    totalDelta,
    avgDelta: rounds.length ? Math.round(totalDelta / rounds.length) : null,
    timedOutRounds: rounds.filter((item) => item.timedOut === true).length,
    noGrowthRounds: rounds.filter((item) => item.grew === false).length,
    finalNoGrowthRounds: last?.noGrowthRounds ?? null,
    finalBatchSize: last?.batchSize ?? null,
    reachedEnd: last?.reachedEnd ?? null,
    finalAfterCount: last?.afterCount ?? null,
  };
};

const startConversationMetric = (job, item) => ({
  index: item.index ?? null,
  chatId: item.chatId || null,
  title: item.title || null,
  startedAt: new Date().toISOString(),
  startedMs: Date.now(),
  timings: {},
  counters: {},
});

const finishConversationMetric = (job, metric, status, patch = {}) => {
  const metrics = ensureExportJobMetrics(job);
  const finishedAtMs = Date.now();
  const item = {
    ...metric,
    ...patch,
    status,
    finishedAt: new Date(finishedAtMs).toISOString(),
    elapsedMs: Math.max(0, finishedAtMs - (metric.startedMs || finishedAtMs)),
  };
  delete item.startedMs;
  metrics.conversations.push(item);
  if (metrics.conversations.length > 1000) metrics.conversations.shift();
  return item;
};

const browserTimeoutCountFromConversationMetrics = (metrics = {}) =>
  metrics.hydration?.timedOut === true ? 1 : 0;

const assetTimeoutCountFromConversationMetrics = (metrics = {}) =>
  metrics.media?.timedOut === true ? 1 : 0;

const summarizeExportJobMetrics = (job, client, { includeConversations = false } = {}) => {
  const metrics = job.metrics || createExportJobMetrics();
  const conversations = Array.isArray(metrics.conversations) ? metrics.conversations : [];
  const assetDelta = diffBridgeAssetMetrics(metrics.assetBaseline);
  return {
    version: metrics.version || 1,
    phaseTimings: summarizeTimingBuckets(metrics.timings),
    counters: {
      ...metrics.counters,
      conversationTimings: conversations.length,
    },
    payloads: summarizePayloadMetrics(client),
    assets: {
      bridge: assetDelta,
      mediaFiles: metrics.counters?.mediaFiles || 0,
      mediaWarnings: metrics.counters?.mediaWarnings || 0,
    },
    lazyLoad: summarizeLoadMoreMetrics(job.loadMoreTrace),
    recentConversations: conversations.slice(-20),
    ...(includeConversations ? { conversations } : {}),
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
  tabClaim: summarizeTabClaim(claimForClient(clients.get(job.clientId))),
  autoReleaseTabClaim: job.autoReleaseTabClaim ?? null,
  tabClaimId: job.tabClaimId || null,
  tabClaimRelease: job.tabClaimRelease || null,
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
  syncMode: job.syncMode === true,
  syncStateFile: job.syncStateFile || null,
  syncBoundary: job.syncBoundary || null,
  syncStateUpdate: job.syncStateUpdate || null,
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
  metrics: summarizeExportJobMetrics(job, clients.get(job.clientId)),
  progressMessage: exportJobProgressMessage(job),
  decisionSummary: exportJobDecisionSummary(job),
  nextAction: exportJobNextAction(job),
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
    fullHistoryRequested &&
    ((job.syncMode === true && job.syncBoundary?.found === true) ||
      (job.reachedEnd === true && job.truncated !== true));
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

const shellQuoteJson = (value) => JSON.stringify(value);

const exportJobResumeCommand = (job) => {
  if (!job?.reportFile) return null;
  const tool = 'gemini_export';
  const args = {
    action: job.syncMode ? 'sync' : job.exportMissingOnly ? 'missing' : 'recent',
    resumeReportFile: job.reportFile,
  };
  if (job.exportMissingOnly && job.existingScanDir) {
    args.vaultDir = job.existingScanDir;
  }
  if (job.outputDir && (!job.exportMissingOnly || job.outputDir !== job.existingScanDir)) {
    args.outputDir = job.outputDir;
  }
  return {
    tool,
    args,
    text: `${tool}(${shellQuoteJson(args)})`,
  };
};

const exportJobPollCommand = (job) => ({
  tool: 'gemini_job',
  args: { action: 'status', jobId: job.jobId },
  text: `gemini_job(${shellQuoteJson({ action: 'status', jobId: job.jobId })})`,
});

const exportJobCancelCommand = (job) => ({
  tool: 'gemini_job',
  args: { action: 'cancel', jobId: job.jobId },
  text: `gemini_job(${shellQuoteJson({ action: 'cancel', jobId: job.jobId })})`,
});

const mediaWarningCountForJob = (job) =>
  Number(job.metrics?.counters?.mediaWarnings || 0) ||
  (Array.isArray(job.recentSuccesses)
    ? job.recentSuccesses.reduce((sum, item) => sum + Number(item.mediaFailureCount || 0), 0)
    : 0);

const downloadedThisRunCount = (job) =>
  Math.max(0, Number(job.successCount || 0) - Number(job.resume?.previousSuccessCount || 0));

const exportJobWorkflow = (job) => {
  if (job.type === 'direct-chats-export') return 'direct-reexport';
  if (job.syncMode) return 'vault-incremental-sync';
  if (job.exportMissingOnly) return 'vault-reconciliation';
  return job.exportAll ? 'full-history-export' : 'partial-history-export';
};

const exportJobProgressMessage = (job) => {
  const errorCount = job.failureCount || 0;
  const fullHistoryVerified =
    job.type === 'recent-chats-export' && recentChatsExportScope(job).fullHistoryVerified;
  const mediaWarnings = mediaWarningCountForJob(job);

  if (job.status === 'cancel_requested') {
    return 'Cancelamento solicitado. Vou parar antes da próxima conversa.';
  }
  if (job.status === 'cancelled') {
    return 'Exportação cancelada. O relatório já permite retomar depois.';
  }
  if (job.status === 'failed') {
    return 'Exportação falhou. Use o relatório para retomar quando o problema for resolvido.';
  }
  if (job.status === 'completed_with_errors') {
    if (job.loadWarning || job.truncated || job.loadMoreTimedOut || job.vaultScan?.truncated) {
      return 'Não consegui confirmar o fim do histórico. O relatório mostra o que foi salvo e como retomar.';
    }
    return `Exportação concluída com ${errorCount} erro${errorCount === 1 ? '' : 's'}.`;
  }
  if (job.status === 'completed') {
    if (job.syncMode) {
      const downloaded = downloadedThisRunCount(job);
      return downloaded > 0
        ? `Vault atualizado. ${downloaded} conversa${downloaded === 1 ? '' : 's'} nova${downloaded === 1 ? '' : 's'} salva${downloaded === 1 ? '' : 's'}.`
        : 'Vault já estava atualizado. Nenhuma conversa nova encontrada.';
    }
    if (job.exportMissingOnly && fullHistoryVerified && (job.missingCount || 0) === 0) {
      return 'Histórico inteiro verificado. Nada faltava no vault.';
    }
    if (fullHistoryVerified) {
      const suffix =
        mediaWarnings > 0
          ? ` ${mediaWarnings} mídia${mediaWarnings === 1 ? '' : 's'} ficaram com warning.`
          : '';
      return `Histórico inteiro verificado.${suffix}`;
    }
    return 'Exportação concluída.';
  }
  if (job.resume && job.phase === 'loading-history') {
    return 'Retomando do relatório anterior e listando histórico do Gemini...';
  }
  if (job.phase === 'loading-history') {
    if (job.syncMode) return 'Verificando histórico desde a última sincronização...';
    return 'Listando histórico do Gemini...';
  }
  if (job.phase === 'scanning-vault') {
    if (job.syncMode) return 'Lendo índice local do vault antes de sincronizar...';
    return 'Cruzando histórico do Gemini com o vault...';
  }
  if (job.phase === 'exporting' && job.current?.skippedExisting) {
    const title = job.current.title || job.current.chatId || 'conversa já salva';
    return `Pulando conversa já salva: ${title}`;
  }
  if (job.phase === 'exporting') {
    const title = job.current?.title || job.current?.chatId || '';
    const prefix = job.exportMissingOnly
      ? job.syncMode
        ? 'Baixando conversas novas'
        : 'Baixando somente o que falta no vault'
      : 'Exportando conversas do Gemini';
    const count =
      job.requested > 0
        ? ` (${Math.min(job.completed + 1, job.requested)}/${job.requested})`
        : '';
    return `${prefix}${count}${title ? `: ${title}` : '...'}`;
  }
  if (job.phase === 'writing-report') {
    return 'Gravando relatório final...';
  }
  return 'Preparando exportação...';
};

const exportJobNextAction = (job) => {
  const resumeCommand = exportJobResumeCommand(job);
  if (!isTerminalExportJobStatus(job.status)) {
    return {
      code: 'poll_status',
      message: 'Acompanhe o job sem listar conversas no chat.',
      command: exportJobPollCommand(job),
      cancelCommand: exportJobCancelCommand(job),
    };
  }
  if (job.status === 'completed') {
    return {
      code: 'done',
      message: job.exportMissingOnly
        ? 'Importação do histórico para o vault concluída.'
        : 'Exportação concluída.',
      command: null,
    };
  }
  if (resumeCommand) {
    return {
      code: 'resume_available',
      message: 'Retome pelo relatório incremental em vez de começar do zero.',
      command: resumeCommand,
    };
  }
  return {
    code: 'inspect_report',
    message: 'Consulte o relatório e corrija o erro antes de tentar novamente.',
    command: null,
  };
};

const exportJobDecisionSummary = (job) => {
  const scope =
    job.type === 'recent-chats-export'
      ? recentChatsExportScope(job)
      : directChatsExportScope(job);
  const terminal = isTerminalExportJobStatus(job.status);
  const mediaWarnings = mediaWarningCountForJob(job);
  const warnings = [];
  if (job.loadWarning) warnings.push(job.loadWarning);
  if (job.refreshError) warnings.push(`Falha ao atualizar o sidebar: ${job.refreshError}`);
  if (job.vaultScan?.truncated) {
    warnings.push('O scan do vault foi truncado; alguns exports existentes podem não ter sido considerados.');
  }
  if (mediaWarnings > 0) {
    warnings.push(
      `${mediaWarnings} mídia${mediaWarnings === 1 ? '' : 's'} ficaram com warning no Markdown.`,
    );
  }
  if (job.failureCount > 0) {
    warnings.push(`${job.failureCount} conversa${job.failureCount === 1 ? '' : 's'} falharam.`);
  }

  return {
    workflow: exportJobWorkflow(job),
    headline: exportJobProgressMessage(job),
    terminal,
    fullHistoryRequested: scope.fullHistoryRequested,
    fullHistoryVerified: scope.fullHistoryVerified,
    shouldResume:
      terminal &&
      job.status !== 'completed' &&
      !!job.reportFile,
    totals: {
      geminiWebSeen: job.webConversationCount ?? job.loadedCount ?? null,
      existingInVault: job.exportMissingOnly ? job.existingVaultCount ?? 0 : null,
      missingInVault: job.exportMissingOnly ? job.missingCount ?? null : null,
      downloadedNow: downloadedThisRunCount(job),
      downloadedInReport: job.successCount || 0,
      skipped: job.skippedCount || 0,
      mediaWarnings,
      failed: job.failureCount || 0,
    },
    sync: job.syncMode
      ? {
          stateFile: job.syncStateFile || null,
          boundary: job.syncBoundary || null,
          stateUpdated: job.syncStateUpdate?.updated === true,
          stateUpdate: job.syncStateUpdate || null,
        }
      : null,
    reportFile: job.reportFile || null,
    resumeCommand: exportJobResumeCommand(job),
    nextAction: exportJobNextAction(job),
    warnings,
  };
};

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
  syncMode: job.syncMode === true,
  syncStateFile: job.syncStateFile || null,
  syncState: job.syncState || null,
  syncBoundary: job.syncBoundary || null,
  syncStateUpdate: job.syncStateUpdate || null,
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
  metrics: summarizeExportJobMetrics(job, client, { includeConversations: true }),
  progressMessage: exportJobProgressMessage(job),
  decisionSummary: exportJobDecisionSummary(job),
  nextAction: exportJobNextAction(job),
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
  metrics: summarizeExportJobMetrics(job, client, { includeConversations: true }),
  progressMessage: exportJobProgressMessage(job),
  decisionSummary: exportJobDecisionSummary(job),
  nextAction: exportJobNextAction(job),
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
    label = exportJobProgressMessage({ ...job, status, phase, failureCount: errorCount });
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

const maybeUpdateSyncState = (job, client, failures = []) => {
  if (!job.syncMode || !job.existingScanDir || !job.syncStateFile) return null;
  const completeEnough =
    job.status === 'completed' &&
    failures.length === 0 &&
    (job.syncBoundary?.found === true || (job.reachedEnd === true && job.truncated !== true));
  const conversations = recentConversationsForClient(client);
  const boundaryChatIds = conversations
    .map((conversation) => normalizeConversationChatId(conversation).toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
  const topChatId = boundaryChatIds[0] || job.syncState?.topChatId || null;

  if (!completeEnough || !topChatId) {
    job.syncStateUpdate = {
      updated: false,
      reason: !topChatId
        ? 'no-top-chat-id'
        : failures.length > 0
          ? 'failures-present'
          : job.status !== 'completed'
            ? `job-${job.status}`
            : 'boundary-not-proven',
      stateFile: job.syncStateFile,
      boundary: job.syncBoundary || null,
    };
    return job.syncStateUpdate;
  }

  const now = new Date().toISOString();
  const nextState = {
    version: 1,
    exporterVersion: SERVER_VERSION,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    vaultDir: job.existingScanDir,
    outputDir: job.outputDir,
    lastSuccessfulSyncAt: now,
    lastFullSyncAt:
      job.reachedEnd === true && job.truncated !== true
        ? now
        : job.syncState?.lastFullSyncAt || null,
    topChatId,
    boundaryChatIds,
    lastReportFile: job.reportFile || null,
    lastJobId: job.jobId,
    lastWebConversationCount: job.webConversationCount ?? null,
    lastDownloadedCount: downloadedThisRunCount(job),
    lastExistingVaultCount: job.existingVaultCount ?? null,
    lastBoundary: job.syncBoundary || null,
    updatedAt: now,
  };
  const stateFile = writeVaultSyncState(job.existingScanDir, nextState, job.syncStateFile);
  job.syncState = nextState;
  job.syncStateUpdate = {
    updated: true,
    stateFile,
    topChatId,
    boundaryChatIds: boundaryChatIds.slice(0, 10),
    reason: job.syncBoundary?.found ? 'known-boundary-found' : 'full-history-verified',
  };
  return job.syncStateUpdate;
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
  let preloadedVaultScan = null;
  try {
    if (job.syncMode) {
      job.phase = 'scanning-vault';
      touchExportJob(job);
      persistRecentChatsExportReport(job, client, successes, failures);
      broadcastRecentChatsJobProgress(job, client);
      preloadedVaultScan = await measureJobTiming(job, 'scanVaultMs', async () =>
        scanDownloadedGeminiExportsInVault(job.existingScanDir),
      );
      job.vaultScan = summarizeVaultScan(preloadedVaultScan);
    }

    job.phase = 'loading-history';
    touchExportJob(job);
    persistRecentChatsExportReport(job, client, successes, failures);
    broadcastRecentChatsJobProgress(job, client);

    await measureJobTiming(job, 'loadSidebarMs', async () => {
      if (job.exportAll) {
        const refreshPlan = buildRecentChatsRefreshPlan(client, args, {
          maxAgeMs: RECENT_CHATS_CACHE_MAX_AGE_MS,
        });
        if (refreshPlan.shouldRefresh) {
          const refreshStartedAt = Date.now();
          try {
            const refreshPromise = refreshClientConversations(client, { ensureSidebar: true });
            const refresh = refreshPlan.preferFastRefresh
              ? await withTimeout(refreshPromise, RECENT_CHATS_REFRESH_BUDGET_MS)
              : await refreshPromise;
            if (refresh?.client) client = refresh.client;
            if (refresh?.snapshot) {
              client.lastSnapshot = refresh.snapshot;
            }
          } catch (err) {
            job.refreshError = err.message;
          } finally {
            recordJobTimingFrom(job, 'refreshSidebarMs', refreshStartedAt);
          }
        }
        const loadMore = job.syncMode
          ? await loadRecentChatsUntilSyncBoundaryForClient(
              client,
              {
                ...args,
                shouldStop: () => job.cancelRequested === true,
              },
              {
                vaultScan: preloadedVaultScan,
                syncState: job.syncState,
              },
            )
          : await loadAllRecentChatsForClient(client, {
              ...args,
              shouldStop: () => job.cancelRequested === true,
            });
        if (loadMore?.client) client = loadMore.client;
        const loadMoreResolved =
          loadMore.reachedEnd === true || (job.syncMode && loadMore.boundary?.found === true);
        job.loadMoreRoundsCompleted = loadMore.roundsCompleted;
        job.loadMoreTimedOut = loadMore.timedOut === true && !loadMoreResolved;
        job.loadMoreTrace = Array.isArray(loadMore.loadTrace) ? loadMore.loadTrace : [];
        if (job.syncMode) job.syncBoundary = loadMore.boundary || null;
        if (job.loadMoreTimedOut) recordJobCounter(job, 'browserTimeouts');
      } else {
        const targetCount = Math.min(MAX_RECENT_CHATS_LOAD_TARGET, job.startIndex - 1 + job.maxChats);
        const listed = await listRecentChatsForClient(client, {
          ...args,
          limit: 1,
          offset: Math.max(0, targetCount - 1),
          refresh: args.refresh,
        });
        const listedClient = listed?.client?.clientId ? clients.get(listed.client.clientId) : null;
        if (listedClient) client = listedClient;
      }
    });

    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.phase = 'cancelled';
      return;
    }

    const allConversations = recentConversationsForClient(client);
    const syncBoundaryIndex =
      job.syncMode && job.syncBoundary?.found === true
        ? Math.max(0, Number(job.syncBoundary.index || 0))
        : null;
    const conversations =
      syncBoundaryIndex === null ? allConversations : allConversations.slice(0, syncBoundaryIndex);
    job.loadedCount = allConversations.length;
    job.reachedEnd = recentChatsReachedEndForClient(client);
    job.truncated = job.exportAll
      ? !job.reachedEnd
      : !job.reachedEnd && allConversations.length >= MAX_RECENT_CHATS_LOAD_TARGET;
    if (job.syncMode && job.syncBoundary?.found === true) {
      job.truncated = false;
    }
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

      const vaultScan =
        preloadedVaultScan ||
        (await measureJobTiming(job, 'scanVaultMs', async () =>
          scanDownloadedGeminiExportsInVault(job.existingScanDir),
        ));
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

    const exportingStartedAt = Date.now();
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
      const itemMetric = startConversationMetric(job, {
        index,
        chatId: job.current.chatId,
        title: job.current.title,
      });
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
            recordJobCounter(job, 'skippedExisting');
            finishConversationMetric(job, itemMetric, 'skipped_existing', {
              chatId: existing.chatId,
              filename: existing.filename,
              filePath: existing.filePath,
              bytes: existing.bytes,
              reason: 'existing-file',
            });
            continue;
          }
        }

        const result = await downloadConversationItemWithRetry(job, client, conversation, {
          ...args,
          outputDir: job.outputDir,
          returnToOriginal: false,
        });
        const resultClient = result.client?.clientId ? clients.get(result.client.clientId) : null;
        if (resultClient) client = resultClient;
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
          metrics: result.metrics || null,
        };
        successes.push(success);
        job.recentSuccesses.push(success);
        job.recentSuccesses = job.recentSuccesses.slice(-10);
        job.successCount = successes.length;
        recordJobCounter(job, 'mediaFiles', result.mediaFileCount || 0);
        recordJobCounter(job, 'mediaWarnings', result.mediaFailureCount || 0);
        recordJobCounter(
          job,
          'savedBytes',
          (result.bytes || 0) + (result.metrics?.counters?.savedMediaBytes || 0),
        );
        recordJobCounter(job, 'browserTimeouts', browserTimeoutCountFromConversationMetrics(result.metrics));
        recordJobCounter(job, 'assetTimeouts', assetTimeoutCountFromConversationMetrics(result.metrics));
        finishConversationMetric(job, itemMetric, 'success', {
          chatId: result.chatId,
          filename: result.filename,
          filePath: result.filePath,
          bytes: result.bytes,
          timings: result.metrics?.timings || {},
          counters: result.metrics?.counters || {},
          hydration: result.metrics?.hydration || null,
          navigation: result.metrics?.navigation || null,
          media: result.metrics?.media || null,
        });
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
        recordJobCounter(job, 'failedConversations');
        if (/timeout|tempo esgotado/i.test(err.message)) {
          recordJobCounter(job, 'browserTimeouts');
        }
        finishConversationMetric(job, itemMetric, 'failed', {
          error: err.message,
        });
      } finally {
        job.completed = resumedCompletedCount + i + 1;
        touchExportJob(job);
        persistRecentChatsExportReport(job, client, successes, failures);
        broadcastRecentChatsJobProgress(job, client);
      }
    }
    recordJobTimingFrom(job, 'exportConversationsMs', exportingStartedAt);

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
      maybeUpdateSyncState(job, client, failures);
    } catch (err) {
      job.syncStateUpdate = {
        updated: false,
        reason: 'write-failed',
        error: err.message,
        stateFile: job.syncStateFile || null,
      };
    }
    const finalReportStartedAt = Date.now();
    try {
      persistRecentChatsExportReport(job, client, successes, failures);
    } catch {
      // Status em memória permanece disponível mesmo se o relatório final falhar.
    } finally {
      recordJobTimingFrom(job, 'writeReportMs', finalReportStartedAt);
      try {
        if (job.reportFile) {
          overwriteExportReport(
            job.reportFile,
            buildRecentChatsExportReport(job, client, successes, failures),
          );
        }
      } catch {
        // A primeira escrita já deixou o status principal; esta só atualiza a métrica final.
      }
    }
    await autoReleaseTabClaimForJob(job, `job-${job.status || 'finished'}`);
    touchExportJob(job);
    try {
      if (job.reportFile) {
        overwriteExportReport(
          job.reportFile,
          buildRecentChatsExportReport(job, client, successes, failures),
        );
      }
    } catch {
      // A liberação da claim é melhor esforço e não deve mascarar o resultado do job.
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
  const syncMode = args.syncMode === true;
  const existingScanDir =
    args.existingScanDir || args.vaultDir || (exportMissingOnly ? resume?.previousExistingScanDir : null);
  if (exportMissingOnly && !existingScanDir) {
    throw new Error('Informe vaultDir/existingScanDir ou resumeReportFile com existingScanDir para cruzar o histórico do Gemini com o vault.');
  }
  const syncState =
    syncMode && existingScanDir ? readVaultSyncState(existingScanDir, args.syncStateFile) : null;
  const hasExplicitMaxChats = args.maxChats !== undefined || args.limit !== undefined;
  const skipExisting =
    typeof args.skipExisting === 'boolean' ? args.skipExisting : !hasExplicitMaxChats;
  const activeClaim = claimForClient(client);
  const job = {
    jobId: randomUUID(),
    type: 'recent-chats-export',
    status: 'running',
    phase: 'queued',
    clientId: client.clientId,
    autoReleaseTabClaim: shouldAutoReleaseTabClaim(args),
    tabClaimId: activeClaim?.claimId || args.claimId || null,
    tabClaimRelease: null,
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
    syncMode,
    syncStateFile: syncState?.filePath || null,
    syncState: syncState?.state || null,
    syncStateError: syncState?.error || null,
    syncBoundary: null,
    syncStateUpdate: null,
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
    metrics: createExportJobMetrics(),
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

    const exportingStartedAt = Date.now();
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
      const itemMetric = startConversationMetric(job, {
        index,
        chatId: conversation.chatId,
        title: conversation.title || null,
      });
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
          metrics: result.metrics || null,
        };
        successes.push(success);
        job.recentSuccesses.push(success);
        job.recentSuccesses = job.recentSuccesses.slice(-10);
        job.successCount = successes.length;
        recordJobCounter(job, 'mediaFiles', result.mediaFileCount || 0);
        recordJobCounter(job, 'mediaWarnings', result.mediaFailureCount || 0);
        recordJobCounter(
          job,
          'savedBytes',
          (result.bytes || 0) + (result.metrics?.counters?.savedMediaBytes || 0),
        );
        recordJobCounter(job, 'browserTimeouts', browserTimeoutCountFromConversationMetrics(result.metrics));
        recordJobCounter(job, 'assetTimeouts', assetTimeoutCountFromConversationMetrics(result.metrics));
        finishConversationMetric(job, itemMetric, 'success', {
          chatId: result.chatId,
          filename: result.filename,
          filePath: result.filePath,
          bytes: result.bytes,
          sourcePath: conversation.request?.sourcePath || null,
          timings: result.metrics?.timings || {},
          counters: result.metrics?.counters || {},
          hydration: result.metrics?.hydration || null,
          navigation: result.metrics?.navigation || null,
          media: result.metrics?.media || null,
        });
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
        recordJobCounter(job, 'failedConversations');
        if (/timeout|tempo esgotado/i.test(err.message)) {
          recordJobCounter(job, 'browserTimeouts');
        }
        finishConversationMetric(job, itemMetric, 'failed', {
          sourcePath: conversation.request?.sourcePath || null,
          error: err.message,
        });
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
    recordJobTimingFrom(job, 'exportConversationsMs', exportingStartedAt);

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
    const finalReportStartedAt = Date.now();
    try {
      persistDirectChatsExportReport(job, client, successes, failures);
    } catch {
      // Status em memória permanece disponível mesmo se o relatório final falhar.
    } finally {
      recordJobTimingFrom(job, 'writeReportMs', finalReportStartedAt);
      try {
        if (job.reportFile) {
          overwriteExportReport(
            job.reportFile,
            buildDirectChatsExportReport(job, client, successes, failures),
          );
        }
      } catch {
        // A primeira escrita já deixou o status principal; esta só atualiza a métrica final.
      }
    }
    await autoReleaseTabClaimForJob(job, `job-${job.status || 'finished'}`);
    touchExportJob(job);
    try {
      if (job.reportFile) {
        overwriteExportReport(
          job.reportFile,
          buildDirectChatsExportReport(job, client, successes, failures),
        );
      }
    } catch {
      // A liberação da claim é melhor esforço e não deve mascarar o resultado do job.
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
  const activeClaim = claimForClient(client);
  const job = {
    jobId: randomUUID(),
    type: 'direct-chats-export',
    status: 'running',
    phase: 'queued',
    clientId: client.clientId,
    autoReleaseTabClaim: shouldAutoReleaseTabClaim(args),
    tabClaimId: activeClaim?.claimId || args.claimId || null,
    tabClaimRelease: null,
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
    metrics: createExportJobMetrics(),
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

  const selector = normalizeClientSelector(args);
  if (selector.clientId || selector.tabId !== null || selector.claimId || claimForSession(selector.sessionId)) {
    const client = requireClient(args);
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

const legacyRawTools = [
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
            timings: ready.timings || null,
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
      const summarizedMatchingClients = matchingClients.map(summarizeClient);
      const extensionReadiness = buildExtensionReadiness({
        connectedClients: summarizedClients,
        matchingClients: summarizedMatchingClients,
        selfHeal,
      });
      const handshakeMode =
        (selfHeal.reloadAttempts || 0) > 0
          ? 'post-update'
          : launchResult?.attempted || waitedMs > 0 || (selfHeal.timings?.initialWaitMs || 0) > 0
            ? 'cold'
            : 'hot';
      return toolTextResult({
        ready: matchingClients.length > 0,
        blockingIssue:
          liveClients.length === 0
            ? 'no_connected_clients'
            : matchingClients.length === 0
              ? 'extension_version_mismatch'
              : null,
        expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
        sessionId: PROCESS_SESSION_ID,
        matchingClientCount: matchingClients.length,
        connectedClients: summarizedClients,
        tabClaims: summarizeTabClaims(),
        extensionReadiness,
        handshake: {
          mode: handshakeMode,
          timings: {
            extensionInfoMs: selfHeal.timings?.extensionInfoMs ?? null,
            reloadMs: selfHeal.timings?.reloadMs ?? null,
            firstHeartbeatMs: waitedMs || selfHeal.timings?.initialWaitMs || null,
            totalGuardMs: selfHeal.timings?.totalMs ?? null,
          },
        },
        manualReloadRequired: extensionReadiness.reload.manualReloadRequired,
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
    name: 'gemini_browser_ready',
    description:
      'Checagem leve de prontidão do bridge/extensão/aba, com tempos de handshake frio/quente, sem snapshot grande do Gemini.',
    inputSchema: {
      type: 'object',
      properties: {
        wakeBrowser: {
          type: 'boolean',
          description: 'Quando true, pode abrir uma aba Gemini se nenhuma estiver conectada.',
        },
        waitMs: {
          type: 'number',
          description: 'Tempo máximo para aguardar heartbeat após acordar o navegador.',
        },
        selfHeal: {
          type: 'boolean',
          description:
            'Quando true, valida versão/protocolo/build e permite self-heal. Default: false para responder rápido.',
        },
        allowReload: {
          type: 'boolean',
          description: 'Permite reload automático quando selfHeal=true.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => toolTextResult(await buildLightweightBrowserReady(args)),
  },
  {
    name: 'gemini_list_tabs',
    description:
      'Lista abas Gemini conectadas, claims ativas e IDs para escolher uma aba antes de listar/exportar. Se nenhuma aba existir, abre uma aba Gemini por padrão.',
    inputSchema: {
      type: 'object',
      properties: {
        openIfMissing: {
          type: 'boolean',
          description: 'Quando true ou omitido, abre uma aba Gemini se nenhuma estiver conectada.',
        },
        waitMs: {
          type: 'number',
          description: 'Tempo máximo para aguardar heartbeat depois de abrir a aba.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      cleanupStaleClients();
      let launchResult = null;
      let allLiveClients = getLiveClients();
      let liveClients = getSelectableGeminiClients();
      if (liveClients.length === 0 && args.openIfMissing !== false) {
        launchResult = await launchChromeForGemini({
          profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
        });
        await waitForLiveClients(
          normalizeWaitMs(args.waitMs, BROWSER_STATUS_WAKE_WAIT_MS),
          CHROME_GUARD_CONFIG.pollIntervalMs || 500,
        );
        allLiveClients = getLiveClients();
        liveClients = getSelectableGeminiClients();
      }
      const diagnosticClients = tabSelectionDiagnostics(allLiveClients, liveClients);
      return toolTextResult({
        ok: true,
        sessionId: PROCESS_SESSION_ID,
        connectedTabCount: liveClients.length,
        connectedClientCount: allLiveClients.length,
        tabs: liveClients.map((client, index) => ({
          index: index + 1,
          ...summarizeClient(client),
        })),
        diagnosticClients,
        claims: summarizeTabClaims(),
        browserWake: launchResult
          ? {
              ...launchResult,
              connectedAfterWake: liveClients.length,
            }
          : {
              attempted: false,
              reason: liveClients.length > 0 ? 'already-connected' : 'open-disabled',
            },
        nextAction:
          liveClients.length === 0
            ? {
                code: 'no_gemini_tab_connected',
                message:
                  'Abra uma aba do Gemini ou chame gemini_tabs { action: "list", intent: "tab_management", openIfMissing: true }.',
              }
            : liveClients.length === 1
              ? {
                  code: 'claim_single_tab',
                  command: {
                    tool: 'gemini_tabs',
                    arguments: { action: 'claim', clientId: liveClients[0].clientId },
                  },
                }
              : {
                  code: 'choose_tab',
                  message:
                    'Escolha uma aba por index/clientId/tabId e chame gemini_tabs { action: "claim", intent: "tab_management" }.',
                },
      });
    },
  },
  {
    name: 'gemini_claim_tab',
    description:
      'Reivindica uma aba Gemini para a sessão atual e marca a aba no navegador com Tab Group/badge. Use antes de trabalhar com várias abas.',
    inputSchema: {
      type: 'object',
      properties: {
        ...clientSelectorProperties(),
        index: {
          type: 'integer',
          minimum: 1,
          description: 'Índice 1-based retornado por gemini_tabs { action: "list" }.',
        },
        chatId: {
          type: 'string',
          description: 'Opcional: escolhe a aba que está nesse chat ou já tem esse chat carregado.',
        },
        label: {
          type: 'string',
          description: 'Rótulo curto mostrado no Tab Group, por exemplo GME A.',
        },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
        },
        ttlMs: {
          type: 'integer',
          minimum: 30000,
          maximum: 86400000,
          description: 'Tempo de lease da claim. Default: 45 minutos.',
        },
        force: {
          type: 'boolean',
          description: 'Quando true, troca a claim da sessão para outra aba.',
        },
        openIfMissing: {
          type: 'boolean',
          description: 'Quando true ou omitido, abre uma aba Gemini se nenhuma estiver conectada.',
        },
        waitMs: {
          type: 'number',
          description: 'Tempo máximo para aguardar heartbeat depois de abrir aba.',
        },
        allowReload: {
          type: 'boolean',
          description: 'Permite self-heal da extensão antes de aplicar o indicador visual.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = await selectClaimableClient(args);
      return toolTextResult(await claimTabForClient(client, args));
    },
  },
  {
    name: 'gemini_release_tab',
    description:
      'Libera a claim de aba Gemini da sessão atual ou uma claimId explícita, removendo Tab Group/badge quando possível.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string' },
        sessionId: { type: 'string' },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => toolTextResult(await releaseTabClaim(args)),
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
    name: 'gemini_diagnose_environment',
    description:
      'Diagnóstico consolidado de campo: bridge, extensão Chrome conectada, browser configurado, processos/porta, diretório de export, jobs e relatórios recentes.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    call: async () => {
      const result = await buildEnvironmentDiagnostics();
      return toolTextResult(result, { isError: !result.ok });
    },
  },
  {
    name: 'gemini_flight_recorder',
    description:
      'Mostra os eventos operacionais recentes do flight recorder local, sem conteúdo de chats.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Quantidade de eventos recentes. Default: 100.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) =>
      toolTextResult({
        ok: true,
        file: FLIGHT_RECORDER_FILE,
        events: readFlightRecorderTail(args.limit || 100),
      }),
  },
  {
    name: 'gemini_collect_support_bundle',
    description:
      'Gera um bundle JSON seguro de suporte com diagnóstico, processos, versões, jobs recentes e flight recorder sanitizado.',
    inputSchema: {
      type: 'object',
      properties: {
        outputDir: {
          type: 'string',
          description: 'Diretório onde salvar o bundle. Default: ~/.gemini-md-export.',
        },
        flightLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Quantidade de eventos do flight recorder a incluir. Default: 200.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => toolTextResult(await buildSupportBundle(args)),
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
      'Retorna uma página das conversas visíveis/carregáveis no sidebar do Gemini. Com múltiplas abas, use claimId/clientId/tabId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...clientSelectorProperties(),
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
        untilEnd: {
          type: 'boolean',
          description:
            'Se true, tenta carregar ate confirmar o fim do historico antes de responder. Use para contagem, nao para despejar listas no chat.',
        },
        countOnly: {
          type: 'boolean',
          description:
            'Se true, retorna contagem/estado sem incluir conversas.',
        },
        maxLoadMoreRounds: { type: 'integer', minimum: 1, maximum: 500 },
        loadMoreAttempts: { type: 'integer', minimum: 1, maximum: 5 },
        maxNoGrowthRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserTimeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
        loadMoreTimeoutMs: { type: 'integer', minimum: 1000 },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireRecentChatsClient(args);
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
        ...clientSelectorProperties(),
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireNotebookClient(args);
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
        ...clientSelectorProperties(),
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
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
        ...clientSelectorProperties(),
        index: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Posição 1-based na lista retornada por gemini_chats { action: "list" }.',
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
      const client = requireClient(args);
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
        ...clientSelectorProperties(),
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
      const client = requireNotebookClient(args);
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
        ...clientSelectorProperties(),
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
            'Diagnóstico: tempo máximo dentro da aba para cada rodada de lazy-load. Default: 30000.',
        },
        loadMoreTimeoutMs: {
          type: 'integer',
          minimum: 1000,
          description:
            'Diagnóstico: timeout total do comando de lazy-load. Default: timeout de comando MCP.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
      await ensureTabClaimForJob(client, args, 'GME Export');
      return toolTextResult(startRecentChatsExportJob(client, args));
    },
  },
  {
    name: 'gemini_export_missing_chats',
    description:
      'Fluxo recomendado para importar todo o histórico para um vault: carrega o Gemini Web, cruza com exports raw já presentes no vault e baixa apenas as conversas faltantes em job de background.',
    inputSchema: {
      type: 'object',
      properties: {
        ...clientSelectorProperties(),
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
            'Diagnóstico: tempo máximo dentro da aba para cada rodada de lazy-load. Default: 30000.',
        },
        loadMoreTimeoutMs: {
          type: 'integer',
          minimum: 1000,
          description:
            'Diagnóstico: timeout total do comando de lazy-load. Default: timeout de comando MCP.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
      await ensureTabClaimForJob(client, args, 'GME Missing');
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
    name: 'gemini_sync_vault',
    description:
      'Sincroniza incrementalmente um vault já conectado ao Gemini Web: identifica conversas novas desde a última fronteira conhecida e baixa apenas o que falta.',
    inputSchema: {
      type: 'object',
      properties: {
        ...clientSelectorProperties(),
        vaultDir: {
          type: 'string',
          description: 'Pasta do vault a sincronizar. Obrigatório.',
        },
        outputDir: {
          type: 'string',
          description: 'Diretório onde salvar novas conversas. Default: vaultDir.',
        },
        syncStateFile: {
          type: 'string',
          description:
            'Arquivo de estado incremental. Default: <vaultDir>/.gemini-md-export/sync-state.json.',
        },
        refresh: {
          type: 'boolean',
          description: 'Se true, força atualizar o sidebar antes de verificar novas conversas.',
        },
        batchSize: {
          type: 'integer',
          minimum: 10,
          maximum: 200,
          description: 'Quantidade alvo por rodada ao procurar a fronteira conhecida. Default: 50.',
        },
        knownBoundaryCount: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Quantidade consecutiva de chats já existentes no vault que prova a fronteira quando não há estado anterior. Default: 25.',
        },
        maxLoadMoreRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
        },
        loadMoreAttempts: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
        maxNoGrowthRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
        },
        loadMoreBrowserRounds: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
        },
        loadMoreBrowserTimeoutMs: {
          type: 'integer',
          minimum: 500,
          maximum: 30000,
        },
        loadMoreTimeoutMs: {
          type: 'integer',
          minimum: 1000,
        },
        resumeReportFile: {
          type: 'string',
          description: 'Relatório anterior de sync/export missing para retomar.',
        },
        reportFile: {
          type: 'string',
          description: 'Alias de resumeReportFile.',
        },
      },
      required: ['vaultDir'],
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
      await ensureTabClaimForJob(client, args, 'GME Sync');
      return toolTextResult(
        startRecentChatsExportJob(client, {
          ...args,
          outputDir: args.outputDir || args.vaultDir,
          existingScanDir: args.vaultDir,
          exportMissingOnly: true,
          syncMode: true,
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
        ...clientSelectorProperties(),
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
      const client = requireClient(args);
      await ensureTabClaimForJob(client, args, 'GME Reexport');
      return toolTextResult(startDirectChatsExportJob(client, args));
    },
  },
  {
    name: 'gemini_export_job_status',
    description:
      'Consulta o andamento de um job de exportacao/sync em lote iniciado por gemini_export.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'ID retornado por gemini_export.',
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
          description: 'ID retornado por gemini_export.',
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
        ...clientSelectorProperties(),
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
      const client = requireNotebookClient(args);
      const claim = await ensureTabClaimForJob(client, args, 'GME Notebook');
      let result = null;
      try {
        result = await exportNotebookForClient(client, args);
      } finally {
        if (shouldAutoReleaseTabClaim(args) && claim?.claimId) {
          const tabClaimRelease = await releaseTabClaim({
            claimId: claim.claimId,
            reason: 'notebook-export-finished',
          });
          if (result) result.tabClaimRelease = tabClaimRelease;
        }
      }
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
        ...clientSelectorProperties(),
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
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
        ...clientSelectorProperties(),
        notebookId: {
          type: 'string',
          description: 'Opcional: limpa apenas entradas deste caderno.',
        },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
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
        ...clientSelectorProperties(),
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
      const client = args.notebook ? requireNotebookClient(args) : requireClient(args);
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
        ...clientSelectorProperties(),
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
        ...clientSelectorProperties(),
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args);
      const result = await enqueueCommand(client.clientId, 'snapshot');
      return toolTextResult({
        client: summarizeClient(client),
        ...result,
      });
    },
  },
];

const LEGACY_BROWSER_DEPENDENT_TOOL_NAMES = new Set([
  'gemini_list_recent_chats',
  'gemini_list_notebook_chats',
  'gemini_get_current_chat',
  'gemini_download_chat',
  'gemini_download_notebook_chat',
  'gemini_export_recent_chats',
  'gemini_export_missing_chats',
  'gemini_sync_vault',
  'gemini_reexport_chats',
  'gemini_export_notebook',
  'gemini_cache_status',
  'gemini_clear_cache',
  'gemini_open_chat',
  'gemini_reload_gemini_tabs',
  'gemini_snapshot',
]);

const withChromeExtensionGuard = (tool) => ({
  ...tool,
  call: async (args = {}) => {
    await ensureBrowserExtensionReady(args, {
      allowLaunchChrome: args.openIfMissing !== false && args.wakeBrowser !== false,
    });
    return tool.call(args);
  },
});

const legacyTools = legacyRawTools.map((tool) =>
  LEGACY_BROWSER_DEPENDENT_TOOL_NAMES.has(tool.name) ? withChromeExtensionGuard(tool) : tool,
);

const legacyToolByName = new Map(legacyTools.map((tool) => [tool.name, tool]));

const migrationArguments = (action, args = {}, defaults = {}) => {
  const next = { ...args };
  delete next.detail;
  return { ...next, ...defaults, action };
};

const legacyToolReplacement = (name, args = {}) => {
  switch (name) {
    case 'gemini_browser_status':
      return { tool: 'gemini_ready', arguments: migrationArguments('status', args) };
    case 'gemini_browser_ready':
      return { tool: 'gemini_ready', arguments: migrationArguments('check', args) };
    case 'gemini_list_tabs':
      return { tool: 'gemini_tabs', arguments: migrationArguments('list', args) };
    case 'gemini_claim_tab':
      return { tool: 'gemini_tabs', arguments: migrationArguments('claim', args) };
    case 'gemini_release_tab':
      return { tool: 'gemini_tabs', arguments: migrationArguments('release', args) };
    case 'gemini_reload_gemini_tabs':
      return { tool: 'gemini_tabs', arguments: migrationArguments('reload', args) };
    case 'gemini_list_recent_chats':
      return { tool: 'gemini_chats', arguments: migrationArguments('list', args, { source: 'recent' }) };
    case 'gemini_list_notebook_chats':
      return { tool: 'gemini_chats', arguments: migrationArguments('list', args, { source: 'notebook' }) };
    case 'gemini_get_current_chat':
      return { tool: 'gemini_chats', arguments: migrationArguments('current', args) };
    case 'gemini_open_chat':
      {
        const { notebook: _notebook, ...openArgs } = args;
        return {
          tool: 'gemini_chats',
          arguments: migrationArguments('open', openArgs, {
            source: args.notebook ? 'notebook' : 'recent',
          }),
        };
      }
    case 'gemini_download_chat':
      return {
        tool: 'gemini_chats',
        arguments: migrationArguments('download', args, { source: 'recent' }),
      };
    case 'gemini_download_notebook_chat':
      return {
        tool: 'gemini_chats',
        arguments: migrationArguments('download', args, { source: 'notebook' }),
      };
    case 'gemini_export_recent_chats':
      return { tool: 'gemini_export', arguments: migrationArguments('recent', args) };
    case 'gemini_export_missing_chats':
      return { tool: 'gemini_export', arguments: migrationArguments('missing', args) };
    case 'gemini_sync_vault':
      return { tool: 'gemini_export', arguments: migrationArguments('sync', args) };
    case 'gemini_reexport_chats':
      return { tool: 'gemini_export', arguments: migrationArguments('reexport', args) };
    case 'gemini_export_notebook':
      return { tool: 'gemini_export', arguments: migrationArguments('notebook', args) };
    case 'gemini_export_job_status':
      return { tool: 'gemini_job', arguments: migrationArguments('status', args) };
    case 'gemini_export_job_cancel':
      return { tool: 'gemini_job', arguments: migrationArguments('cancel', args) };
    case 'gemini_get_export_dir':
      return { tool: 'gemini_config', arguments: migrationArguments('get_export_dir', args) };
    case 'gemini_set_export_dir':
      return { tool: 'gemini_config', arguments: migrationArguments('set_export_dir', args) };
    case 'gemini_cache_status':
      return { tool: 'gemini_config', arguments: migrationArguments('cache_status', args) };
    case 'gemini_clear_cache':
      return { tool: 'gemini_config', arguments: migrationArguments('clear_cache', args) };
    case 'gemini_diagnose_environment':
      return { tool: 'gemini_support', arguments: migrationArguments('diagnose', args) };
    case 'gemini_mcp_diagnose_processes':
      return { tool: 'gemini_support', arguments: migrationArguments('processes', args) };
    case 'gemini_mcp_cleanup_stale_processes':
      return { tool: 'gemini_support', arguments: migrationArguments('cleanup_processes', args) };
    case 'gemini_flight_recorder':
      return { tool: 'gemini_support', arguments: migrationArguments('flight_recorder', args) };
    case 'gemini_collect_support_bundle':
      return { tool: 'gemini_support', arguments: migrationArguments('bundle', args) };
    case 'gemini_snapshot':
      return { tool: 'gemini_support', arguments: migrationArguments('snapshot', args) };
    default:
      return null;
  }
};

const legacyToolRenamedResult = (name, args = {}) => {
  const replacement = legacyToolReplacement(name, args);
  return toolTextResult(
    {
      ok: false,
      error: `Tool renomeada no gemini-md-export v0.5.0: ${name}.`,
      code: 'tool_renamed',
      legacyTool: name,
      replacement,
      nextAction: replacement
        ? {
            code: 'call_replacement_tool',
            message: `Use ${replacement.tool} com os argumentos informados em replacement.arguments.`,
            command: replacement,
          }
        : null,
    },
    { isError: true },
  );
};

const fullDetailRequested = (args = {}) => String(args.detail || '').toLowerCase() === 'full';

const compactClient = (client) => {
  if (!client) return null;
  return {
    clientId: client.clientId || null,
    tabId: client.tabId ?? null,
    windowId: client.windowId ?? null,
    url: client.url || null,
    title: client.title || null,
    chatId: client.chatId || client.page?.chatId || null,
    routeKind: client.routeKind || client.page?.routeKind || null,
    isActiveTab: client.isActiveTab === true,
    claimed: client.claimed === true || client.claim ? true : undefined,
  };
};

const compactClients = (clients, limit = 20) =>
  Array.isArray(clients) ? clients.slice(0, limit).map(compactClient) : [];

const compactNextAction = (nextAction) => {
  if (!nextAction || typeof nextAction !== 'object') return nextAction || null;
  const command =
    nextAction.command?.tool && legacyToolByName.has(nextAction.command.tool)
      ? legacyToolReplacement(nextAction.command.tool, nextAction.command.arguments || {})
      : nextAction.command || null;
  return {
    code: nextAction.code || null,
    message: nextAction.message || null,
    command,
  };
};

const compactStructuredContent = (name, action, structured = {}) => {
  if (!structured || typeof structured !== 'object') return structured;

  if (name === 'gemini_ready') {
    return {
      ok: structured.ok !== false,
      ready: structured.ready === true,
      status: structured.ready === true ? 'ready' : 'not_ready',
      blockingIssue: structured.blockingIssue || null,
      matchingClientCount: structured.matchingClientCount ?? structured.connectedClientCount ?? null,
      connectedClientCount: Array.isArray(structured.connectedClients)
        ? structured.connectedClients.length
        : structured.connectedClientCount ?? null,
      clients: compactClients(structured.connectedClients || structured.clients, 8),
      manualReloadRequired: structured.manualReloadRequired === true,
      handshake: structured.handshake
        ? {
            mode: structured.handshake.mode || null,
            timings: structured.handshake.timings || null,
          }
        : null,
      extensionReadiness: structured.extensionReadiness
        ? {
            status: structured.extensionReadiness.status || null,
            serviceWorker: structured.extensionReadiness.serviceWorker?.status || null,
            contentScript: structured.extensionReadiness.contentScript?.status || null,
            reload: structured.extensionReadiness.reload || null,
          }
        : null,
      nextAction: compactNextAction(structured.nextAction),
    };
  }

  if (name === 'gemini_tabs') {
    return {
      ok: structured.ok !== false,
      action,
      status: structured.status || (structured.ok === false ? 'failed' : 'ok'),
      connectedTabCount: structured.connectedTabCount ?? null,
      connectedClientCount: structured.connectedClientCount ?? null,
      tabs: compactClients(structured.tabs, 20),
      claim: structured.claim || structured.claimed || null,
      released: structured.released ?? null,
      reloaded: structured.reloaded ?? null,
      failureCount: structured.failureCount ?? structured.failures?.length ?? null,
      browserWake: structured.browserWake
        ? {
            attempted: structured.browserWake.attempted === true,
            reason: structured.browserWake.reason || null,
            connectedAfterWake: structured.browserWake.connectedAfterWake ?? null,
          }
        : null,
      nextAction: compactNextAction(structured.nextAction),
    };
  }

  if (name === 'gemini_chats') {
    const conversations = Array.isArray(structured.conversations)
      ? structured.conversations
      : Array.isArray(structured.chats)
        ? structured.chats
        : [];
    const conversationPreviewLimit = structured.countOnly === true || structured.action === 'count'
      ? 0
      : structured.totalKnown === false
        ? 10
        : 50;
    return {
      ok: structured.ok !== false,
      action,
      source: structured.source || structured.page?.source || null,
      client: compactClient(structured.client),
      countStatus: structured.countStatus || structured.pagination?.countStatus || null,
      countIsTotal: structured.countIsTotal ?? structured.pagination?.countIsTotal ?? null,
      totalKnown: structured.totalKnown ?? structured.pagination?.totalKnown ?? null,
      totalCount: structured.totalCount ?? structured.pagination?.totalCount ?? null,
      countSource: structured.countSource ?? structured.pagination?.countSource ?? null,
      countConfidence: structured.countConfidence ?? structured.pagination?.countConfidence ?? null,
      knownLoadedCount:
        structured.knownLoadedCount ?? structured.pagination?.knownLoadedCount ?? structured.pagination?.loadedCount ?? null,
      minimumKnownCount:
        structured.minimumKnownCount ?? structured.pagination?.minimumKnownCount ?? structured.pagination?.loadedCount ?? null,
      countWarning: structured.countWarning || null,
      answer: structured.answer || null,
      chatId: structured.chatId || structured.markdown?.chatId || null,
      title: structured.title || structured.markdown?.title || null,
      filePath: structured.filePath || structured.path || null,
      outputDir: structured.outputDir || null,
      mediaFileCount: structured.mediaFileCount ?? structured.mediaFiles?.length ?? null,
      mediaFailureCount: structured.mediaFailureCount ?? structured.mediaFailures?.length ?? null,
      count: structured.count ?? conversations.length,
      pagination: structured.pagination || null,
      conversationPreviewCount: Math.min(conversations.length, conversationPreviewLimit),
      omittedConversationCount: Math.max(0, conversations.length - conversationPreviewLimit),
      conversations: conversations.slice(0, conversationPreviewLimit).map((conversation, index) => ({
        index: conversation.index ?? index + 1,
        chatId: conversation.chatId || conversation.id || null,
        title: conversation.title || null,
        url: conversation.url || null,
        source: conversation.source || null,
      })),
      nextAction: compactNextAction(structured.nextAction),
    };
  }

  if (name === 'gemini_export' || name === 'gemini_job') {
    return {
      ok: structured.ok !== false,
      action,
      jobId: structured.jobId || null,
      type: structured.type || structured.kind || null,
      status: structured.status || null,
      phase: structured.phase || null,
      progressMessage: structured.progressMessage || null,
      decisionSummary: structured.decisionSummary || null,
      nextAction: compactNextAction(structured.nextAction),
      outputDir: structured.outputDir || null,
      reportFile: structured.reportFile || null,
      current: structured.current || structured.currentChat || null,
      counts: {
        total: structured.totalCount ?? structured.total ?? null,
        processed: structured.processedCount ?? structured.processed ?? null,
        success: structured.successCount ?? structured.savedCount ?? null,
        failure: structured.failureCount ?? structured.errorCount ?? null,
        skipped: structured.skippedCount ?? null,
        existingVault: structured.existingVaultCount ?? null,
        webConversations: structured.webConversationCount ?? null,
        missing: structured.missingCount ?? null,
      },
      recentErrors: Array.isArray(structured.recentErrors)
        ? structured.recentErrors.slice(-5)
        : Array.isArray(structured.failures)
          ? structured.failures.slice(-5)
          : [],
      error: structured.error || null,
    };
  }

  if (name === 'gemini_config') {
    return {
      ok: structured.ok !== false,
      action,
      outputDir: structured.outputDir || null,
      defaultExportDir: structured.defaultExportDir || null,
      reset: structured.reset === true,
      client: compactClient(structured.client),
      count: structured.count ?? structured.entries?.length ?? null,
      cleared: structured.cleared ?? null,
      error: structured.error || null,
    };
  }

  if (name === 'gemini_support') {
    return {
      ok: structured.ok !== false,
      action,
      status: structured.status || null,
      ready: structured.ready ?? null,
      bridgeRole: structured.mcp?.bridgeRole || structured.bridgeRole || null,
      pid: structured.pid || structured.process?.pid || null,
      file: structured.file || structured.bundleFile || structured.path || null,
      outputDir: structured.outputDir || null,
      eventCount: Array.isArray(structured.events) ? structured.events.length : null,
      processCount: Array.isArray(structured.processes) ? structured.processes.length : null,
      wouldTerminate: structured.wouldTerminate || null,
      terminated: structured.terminated || null,
      client: compactClient(structured.client),
      error: structured.error || null,
      nextAction: compactNextAction(structured.nextAction),
    };
  }

  return structured;
};

const callLegacyTool = async (legacyName, args = {}) => {
  const tool = legacyToolByName.get(legacyName);
  if (!tool) {
    return toolTextResult({ error: `Handler legado desconhecido: ${legacyName}` }, { isError: true });
  }
  return tool.call(args);
};

const callLegacyToolCompacted = async (publicName, action, legacyName, args = {}) => {
  const result = await callLegacyTool(legacyName, args);
  if (fullDetailRequested(args)) return result;
  return {
    ...result,
    structuredContent: compactStructuredContent(publicName, action, result.structuredContent),
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          compactStructuredContent(publicName, action, result.structuredContent),
          null,
          2,
        ),
      },
    ],
  };
};

const domainSelectorProperties = () => clientSelectorProperties();

const advancedExportArgs = (args = {}) => {
  const { action: _action, source: _source, detail: _detail, advanced, ...rest } = args;
  return {
    ...rest,
    ...(advanced && typeof advanced === 'object' ? advanced : {}),
  };
};

const shellQuote = (value) => {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
};

const addCliFlag = (args, flag, value) => {
  if (value === undefined || value === null || value === '') return;
  if (value === true) {
    args.push(flag);
    return;
  }
  if (value === false) return;
  args.push(flag, String(value));
};

const chatIdsFromExportArgs = (args = {}) => {
  const values = [];
  if (args.chatId) values.push(args.chatId);
  if (Array.isArray(args.chatIds)) values.push(...args.chatIds);
  if (Array.isArray(args.items)) {
    for (const item of args.items) {
      if (item?.chatId) values.push(item.chatId);
      else if (item?.id) values.push(item.id);
      else if (item?.url) values.push(item.url);
    }
  }
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
};

const buildCliExportCommand = (action, args = {}) => {
  const bridgeUrl = `http://${cli.host}:${cli.port}`;
  const commandArgs = [CLI_BIN_PATH];
  const missingArguments = [];
  const vaultDir = args.vaultDir || args.existingScanDir || null;
  const reportFile = args.resumeReportFile || args.reportFile || null;

  if (action === 'sync') {
    commandArgs.push('sync', vaultDir || '<vaultDir>');
    if (!vaultDir) missingArguments.push('vaultDir');
  } else if (action === 'missing') {
    commandArgs.push('export', 'missing', vaultDir || '<vaultDir>');
    if (!vaultDir) missingArguments.push('vaultDir');
  } else if (action === 'reexport') {
    const chatIds = chatIdsFromExportArgs(args);
    commandArgs.push('export', 'reexport');
    for (const chatId of chatIds) commandArgs.push('--chat-id', chatId);
    if (chatIds.length === 0) missingArguments.push('chatId');
  } else if (action === 'notebook') {
    commandArgs.push('export', 'notebook');
  } else if (action === 'resume') {
    commandArgs.push('export', 'resume', reportFile || '<reportFile>');
    if (!reportFile) missingArguments.push('reportFile');
  } else {
    commandArgs.push('export', 'recent');
  }

  addCliFlag(commandArgs, '--output-dir', args.outputDir || (action === 'sync' || action === 'missing' ? vaultDir : null));
  addCliFlag(commandArgs, '--resume-report-file', reportFile);
  addCliFlag(commandArgs, '--sync-state-file', args.syncStateFile);
  addCliFlag(commandArgs, '--known-boundary-count', args.knownBoundaryCount);
  addCliFlag(commandArgs, '--max-chats', args.maxChats || args.limit);
  addCliFlag(commandArgs, '--batch-size', args.batchSize);
  addCliFlag(commandArgs, '--max-load-more-rounds', args.maxLoadMoreRounds);
  addCliFlag(commandArgs, '--load-more-attempts', args.loadMoreAttempts);
  addCliFlag(commandArgs, '--max-no-growth-rounds', args.maxNoGrowthRounds);
  addCliFlag(commandArgs, '--load-more-browser-rounds', args.loadMoreBrowserRounds);
  addCliFlag(commandArgs, '--load-more-browser-timeout-ms', args.loadMoreBrowserTimeoutMs);
  addCliFlag(commandArgs, '--load-more-timeout-ms', args.loadMoreTimeoutMs);
  addCliFlag(commandArgs, '--start-index', args.startIndex);
  addCliFlag(commandArgs, '--delay-ms', args.delayMs);
  if (args.refresh === true) commandArgs.push('--refresh');
  if (args.refresh === false) commandArgs.push('--no-refresh');
  addCliFlag(commandArgs, '--client-id', args.clientId);
  addCliFlag(commandArgs, '--tab-id', args.tabId);
  addCliFlag(commandArgs, '--claim-id', args.claimId);
  addCliFlag(commandArgs, '--bridge-url', bridgeUrl);
  commandArgs.push('--plain');

  return {
    command: process.execPath,
    args: commandArgs,
    cwd: homedir(),
    commandLine: [process.execPath, ...commandArgs].map(shellQuote).join(' '),
    missingArguments,
  };
};

const cliFirstExportResult = (action, args = {}) => {
  const cliCommand = buildCliExportCommand(action, args);
  return {
    ok: false,
    status: 'cli_required',
    code: 'use_cli',
    action,
    reason:
      'Export/sync/reexport/notebook sao jobs longos. Na arquitetura CLI-first, execute a CLI diretamente para ter progresso, RESULT_JSON e lifecycle correto da bridge.',
    cli: cliCommand,
    command: cliCommand.command,
    args: cliCommand.args,
    cwd: cliCommand.cwd,
    nextAction: {
      code: cliCommand.missingArguments.length > 0 ? 'fill_missing_arguments_then_run_cli' : 'run_cli_command',
      message:
        cliCommand.missingArguments.length > 0
          ? `Preencha ${cliCommand.missingArguments.join(', ')} e rode o comando CLI retornado.`
          : 'Rode o comando CLI retornado diretamente no shell, sem repetir gemini_ready/gemini_tabs antes; a CLI faz readiness, tabs e progresso.',
      command: cliCommand,
    },
    help: {
      command: process.execPath,
      args: [CLI_BIN_PATH, action === 'sync' ? 'sync' : 'export', action === 'sync' ? '--help' : action, action === 'sync' ? undefined : '--help'].filter(Boolean),
      cwd: homedir(),
    },
  };
};

const PUBLIC_MCP_INTENTS = new Set(['diagnostic', 'tab_management', 'small_page', 'one_off']);

const publicMcpIntent = (args = {}) => {
  const intent = String(args.intent || '').trim();
  if (args.diagnostic === true) return intent || 'diagnostic';
  if (PUBLIC_MCP_INTENTS.has(intent)) return intent;
  return null;
};

const hasExplicitPublicMcpIntent = (args = {}) => !!publicMcpIntent(args);

const buildCliCountCommand = (args = {}) => {
  const bridgeUrl = `http://${cli.host}:${cli.port}`;
  const commandArgs = [CLI_BIN_PATH, 'chats', 'count'];
  addCliFlag(commandArgs, '--client-id', args.clientId);
  addCliFlag(commandArgs, '--tab-id', args.tabId);
  addCliFlag(commandArgs, '--claim-id', args.claimId);
  addCliFlag(commandArgs, '--load-more-browser-rounds', args.loadMoreBrowserRounds);
  addCliFlag(commandArgs, '--load-more-browser-timeout-ms', args.loadMoreBrowserTimeoutMs);
  addCliFlag(commandArgs, '--load-more-timeout-ms', args.loadMoreTimeoutMs);
  addCliFlag(commandArgs, '--bridge-url', bridgeUrl);
  commandArgs.push('--plain');
  return {
    command: process.execPath,
    args: commandArgs,
    cwd: homedir(),
    commandLine: [process.execPath, ...commandArgs].map(shellQuote).join(' '),
  };
};

const buildCliTabsCommand = (action, args = {}) => {
  const bridgeUrl = `http://${cli.host}:${cli.port}`;
  const commandArgs = [CLI_BIN_PATH, 'tabs', action || 'list'];
  addCliFlag(commandArgs, '--index', args.index);
  addCliFlag(commandArgs, '--client-id', args.clientId);
  addCliFlag(commandArgs, '--tab-id', args.tabId);
  addCliFlag(commandArgs, '--claim-id', args.claimId);
  addCliFlag(commandArgs, '--ttl-ms', args.ttlMs);
  addCliFlag(commandArgs, '--label', args.label);
  if (args.force === true) commandArgs.push('--force');
  addCliFlag(commandArgs, '--bridge-url', bridgeUrl);
  commandArgs.push('--plain');
  return {
    command: process.execPath,
    args: commandArgs,
    cwd: homedir(),
    commandLine: [process.execPath, ...commandArgs].map(shellQuote).join(' '),
  };
};

const buildCliReexportCommand = (args = {}) => {
  const bridgeUrl = `http://${cli.host}:${cli.port}`;
  const commandArgs = [CLI_BIN_PATH, 'export', 'reexport'];
  for (const chatId of chatIdsFromExportArgs(args)) commandArgs.push('--chat-id', chatId);
  addCliFlag(commandArgs, '--output-dir', args.outputDir);
  addCliFlag(commandArgs, '--client-id', args.clientId);
  addCliFlag(commandArgs, '--tab-id', args.tabId);
  addCliFlag(commandArgs, '--claim-id', args.claimId);
  addCliFlag(commandArgs, '--bridge-url', bridgeUrl);
  commandArgs.push('--plain');
  return {
    command: process.execPath,
    args: commandArgs,
    cwd: homedir(),
    commandLine: [process.execPath, ...commandArgs].map(shellQuote).join(' '),
    missingArguments: chatIdsFromExportArgs(args).length === 0 ? ['chatId'] : [],
  };
};

const publicMcpBlockedResult = ({ tool, action, code, reason, cliCommand = null, guidance = null }) =>
  toolTextResult(
    {
      ok: false,
      status: 'blocked',
      code,
      tool,
      action,
      reason,
      cli: cliCommand,
      command: cliCommand?.command || null,
      args: cliCommand?.args || null,
      cwd: cliCommand?.cwd || null,
      guidance,
      nextAction: cliCommand
        ? {
            code: 'run_cli_command',
            message: guidance || 'Rode o comando CLI retornado. Nao use fallback MCP para esta tarefa.',
            command: cliCommand,
          }
        : {
            code: 'explicit_mcp_intent_required',
            message:
              guidance ||
              'Esta tool MCP so roda com diagnostic=true ou intent explicito. Para contagem/exportacao, use a CLI.',
          },
    },
    { isError: true },
  );

const publicMcpDiagnosticRequiredResult = (tool, action, args = {}) =>
  publicMcpBlockedResult({
    tool,
    action,
    code: 'explicit_mcp_intent_required',
    reason:
      'MCP ficou reservado para diagnostico/controle explicito. Chamadas normais de usuario devem usar a CLI para evitar JSON grande e disputa de aba.',
    cliCommand:
      tool === 'gemini_chats' && (action === 'count' || args.untilEnd === true || args.countOnly === true)
        ? buildCliCountCommand(args)
        : tool === 'gemini_tabs' && ['list', 'claim', 'release', 'reload'].includes(action)
          ? buildCliTabsCommand(action, args)
          : null,
    guidance:
      tool === 'gemini_ready'
        ? 'Se for diagnostico real, chame gemini_ready com diagnostic=true ou intent="diagnostic". Para contar/exportar, rode a CLI diretamente.'
        : tool === 'gemini_tabs'
          ? 'Para fluxo normal, use gemini-md-export tabs ... --plain. Se for diagnostico/controle MCP deliberado, passe diagnostic=true ou intent="tab_management".'
          : 'Para contagem/exportacao, use a CLI. Para uma pagina pequena deliberada, passe diagnostic=true ou intent="small_page".',
  });

const publicMcpCliOnlyResult = (tool, action, cliCommand, reason) =>
  publicMcpBlockedResult({
    tool,
    action,
    code: 'use_cli_only',
    reason,
    cliCommand,
    guidance:
      'Pare aqui e rode a CLI. Se ela falhar por timeout/conexao, responda a falha curta; nao chame gemini_ready/gemini_tabs/gemini_chats como fallback.',
  });

const rawTools = [
  {
    name: 'gemini_ready',
    description:
      'Diagnóstico explícito do bridge/extensão/abas Gemini. Para evitar JSON ruidoso, exige diagnostic=true ou intent="diagnostic".',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'status'],
          description: 'check é leve; status inclui diagnóstico mais completo.',
        },
        wakeBrowser: { type: 'boolean' },
        waitMs: { type: 'number' },
        initialWaitMs: { type: 'number' },
        selfHeal: { type: 'boolean' },
        allowReload: { type: 'boolean' },
        reloadWaitMs: { type: 'number' },
        diagnostics: { type: 'boolean' },
        diagnostic: { type: 'boolean' },
        intent: { type: 'string', enum: ['diagnostic'] },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action === 'status' ? 'status' : 'check';
      if (!hasExplicitPublicMcpIntent(args)) {
        return publicMcpDiagnosticRequiredResult('gemini_ready', action, args);
      }
      return callLegacyToolCompacted(
        'gemini_ready',
        action,
        action === 'status' ? 'gemini_browser_status' : 'gemini_browser_ready',
        args,
      );
    },
  },
  {
    name: 'gemini_tabs',
    description:
      'Controle explícito/diagnóstico de abas Gemini. Para fluxo normal de contagem/exportação, use a CLI tabs; MCP exige diagnostic=true ou intent="tab_management".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'claim', 'release', 'reload'] },
        ...domainSelectorProperties(),
        index: { type: 'integer', minimum: 1 },
        chatId: { type: 'string' },
        claimId: { type: 'string' },
        sessionId: { type: 'string' },
        label: { type: 'string' },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
        },
        ttlMs: { type: 'integer', minimum: 30000, maximum: 86400000 },
        force: { type: 'boolean' },
        openIfMissing: { type: 'boolean' },
        waitMs: { type: 'number' },
        allowReload: { type: 'boolean' },
        delayMs: { type: 'integer', minimum: 0, maximum: 10000 },
        diagnostic: { type: 'boolean' },
        intent: { type: 'string', enum: ['diagnostic', 'tab_management'] },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action || 'list';
      if (action !== 'release' && !hasExplicitPublicMcpIntent(args)) {
        return publicMcpDiagnosticRequiredResult('gemini_tabs', action, args);
      }
      const legacyName =
        action === 'claim'
          ? 'gemini_claim_tab'
          : action === 'release'
            ? 'gemini_release_tab'
            : action === 'reload'
              ? 'gemini_reload_gemini_tabs'
              : 'gemini_list_tabs';
      return callLegacyToolCompacted('gemini_tabs', action, legacyName, args);
    },
  },
  {
    name: 'gemini_chats',
    description:
      'Operações MCP deliberadas em chats. Contagem total e download/exportação são CLI-only; list/current/open exigem diagnostic=true ou intent="small_page"/"one_off".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'count', 'current', 'open', 'download'] },
        source: { type: 'string', enum: ['recent', 'notebook'] },
        ...domainSelectorProperties(),
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        offset: { type: 'integer', minimum: 0, maximum: 999 },
        refresh: { type: 'boolean' },
        untilEnd: { type: 'boolean' },
        countOnly: { type: 'boolean' },
        maxLoadMoreRounds: { type: 'integer', minimum: 1, maximum: 500 },
        loadMoreAttempts: { type: 'integer', minimum: 1, maximum: 5 },
        maxNoGrowthRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserTimeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
        loadMoreTimeoutMs: { type: 'integer', minimum: 1000 },
        index: { type: 'integer', minimum: 1 },
        chatId: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        outputDir: { type: 'string' },
        returnToOriginal: { type: 'boolean' },
        diagnostic: { type: 'boolean' },
        intent: { type: 'string', enum: ['diagnostic', 'small_page', 'one_off'] },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action || 'list';
      const source = args.source === 'notebook' ? 'notebook' : 'recent';
      if (action === 'count' || args.untilEnd === true || args.countOnly === true) {
        return publicMcpCliOnlyResult(
          'gemini_chats',
          'count',
          buildCliCountCommand(args),
          'Contagem total e carregamento ate o fim devem rodar pela CLI. MCP nao e fallback para "quantos chats ao todo".',
        );
      }
      if (action === 'download') {
        return publicMcpCliOnlyResult(
          'gemini_chats',
          action,
          buildCliReexportCommand(args),
          'Download/exportacao de chat pelo MCP foi bloqueado para evitar jobs escondidos, JSON grande e claims presas. Use a CLI.',
        );
      }
      if (!hasExplicitPublicMcpIntent(args)) {
        return publicMcpDiagnosticRequiredResult('gemini_chats', action, args);
      }
      const legacyArgs = { ...args };
      if (source === 'notebook') legacyArgs.notebook = true;
      const legacyName =
        action === 'current'
          ? 'gemini_get_current_chat'
          : action === 'open'
            ? 'gemini_open_chat'
            : action === 'download'
              ? source === 'notebook'
                ? 'gemini_download_notebook_chat'
                : 'gemini_download_chat'
              : action === 'count'
                ? 'gemini_list_recent_chats'
              : source === 'notebook'
                ? 'gemini_list_notebook_chats'
                : 'gemini_list_recent_chats';
      if (action === 'count') {
        legacyArgs.limit = 1;
        legacyArgs.offset = 0;
        legacyArgs.countOnly = true;
        legacyArgs.untilEnd = true;
      }
      return callLegacyToolCompacted('gemini_chats', action, legacyName, legacyArgs);
    },
  },
  {
    name: 'gemini_export',
    description:
      'Orienta export/sync em lote pelo caminho CLI-first: recent, missing, sync, reexport ou notebook. Nao inicia job escondido pelo MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['recent', 'missing', 'sync', 'reexport', 'notebook'] },
        ...domainSelectorProperties(),
        vaultDir: { type: 'string' },
        outputDir: { type: 'string' },
        syncStateFile: { type: 'string' },
        resumeReportFile: { type: 'string' },
        reportFile: { type: 'string' },
        startIndex: { type: 'integer', minimum: 1 },
        maxChats: { type: 'integer', minimum: 1, maximum: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        refresh: { type: 'boolean' },
        skipExisting: { type: 'boolean' },
        knownBoundaryCount: { type: 'integer', minimum: 1, maximum: 100 },
        maxLoadMoreRounds: { type: 'integer', minimum: 1, maximum: 500 },
        loadMoreAttempts: { type: 'integer', minimum: 1, maximum: 5 },
        maxNoGrowthRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserRounds: { type: 'integer', minimum: 1, maximum: 20 },
        loadMoreBrowserTimeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
        loadMoreTimeoutMs: { type: 'integer', minimum: 1000 },
        chatId: { type: 'string' },
        chatIds: { type: 'array', maxItems: 500, items: { type: 'string' } },
        items: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: true } },
        delayMs: { type: 'integer', minimum: 0, maximum: 30000 },
        advanced: { type: 'object', additionalProperties: true },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action || 'recent';
      return toolTextResult(cliFirstExportResult(action, advancedExportArgs(args)));
    },
  },
  {
    name: 'gemini_job',
    description: 'Consulta ou cancela job de export/sync iniciado por gemini_export.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'cancel'] },
        jobId: { type: 'string' },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action === 'cancel' ? 'cancel' : 'status';
      return callLegacyToolCompacted(
        'gemini_job',
        action,
        action === 'cancel' ? 'gemini_export_job_cancel' : 'gemini_export_job_status',
        args,
      );
    },
  },
  {
    name: 'gemini_config',
    description:
      'Consulta/define diretório de export e inspeciona/limpa caches locais da extensão.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_export_dir', 'set_export_dir', 'cache_status', 'clear_cache'],
        },
        ...domainSelectorProperties(),
        outputDir: { type: 'string' },
        reset: { type: 'boolean' },
        notebookId: { type: 'string' },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action || 'get_export_dir';
      const legacyName =
        action === 'set_export_dir'
          ? 'gemini_set_export_dir'
          : action === 'cache_status'
            ? 'gemini_cache_status'
            : action === 'clear_cache'
              ? 'gemini_clear_cache'
              : 'gemini_get_export_dir';
      return callLegacyToolCompacted('gemini_config', action, legacyName, args);
    },
  },
  {
    name: 'gemini_support',
    description:
      'Diagnóstico e suporte operacional: ambiente, processos, cleanup seguro, flight recorder, bundle e snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['diagnose', 'processes', 'cleanup_processes', 'flight_recorder', 'bundle', 'snapshot'],
        },
        ...domainSelectorProperties(),
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        force: { type: 'boolean' },
        waitMs: { type: 'integer', minimum: 100, maximum: 30000 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        outputDir: { type: 'string' },
        flightLimit: { type: 'integer', minimum: 1, maximum: 1000 },
        detail: { type: 'string', enum: ['compact', 'full'] },
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const action = args.action || 'diagnose';
      const legacyName =
        action === 'processes'
          ? 'gemini_mcp_diagnose_processes'
          : action === 'cleanup_processes'
            ? 'gemini_mcp_cleanup_stale_processes'
            : action === 'flight_recorder'
              ? 'gemini_flight_recorder'
              : action === 'bundle'
                ? 'gemini_collect_support_bundle'
                : action === 'snapshot'
                  ? 'gemini_snapshot'
                  : 'gemini_diagnose_environment';
      return callLegacyToolCompacted('gemini_support', action, legacyName, args);
    },
  },
];

const tools = rawTools;
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

const executeToolCall = async (name, args = {}) => {
  const tool = toolByName.get(name);
  const startedAt = Date.now();

  if (!tool) {
    if (legacyToolByName.has(name)) {
      recordFlightEvent('tool_call_renamed', {
        name,
        replacement: legacyToolReplacement(name, args),
      });
      return legacyToolRenamedResult(name, args);
    }
    recordFlightEvent('tool_call_unknown', { name });
    return toolTextResult({ error: `Tool desconhecida: ${name}` }, { isError: true });
  }

  try {
    const result = await tool.call(args);
    recordFlightEvent('tool_call_completed', {
      name,
      elapsedMs: Date.now() - startedAt,
      isError: result?.isError === true,
    });
    return result;
  } catch (err) {
    recordFlightEvent('tool_call_failed', {
      name,
      elapsedMs: Date.now() - startedAt,
      error: err,
    });
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

const LOCAL_PROXY_SUPPORT_ACTIONS = new Set([
  'diagnose',
  'processes',
  'cleanup_processes',
  'flight_recorder',
  'bundle',
]);

const shouldProxyToolCall = (name, args = {}) => {
  if (legacyToolByName.has(name)) return false;
  if (name === 'gemini_support') {
    const action = args.action || 'diagnose';
    return !LOCAL_PROXY_SUPPORT_ACTIONS.has(action);
  }
  return toolByName.has(name);
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

  const proxiedArgs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? {
          ...args,
          sessionId: args.sessionId || args._proxySessionId || PROCESS_SESSION_ID,
          _proxySessionId: args._proxySessionId || PROCESS_SESSION_ID,
        }
      : args;

  const response = await fetch(`${primaryBridgeBaseUrl()}/agent/mcp-tool-call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: proxiedArgs }),
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
  trackBridgeRequestLifecycle(req, res);
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
      bridgeOnly: cli.bridgeOnly === true,
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
      bridgeAssetFetch: snapshotBridgeAssetMetrics(),
      clients: getLiveClients().length,
      idleLifecycle: bridgeIdleLifecycleSnapshot(),
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
        sessionId: PROCESS_SESSION_ID,
        process: summarizeProcess(),
      },
      connectedClients,
      tabClaims: summarizeTabClaims(),
      bridgeAssetFetch: snapshotBridgeAssetMetrics(),
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

  if (req.method === 'GET' && url.pathname === '/agent/tabs') {
    try {
      const action = url.searchParams.get('action') || 'list';
      const args = {
        ...clientSelectorFromSearchParams(url.searchParams),
        index: url.searchParams.get('index') || undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        claimId: url.searchParams.get('claimId') || undefined,
        sessionId: url.searchParams.get('sessionId') || undefined,
        label: url.searchParams.get('label') || undefined,
        color: url.searchParams.get('color') || undefined,
        ttlMs: url.searchParams.get('ttlMs') || undefined,
        force: parseOptionalBoolean(url.searchParams.get('force')),
        openIfMissing: parseOptionalBoolean(url.searchParams.get('openIfMissing')),
        waitMs: url.searchParams.get('waitMs') || undefined,
        allowReload: parseOptionalBoolean(url.searchParams.get('allowReload')),
        delayMs: url.searchParams.get('delayMs') || undefined,
      };
      if (action === 'claim') {
        const client = await selectClaimableClient(args);
        sendAgentJson(res, 200, await claimTabForClient(client, args));
        return;
      }
      if (action === 'release') {
        sendAgentJson(res, 200, await releaseTabClaim(args));
        return;
      }
      if (action === 'reload') {
        sendAgentJson(res, 200, await reloadGeminiTabs(args));
        return;
      }
      if (action !== 'list') {
        sendAgentJson(res, 400, { ok: false, error: `Ação de tabs desconhecida: ${action}` });
        return;
      }
      let allLiveClients = getLiveClients();
      let liveClients = getSelectableGeminiClients();
      let launchResult = null;
      if (liveClients.length === 0 && parseOptionalBoolean(url.searchParams.get('openIfMissing')) !== false) {
        launchResult = await launchChromeForGemini({
          profileDirectory: CHROME_GUARD_CONFIG.profileDirectory,
        });
        await waitForLiveClients(
          normalizeWaitMs(url.searchParams.get('waitMs'), BROWSER_STATUS_WAKE_WAIT_MS),
          CHROME_GUARD_CONFIG.pollIntervalMs || 500,
        );
        allLiveClients = getLiveClients();
        liveClients = getSelectableGeminiClients();
      }
      sendAgentJson(res, 200, {
        ok: true,
        action: 'list',
        sessionId: PROCESS_SESSION_ID,
        connectedTabCount: liveClients.length,
        connectedClientCount: allLiveClients.length,
        tabs: liveClients.map((client, index) => ({
          index: index + 1,
          ...summarizeClient(client),
        })),
        connectedClients: liveClients.map(summarizeClient),
        diagnosticClients: tabSelectionDiagnostics(allLiveClients, liveClients),
        claims: summarizeTabClaims(),
        tabClaims: summarizeTabClaims(),
        browserWake: launchResult || { attempted: false },
      });
    } catch (err) {
      sendAgentJson(res, 503, { ok: false, error: err.message, code: err.code || null });
    }
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    url.pathname === '/agent/claim-tab'
  ) {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const args = {
        ...Object.fromEntries(url.searchParams.entries()),
        ...body,
      };
      const client = await selectClaimableClient(args);
      sendAgentJson(res, 200, await claimTabForClient(client, args));
    } catch (err) {
      sendAgentJson(res, 503, {
        ok: false,
        error: err.message,
        code: err.code || null,
        data: err.data || null,
      });
    }
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    url.pathname === '/agent/release-tab'
  ) {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const args = {
        ...Object.fromEntries(url.searchParams.entries()),
        ...body,
      };
      sendAgentJson(res, 200, await releaseTabClaim(args));
    } catch (err) {
      sendAgentJson(res, 503, {
        ok: false,
        error: err.message,
        code: err.code || null,
        data: err.data || null,
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/diagnostics') {
    sendAgentJson(res, 200, await buildEnvironmentDiagnostics());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/processes') {
    sendAgentJson(res, 200, await buildProcessDiagnostics());
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    url.pathname === '/agent/cleanup-stale-processes'
  ) {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const args = {
        ...Object.fromEntries(url.searchParams.entries()),
        ...body,
        confirm: parseOptionalBoolean(body.confirm ?? url.searchParams.get('confirm')),
        dryRun: parseOptionalBoolean(body.dryRun ?? url.searchParams.get('dryRun')),
        force: parseOptionalBoolean(body.force ?? url.searchParams.get('force')),
        waitMs: body.waitMs ?? url.searchParams.get('waitMs') ?? undefined,
      };
      sendAgentJson(res, 200, await cleanupStaleMcpProcesses(args));
    } catch (err) {
      sendAgentJson(res, 503, { ok: false, error: err.message, code: err.code || null });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/flight-recorder') {
    sendAgentJson(res, 200, {
      ok: true,
      file: FLIGHT_RECORDER_FILE,
      events: readFlightRecorderTail(url.searchParams.get('limit') || 100),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/support-bundle') {
    sendAgentJson(
      res,
      200,
      await buildSupportBundle({
        outputDir: url.searchParams.get('outputDir') || undefined,
        flightLimit: url.searchParams.get('flightLimit') || undefined,
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/ready') {
    sendAgentJson(
      res,
      200,
      await buildLightweightBrowserReady({
        clientId: url.searchParams.get('clientId') || undefined,
        wakeBrowser: parseOptionalBoolean(url.searchParams.get('wakeBrowser')),
        waitMs: url.searchParams.get('waitMs') || undefined,
        selfHeal: parseOptionalBoolean(url.searchParams.get('selfHeal')),
        allowReload: parseOptionalBoolean(url.searchParams.get('allowReload')),
      }),
    );
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
      const selector = clientSelectorFromSearchParams(url.searchParams);
      const client = requireRecentChatsClient(selector);
      const args = {
        ...selector,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
        refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
        untilEnd: parseOptionalBoolean(url.searchParams.get('untilEnd')),
        countOnly: parseOptionalBoolean(url.searchParams.get('countOnly')),
        autoClaim: parseOptionalBoolean(url.searchParams.get('autoClaim')),
        autoReleaseClaim: parseOptionalBoolean(url.searchParams.get('autoReleaseClaim')),
        claimMinVisibleMs: url.searchParams.get('claimMinVisibleMs') || undefined,
        maxLoadMoreRounds: url.searchParams.get('maxLoadMoreRounds') || undefined,
        loadMoreRounds: url.searchParams.get('loadMoreRounds') || undefined,
        loadMoreAttempts: url.searchParams.get('loadMoreAttempts') || undefined,
        maxNoGrowthRounds: url.searchParams.get('maxNoGrowthRounds') || undefined,
        loadMoreBrowserRounds: url.searchParams.get('loadMoreBrowserRounds') || undefined,
        loadMoreBrowserTimeoutMs: url.searchParams.get('loadMoreBrowserTimeoutMs') || undefined,
        loadMoreTimeoutMs: url.searchParams.get('loadMoreTimeoutMs') || undefined,
      };
      const shouldTemporarilyClaimTab =
        (args.countOnly === true || args.untilEnd === true) && args.autoClaim !== false;
      let claim = null;
      let claimVisibleAtMs = null;
      let result = null;
      try {
        if (shouldTemporarilyClaimTab) {
          claim = await ensureTabClaimForJob(client, args, args.countOnly ? 'GME Count' : 'GME List');
          claimVisibleAtMs = claim ? Date.now() : null;
        }
        const operationArgs = claim?.claimId
          ? {
              ...args,
              claimId: claim.claimId,
              tabId: claim.tabId ?? args.tabId,
            }
          : args;
        result = await listRecentChatsForClient(client, operationArgs);
        if (claim) result.tabClaim = claim;
      } finally {
        if (claim?.claimId && shouldAutoReleaseTabClaim(args)) {
          await waitForTabClaimMinimumVisibility(claimVisibleAtMs, args);
          const tabClaimRelease = await releaseTabClaim({
            claimId: claim.claimId,
            reason: 'recent-chats-list-finished',
          });
          if (result) result.tabClaimRelease = tabClaimRelease;
        }
      }
      sendAgentJson(res, 200, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-recent-chats') {
    try {
      const selector = clientSelectorFromSearchParams(url.searchParams);
      const client = requireClient(selector);
      await ensureTabClaimForJob(client, selector, 'GME Export');
      sendAgentJson(
        res,
        202,
        startRecentChatsExportJob(client, {
          ...selector,
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
          loadMoreTimeoutMs: url.searchParams.get('loadMoreTimeoutMs') || undefined,
          skipExisting: parseOptionalBoolean(url.searchParams.get('skipExisting')),
          autoReleaseClaim: parseOptionalBoolean(url.searchParams.get('autoReleaseClaim')),
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/export-missing-chats') {
    try {
      const selector = clientSelectorFromSearchParams(url.searchParams);
      const client = requireClient(selector);
      await ensureTabClaimForJob(client, selector, 'GME Missing');
      sendAgentJson(
        res,
        202,
        startRecentChatsExportJob(client, {
          ...selector,
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
          loadMoreTimeoutMs: url.searchParams.get('loadMoreTimeoutMs') || undefined,
          skipExisting: true,
          autoReleaseClaim: parseOptionalBoolean(url.searchParams.get('autoReleaseClaim')),
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/sync-vault') {
    try {
      const selector = clientSelectorFromSearchParams(url.searchParams);
      const client = requireClient(selector);
      await ensureTabClaimForJob(client, selector, 'GME Sync');
      sendAgentJson(
        res,
        202,
        startRecentChatsExportJob(client, {
          ...selector,
          vaultDir: url.searchParams.get('vaultDir'),
          existingScanDir: url.searchParams.get('vaultDir'),
          outputDir: url.searchParams.get('outputDir') || url.searchParams.get('vaultDir') || undefined,
          syncStateFile: url.searchParams.get('syncStateFile') || undefined,
          resumeReportFile: url.searchParams.get('resumeReportFile') || url.searchParams.get('reportFile') || undefined,
          exportMissingOnly: true,
          syncMode: true,
          refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
          batchSize: url.searchParams.get('batchSize') || undefined,
          knownBoundaryCount: url.searchParams.get('knownBoundaryCount') || undefined,
          maxLoadMoreRounds: url.searchParams.get('maxLoadMoreRounds') || undefined,
          loadMoreAttempts: url.searchParams.get('loadMoreAttempts') || undefined,
          maxNoGrowthRounds: url.searchParams.get('maxNoGrowthRounds') || undefined,
          loadMoreBrowserRounds: url.searchParams.get('loadMoreBrowserRounds') || undefined,
          loadMoreBrowserTimeoutMs: url.searchParams.get('loadMoreBrowserTimeoutMs') || undefined,
          loadMoreTimeoutMs: url.searchParams.get('loadMoreTimeoutMs') || undefined,
          skipExisting: true,
          autoReleaseClaim: parseOptionalBoolean(url.searchParams.get('autoReleaseClaim')),
        }),
      );
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/agent/reexport-chats') {
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const chatIds = [
        ...url.searchParams.getAll('chatId'),
        ...(Array.isArray(body.chatIds) ? body.chatIds : []),
        ...(body.chatId ? [body.chatId] : []),
        ...String(url.searchParams.get('chatIds') || '')
          .split(/[,\s]+/)
          .filter(Boolean),
      ];
      const itemsText = url.searchParams.get('items');
      const items = body.items || (itemsText ? JSON.parse(itemsText) : undefined);
      const bodySelector = body && typeof body === 'object' ? body : {};
      const selector = {
        ...clientSelectorFromSearchParams(url.searchParams),
        ...bodySelector,
      };
      const client = requireClient(selector);
      await ensureTabClaimForJob(client, selector, 'GME Reexport');
      sendAgentJson(
        res,
        202,
        startDirectChatsExportJob(client, {
          ...selector,
          ...bodySelector,
          outputDir: body.outputDir || url.searchParams.get('outputDir') || undefined,
          chatIds,
          items,
          delayMs: body.delayMs || url.searchParams.get('delayMs') || undefined,
          autoReleaseClaim: parseOptionalBoolean(
            body.autoReleaseClaim ?? url.searchParams.get('autoReleaseClaim'),
          ),
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
      const client = requireNotebookClient(clientSelectorFromSearchParams(url.searchParams));
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
      const client = requireClient(clientSelectorFromSearchParams(url.searchParams));
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
        ...clientSelectorFromSearchParams(url.searchParams),
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        outputDir: url.searchParams.get('outputDir') || undefined,
        returnToOriginal: url.searchParams.get('returnToOriginal') !== 'false',
      };
      const client = requireClient(args);
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
        ...clientSelectorFromSearchParams(url.searchParams),
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        title: url.searchParams.get('title') || undefined,
        outputDir: url.searchParams.get('outputDir') || undefined,
        returnToOriginal: url.searchParams.get('returnToOriginal') !== 'false',
      };
      const client = requireNotebookClient(args);
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
        ...clientSelectorFromSearchParams(url.searchParams),
        outputDir: url.searchParams.get('outputDir') || undefined,
        startIndex: url.searchParams.has('startIndex')
          ? Number(url.searchParams.get('startIndex'))
          : undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        autoReleaseClaim: parseOptionalBoolean(url.searchParams.get('autoReleaseClaim')),
      };
      const client = requireNotebookClient(args);
      const claim = await ensureTabClaimForJob(client, args, 'GME Notebook');
      let result = null;
      try {
        result = await exportNotebookForClient(client, args);
      } finally {
        if (shouldAutoReleaseTabClaim(args) && claim?.claimId) {
          const tabClaimRelease = await releaseTabClaim({
            claimId: claim.claimId,
            reason: 'notebook-export-finished',
          });
          if (result) result.tabClaimRelease = tabClaimRelease;
        }
      }
      sendAgentJson(res, result.failureCount > 0 ? 207 : 200, result);
    } catch (err) {
      sendAgentJson(res, 503, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/cache-status') {
    try {
      const client = requireClient(clientSelectorFromSearchParams(url.searchParams));
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
      const client = requireClient(clientSelectorFromSearchParams(url.searchParams));
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
        ...clientSelectorFromSearchParams(url.searchParams),
        index: url.searchParams.has('index') ? Number(url.searchParams.get('index')) : undefined,
        chatId: url.searchParams.get('chatId') || undefined,
        url: url.searchParams.get('url') || undefined,
        title: url.searchParams.get('title') || undefined,
        notebook: url.searchParams.get('notebook') === 'true',
      };
      const client = args.notebook ? requireNotebookClient(args) : requireClient(args);
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
        ...clientSelectorFromSearchParams(url.searchParams),
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
      const client = requireClient(clientSelectorFromSearchParams(url.searchParams));
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

      lastChromeHeartbeatAt = Date.now();
      touchBridgeActivity();
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
  recordFlightEvent('bridge_started', {
    role: bridgeRole,
    host: cli.host,
    port: cli.port,
    version: SERVER_VERSION,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    idleLifecycle: bridgeIdleLifecycleSnapshot(),
  });
  scheduleIdleShutdownCheck();
});

const shutdown = (reason, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) log(reason);
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }

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
    if (cli.bridgeOnly) {
      debugLog(
        `bridge HTTP já está em uso em ${cli.host}:${cli.port}; processo bridge-only vai encerrar sem iniciar MCP.`,
      );
      shutdown('Bridge local já está ativo; encerrando bridge-only.', 0);
      return;
    }
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
        shouldProxyToolCall(name, args)
      ) {
        result = await proxyToolCallToPrimary(name, args);
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

if (!cli.bridgeOnly) {
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
} else {
  debugLog('bridge-only ativo; servidor MCP por stdio não será iniciado.');
}
