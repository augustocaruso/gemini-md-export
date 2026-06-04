import {
  activateCdpTarget,
  buildCdpBrowserSnapshot,
  type CdpBrowserSnapshot,
  type CdpRequestOptions,
  type CdpTarget,
  selectCdpTarget,
} from './browser-control.js';

export type ExtensionClientForCdp = Readonly<{
  tabId?: number | string | null;
  windowId?: number | string | null;
  chatId?: string | null;
  url?: string | null;
  page?: {
    chatId?: string | null;
    url?: string | null;
  } | null;
}>;

export type CdpRuntimeInput = Readonly<{
  allowHttpBrowserFallback?: boolean | null;
  cdpUrl?: string | null;
  defaultCdpUrl?: string | null;
  defaultDevToolsActivePortFile?: string | null;
  devToolsActivePortContents?: string | null;
  devToolsActivePortFile?: string | null;
  controlPlane?: string | null;
  chatId?: string | null;
}>;

export type CdpTabSessionBrokerDeps = Readonly<{
  buildSnapshot?: (options: CdpRequestOptions) => Promise<CdpBrowserSnapshot>;
  activateTarget?: (
    target: Pick<CdpTarget, 'id'>,
    options: CdpRequestOptions,
  ) => Promise<Readonly<Record<string, unknown>>>;
}>;

export type CdpActivationResult = Readonly<{
  ok: boolean;
  mode: 'cdp';
  skipped?: boolean;
  reason?: string;
  targetId?: string;
  target?: CdpTarget;
  snapshot?: CdpBrowserSnapshot | Record<string, unknown>;
  tabId?: number | string | null;
  windowId?: number | string | null;
  isActiveTab?: true;
  result?: Record<string, unknown>;
}>;

export const cdpUrlForRuntimeInput = (input: CdpRuntimeInput = {}): string | null => {
  if (input.controlPlane === 'bridge') return null;
  const value = String(input.cdpUrl || input.defaultCdpUrl || '').trim();
  return value || null;
};

export const buildCdpControlSnapshot = async (
  input: CdpRuntimeInput = {},
  deps: CdpTabSessionBrokerDeps = {},
): Promise<CdpBrowserSnapshot | Record<string, unknown>> => {
  const endpoint = cdpUrlForRuntimeInput(input);
  if (!endpoint) {
    return {
      attempted: false,
      ok: false,
      reason: 'cdp-url-not-configured',
    };
  }
  try {
    const buildSnapshot = deps.buildSnapshot || buildCdpBrowserSnapshot;
    return {
      attempted: true,
      ...(await buildSnapshot({
        endpoint,
        allowHttpBrowserFallback: input.allowHttpBrowserFallback === true,
        devToolsActivePortContents: input.devToolsActivePortContents || null,
        devToolsActivePortFile:
          input.devToolsActivePortFile || input.defaultDevToolsActivePortFile || null,
      })),
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      endpoint,
      error: err instanceof Error ? err.message : String(err),
      code:
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'cdp_unavailable',
    };
  }
};

const snapshotTargets = (
  snapshot: CdpBrowserSnapshot | Record<string, unknown>,
): readonly CdpTarget[] =>
  Array.isArray((snapshot as { targets?: unknown }).targets)
    ? (snapshot as { targets: CdpTarget[] }).targets
    : [];

export const activateExtensionClientWithCdp = async (
  client: ExtensionClientForCdp | null | undefined,
  input: CdpRuntimeInput = {},
  deps: CdpTabSessionBrokerDeps = {},
): Promise<CdpActivationResult | null> => {
  const endpoint = cdpUrlForRuntimeInput(input);
  if (!endpoint || !client) return null;

  const snapshot = await buildCdpControlSnapshot(input, deps);
  if ((snapshot as { ok?: unknown }).ok === false) {
    return {
      ok: false,
      mode: 'cdp',
      skipped: true,
      snapshot,
    };
  }

  const target = selectCdpTarget(snapshotTargets(snapshot), {
    chatId: client.page?.chatId || client.chatId || input.chatId || null,
    url: client.page?.url || client.url || null,
  });
  if (!target) {
    return {
      ok: false,
      mode: 'cdp',
      skipped: true,
      reason: 'cdp-target-not-found',
      snapshot,
    };
  }

  const activateTarget = deps.activateTarget || activateCdpTarget;
  const activated = await activateTarget(target, { endpoint });
  return {
    ok: activated.ok !== false,
    mode: 'cdp',
    targetId: String(activated.targetId || target.id),
    target,
    snapshot,
    tabId: client.tabId ?? null,
    windowId: client.windowId ?? null,
    isActiveTab: true,
    result: { ...activated },
  };
};
