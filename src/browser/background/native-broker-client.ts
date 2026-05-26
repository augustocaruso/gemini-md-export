import type { NativeBrokerRequest, NativeBrokerResponse } from '../../native/protocol.js';
import {
  claimDebuggableGeminiTab,
  classifyBrowserTabs,
  getDebuggableGeminiTabs,
  type RawBrowserTab,
} from './browser-session-broker.js';
import { inspectTabWithDebugger } from './chrome-debugger-controller.js';
import { looksLikeManagedClaimGroupTitle } from './tab-claim-managed-group.js';
import { trackedTabIdsForClaimRelease } from './tab-claim-release.js';

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
    ungroup?(tabIds: number | number[], callback?: () => void): void;
    update?(
      tabId: number,
      updateProperties: { active?: boolean },
      callback?: (tab?: RawBrowserTab) => void,
    ): void;
  };
  windows?: {
    update?(
      windowId: number,
      updateProperties: { focused?: boolean },
      callback?: (window?: unknown) => void,
    ): void;
  };
  tabGroups?: {
    get?(groupId: number, callback?: (group?: { id?: number; title?: string }) => void): void;
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
  command:
    | 'tabs.list'
    | 'tabs.status'
    | 'tabs.claim'
    | 'tabs.release'
    | 'tabs.activate'
    | 'tabs.reload'
    | 'extension.status'
    | 'extension.selfHealContentScripts'
    | 'extension.reloadSelf';
  payload?: {
    tabId?: number | null;
    claimId?: string | null;
    label?: string | null;
    color?: string | null;
    reloadAll?: boolean | null;
    reason?: string | null;
    force?: boolean | null;
    focusWindow?: boolean | null;
    timeoutMs?: number | null;
    tabIds?: readonly unknown[] | null;
    relatedTabIds?: readonly unknown[] | null;
    visualGroupTabId?: number | null;
    groupWithTabId?: number | null;
  };
}>;

type NativeBrowserBrokerRuntimeActions = Readonly<{
  extensionStatus?: () => unknown;
  selfHealContentScripts?: (payload: NativeBrowserBrokerCommand['payload']) => Promise<unknown>;
  reloadSelf?: (payload: NativeBrowserBrokerCommand['payload']) => Promise<unknown>;
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

const chromeGetTabGroup = (
  chromeApi: ChromeNativeBrokerApi,
  groupId: number,
): Promise<{ id?: number; title?: string } | null> =>
  new Promise((resolve) => {
    if (!chromeApi.tabGroups?.get || !Number.isInteger(groupId) || groupId < 0) {
      resolve(null);
      return;
    }
    chromeApi.tabGroups.get(groupId, (group) => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message || !group) {
        resolve(null);
        return;
      }
      resolve(group);
    });
  });

const chromeUngroupTabs = (
  chromeApi: ChromeNativeBrokerApi,
  tabIds: readonly number[],
): Promise<{ ok: true } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    if (!chromeApi.tabs?.ungroup) {
      resolve({ ok: false, error: 'chrome_tabs_ungroup_unavailable' });
      return;
    }
    const clean = Array.from(new Set(tabIds)).filter(
      (tabId) => Number.isInteger(tabId) && tabId > 0,
    );
    if (clean.length === 0) {
      resolve({ ok: true });
      return;
    }
    chromeApi.tabs.ungroup(clean, () => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) {
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
    });
  });

const chromeUpdateTabActive = (
  chromeApi: ChromeNativeBrokerApi,
  tabId: number,
): Promise<{ ok: true; tab: RawBrowserTab | null } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    if (!chromeApi.tabs?.update) {
      resolve({ ok: false, error: 'chrome_tabs_update_unavailable' });
      return;
    }
    chromeApi.tabs.update(tabId, { active: true }, (tab) => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) {
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true, tab: tab || null });
    });
  });

const chromeFocusWindow = (
  chromeApi: ChromeNativeBrokerApi,
  windowId: number,
): Promise<{ ok: true } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    if (!chromeApi.windows?.update || !Number.isInteger(windowId) || windowId <= 0) {
      resolve({ ok: true });
      return;
    }
    chromeApi.windows.update(windowId, { focused: true }, () => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) {
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
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

const integerArray = (values: unknown): number[] =>
  Array.isArray(values)
    ? values.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    : [];

const relatedTabIdsFromClaimPayload = (
  tabId: number,
  payload: NativeBrowserBrokerCommand['payload'] = {},
): number[] => {
  const visualGroupTabId = Number(payload?.visualGroupTabId ?? payload?.groupWithTabId);
  return Array.from(
    new Set([
      ...integerArray(payload?.relatedTabIds),
      ...integerArray(payload?.tabIds).filter((candidateTabId) => candidateTabId !== tabId),
      ...(Number.isInteger(visualGroupTabId) && visualGroupTabId > 0 ? [visualGroupTabId] : []),
    ]),
  );
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

const releaseNativeClaimVisual = async (
  chromeApi: ChromeNativeBrokerApi,
  tabs: readonly RawBrowserTab[],
  payload: NativeBrowserBrokerCommand['payload'] = {},
) => {
  const primaryTabId = Number(payload?.tabId || 0);
  const explicitTabIds = trackedTabIdsForClaimRelease(primaryTabId, {
    tabIds: payload?.tabIds,
  });
  const candidateGroupIds = Array.from(
    new Set(
      tabs
        .filter((tab) =>
          explicitTabIds.length > 0 ? explicitTabIds.includes(Number(tab.id)) : true,
        )
        .map((tab) => Number((tab as { groupId?: unknown }).groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId >= 0),
    ),
  );

  const managedGroupIds: number[] = [];
  for (const groupId of candidateGroupIds) {
    const group = await chromeGetTabGroup(chromeApi, groupId);
    if (looksLikeManagedClaimGroupTitle(group?.title)) managedGroupIds.push(groupId);
  }

  const tabIdsToUngroup = tabs
    .filter((tab) => managedGroupIds.includes(Number((tab as { groupId?: unknown }).groupId)))
    .map((tab) => Number(tab.id))
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0);

  const ungrouped = await chromeUngroupTabs(chromeApi, tabIdsToUngroup);
  return {
    ok: ungrouped.ok,
    released: ungrouped.ok,
    claimId: payload?.claimId || null,
    ungrouped: ungrouped.ok ? tabIdsToUngroup.length : 0,
    ungroupedTabIds: ungrouped.ok ? Array.from(new Set(tabIdsToUngroup)) : [],
    groupIds: managedGroupIds,
    error: ungrouped.ok ? null : ungrouped.error,
    code: ungrouped.ok ? null : 'native_tab_claim_release_failed',
  };
};

const activateNativeBrowserTab = async (
  chromeApi: ChromeNativeBrokerApi,
  tabs: readonly RawBrowserTab[],
  payload: NativeBrowserBrokerCommand['payload'] = {},
) => {
  const tabId = Number(payload?.tabId || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false as const, code: 'tab_id_required', error: 'tabId required' };
  }
  const tab = tabs.find((item) => Number(item.id) === tabId) || null;
  if (!tab) {
    return { ok: false as const, code: 'tab_not_found', error: 'Tab not found', tabId };
  }

  const activated = await chromeUpdateTabActive(chromeApi, tabId);
  if (!activated.ok) {
    return {
      ok: false as const,
      code: 'native_tab_activation_failed',
      error: activated.error,
      tabId,
    };
  }
  const shouldFocusWindow = payload?.focusWindow === true;
  const focus = shouldFocusWindow ? await chromeFocusWindow(chromeApi, Number(tab.windowId)) : null;
  return {
    ok: true as const,
    activated: true,
    tabId,
    windowId: Number(tab.windowId) || null,
    isActiveTab: true,
    focusWindow: shouldFocusWindow,
    focusOk: focus ? focus.ok : null,
    focusError: focus && !focus.ok ? focus.error : null,
    tab: activated.tab || tab,
  };
};

export const handleNativeBrowserBrokerCommand = async (
  request: NativeBrowserBrokerCommand,
  chromeApi: ChromeNativeBrokerApi = globalChrome() || {},
  runtimeActions: NativeBrowserBrokerRuntimeActions = {},
) => {
  if (request.command === 'extension.status') {
    return (
      runtimeActions.extensionStatus?.() ?? {
        ok: false as const,
        code: 'extension_status_unavailable',
      }
    );
  }

  if (request.command === 'extension.selfHealContentScripts') {
    if (!runtimeActions.selfHealContentScripts) {
      return {
        ok: false as const,
        code: 'extension_self_heal_unavailable',
      };
    }
    return runtimeActions.selfHealContentScripts(request.payload || {});
  }

  if (request.command === 'extension.reloadSelf') {
    if (!runtimeActions.reloadSelf) {
      return {
        ok: false as const,
        code: 'extension_reload_unavailable',
      };
    }
    return runtimeActions.reloadSelf(request.payload || {});
  }

  const tabs = await queryManagedTabs(chromeApi);
  const inspectTab = inspectWith(chromeApi);

  if (request.command === 'tabs.list' || request.command === 'tabs.status') {
    return { ok: true as const, tabs: await classifyBrowserTabs(tabs, { inspectTab }) };
  }

  if (request.command === 'tabs.claim') {
    const claim = await claimDebuggableGeminiTab(tabs, {
      requestedTabId: Number(request.payload?.tabId || 0) || null,
      claimId: request.payload?.claimId || null,
      inspectTab,
    });
    if (claim.ok !== true) return claim;
    const relatedTabIds = Array.from(
      new Set([
        ...claim.visualCompanionTabIds,
        ...relatedTabIdsFromClaimPayload(claim.tab.tabId, request.payload),
      ]),
    );
    return {
      ...claim,
      visual: await applyNativeClaimVisual(
        chromeApi,
        claim.tab.tabId,
        relatedTabIds,
        request.payload,
      ),
    };
  }

  if (request.command === 'tabs.release') {
    return releaseNativeClaimVisual(chromeApi, tabs, request.payload || {});
  }

  if (request.command === 'tabs.activate') {
    return activateNativeBrowserTab(chromeApi, tabs, request.payload || {});
  }

  if (request.command === 'tabs.reload') {
    const listed = await getDebuggableGeminiTabs(tabs, { inspectTab });
    const requestedTabId = Number(request.payload?.tabId || 0);
    const explicitTabIds = trackedTabIdsForClaimRelease(requestedTabId, {
      tabIds: request.payload?.tabIds,
    });
    const reloadAll = request.payload?.reloadAll === true;
    const explicitTargets =
      explicitTabIds.length > 0
        ? tabs
            .filter((tab) => explicitTabIds.includes(Number(tab.id)))
            .map((tab) => ({ ...tab, tabId: Number(tab.id) }))
        : [];
    const targets =
      explicitTabIds.length > 0
        ? explicitTargets
        : reloadAll
          ? listed.tabs
          : listed.tabs.filter((tab) => tab.active === true);

    if (targets.length === 0) {
      return {
        ok: false as const,
        code:
          explicitTabIds.length > 0
            ? 'no_requested_tabs'
            : listed.tabs.length === 0
              ? 'no_existing_gemini_tabs'
              : 'no_active_gemini_tab',
        reloaded: 0,
        tabs: listed.tabs,
        classified: listed.classified,
      };
    }
    if (explicitTabIds.length === 0 && !requestedTabId && !reloadAll && targets.length > 1) {
      return {
        ok: false as const,
        code: 'ambiguous_active_gemini_tabs',
        reloaded: 0,
        tabs: targets,
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
  command === 'tabs.activate' ||
  command === 'tabs.reload' ||
  command === 'extension.status' ||
  command === 'extension.selfHealContentScripts' ||
  command === 'extension.reloadSelf';

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
  runtimeActions = {},
}: {
  chromeApi?: ChromeNativeBrokerApi;
  hostName: string;
  onStatus?: (status: unknown) => void;
  runtimeActions?: NativeBrowserBrokerRuntimeActions;
}) => {
  let port: ChromeRuntimePort | null = null;
  let readyPromise: Promise<unknown> | null = null;
  let settleReady: ((status: unknown) => void) | null = null;

  const connect = () => {
    if (!chromeApi.runtime?.connectNative) {
      throw new Error('native_messaging_unavailable');
    }

    const helloId = `extension-${Date.now()}`;
    readyPromise = new Promise((resolve) => {
      settleReady = resolve;
    });
    port = chromeApi.runtime.connectNative(hostName);
    port.onMessage.addListener((message: unknown) => {
      if (isBrokerResponse(message)) {
        onStatus?.({ ok: message.ok, response: message });
        if (message.id === helloId) {
          settleReady?.({ ok: message.ok, response: message });
          settleReady = null;
        }
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
        runtimeActions,
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
      settleReady?.({
        ok: false,
        code: 'native_broker_disconnected',
        error: chromeApi.runtime?.lastError?.message || null,
      });
      settleReady = null;
      readyPromise = null;
      port = null;
    });

    port.postMessage({
      id: helloId,
      protocolVersion: 1,
      command: 'extension.hello',
      payload: { source: 'extension-background' },
    });
    onStatus?.({ ok: true, connected: true });
    return port;
  };

  return {
    ensureConnected: () => port || connect(),
    ensureReady: ({ timeoutMs = 2500 } = {}) => {
      const connectedPort = port || connect();
      void connectedPort;
      const timeout = new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: false,
              code: 'native_broker_ready_timeout',
              timeoutMs,
            }),
          timeoutMs,
        );
      });
      return Promise.race([readyPromise || Promise.resolve({ ok: true }), timeout]);
    },
    disconnect: () => {
      port?.disconnect?.();
      settleReady = null;
      readyPromise = null;
      port = null;
    },
  };
};
