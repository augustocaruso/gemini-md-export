type NativeExportLease = Readonly<{
  tabId?: unknown;
  claimId?: unknown;
  tab?: { claimId?: unknown } | null;
  visual?: {
    tabIds?: readonly unknown[] | null;
  } | null;
}>;

type NativeTabLike = Readonly<{
  id?: unknown;
  tabId?: unknown;
  windowId?: unknown;
  index?: unknown;
  url?: unknown;
  pendingUrl?: unknown;
}>;

type NativeTabClassificationLike = Readonly<{
  tab?: NativeTabLike | null;
  inspection?: { pageKind?: unknown } | null;
}>;

type NativeTabsListLike = Readonly<{
  tabs?: readonly (NativeTabClassificationLike | NativeTabLike)[] | null;
}>;

const positiveTabId = (value: unknown): number | null => {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
};

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const tabFromListItem = (item: NativeTabClassificationLike | NativeTabLike): NativeTabLike => {
  if (item && typeof item === 'object' && 'tab' in item && item.tab) return item.tab;
  return item as NativeTabLike;
};

const tabUrl = (tab: NativeTabLike): string => String(tab.url || tab.pendingUrl || '');

const itemPageKind = (item: NativeTabClassificationLike | NativeTabLike): string =>
  String(
    item && typeof item === 'object' && 'inspection' in item ? item.inspection?.pageKind || '' : '',
  );

const isActivityListItem = (item: NativeTabClassificationLike | NativeTabLike): boolean => {
  const tab = tabFromListItem(item);
  return (
    itemPageKind(item) === 'my_activity' ||
    tabUrl(tab).startsWith('https://myactivity.google.com/product/gemini')
  );
};

export const activityCompanionTabIdsForNativeLease = (
  lease: NativeExportLease | null | undefined,
  exportTabId: unknown = undefined,
): readonly number[] => {
  const primaryTabId = positiveTabId(exportTabId ?? lease?.tabId);
  const tabIds = Array.isArray(lease?.visual?.tabIds) ? lease.visual.tabIds : [];
  const companions = tabIds
    .map(positiveTabId)
    .filter((tabId): tabId is number => tabId !== null && tabId !== primaryTabId);
  return Array.from(new Set(companions));
};

export const activityCompanionTabIdsForNativeTabs = (
  list: NativeTabsListLike | null | undefined,
  exportTabId: unknown = undefined,
): readonly number[] => {
  const primaryTabId = positiveTabId(exportTabId);
  const entries = Array.isArray(list?.tabs) ? list.tabs : [];
  const exportTab = entries
    .map(tabFromListItem)
    .find((tab) => primaryTabId !== null && positiveTabId(tab.id ?? tab.tabId) === primaryTabId);
  const exportWindowId = numberOrNull(exportTab?.windowId);
  const exportIndex = numberOrNull(exportTab?.index);
  const candidates = entries
    .filter(isActivityListItem)
    .map(tabFromListItem)
    .map((tab) => ({
      tabId: positiveTabId(tab.id ?? tab.tabId),
      windowId: numberOrNull(tab.windowId),
      index: numberOrNull(tab.index),
    }))
    .filter(
      (item): item is { tabId: number; windowId: number | null; index: number | null } =>
        item.tabId !== null && item.tabId !== primaryTabId,
    )
    .filter(
      (item) =>
        exportWindowId === null || item.windowId === null || item.windowId === exportWindowId,
    )
    .sort((left, right) => {
      const leftDistance =
        exportIndex === null || left.index === null
          ? Number.MAX_SAFE_INTEGER
          : Math.abs(left.index - exportIndex);
      const rightDistance =
        exportIndex === null || right.index === null
          ? Number.MAX_SAFE_INTEGER
          : Math.abs(right.index - exportIndex);
      return leftDistance - rightDistance || left.tabId - right.tabId;
    });
  const selected = candidates[0]?.tabId;
  return Number.isInteger(selected) ? [selected] : [];
};

export const shouldPrepareActivityCompanionForDateImport = (
  args: Readonly<Record<string, unknown>> = {},
): boolean => args.noMyActivity !== true && args.useMyActivity !== false;

const DEFAULT_ACTIVITY_COMPANION_WAKE_WAIT_MS = 15_000;

type AnyRecord = Record<string, any>;

const activityCompanionWakeWaitMs = (
  args: Readonly<Record<string, unknown>>,
  normalizeWaitMs: (value: unknown, fallbackMs: number, maxMs: number) => number,
) =>
  normalizeWaitMs(
    args.activityCompanionWakeWaitMs ?? args.activityWaitMs ?? args.myActivityWaitMs,
    DEFAULT_ACTIVITY_COMPANION_WAKE_WAIT_MS,
    60_000,
  );

const summarizeActivityCompanionWakeError = (err: any) => ({
  ok: false,
  code: err?.code || null,
  error: err?.message || String(err),
});

const claimIdFromLease = (
  lease: NativeExportLease | null | undefined,
  args: AnyRecord,
): string | null => {
  const claimId = args.claimId || lease?.claimId || lease?.tab?.claimId;
  const normalized = String(claimId || '').trim();
  return normalized || null;
};

export const createActivityCompanionPreparer =
  (deps: {
    normalizeTabId(value: unknown): number | null;
    normalizeWaitMs(value: unknown, fallbackMs: number, maxMs: number): number;
    waitForActivityClient(selector: AnyRecord, timeoutMs?: unknown): Promise<AnyRecord | null>;
    activityClientCommandReady(client: AnyRecord | null): boolean;
    activateBrowserTabById(
      tabId: number,
      args?: AnyRecord,
      preferredClient?: AnyRecord | null,
    ): Promise<AnyRecord | null>;
    tryNativeBrowserBrokerTabsAction(action: string, args?: AnyRecord): Promise<AnyRecord | null>;
    summarizeClient(client: AnyRecord): AnyRecord;
    getActivityClients(): AnyRecord[];
  }) =>
  async (
    client: AnyRecord | null,
    args: AnyRecord = {},
    nativeLease: NativeExportLease | null = null,
  ) => {
    if (!shouldPrepareActivityCompanionForDateImport(args)) {
      return { attempted: false, reason: 'my-activity-disabled' };
    }
    const exportTabId = deps.normalizeTabId(nativeLease?.tabId ?? args.tabId ?? client?.tabId);
    let companionTabIds = activityCompanionTabIdsForNativeLease(nativeLease, exportTabId);
    let companionSource = 'claim-visual';
    let companionList = null;
    let visualRefresh = null;
    if (companionTabIds.length === 0) {
      try {
        companionList = await deps.tryNativeBrowserBrokerTabsAction('list', {
          reason: 'find-activity-companion-before-export',
        });
        companionTabIds = activityCompanionTabIdsForNativeTabs(companionList, exportTabId);
        companionSource = 'native-tabs-list';
      } catch (err) {
        companionList = summarizeActivityCompanionWakeError(err);
      }
    }
    if (companionTabIds.length === 0) {
      return { attempted: false, reason: 'no-activity-companion-tab', companionList };
    }

    const companionTabId = companionTabIds[0];
    if (exportTabId !== null) {
      try {
        visualRefresh = await deps.tryNativeBrowserBrokerTabsAction('claim', {
          ...args,
          tabId: exportTabId,
          claimId: claimIdFromLease(nativeLease, args) || undefined,
          tabIds: [exportTabId, companionTabId],
          relatedTabIds: [companionTabId],
          reason: 'attach-activity-companion-before-export',
        });
      } catch (err) {
        visualRefresh = summarizeActivityCompanionWakeError(err);
      }
    }

    const alreadyReady = await deps.waitForActivityClient({ tabId: companionTabId }, 1500);
    if (alreadyReady && deps.activityClientCommandReady(alreadyReady)) {
      return {
        attempted: false,
        reason: 'activity-companion-already-ready',
        source: companionSource,
        tabId: companionTabId,
        client: deps.summarizeClient(alreadyReady),
        visualRefresh,
      };
    }

    let activation = null;
    let reload = null;
    let restore = null;
    try {
      activation = await deps.activateBrowserTabById(
        companionTabId,
        {
          ...args,
          activateTabReason: 'wake-activity-companion-before-export',
          focusWindow: false,
          activateTabConfirmWaitMs: 5000,
        },
        null,
      );
    } catch (err) {
      activation = summarizeActivityCompanionWakeError(err);
    }

    try {
      reload = await deps.tryNativeBrowserBrokerTabsAction('reload', {
        tabIds: [companionTabId],
        reason: 'reload-activity-companion-before-export',
        focusWindow: false,
      });
    } catch (err) {
      reload = summarizeActivityCompanionWakeError(err);
    }

    const activityClient = await deps.waitForActivityClient(
      { tabId: companionTabId },
      activityCompanionWakeWaitMs(args, deps.normalizeWaitMs),
    );

    if (exportTabId !== null) {
      try {
        restore = await deps.activateBrowserTabById(
          exportTabId,
          {
            ...args,
            activateTabReason: 'restore-gemini-after-activity-companion',
            focusWindow: false,
            activateTabConfirmWaitMs: 8000,
          },
          client,
        );
      } catch (err) {
        restore = summarizeActivityCompanionWakeError(err);
      }
    }

    if (!activityClient || !deps.activityClientCommandReady(activityClient)) {
      const error = new Error(
        'A aba My Activity da claim visual não ficou pronta para buscar datas.',
      ) as Error & { code?: string; data?: AnyRecord };
      error.code = 'activity_companion_not_ready';
      error.data = {
        companionTabId,
        exportTabId,
        activation,
        reload,
        restore,
        visualRefresh,
        connectedActivityClients: deps.getActivityClients().map(deps.summarizeClient),
      };
      throw error;
    }

    return {
      attempted: true,
      reason: 'activity-companion-ready-after-wake',
      source: companionSource,
      tabId: companionTabId,
      client: deps.summarizeClient(activityClient),
      visualRefresh,
      activation,
      reload,
      restore,
    };
  };
