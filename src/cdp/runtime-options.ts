import {
  type CdpRuntimeSessionOwner,
  createCdpRuntimeSessionOwner,
} from './runtime-session-owner.js';
import {
  activateExtensionClientWithCdp,
  buildCdpControlSnapshot,
  type CdpActivationResult,
  type CdpRuntimeInput,
  type CdpTabSessionBrokerDeps,
  cdpUrlForRuntimeInput,
  type ExtensionClientForCdp,
} from './tab-session-broker.js';

export const CDP_ENV_KEYS = Object.freeze([
  'GEMINI_MD_EXPORT_CDP_URL',
  'GEMINI_MCP_CDP_URL',
  'GME_CDP_URL',
]);

export const CDP_DEVTOOLS_ACTIVE_PORT_FILE_ENV_KEYS = Object.freeze([
  'GEMINI_MD_EXPORT_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
  'GEMINI_MCP_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
  'GME_CDP_DEVTOOLS_ACTIVE_PORT_FILE',
]);

export type CdpRuntimeArgs = CdpRuntimeInput & Readonly<Record<string, unknown>>;

export type CdpRuntimeOptions = Readonly<{
  defaultCdpUrl?: string | null;
  env?: Record<string, string | undefined>;
}>;

export type BrowserControlParams = Readonly<{
  activateTab?: boolean;
  allowHttpBrowserFallback?: boolean;
  cdpUrl?: string;
  controlPlane?: 'cdp';
  focusWindow?: boolean;
}>;

export const defaultCdpUrlFromEnv = (
  env: Record<string, string | undefined> = process.env,
): string => {
  for (const key of CDP_ENV_KEYS) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
};

export const defaultDevToolsActivePortFileFromEnv = (
  env: Record<string, string | undefined> = process.env,
): string => {
  for (const key of CDP_DEVTOOLS_ACTIVE_PORT_FILE_ENV_KEYS) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
};

export const cdpRuntimeInputForArgs = (
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
): CdpRuntimeInput => {
  const defaultCdpUrl =
    options.defaultCdpUrl !== undefined ? options.defaultCdpUrl : defaultCdpUrlFromEnv(options.env);
  const defaultDevToolsActivePortFile = defaultDevToolsActivePortFileFromEnv(options.env);
  const input = {
    ...args,
    defaultCdpUrl,
    ...(defaultDevToolsActivePortFile ? { defaultDevToolsActivePortFile } : {}),
  };
  const devToolsActivePortFile = String(
    input.devToolsActivePortFile || input.defaultDevToolsActivePortFile || '',
  ).trim();
  return {
    ...input,
    cdpUrl: cdpUrlForRuntimeInput(input),
    ...(devToolsActivePortFile ? { devToolsActivePortFile } : {}),
  };
};

export const buildRuntimeCdpControlSnapshot = (
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
  deps: CdpTabSessionBrokerDeps = {},
) => buildCdpControlSnapshot(cdpRuntimeInputForArgs(args, options), deps);

export const activateRuntimeExtensionClientWithCdp = (
  client: ExtensionClientForCdp | null | undefined,
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
  deps: CdpTabSessionBrokerDeps = {},
): Promise<CdpActivationResult | null> =>
  activateExtensionClientWithCdp(client, cdpRuntimeInputForArgs(args, options), deps);

const ownedCdpRuntimeSessionOwner: CdpRuntimeSessionOwner = createCdpRuntimeSessionOwner();

export const buildOwnedRuntimeCdpControlSnapshot = (
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
) => buildRuntimeCdpControlSnapshot(args, options, ownedCdpRuntimeSessionOwner);

export const activateOwnedRuntimeExtensionClientWithCdp = (
  client: ExtensionClientForCdp | null | undefined,
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
): Promise<CdpActivationResult | null> =>
  activateRuntimeExtensionClientWithCdp(client, args, options, ownedCdpRuntimeSessionOwner);

export const reloadExtensionFromOwnedDevToolsActivePort: CdpRuntimeSessionOwner['reloadExtensionFromDevToolsActivePort'] =
  (args) => ownedCdpRuntimeSessionOwner.reloadExtensionFromDevToolsActivePort(args);

export const closeOwnedCdpRuntimeSessionOwner = (): void => ownedCdpRuntimeSessionOwner.closeAll();

export type OwnedCdpRuntimePorts = Readonly<{
  buildSnapshot(args?: CdpRuntimeArgs): ReturnType<typeof buildRuntimeCdpControlSnapshot>;
  activateClient(
    client: ExtensionClientForCdp | null | undefined,
    args?: CdpRuntimeArgs,
  ): Promise<CdpActivationResult | null>;
  close(): void;
}>;

export const createOwnedCdpRuntimePorts = (
  options: CdpRuntimeOptions = {},
): OwnedCdpRuntimePorts => ({
  buildSnapshot: (args = {}) => buildOwnedRuntimeCdpControlSnapshot(args, options),
  activateClient: (client, args = {}) =>
    activateOwnedRuntimeExtensionClientWithCdp(client, args, options),
  close: closeOwnedCdpRuntimeSessionOwner,
});

export const cdpRuntime = createOwnedCdpRuntimePorts();

export const browserControlParamsFromFlags = (
  flags: Readonly<{
    activateTab?: boolean | null;
    allowHttpBrowserFallback?: boolean | null;
    cdpUrl?: string | null;
    focusWindow?: boolean | null;
  }> = {},
): BrowserControlParams => {
  const cdpUrl = String(flags.cdpUrl || '').trim();
  const params: BrowserControlParams = {
    activateTab: flags.activateTab === true,
    focusWindow: flags.focusWindow === true,
    ...(flags.allowHttpBrowserFallback === true ? { allowHttpBrowserFallback: true } : {}),
  };
  return cdpUrl ? { ...params, cdpUrl, controlPlane: 'cdp' } : params;
};
