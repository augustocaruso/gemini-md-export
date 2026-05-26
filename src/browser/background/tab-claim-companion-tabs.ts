export type ClaimVisualCandidateTab = Readonly<{
  id?: number;
  tabId?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
}>;

const ACTIVITY_GEMINI_URL_PREFIX = 'https://myactivity.google.com/product/gemini';

const tabIdOf = (tab: ClaimVisualCandidateTab): number | null => {
  const tabId = Number(tab.id ?? tab.tabId);
  return Number.isInteger(tabId) ? tabId : null;
};

const tabUrlOf = (tab: ClaimVisualCandidateTab): string => tab.url || tab.pendingUrl || '';

const isGeminiActivityTab = (tab: ClaimVisualCandidateTab): boolean =>
  tabUrlOf(tab).startsWith(ACTIVITY_GEMINI_URL_PREFIX);

const sameWindowOrUnknown = (
  claimedTab: ClaimVisualCandidateTab,
  companionTab: ClaimVisualCandidateTab,
): boolean => {
  const claimedWindowId = Number(claimedTab.windowId);
  const companionWindowId = Number(companionTab.windowId);
  return (
    !Number.isInteger(claimedWindowId) ||
    !Number.isInteger(companionWindowId) ||
    claimedWindowId === companionWindowId
  );
};

const tabDistance = (
  claimedTab: ClaimVisualCandidateTab,
  companionTab: ClaimVisualCandidateTab,
): number => {
  const claimedIndex = Number(claimedTab.index);
  const companionIndex = Number(companionTab.index);
  if (!Number.isFinite(claimedIndex) || !Number.isFinite(companionIndex)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(companionIndex - claimedIndex);
};

export const selectClaimVisualCompanionTabIds = (
  claimedTab: ClaimVisualCandidateTab,
  candidateTabs: readonly ClaimVisualCandidateTab[],
  alreadyRelatedTabIds: readonly number[] = [],
): readonly number[] => {
  const claimedTabId = tabIdOf(claimedTab);
  const alreadyRelated = new Set(
    alreadyRelatedTabIds.map(Number).filter((tabId) => Number.isInteger(tabId)),
  );
  const candidates = candidateTabs
    .map((tab) => ({ tab, tabId: tabIdOf(tab) }))
    .filter((item): item is { tab: ClaimVisualCandidateTab; tabId: number } =>
      Number.isInteger(item.tabId),
    )
    .filter((item) => item.tabId !== claimedTabId)
    .filter((item) => isGeminiActivityTab(item.tab))
    .filter((item) => sameWindowOrUnknown(claimedTab, item.tab))
    .sort(
      (left, right) =>
        tabDistance(claimedTab, left.tab) - tabDistance(claimedTab, right.tab) ||
        left.tabId - right.tabId,
    );
  const selected = candidates[0]?.tabId;
  if (!Number.isInteger(selected)) return [];
  if (alreadyRelated.has(selected)) return [selected];
  return [selected];
};
