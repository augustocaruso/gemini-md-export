import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, win32 } from 'node:path';

const GEMINI_URL = 'https://gemini.google.com/app';
const DEFAULT_LAUNCH_OBSERVE_MS = 180;
export const BROWSER_LAUNCH_STATE_FILENAME = 'hook-browser-launch.json';
const WINDOWS_NO_FOCUS_SCRIPT_FILENAME = 'open-gemini-minimized.vbs';
const WINDOWS_RESTORE_FOCUS_SCRIPT_FILENAME = 'open-gemini-restore-focus.ps1';

const quoteCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quoteVbsString = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quotePowerShellString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const firstExisting = (paths, exists = existsSync) => paths.find((candidate) => exists(candidate));

const commandOnPath = (command, spawnSyncFn = spawnSync, platform = process.platform) => {
  const probeCommand = platform === 'win32' ? 'where' : 'which';
  const probe = spawnSyncFn(probeCommand, [command], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
    shell: false,
  });
  if (probe.status !== 0) return null;
  return String(probe.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
};

const normalizeBrowserKey = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'chrome';
  if (/^(google[-_\s]*)?chrome$|chrome\.exe$/.test(text)) return 'chrome';
  if (/^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$/.test(text)) return 'edge';
  if (/^brave$|brave[-_\s]*browser|brave(\.exe)?$/.test(text)) return 'brave';
  if (/^dia$|dia(\.exe)?$/.test(text)) return 'dia';
  return text;
};

const windowsBrowsers = (env = process.env) => {
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return {
    chrome: {
      name: 'Chrome',
      commands: ['chrome.exe', 'chrome'],
      paths: [
        env.GEMINI_MCP_CHROME_EXE,
        env.GME_CHROME_EXE,
        localAppData && win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean),
    },
    edge: {
      name: 'Edge',
      commands: ['msedge.exe', 'msedge'],
      paths: [
        env.GEMINI_MCP_EDGE_EXE,
        env.GME_EDGE_EXE,
        localAppData && win32.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean),
    },
    brave: {
      name: 'Brave',
      commands: ['brave.exe', 'brave'],
      paths: [
        env.GEMINI_MCP_BRAVE_EXE,
        env.GME_BRAVE_EXE,
        localAppData &&
          win32.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        win32.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        win32.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ].filter(Boolean),
    },
    dia: {
      name: 'Dia',
      commands: ['dia.exe', 'dia'],
      paths: [
        env.GEMINI_MCP_DIA_EXE,
        env.GME_DIA_EXE,
        localAppData && win32.join(localAppData, 'Programs', 'Dia', 'Dia.exe'),
        env.APPDATA && win32.join(env.APPDATA, 'Dia', 'Application', 'Dia.exe'),
      ].filter(Boolean),
    },
  };
};

const macBrowsers = (env = process.env) => ({
  chrome: {
    name: 'Chrome',
    app: env.GEMINI_MCP_CHROME_APP || env.GME_CHROME_APP || 'Google Chrome',
    appPaths: ['/Applications/Google Chrome.app', resolve(homedir(), 'Applications', 'Google Chrome.app')],
  },
  edge: {
    name: 'Edge',
    app: env.GEMINI_MCP_EDGE_APP || env.GME_EDGE_APP || 'Microsoft Edge',
    appPaths: ['/Applications/Microsoft Edge.app', resolve(homedir(), 'Applications', 'Microsoft Edge.app')],
  },
  brave: {
    name: 'Brave',
    app: env.GEMINI_MCP_BRAVE_APP || env.GME_BRAVE_APP || 'Brave Browser',
    appPaths: ['/Applications/Brave Browser.app', resolve(homedir(), 'Applications', 'Brave Browser.app')],
  },
  dia: {
    name: 'Dia',
    app: env.GEMINI_MCP_DIA_APP || env.GME_DIA_APP || 'Dia',
    appPaths: ['/Applications/Dia.app', resolve(homedir(), 'Applications', 'Dia.app')],
  },
});

const linuxBrowsers = () => ({
  chrome: { name: 'Chrome', commands: ['google-chrome', 'google-chrome-stable', 'chrome'] },
  edge: { name: 'Edge', commands: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'] },
  brave: { name: 'Brave', commands: ['brave-browser', 'brave'] },
  dia: { name: 'Dia', commands: ['dia'] },
});

const browserOrder = (preferredKey) => [
  preferredKey,
  ...['chrome', 'edge', 'brave', 'dia'].filter((key) => key !== preferredKey),
];

export const browserLaunchStateDir = (env = process.env) =>
  env.GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR ||
  env.GEMINI_MCP_HOOK_STATE_DIR ||
  resolve(env.TEMP || env.TMP || tmpdir(), 'gemini-md-export');

export const browserLaunchStatePath = (env = process.env) =>
  resolve(browserLaunchStateDir(env), BROWSER_LAUNCH_STATE_FILENAME);

export const readBrowserLaunchState = ({ env = process.env } = {}) => {
  try {
    return JSON.parse(readFileSync(browserLaunchStatePath(env), 'utf-8'));
  } catch {
    return null;
  }
};

export const writeBrowserLaunchState = (state, { env = process.env } = {}) => {
  const dir = browserLaunchStateDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, BROWSER_LAUNCH_STATE_FILENAME),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf-8',
  );
};

export const describeRecentBrowserLaunch = (
  state,
  { now = Date.now(), cooldownMs = 60_000 } = {},
) => {
  const lastAttemptAt = Number(state?.lastAttemptAt || 0);
  if (!state || cooldownMs <= 0 || !lastAttemptAt || now - lastAttemptAt >= cooldownMs) {
    return null;
  }

  return {
    source: state.source || 'unknown',
    cooldownMs,
    previousAttemptedAt: new Date(lastAttemptAt).toISOString(),
    ageMs: Math.max(0, now - lastAttemptAt),
    previousLaunch: state,
  };
};

export const buildWindowsNoFocusLaunchScript = (command, args = []) => {
  const commandLine = [quoteCmd(command), ...args.map(quoteCmd)].join(' ');
  return [
    "' Generated by gemini-md-export. Opens Gemini with Windows' minimized/no-activate hint.",
    'On Error Resume Next',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${quoteVbsString(commandLine)}, 7, False`,
    '',
  ].join('\r\n');
};

export const writeWindowsNoFocusLaunchScript = (command, args = [], { env = process.env } = {}) => {
  const dir = browserLaunchStateDir(env);
  mkdirSync(dir, { recursive: true });
  const scriptPath = resolve(dir, WINDOWS_NO_FOCUS_SCRIPT_FILENAME);
  writeFileSync(scriptPath, buildWindowsNoFocusLaunchScript(command, args), 'utf-8');
  return scriptPath;
};

export const buildWindowsRestoreFocusLaunchScript = (
  command,
  args = [],
  { restoreDelayMs = 900 } = {},
) => {
  const argLine = args.map(quoteCmd).join(' ');
  return [
    '# Generated by gemini-md-export. Opens Gemini minimized, then restores the previous foreground window.',
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
    `$arguments = ${quotePowerShellString(argLine)}`,
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    '$psi.FileName = $browser',
    '$psi.Arguments = $arguments',
    '$psi.UseShellExecute = $true',
    '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized',
    '[System.Diagnostics.Process]::Start($psi) | Out-Null',
    `Start-Sleep -Milliseconds ${Math.max(0, Math.min(5000, Number(restoreDelayMs) || 0))}`,
    'if ($previousWindow -ne [IntPtr]::Zero) {',
    '  [GeminiMdExportWin32]::ShowWindowAsync($previousWindow, 9) | Out-Null',
    '  [GeminiMdExportWin32]::SetForegroundWindow($previousWindow) | Out-Null',
    '}',
    '',
  ].join('\r\n');
};

export const writeWindowsRestoreFocusLaunchScript = (
  command,
  args = [],
  { env = process.env, restoreDelayMs } = {},
) => {
  const dir = browserLaunchStateDir(env);
  mkdirSync(dir, { recursive: true });
  const scriptPath = resolve(dir, WINDOWS_RESTORE_FOCUS_SCRIPT_FILENAME);
  writeFileSync(
    scriptPath,
    buildWindowsRestoreFocusLaunchScript(command, args, { restoreDelayMs }),
    'utf-8',
  );
  return scriptPath;
};

export const resolveGeminiBrowserLaunchPlan = ({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  spawnSyncFn = spawnSync,
} = {}) => {
  const preferredKey = normalizeBrowserKey(env.GEMINI_MCP_BROWSER || env.GME_BROWSER || 'chrome');

  if (platform === 'darwin') {
    const browsers = macBrowsers(env);
    const explicitApp =
      env.GEMINI_MCP_BROWSER_APP ||
      env.GME_BROWSER_APP ||
      env.GEMINI_MCP_CHROME_APP ||
      env.GME_CHROME_APP ||
      '';
    if (explicitApp) {
      return {
        platform,
        browserKey: preferredKey,
        browserName: explicitApp,
        app: explicitApp,
        fallbackFrom: null,
        method: 'macos-open-app',
      };
    }

    for (const key of browserOrder(preferredKey)) {
      const browser = browsers[key];
      if (!browser) continue;
      if (!firstExisting(browser.appPaths, exists)) continue;
      return {
        platform,
        browserKey: key,
        browserName: browser.name,
        app: browser.app,
        fallbackFrom: key === preferredKey ? null : browsers[preferredKey]?.name || preferredKey,
        method: 'macos-open-app',
      };
    }

    return {
      platform,
      browserKey: preferredKey,
      browserName: 'default browser',
      app: null,
      fallbackFrom: null,
      method: 'macos-open-default-browser',
    };
  }

  if (platform === 'win32') {
    const browsers = windowsBrowsers(env);
    let commandFallback = null;

    for (const key of browserOrder(preferredKey)) {
      const browser = browsers[key];
      if (!browser) continue;
      if (!commandFallback && key === preferredKey) {
        commandFallback = browser.commands[0] || null;
      }
      const binary = firstExisting(browser.paths, exists);
      if (!binary) continue;
      return {
        platform,
        browserKey: key,
        browserName: browser.name,
        binary,
        binarySource: 'known-path',
        fallbackFrom: key === preferredKey ? null : browsers[preferredKey]?.name || preferredKey,
        method: 'windows-direct-spawn',
      };
    }

    if (commandFallback) {
      return {
        platform,
        browserKey: preferredKey,
        browserName: browsers[preferredKey]?.name || preferredKey,
        binary: commandFallback,
        binarySource: 'command-fallback',
        fallbackFrom: null,
        method: 'windows-command-fallback',
      };
    }

    return {
      platform,
      browserKey: preferredKey,
      browserName: windowsBrowsers(env)[preferredKey]?.name || preferredKey,
      binary: null,
      fallbackFrom: null,
      method: 'windows-direct-spawn',
    };
  }

  if (platform === 'linux') {
    const browsers = linuxBrowsers();
    const explicit = env.BROWSER || '';
    if (explicit) {
      return {
        platform,
        browserKey: preferredKey,
        browserName: explicit,
        command: explicit,
        fallbackFrom: null,
        method: 'linux-browser-env',
      };
    }
    for (const key of browserOrder(preferredKey)) {
      const browser = browsers[key];
      if (!browser) continue;
      const command = browser.commands
        .map((candidate) => commandOnPath(candidate, spawnSyncFn, platform))
        .find(Boolean);
      if (!command) continue;
      return {
        platform,
        browserKey: key,
        browserName: browser.name,
        command,
        fallbackFrom: key === preferredKey ? null : browsers[preferredKey]?.name || preferredKey,
        method: 'linux-browser-command',
      };
    }
    return {
      platform,
      browserKey: preferredKey,
      browserName: 'xdg-open',
      command: 'xdg-open',
      fallbackFrom: null,
      method: 'linux-xdg-open',
    };
  }

  return {
    platform,
    browserKey: preferredKey,
    browserName: null,
    method: 'unsupported-platform',
  };
};

const normalizeObserveMs = (value, fallback = DEFAULT_LAUNCH_OBSERVE_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 2000);
};

const observeDetachedSpawn = (spawnFn, command, args, options, observeMs) =>
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
      child = spawnFn(command, args, options);
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err), phase: 'spawn-throw' });
      return;
    }

    child?.on?.('error', (err) => {
      finish({ ok: false, error: err?.message || String(err), phase: 'spawn-error' });
    });
    child?.on?.('exit', (code, signal) => {
      if (code === 0 || code === null) {
        finish({ ok: true, exited: true, exitCode: code, signal: signal || null });
      } else {
        finish({ ok: false, exited: true, exitCode: code, signal: signal || null });
      }
    });
    child?.unref?.();

    timer = setTimeout(() => {
      finish({ ok: true, exited: false });
    }, observeMs);
  });

export const launchGeminiBrowser = async ({
  profileDirectory,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  launchObserveMs,
} = {}) => {
  const plan = resolveGeminiBrowserLaunchPlan({ env, platform, exists, spawnSyncFn });
  const profileArg = profileDirectory ? `--profile-directory=${profileDirectory}` : null;
  const observeMs = normalizeObserveMs(
    launchObserveMs ?? env.GEMINI_MCP_BROWSER_LAUNCH_OBSERVE_MS,
  );

  try {
    if (platform === 'darwin') {
      const args = ['-g'];
      if (plan.app) args.push('-a', plan.app);
      args.push(GEMINI_URL);
      if (profileArg && plan.app) args.push('--args', profileArg);
      const child = spawnFn('open', args, { detached: true, stdio: 'ignore' });
      child.unref?.();
      return { attempted: true, supported: true, ...plan, profileDirectory: profileDirectory || null };
    }

    if (platform === 'linux') {
      const command = plan.command || 'xdg-open';
      const args = plan.method === 'linux-xdg-open'
        ? [GEMINI_URL]
        : [profileArg, GEMINI_URL].filter(Boolean);
      const child = spawnFn(command, args, { detached: true, stdio: 'ignore' });
      child.unref?.();
      return { attempted: true, supported: true, ...plan, profileDirectory: profileDirectory || null };
    }

    if (platform === 'win32') {
      if (!plan.binary) {
        return {
          attempted: false,
          supported: true,
          ...plan,
          reason: 'browser-not-found',
          profileDirectory: profileDirectory || null,
        };
      }
      const args = [profileArg, '--new-tab', GEMINI_URL].filter(Boolean);
      let restoreFocusScriptPath = null;
      try {
        restoreFocusScriptPath = writeWindowsRestoreFocusLaunchScript(plan.binary, args, {
          env,
          restoreDelayMs: env.GEMINI_MCP_BROWSER_RESTORE_FOCUS_DELAY_MS || 900,
        });
        const restoreFocus = await observeDetachedSpawn(spawnFn, 'powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          restoreFocusScriptPath,
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }, observeMs);
        if (restoreFocus.ok) {
          return {
            attempted: true,
            supported: true,
            ...plan,
            method: 'windows-powershell-minimized-restore-focus',
            profileDirectory: profileDirectory || null,
            launch: restoreFocus,
            browserCommand: plan.binary,
            browserArgs: args,
            restoreFocusScriptPath,
          };
        }
      } catch {
        restoreFocusScriptPath = null;
      }

      let noFocusScriptPath = null;
      try {
        noFocusScriptPath = writeWindowsNoFocusLaunchScript(plan.binary, args, { env });
        const noFocus = await observeDetachedSpawn(spawnFn, 'wscript.exe', [
          '//B',
          '//Nologo',
          noFocusScriptPath,
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }, observeMs);
        if (noFocus.ok) {
          return {
            attempted: true,
            supported: true,
            ...plan,
            method: 'windows-wscript-minimized-no-focus',
            profileDirectory: profileDirectory || null,
            launch: noFocus,
            browserCommand: plan.binary,
            browserArgs: args,
            restoreFocusScriptPath,
            noFocusScriptPath,
          };
        }
      } catch {
        noFocusScriptPath = null;
      }

      const direct = await observeDetachedSpawn(spawnFn, plan.binary, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }, observeMs);
      if (direct.ok) {
        return {
          attempted: true,
          supported: true,
          ...plan,
          method: 'windows-direct-spawn',
          profileDirectory: profileDirectory || null,
          launch: direct,
          restoreFocusScriptPath,
          noFocusScriptPath,
        };
      }

      const command = `start "" /min ${quoteCmd(plan.binary)} ${args.map(quoteCmd).join(' ')}`;
      const cmdArgs = ['/d', '/s', '/c', command];
      const shellFallback = await observeDetachedSpawn(spawnFn, 'cmd.exe', cmdArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }, observeMs);
      return {
        attempted: shellFallback.ok,
        supported: true,
        ...plan,
        method: 'windows-cmd-start-fallback',
        profileDirectory: profileDirectory || null,
        launch: shellFallback,
        directLaunch: direct,
        restoreFocusScriptPath,
        noFocusScriptPath,
        reason: shellFallback.ok ? null : 'browser-launch-failed',
        error: shellFallback.ok
          ? null
          : shellFallback.error || direct.error || `exit ${shellFallback.exitCode ?? 'unknown'}`,
      };
    }

    return {
      attempted: false,
      supported: false,
      ...plan,
      reason: 'unsupported-platform',
      profileDirectory: profileDirectory || null,
    };
  } catch (err) {
    return {
      attempted: true,
      supported: platform === 'darwin' || platform === 'linux' || platform === 'win32',
      ...plan,
      error: err?.message || String(err),
      profileDirectory: profileDirectory || null,
    };
  }
};
