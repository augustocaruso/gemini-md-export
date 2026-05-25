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
    group?(
      createProperties: { tabIds: number[]; groupId?: number },
      callback?: (groupId?: number) => void,
    ): void;
  };
  tabGroups?: {
    update?(
      groupId: number,
      updateProperties: { title?: string; color?: string },
      callback?: (group?: unknown) => void,
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
  payload?: {
    tabId?: number | null;
    claimId?: string | null;
    label?: string | null;
    color?: string | null;
  };
}>;

const managedTabQueryUrls = [
  'https://gemini.google.com/*',
  'https://myactivity.google.com/*',
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

const chromeGroupTabs = (
  chromeApi: ChromeNativeBrokerApi,
  tabIds: number[],
): Promise<number | null> =>
  new Promise((resolve) => {
    if (!chromeApi.tabs || !chromeApi.tabs.group || tabIds.length === 0) {
      resolve(null);
      return;
    }
    chromeApi.tabs.group({ tabIds }, (groupId) => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message || !Number.isInteger(groupId)) {
        resolve(null);
        return;
      }
      resolve(Number(groupId));
    });
  });

const chromeUpdateTabGroup = (
  chromeApi: ChromeNativeBrokerApi,
  groupId: number,
  updateProperties: { title?: string; color?: string },
): Promise<boolean> =>
  new Promise((resolve) => {
    if (!chromeApi.tabGroups?.update || !Number.isInteger(groupId)) {
      resolve(false);
      return;
    }
    chromeApi.tabGroups.update(groupId, updateProperties, () => {
      const message = chromeApi.runtime?.lastError?.message;
      resolve(!message);
    });
  });

const nonEmptyIntegerArray = (
  values: readonly number[],
  fallback: number,
): [number, ...number[]] => {
  const clean = Array.from(new Set(values)).filter(Number.isInteger);
  if (clean.length === 0) return [fallback];
  return clean as [number, ...number[]];
};

const applyNativeClaimVisual = async (
  chromeApi: ChromeNativeBrokerApi,
  tabId: number,
  relatedTabIds: readonly number[],
  payload: { label?: string | null; color?: string | null } = {},
) => {
  const tabIds = Array.from(new Set([tabId, ...relatedTabIds])).filter(Number.isInteger);
  if (!chromeApi.tabs || !chromeApi.tabs.group || !chromeApi.tabGroups?.update) {
    return { mode: 'action-badge' as const, tabId, reason: 'tab-groups-api-unavailable' };
  }
  const groupId = Number(await chromeGroupTabs(chromeApi, tabIds));
  if (!Number.isInteger(groupId)) {
    return { mode: 'action-badge' as const, tabId, reason: 'tab-group-create-failed' };
  }
  const label = payload.label || 'Gemini Export';
  const color = payload.color || 'blue';
  const updated = await chromeUpdateTabGroup(chromeApi, groupId, { title: label, color });
  if (!updated) {
    return { mode: 'action-badge' as const, tabId, groupId, reason: 'tab-group-update-failed' };
  }
  return {
    mode: 'tab-group' as const,
    tabId,
    tabIds: nonEmptyIntegerArray(tabIds, tabId),
    groupId,
    label,
    color,
  };
};

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
    const claim = await claimDebuggableGeminiTab(tabs, {
      requestedTabId: request.payload?.tabId || null,
      claimId: request.payload?.claimId || null,
      inspectTab,
    });
    if (claim.ok !== true) return claim;
    return {
      ...claim,
      visual: await applyNativeClaimVisual(
        chromeApi,
        claim.tab.tabId,
        claim.visualCompanionTabIds,
        request.payload,
      ),
    };
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
