import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const GEMINI_URL = 'https://gemini.google.com/app';

const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;

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
        localAppData && resolve(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        resolve(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean),
    },
    edge: {
      name: 'Edge',
      commands: ['msedge.exe', 'msedge'],
      paths: [
        env.GEMINI_MCP_EDGE_EXE,
        env.GME_EDGE_EXE,
        localAppData && resolve(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        resolve(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        resolve(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean),
    },
    brave: {
      name: 'Brave',
      commands: ['brave.exe', 'brave'],
      paths: [
        env.GEMINI_MCP_BRAVE_EXE,
        env.GME_BRAVE_EXE,
        localAppData &&
          resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        resolve(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        resolve(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ].filter(Boolean),
    },
    dia: {
      name: 'Dia',
      commands: ['dia.exe', 'dia'],
      paths: [
        env.GEMINI_MCP_DIA_EXE,
        env.GME_DIA_EXE,
        localAppData && resolve(localAppData, 'Programs', 'Dia', 'Dia.exe'),
        env.APPDATA && resolve(env.APPDATA, 'Dia', 'Application', 'Dia.exe'),
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
    for (const key of browserOrder(preferredKey)) {
      const browser = browsers[key];
      if (!browser) continue;
      const binary =
        firstExisting(browser.paths, exists) ||
        browser.commands
          .map((command) => commandOnPath(command, spawnSyncFn, platform))
          .find(Boolean);
      if (!binary) continue;
      return {
        platform,
        browserKey: key,
        browserName: browser.name,
        binary,
        fallbackFrom: key === preferredKey ? null : browsers[preferredKey]?.name || preferredKey,
        method: 'windows-start-process-minimized',
      };
    }
    return {
      platform,
      browserKey: preferredKey,
      browserName: windowsBrowsers(env)[preferredKey]?.name || preferredKey,
      binary: null,
      fallbackFrom: null,
      method: 'windows-start-process-minimized',
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

export const launchGeminiBrowser = async ({
  profileDirectory,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
} = {}) => {
  const plan = resolveGeminiBrowserLaunchPlan({ env, platform, exists, spawnSyncFn });
  const profileArg = profileDirectory ? `--profile-directory=${profileDirectory}` : null;

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
      const args = [profileArg, GEMINI_URL].filter(Boolean);
      const psArgs = args.map(quotePowerShell).join(',');
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$arguments = @(${psArgs})`,
        `Start-Process -FilePath ${quotePowerShell(plan.binary)} -ArgumentList $arguments -WindowStyle Minimized`,
      ].join('; ');
      const child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref?.();
      return { attempted: true, supported: true, ...plan, profileDirectory: profileDirectory || null };
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
