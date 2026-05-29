import {
  activateCdpTarget,
  buildCdpBrowserSnapshot,
  type CdpBrowserSnapshot,
  type CdpFetch,
  type CdpRequestOptions,
  type CdpTarget,
  type CdpWebSocketConstructor,
  normalizeCdpEndpoint,
} from './browser-control.js';
import {
  type BrowserWebSocketSession,
  createBrowserWebSocketSession,
  type ExtensionManagementReloadResult,
  findExtensionManagementTarget,
  parseDevToolsActivePort,
  readDevToolsActivePort,
} from './browser-websocket.js';

export type CdpRuntimeSessionOwnerOptions = Readonly<{
  fetchImpl?: CdpFetch;
  WebSocketImpl?: CdpWebSocketConstructor;
  timeoutMs?: number;
}>;

export type CdpRuntimeSessionOwner = Readonly<{
  buildSnapshot(options: CdpRequestOptions): Promise<CdpBrowserSnapshot>;
  activateTarget(
    target: Pick<CdpTarget, 'id'>,
    options: CdpRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
  reloadExtensionFromDevToolsActivePort(
    args: Readonly<{
      extensionId: string;
      devToolsActivePortContents?: string | null;
      devToolsActivePortFile?: string | null;
      timeoutMs?: number;
    }>,
  ): Promise<ExtensionManagementReloadResult>;
  closeAll(): void;
}>;

const fetchVersion = async (
  endpoint: string,
  fetchImpl: CdpFetch,
): Promise<Record<string, unknown> | null> => {
  const response = await fetchImpl(`${normalizeCdpEndpoint(endpoint)}/json/version`, {
    method: 'GET',
  });
  if (!response.ok) return null;
  return (await response.json()) as Record<string, unknown>;
};

const browserWebSocketUrlFromVersion = (version: Record<string, unknown> | null): string => {
  const value = version?.webSocketDebuggerUrl;
  return typeof value === 'string' ? value.trim() : '';
};

export const createCdpRuntimeSessionOwner = ({
  fetchImpl = fetch as CdpFetch,
  WebSocketImpl,
  timeoutMs,
}: CdpRuntimeSessionOwnerOptions = {}): CdpRuntimeSessionOwner => {
  const sessions = new Map<string, BrowserWebSocketSession>();
  const endpointBrowserUrls = new Map<string, string>();

  const sessionForUrl = (browserWebSocketUrl: string): BrowserWebSocketSession => {
    const cached = sessions.get(browserWebSocketUrl);
    if (cached) return cached;
    const session = createBrowserWebSocketSession({
      browserWebSocketUrl,
      WebSocketImpl,
      timeoutMs,
    });
    sessions.set(browserWebSocketUrl, session);
    return session;
  };

  const resolveBrowserWebSocketUrl = async (options: CdpRequestOptions): Promise<string> => {
    const explicit = String(options.browserWebSocketUrl || '').trim();
    if (explicit) return explicit;
    const endpoint = normalizeCdpEndpoint(options.endpoint);
    const cached = endpointBrowserUrls.get(endpoint);
    if (cached) return cached;
    const version = await fetchVersion(endpoint, options.fetchImpl || fetchImpl).catch(() => null);
    const browserWebSocketUrl = browserWebSocketUrlFromVersion(version);
    if (browserWebSocketUrl) endpointBrowserUrls.set(endpoint, browserWebSocketUrl);
    return browserWebSocketUrl;
  };

  const withOwnedSession = async (options: CdpRequestOptions): Promise<CdpRequestOptions> => {
    const browserWebSocketUrl = await resolveBrowserWebSocketUrl(options);
    if (!browserWebSocketUrl) return { ...options, fetchImpl: options.fetchImpl || fetchImpl };
    return {
      ...options,
      browserWebSocketUrl,
      browserWebSocketSession: sessionForUrl(browserWebSocketUrl),
      fetchImpl: options.fetchImpl || fetchImpl,
      WebSocketImpl: options.WebSocketImpl || WebSocketImpl,
      timeoutMs: options.timeoutMs || timeoutMs,
    };
  };

  return {
    async buildSnapshot(options) {
      return buildCdpBrowserSnapshot(await withOwnedSession(options));
    },

    async activateTarget(target, options) {
      return activateCdpTarget(target, await withOwnedSession(options));
    },

    async reloadExtensionFromDevToolsActivePort({
      extensionId,
      devToolsActivePortContents,
      devToolsActivePortFile,
    }) {
      const activePort =
        typeof devToolsActivePortContents === 'string'
          ? parseDevToolsActivePort(devToolsActivePortContents)
          : readDevToolsActivePort(String(devToolsActivePortFile || ''));
      const session = sessionForUrl(activePort.webSocketDebuggerUrl);
      const targets = await session.listTargets();
      const target = findExtensionManagementTarget(targets, extensionId);
      if (!target) {
        return {
          ok: false,
          mode: 'cdp-browser-websocket',
          extensionId,
          targetId: '',
          targetUrl: '',
          code: 'extension_management_target_not_found',
          error: 'Nao encontrei uma aba chrome://extensions da extensao carregada.',
        };
      }
      return session.reloadExtensionFromManagementTarget({ extensionId, target });
    },

    closeAll() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
      endpointBrowserUrls.clear();
    },
  };
};
