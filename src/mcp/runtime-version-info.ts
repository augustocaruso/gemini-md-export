import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

type RuntimeVersionOptions = {
  root: string;
  bridgeVersion: Record<string, unknown>;
  packageVersion: string;
  serverVersion: string;
  protocolVersion: number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type ExpectedChromeExtensionInfo = {
  extensionVersion: string;
  protocolVersion: number;
  buildStamp: string | null;
  toJSON(): {
    extensionVersion: string;
    protocolVersion: number;
    buildStamp: string | null;
  };
};

const readJsonFileSafe = <T>(filePath: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
};

export const readCurrentBridgeVersion = ({
  root,
  bridgeVersion,
}: Pick<RuntimeVersionOptions, 'root' | 'bridgeVersion'>): Record<string, unknown> =>
  readJsonFileSafe(resolve(root, 'bridge-version.json'), bridgeVersion) || bridgeVersion;

export const readCurrentPackageVersion = ({
  root,
  packageVersion,
  serverVersion,
}: Pick<RuntimeVersionOptions, 'root' | 'packageVersion' | 'serverVersion'>): string =>
  readJsonFileSafe<{ version?: string }>(resolve(root, 'package.json'), { version: packageVersion })
    ?.version || serverVersion;

export const detectExpectedBrowserBuildStamp = ({
  root,
  bridgeVersion,
  env = process.env,
  homeDir = homedir(),
}: Pick<RuntimeVersionOptions, 'root' | 'bridgeVersion' | 'env' | 'homeDir'>): string | null => {
  if (env.GEMINI_MCP_EXPECTED_BUILD_STAMP) return env.GEMINI_MCP_EXPECTED_BUILD_STAMP;

  const currentBridgeVersion = readCurrentBridgeVersion({ root, bridgeVersion });
  if (typeof currentBridgeVersion.buildStamp === 'string' && currentBridgeVersion.buildStamp) {
    return currentBridgeVersion.buildStamp;
  }

  const candidates = [
    resolve(root, 'browser-extension', 'background.js'),
    resolve(root, 'dist', 'extension', 'background.js'),
    resolve(root, 'dist', 'extension', 'content.js'),
    resolve(homeDir, '.gemini', 'extensions', 'gemini-md-export', 'browser-extension', 'background.js'),
    resolve(homeDir, '.gemini', 'extensions', 'gemini-md-export', 'browser-extension', 'content.js'),
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

export const createExpectedChromeExtensionInfo = (
  options: RuntimeVersionOptions,
): ExpectedChromeExtensionInfo => {
  const snapshot = () => ({
    extensionVersion:
      String(readCurrentBridgeVersion(options).extensionVersion || '') ||
      readCurrentPackageVersion(options),
    protocolVersion: options.protocolVersion,
    buildStamp: detectExpectedBrowserBuildStamp(options),
  });
  const info = {} as ExpectedChromeExtensionInfo;
  for (const key of ['extensionVersion', 'protocolVersion', 'buildStamp'] as const) {
    Object.defineProperty(info, key, {
      enumerable: true,
      get: () => snapshot()[key],
    });
  }
  Object.defineProperty(info, 'toJSON', {
    enumerable: false,
    value: snapshot,
  });
  return info;
};
