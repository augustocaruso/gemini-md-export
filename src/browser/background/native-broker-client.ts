import type { NativeBrokerRequest, NativeBrokerResponse } from '../../native/protocol.js';
import {
  claimDebuggableGeminiTab,
  classifyBrowserTabs,
  getDebuggableGeminiTabs,
  type RawBrowserTab,
} from './browser-session-broker.js';
import { inspectTabWithDebugger } from './chrome-debugger-controller.js';

type ChromeRuntimePort = Readonly<{
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect?(): void;
}>;

type ChromeNativeBrokerApi = Readonly<{
  runtime?: {
    connectNative?(hostName: string): ChromeRuntimePort;
    lastError?: { message?: string } | null;
  };
  tabs?: {
    query(queryInfo: { url: string[] }, callback: (tabs?: RawBrowserTab[]) => void): void;
    reload?(
      tabId: number,
      reloadProperties: { bypassCache?: boolean },
      callback?: () => void,
    ): void;
  };
  debugger?: {
    attach(target: { tabId: number }, protocolVersion: string, callback: () => void): void;
    sendCommand(
      target: { tabId: number },
      method: string,
      params: Record<string, unknown>,
      callback: (result?: unknown) => void,
    ): void;
    detach(target: { tabId: number }, callback?: () => void): void;
  };
}>;

export type NativeBrowserBrokerCommand = Readonly<{
  id?: string;
  command: 'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release' | 'tabs.reload';
  payload?: { tabId?: number | null; claimId?: string | null };
}>;

const managedTabQueryUrls = [
  'https://gemini.google.com/*',
  'https://accounts.google.com/*',
  'https://www.google.com/sorry/*',
];

const globalChrome = () => (globalThis as { chrome?: ChromeNativeBrokerApi }).chrome;

const queryManagedTabs = (chromeApi: ChromeNativeBrokerApi): Promise<RawBrowserTab[]> =>
  new Promise((resolve) => {
    chromeApi.tabs?.query?.({ url: managedTabQueryUrls }, (items: RawBrowserTab[] = []) => {
      resolve(Array.isArray(items) ? items : []);
    });
  });

const inspectWith = (chromeApi: ChromeNativeBrokerApi) => (tabId: number) =>
  inspectTabWithDebugger(tabId, { chromeApi });

const chromeReloadTab = (
  chromeApi: ChromeNativeBrokerApi,
  tabId: number,
): Promise<{ ok: true } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    if (!chromeApi.tabs?.reload) {
      resolve({ ok: false, error: 'chrome_tabs_reload_unavailable' });
      return;
    }
    chromeApi.tabs.reload(tabId, { bypassCache: false }, () => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) {
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
    });
  });

export const handleNativeBrowserBrokerCommand = async (
  request: NativeBrowserBrokerCommand,
  chromeApi: ChromeNativeBrokerApi = globalChrome() || {},
) => {
  const tabs = await queryManagedTabs(chromeApi);
  const inspectTab = inspectWith(chromeApi);

  if (request.command === 'tabs.list' || request.command === 'tabs.status') {
    return { ok: true as const, tabs: await classifyBrowserTabs(tabs, { inspectTab }) };
  }

  if (request.command === 'tabs.claim') {
    return claimDebuggableGeminiTab(tabs, {
      requestedTabId: request.payload?.tabId || null,
      claimId: request.payload?.claimId || null,
      inspectTab,
    });
  }

  if (request.command === 'tabs.reload') {
    const listed = await getDebuggableGeminiTabs(tabs, { inspectTab });
    const requestedTabId = Number(request.payload?.tabId || 0);
    const targets = requestedTabId
      ? listed.tabs.filter((tab) => tab.tabId === requestedTabId)
      : listed.tabs;

    if (targets.length === 0) {
      return {
        ok: false as const,
        code: 'no_existing_gemini_tabs',
        reloaded: 0,
        tabs: listed.tabs,
        classified: listed.classified,
      };
    }

    const results = await Promise.all(
      targets.map(async (tab) => ({
        tab,
        reload: await chromeReloadTab(chromeApi, tab.tabId),
      })),
    );
    const successes = results.filter((item) => item.reload.ok);
    const failures = results.filter((item) => !item.reload.ok);

    return {
      ok: failures.length === 0,
      code: failures.length === 0 ? null : 'native_tab_reload_failed',
      requested: targets.length,
      reloaded: successes.length,
      reloadedTabIds: successes.map((item) => item.tab.tabId),
      failures: failures.map((item) => ({
        tabId: item.tab.tabId,
        error: item.reload.ok ? null : item.reload.error,
      })),
      tabs: listed.tabs,
      classified: listed.classified,
    };
  }

  return { ok: true as const, released: true, claimId: request.payload?.claimId || null };
};

const isBrokerResponse = (message: unknown): message is NativeBrokerResponse =>
  !!message && typeof message === 'object' && 'ok' in message;

const isBrowserBrokerCommand = (
  command: unknown,
): command is NativeBrowserBrokerCommand['command'] =>
  command === 'tabs.list' ||
  command === 'tabs.status' ||
  command === 'tabs.claim' ||
  command === 'tabs.release' ||
  command === 'tabs.reload';

const unsupportedCommandResponse = (
  request: Pick<NativeBrokerRequest, 'id'>,
): NativeBrokerResponse => ({
  id: request.id,
  ok: false,
  error: {
    code: 'unsupported_native_browser_command',
    message: 'Unsupported native browser broker command.',
    retryable: false,
    nextAction: 'Send a tabs.* command to the browser broker.',
  },
});

export const createNativeBrokerPort = ({
  chromeApi = globalChrome() || {},
  hostName,
  onStatus,
}: {
  chromeApi?: ChromeNativeBrokerApi;
  hostName: string;
  onStatus?: (status: unknown) => void;
}) => {
  let port: ChromeRuntimePort | null = null;

  const connect = () => {
    if (!chromeApi.runtime?.connectNative) {
      throw new Error('native_messaging_unavailable');
    }

    port = chromeApi.runtime.connectNative(hostName);
    port.onMessage.addListener((message: unknown) => {
      if (isBrokerResponse(message)) {
        onStatus?.({ ok: message.ok, response: message });
        return;
      }

      const request = message as NativeBrokerRequest;
      if (!isBrowserBrokerCommand(request.command)) {
        port?.postMessage(unsupportedCommandResponse(request));
        return;
      }

      handleNativeBrowserBrokerCommand(
        {
          id: request.id,
          command: request.command,
          payload: request.payload as NativeBrowserBrokerCommand['payload'],
        },
        chromeApi,
      ).then(
        (result) => {
          const response: NativeBrokerResponse = { id: request.id, ok: true, result };
          port?.postMessage(response);
        },
        (err) => {
          const response: NativeBrokerResponse = {
            id: request.id,
            ok: false,
            error: {
              code: 'native_browser_broker_failed',
              message: err instanceof Error ? err.message : String(err),
              retryable: true,
              nextAction: 'Retry the tab command after the browser settles.',
            },
          };
          port?.postMessage(response);
        },
      );
    });

    port.onDisconnect.addListener(() => {
      onStatus?.({
        ok: false,
        code: 'native_broker_disconnected',
        error: chromeApi.runtime?.lastError?.message || null,
      });
      port = null;
    });

    port.postMessage({
      id: `extension-${Date.now()}`,
      protocolVersion: 1,
      command: 'extension.hello',
      payload: { source: 'extension-background' },
    });
    onStatus?.({ ok: true, connected: true });
    return port;
  };

  return {
    ensureConnected: () => port || connect(),
    disconnect: () => {
      port?.disconnect?.();
      port = null;
    },
  };
};
