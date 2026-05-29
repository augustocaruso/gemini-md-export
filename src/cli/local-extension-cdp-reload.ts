import { existsSync as nodeExistsSync } from 'node:fs';
import { homedir, platform as nodePlatform } from 'node:os';
import { resolve } from 'node:path';

import {
  devToolsActivePortPathForUserDataDir,
  type ExtensionManagementReloadResult,
  reloadExtensionFromDevToolsActivePort,
} from '../cdp/browser-websocket.js';

export type LocalExtensionCdpReloadInput = Readonly<{
  allowReload?: boolean;
  browser?: string | null;
  extensionId?: string | null;
  platform?: NodeJS.Platform;
  homeDir?: string;
}>;

export type LocalExtensionCdpReloadDeps = Readonly<{
  existsSync?: (path: string) => boolean;
  reloadExtensionFromDevToolsActivePort?: (
    args: Readonly<{
      extensionId: string;
      devToolsActivePortFile: string;
      timeoutMs?: number;
    }>,
  ) => Promise<ExtensionManagementReloadResult>;
}>;

export type LocalExtensionCdpReloadResult =
  | (ExtensionManagementReloadResult &
      Readonly<{
        attempted: true;
        devToolsActivePortFile: string;
      }>)
  | Readonly<{
      ok: false;
      attempted: false;
      skipped: true;
      reason:
        | 'reload-not-allowed'
        | 'extension-id-missing'
        | 'devtools-active-port-missing'
        | 'browser-unsupported';
      mode: 'cdp-browser-websocket';
      devToolsActivePortFile: string | null;
    }>;

const normalizeBrowser = (value: string | null | undefined): string => {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (!text) return 'chrome';
  if (/^(google[-_\s]*)?chrome$|chrome\.exe$/.test(text)) return 'chrome';
  if (/^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$/.test(text)) return 'edge';
  if (/^brave$|brave[-_\s]*browser|brave(\.exe)?$/.test(text)) return 'brave';
  if (/^dia$|dia(\.exe)?$/.test(text)) return 'dia';
  return text;
};

export const browserUserDataDirForLocalCdp = ({
  browser = 'chrome',
  platform = nodePlatform(),
  homeDir = homedir(),
}: Pick<LocalExtensionCdpReloadInput, 'browser' | 'platform' | 'homeDir'> = {}): string | null => {
  const key = normalizeBrowser(browser);
  if (platform === 'darwin') {
    const base = resolve(homeDir, 'Library', 'Application Support');
    if (key === 'dia') return resolve(base, 'Dia', 'User Data');
    if (key === 'edge') return resolve(base, 'Microsoft Edge');
    if (key === 'brave') return resolve(base, 'BraveSoftware', 'Brave-Browser');
    if (key === 'chrome') return resolve(base, 'Google', 'Chrome');
    return null;
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || resolve(homeDir, 'AppData', 'Local');
    if (key === 'dia') return resolve(localAppData, 'Dia', 'User Data');
    if (key === 'edge') return resolve(localAppData, 'Microsoft', 'Edge', 'User Data');
    if (key === 'brave')
      return resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data');
    if (key === 'chrome') return resolve(localAppData, 'Google', 'Chrome', 'User Data');
    return null;
  }
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homeDir, '.config');
  if (key === 'dia') return resolve(configHome, 'Dia');
  if (key === 'edge') return resolve(configHome, 'microsoft-edge');
  if (key === 'brave') return resolve(configHome, 'BraveSoftware', 'Brave-Browser');
  if (key === 'chrome') return resolve(configHome, 'google-chrome');
  return null;
};

export const runLocalExtensionCdpReload = async (
  input: LocalExtensionCdpReloadInput,
  deps: LocalExtensionCdpReloadDeps = {},
): Promise<LocalExtensionCdpReloadResult> => {
  const mode = 'cdp-browser-websocket' as const;
  if (input.allowReload !== true) {
    return {
      ok: false,
      attempted: false,
      skipped: true,
      reason: 'reload-not-allowed',
      mode,
      devToolsActivePortFile: null,
    };
  }
  const extensionId = String(input.extensionId || '').trim();
  if (!extensionId) {
    return {
      ok: false,
      attempted: false,
      skipped: true,
      reason: 'extension-id-missing',
      mode,
      devToolsActivePortFile: null,
    };
  }
  const userDataDir = browserUserDataDirForLocalCdp(input);
  if (!userDataDir) {
    return {
      ok: false,
      attempted: false,
      skipped: true,
      reason: 'browser-unsupported',
      mode,
      devToolsActivePortFile: null,
    };
  }
  const devToolsActivePortFile = devToolsActivePortPathForUserDataDir(userDataDir);
  const existsSync = deps.existsSync || nodeExistsSync;
  if (!existsSync(devToolsActivePortFile)) {
    return {
      ok: false,
      attempted: false,
      skipped: true,
      reason: 'devtools-active-port-missing',
      mode,
      devToolsActivePortFile,
    };
  }
  const reload =
    deps.reloadExtensionFromDevToolsActivePort || reloadExtensionFromDevToolsActivePort;
  const result = await reload({
    extensionId,
    devToolsActivePortFile,
    timeoutMs: 15_000,
  });
  return {
    ...result,
    attempted: true,
    devToolsActivePortFile,
  };
};
