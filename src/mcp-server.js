#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const bridgeVersion = JSON.parse(readFileSync(resolve(ROOT, 'bridge-version.json'), 'utf-8'));

const SERVER_NAME = 'gemini-md-export';
const SERVER_VERSION = pkg.version;
const EXTENSION_PROTOCOL_VERSION = Number(bridgeVersion.protocolVersion);
const PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_HOST = process.env.GEMINI_MCP_BRIDGE_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.GEMINI_MCP_BRIDGE_PORT || 47283);
const DEFAULT_EXPORT_DIR = process.env.GEMINI_MCP_EXPORT_DIR || resolve(homedir(), 'Downloads');
const CLIENT_STALE_MS = 45_000;
const LONG_POLL_TIMEOUT_MS = 25_000;
const COMMAND_TIMEOUT_MS = Number(process.env.GEMINI_MCP_COMMAND_TIMEOUT_MS || 180_000);
const FOLDER_PICKER_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_BRIDGE_ORIGIN = 'https://gemini.google.com';
const RECENT_CHATS_CACHE_MAX_AGE_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_CACHE_MAX_AGE_MS || DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS,
);
const RECENT_CHATS_REFRESH_BUDGET_MS = Number(
  process.env.GEMINI_MCP_RECENT_CHATS_REFRESH_BUDGET_MS || 2500,
);
const CHROME_GUARD_CONFIG = {
  profileDirectory:
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY ||
    process.env.GME_CHROME_PROFILE_DIRECTORY ||
    'Default',
  launchIfClosed: process.env.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED !== 'false',
  reloadTimeoutMs: Number(process.env.GEMINI_MCP_CHROME_RELOAD_TIMEOUT_MS || 15_000),
  maxReloadAttempts: Number(process.env.GEMINI_MCP_CHROME_MAX_RELOAD_ATTEMPTS || 1),
  useExtensionsReloaderFallback:
    process.env.GEMINI_MCP_USE_EXTENSIONS_RELOADER_FALLBACK === 'true',
};
const EXPECTED_CHROME_EXTENSION_INFO = {
  extensionVersion: bridgeVersion.extensionVersion || SERVER_VERSION,
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
};

const clients = new Map();
const pendingCommands = new Map();
const exportJobs = new Map();
let configuredExportDir = DEFAULT_EXPORT_DIR;
let shuttingDown = false;

const log = (...args) => {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
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
        b.lastSeenAt - a.lastSeenAt,
    );
};

const cleanupStaleClients = () => {
  const now = Date.now();
  for (const [clientId, client] of clients.entries()) {
    if (now - client.lastSeenAt <= CLIENT_STALE_MS) continue;
    if (client.pendingPoll) {
      try {
        clearTimeout(client.pendingPoll.timer);
        sendNoContent(client.pendingPoll.res);
      } catch {
        // ignore socket errors
      }
    }
    clients.delete(clientId);
  }
};

const upsertClient = (payload) => {
  const existing = clients.get(payload.clientId);
  const next = existing || {
    clientId: payload.clientId,
    queue: [],
    pendingPoll: null,
  };

  next.lastSeenAt = Date.now();
  next.tabId = payload.tabId ?? next.tabId ?? null;
  next.windowId = payload.windowId ?? next.windowId ?? null;
  next.isActiveTab = payload.isActiveTab ?? next.isActiveTab ?? null;
  next.extensionVersion = payload.extensionVersion || next.extensionVersion || null;
  next.protocolVersion =
    payload.protocolVersion !== undefined ? payload.protocolVersion : next.protocolVersion ?? null;
  next.buildStamp = payload.buildStamp || payload.page?.buildStamp || next.buildStamp || null;
  next.page = payload.page || next.page || null;
  next.conversations = Array.isArray(payload.conversations)
    ? payload.conversations
    : next.conversations || [];
  next.summary = payload;

  clients.set(next.clientId, next);
  return next;
};

const flushQueuedCommand = (client) => {
  if (!client?.pendingPoll || client.queue.length === 0) return false;
  const command = client.queue.shift();
  const { res, timer } = client.pendingPoll;
  clearTimeout(timer);
  client.pendingPoll = null;
  sendJson(res, 200, { command });
  return true;
};

const enqueueCommand = (clientId, type, args = {}) => {
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

  client.queue.push(command);
  flushQueuedCommand(client);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(command.id);
      reject(new Error(`Timeout aguardando resposta do comando ${type}.`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(command.id, {
      clientId,
      resolve,
      reject,
      timer,
      type,
    });
  });
};

const resolveCommand = (commandId, result) => {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  pending.resolve(result);
  return true;
};

const toolTextResult = (structuredContent, { isError = false } = {}) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(structuredContent, null, 2),
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

const launchChromeForGemini = async ({ profileDirectory } = {}) => {
  if (process.platform !== 'win32') {
    return {
      attempted: false,
      supported: false,
      reason: 'unsupported-platform',
    };
  }

  const profileArg = profileDirectory ? `--profile-directory=${profileDirectory}` : null;
  const args = [profileArg, 'https://gemini.google.com/app'].filter(Boolean);
  const quotedArgs = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
  const explicitChrome = process.env.GEMINI_MCP_CHROME_EXE || process.env.GME_CHROME_EXE || '';
  const candidates = [
    explicitChrome,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'chrome.exe',
  ].filter(Boolean);
  const quotedCandidates = candidates
    .map((candidate) => `'${String(candidate).replace(/'/g, "''")}'`)
    .join(',');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$candidates = @(${quotedCandidates})`,
    `$arguments = @(${quotedArgs})`,
    'foreach ($candidate in $candidates) {',
    "  if ($candidate -eq 'chrome.exe' -or (Test-Path -LiteralPath $candidate)) {",
    '    Start-Process -FilePath $candidate -ArgumentList $arguments -WindowStyle Minimized',
    '    exit 0',
    '  }',
    '}',
    'exit 1',
  ].join('; ');

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    return {
      attempted: true,
      supported: true,
      method: 'powershell-start-process-minimized',
      profileDirectory: profileDirectory || null,
    };
  } catch (err) {
    return {
      attempted: true,
      supported: true,
      error: err?.message || String(err),
    };
  }
};

const getChromeExtensionInfo = async (client) => {
  const result = await enqueueCommand(client.clientId, 'get-extension-info');
  return result || null;
};

const reloadChromeExtension = async (client, args = {}) => {
  const result = await enqueueCommand(client.clientId, 'reload-extension-self', args);
  return result || null;
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
      log,
    },
    {
      clientId: args.clientId || null,
      ...options,
    },
  );

const summarizeClient = (client) => ({
  clientId: client.clientId,
  tabId: client.tabId ?? null,
  windowId: client.windowId ?? null,
  isActiveTab: client.isActiveTab ?? null,
  extensionVersion: client.extensionVersion ?? null,
  protocolVersion: client.protocolVersion ?? null,
  buildStamp: client.buildStamp ?? client.page?.buildStamp ?? null,
  lastSeenAt: new Date(client.lastSeenAt).toISOString(),
  page: client.page || null,
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

    throw new Error(`A conversa ${requestedChatId} não está carregada no sidebar.`);
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

  const saved = writeExportPayload(result.payload, { outputDir: args.outputDir });
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
  let roundsCompleted = 0;
  let previousCount = initialCount;

  for (let round = 0; round < plan.rounds; round += 1) {
    const result = await enqueueCommand(client.clientId, 'load-more-conversations', {
      ensureSidebar: true,
      attempts: plan.attemptsPerRound,
      targetCount: plan.targetCount,
      fastMode: true,
    });

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

    if (currentCount >= plan.targetCount) break;
    if (reachedEnd) break;
    if (currentCount <= previousCount && result.loadedAny !== true) break;

    previousCount = currentCount;
  }

  return {
    attempted: true,
    loadedAny,
    roundsCompleted,
    reachedEnd,
    snapshot: latestSnapshot,
    conversations: recentConversationsForClient(client),
  };
};

const loadAllRecentChatsForClient = async (client, args = {}) => {
  let latestSnapshot = client.lastSnapshot || null;
  let reachedEnd = recentChatsReachedEndForClient(client);
  let loadedAny = false;
  let roundsCompleted = 0;
  let previousCount = recentConversationsForClient(client).length;
  const batchSize = Math.max(10, Math.min(200, Number(args.batchSize || 50)));
  const maxRounds = Math.max(1, Math.min(500, Number(args.maxLoadMoreRounds || args.loadMoreRounds || 200)));
  const attempts = Math.max(1, Math.min(5, Number(args.loadMoreAttempts || 3)));

  for (let round = 0; round < maxRounds && !reachedEnd; round += 1) {
    if (args.shouldStop?.()) break;

    const targetCount = previousCount + batchSize;
    const result = await enqueueCommand(client.clientId, 'load-more-conversations', {
      ensureSidebar: true,
      attempts,
      targetCount,
      fastMode: true,
      includeConversations: false,
      includeSnapshot: false,
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Falha ao puxar historico completo no browser.');
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
    loadedAny = loadedAny || result.loadedAny === true || currentCount > previousCount;

    if (currentCount <= previousCount && result.loadedAny !== true) break;
    previousCount = currentCount;
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
    roundsCompleted,
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
    loadMore = await loadMoreRecentChatsForClient(client, targetCount, args);
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
  clientId: job.clientId,
  outputDir: job.outputDir,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  finishedAt: job.finishedAt || null,
  startIndex: job.startIndex,
  exportAll: job.exportAll,
  maxChats: job.maxChats,
  loadedCount: job.loadedCount,
  requested: job.requested,
  completed: job.completed,
  successCount: job.successCount,
  failureCount: job.failureCount,
  reachedEnd: job.reachedEnd,
  truncated: job.truncated,
  cancelRequested: job.cancelRequested,
  cancelledAt: job.cancelledAt || null,
  current: job.current || null,
  reportFile: job.reportFile || null,
  reportFilename: job.reportFilename || null,
  error: job.error || null,
  refreshError: job.refreshError || null,
  loadMoreRoundsCompleted: job.loadMoreRoundsCompleted || 0,
  recentSuccesses: job.recentSuccesses.slice(-10),
  failures: job.failures.slice(-20),
});

const touchExportJob = (job) => {
  job.updatedAt = new Date().toISOString();
};

const isTerminalExportJobStatus = (status) =>
  ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status);

const findRunningRecentChatsExportJob = (clientId) =>
  Array.from(exportJobs.values()).find(
    (job) =>
      job.type === 'recent-chats-export' &&
      job.clientId === clientId &&
      !isTerminalExportJobStatus(job.status),
  );

const buildRecentChatsExportReport = (job, client, successes, failures) => ({
  job: {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    phase: job.phase,
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
  reachedEnd: job.reachedEnd,
  truncated: job.truncated,
  current: job.current || null,
  successes,
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

const runRecentChatsExportJob = async (job, client, args = {}) => {
  const successes = [];
  const failures = [];
  try {
    job.phase = 'loading-history';
    touchExportJob(job);
    persistRecentChatsExportReport(job, client, successes, failures);

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
    job.truncated = !job.exportAll && !job.reachedEnd && conversations.length >= MAX_RECENT_CHATS_LOAD_TARGET;

    const seen = new Set();
    const requestedSlice = job.exportAll
      ? conversations.slice(job.startIndex - 1)
      : conversations.slice(job.startIndex - 1, job.startIndex - 1 + job.maxChats);
    const selected = requestedSlice.filter((conversation) => {
        const key = stripGeminiPrefix(conversation.chatId || conversation.id) || conversation.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    job.requested = selected.length;
    if (selected.length === 0) {
      throw new Error('Nenhuma conversa recente carregada para exportar.');
    }

    job.phase = 'exporting';
    touchExportJob(job);
    persistRecentChatsExportReport(job, client, successes, failures);

    for (let i = 0; i < selected.length; i += 1) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.phase = 'cancelled';
        break;
      }

      const conversation = selected[i];
      const index = job.startIndex + i;
      job.current = {
        index,
        title: conversation.title || null,
        chatId: conversation.chatId || conversation.id || null,
      };
      touchExportJob(job);

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
        job.completed = i + 1;
        touchExportJob(job);
        persistRecentChatsExportReport(job, client, successes, failures);
      }
    }

    if (!job.cancelRequested) {
      job.phase = 'writing-report';
      touchExportJob(job);
      job.status = failures.length > 0 ? 'completed_with_errors' : 'completed';
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
  }
};

const startRecentChatsExportJob = (client, args = {}) => {
  const running = findRunningRecentChatsExportJob(client.clientId);
  if (running) {
    throw new Error(
      `Já existe um job de exportação recente em andamento para esta aba: ${running.jobId}. Consulte o status ou cancele antes de iniciar outro.`,
    );
  }

  const outputDir = resolveOutputDir(args.outputDir);
  const hasExplicitMaxChats = args.maxChats !== undefined || args.limit !== undefined;
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
    reachedEnd: false,
    truncated: false,
    cancelRequested: false,
    cancelledAt: null,
    current: null,
    reportFile: null,
    reportFilename: null,
    error: null,
    refreshError: null,
    loadMoreRoundsCompleted: 0,
    recentSuccesses: [],
    failures: [],
  };
  exportJobs.set(job.jobId, job);
  void runRecentChatsExportJob(job, client, args);
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

  const successes = [];
  const failures = [];
  for (let i = 0; i < selected.length; i += 1) {
    const conversation = selected[i];
    try {
      const result = await downloadConversationItemForClient(client, conversation, {
        ...args,
        returnToOriginal: true,
        notebookReturnMode: 'direct',
      });
      successes.push({
        index: startIndex + i,
        ...result,
      });
    } catch (err) {
      failures.push({
        index: startIndex + i,
        conversation,
        error: err.message,
      });
    }
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
    description: 'Lista as abas do Gemini atualmente conectadas à extensão.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    call: async () =>
      toolTextResult({
        expectedChromeExtension: EXPECTED_CHROME_EXTENSION_INFO,
        connectedClients: getLiveClients().map(summarizeClient),
      }),
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
      'Retorna uma página das conversas visíveis/carregáveis no sidebar do Gemini da aba ativa, ou da aba conectada mais recente como fallback.',
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
      const client = requireClient(args.clientId);
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
      },
      additionalProperties: false,
    },
    call: async (args = {}) => {
      const client = requireClient(args.clientId);
      return toolTextResult(startRecentChatsExportJob(client, args));
    },
  },
  {
    name: 'gemini_export_job_status',
    description:
      'Consulta o andamento de um job de exportacao em lote iniciado por gemini_export_recent_chats.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'ID retornado por gemini_export_recent_chats.',
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
      'Solicita cancelamento de um job de exportacao em lote. O job para antes da proxima conversa, preservando arquivos e relatório já gravados.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'ID retornado por gemini_export_recent_chats.',
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
    const ready = await ensureBrowserExtensionReady(args);
    const guardedArgs = {
      ...args,
      clientId: ready.client?.clientId || args.clientId,
    };
    return tool.call(guardedArgs);
  },
});

const tools = rawTools.map((tool) =>
  BROWSER_DEPENDENT_TOOL_NAMES.has(tool.name) ? withChromeExtensionGuard(tool) : tool,
);

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

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
    sendJson(res, 200, {
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      clients: getLiveClients().length,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/agent/clients') {
    sendAgentJson(res, 200, {
      connectedClients: getLiveClients().map(summarizeClient),
    });
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
      const client = requireClient(url.searchParams.get('clientId'));
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
          startIndex: url.searchParams.get('startIndex'),
          maxChats: url.searchParams.get('maxChats') || url.searchParams.get('limit'),
          refresh: parseOptionalBoolean(url.searchParams.get('refresh')),
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

  if (req.method === 'POST' && url.pathname === '/bridge/heartbeat') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload.clientId) {
        sendJson(res, 400, { error: 'clientId is required' });
        return;
      }

      const client = upsertClient(payload);
      flushQueuedCommand(client);
      sendJson(res, 200, {
        ok: true,
        clientId: client.clientId,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
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

    if (flushQueuedCommand(client)) return;

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

      resolveCommand(payload.commandId, payload.result || null);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

bridgeServer.listen(cli.port, cli.host, () => {
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
  log(formatBridgeListenError(error, { host: cli.host, port: cli.port }));
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
    const tool = toolByName.get(name);

    if (!tool) {
      respond(id, toolTextResult({ error: `Tool desconhecida: ${name}` }, { isError: true }));
      return;
    }

    try {
      const result = await tool.call(args);
      respond(id, result);
    } catch (err) {
      respond(id, toolTextResult({ error: err.message }, { isError: true }));
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
