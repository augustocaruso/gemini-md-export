import {
  type DebuggerTabInspection,
  inspectTabWithDebugger,
} from './chrome-debugger-controller.js';

const INSPECTABLE_BROWSER_TAB: unique symbol = Symbol('InspectableBrowserTab');
const DEBUGGABLE_GEMINI_TAB: unique symbol = Symbol('DebuggableGeminiTab');
const CLAIMED_DEBUGGABLE_GEMINI_TAB: unique symbol = Symbol('ClaimedDebuggableGeminiTab');

export type RawBrowserTab = Readonly<{
  id?: number;
  windowId?: number;
  active?: boolean;
  url?: string;
  title?: string;
}>;

export type InspectableBrowserTab = RawBrowserTab &
  Readonly<{ readonly [INSPECTABLE_BROWSER_TAB]: true; tabId: number }>;

export type DebuggableGeminiTab = InspectableBrowserTab &
  Readonly<{ readonly [DEBUGGABLE_GEMINI_TAB]: true; url: string }>;

export type ClaimedDebuggableGeminiTab = DebuggableGeminiTab &
  Readonly<{ readonly [CLAIMED_DEBUGGABLE_GEMINI_TAB]: true; claimId: string }>;

export type BrowserTabClassification = Readonly<{
  state: 'uninspectable' | 'blocked' | 'not_gemini' | 'debuggable';
  code: string | null;
  tab: RawBrowserTab | DebuggableGeminiTab;
  inspection?: DebuggerTabInspection;
}>;

export type BrowserSessionBrokerOptions = Readonly<{
  inspectTab?: (tabId: number) => Promise<DebuggerTabInspection>;
  requestedTabId?: number | null;
  claimId?: string | null;
}>;

const randomClaimId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
};

const toDebuggableGeminiTab = (
  tab: RawBrowserTab,
  tabId: number,
  url: string,
): DebuggableGeminiTab =>
  ({
    ...tab,
    tabId,
    url,
    [INSPECTABLE_BROWSER_TAB]: true,
    [DEBUGGABLE_GEMINI_TAB]: true,
  }) as DebuggableGeminiTab;

const toClaimedDebuggableGeminiTab = (
  tab: DebuggableGeminiTab,
  claimId: string,
): ClaimedDebuggableGeminiTab =>
  ({
    ...tab,
    claimId,
    [CLAIMED_DEBUGGABLE_GEMINI_TAB]: true,
  }) as ClaimedDebuggableGeminiTab;

export const classifyBrowserTabs = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
): Promise<BrowserTabClassification[]> => {
  const inspectTab = options.inspectTab || ((tabId: number) => inspectTabWithDebugger(tabId));
  const result: BrowserTabClassification[] = [];
  for (const tab of tabs) {
    const tabId = Number(tab.id);
    if (!Number.isInteger(tabId)) {
      result.push({ state: 'uninspectable', code: 'missing_tab_id', tab });
      continue;
    }
    const inspection = await inspectTab(tabId);
    if (inspection.blockerCode) {
      result.push({ state: 'blocked', code: inspection.blockerCode, tab, inspection });
      continue;
    }
    if (inspection.pageKind !== 'gemini') {
      result.push({ state: 'not_gemini', code: 'page_not_gemini', tab, inspection });
      continue;
    }
    result.push({
      state: 'debuggable',
      code: null,
      tab: toDebuggableGeminiTab(tab, tabId, inspection.url || tab.url || ''),
      inspection,
    });
  }
  return result;
};

export const getDebuggableGeminiTabs = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
) => {
  const classified = await classifyBrowserTabs(tabs, options);
  const debuggable = classified
    .filter((item) => item.state === 'debuggable')
    .map((item) => item.tab as DebuggableGeminiTab);
  return { ok: true, tabs: debuggable, classified };
};

export const visualCompanionTabIdsForClaim = (
  claimedTab: DebuggableGeminiTab,
  classified: readonly BrowserTabClassification[],
): readonly number[] =>
  classified
    .filter((item) => item.inspection?.pageKind === 'my_activity')
    .filter((item) => {
      const companionWindowId = Number(item.tab.windowId);
      const claimedWindowId = Number(claimedTab.windowId);
      return (
        !Number.isInteger(companionWindowId) ||
        !Number.isInteger(claimedWindowId) ||
        companionWindowId === claimedWindowId
      );
    })
    .map((item) => Number(item.tab.id))
    .filter((tabId) => Number.isInteger(tabId) && tabId !== claimedTab.tabId);

export const claimDebuggableGeminiTab = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
) => {
  const listed = await getDebuggableGeminiTabs(tabs, options);
  const candidates = options.requestedTabId
    ? listed.tabs.filter((candidate) => candidate.tabId === options.requestedTabId)
    : listed.tabs;
  if (candidates.length === 0) {
    return { ok: false as const, code: 'no_debuggable_gemini_tab', tabs: listed.tabs };
  }
  if (candidates.length > 1) {
    return { ok: false as const, code: 'ambiguous_gemini_tabs', tabs: candidates };
  }
  return {
    ok: true as const,
    tab: toClaimedDebuggableGeminiTab(candidates[0], options.claimId || randomClaimId()),
    visualCompanionTabIds: visualCompanionTabIdsForClaim(candidates[0], listed.classified),
  };
};
