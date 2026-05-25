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

export const cdpRuntimeInputForArgs = (
  args: CdpRuntimeArgs = {},
  options: CdpRuntimeOptions = {},
): CdpRuntimeInput => {
  const defaultCdpUrl =
    options.defaultCdpUrl !== undefined ? options.defaultCdpUrl : defaultCdpUrlFromEnv(options.env);
  const input = {
    ...args,
    defaultCdpUrl,
  };
  return {
    ...input,
    cdpUrl: cdpUrlForRuntimeInput(input),
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
