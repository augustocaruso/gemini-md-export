const ACTIVITY_GEMINI_URL_PREFIX = 'https://myactivity.google.com/product/gemini';
const tabIdOf = (tab) => {
    const tabId = Number(tab.id ?? tab.tabId);
    return Number.isInteger(tabId) ? tabId : null;
};
const tabUrlOf = (tab) => tab.url || tab.pendingUrl || '';
const isGeminiActivityTab = (tab) => tabUrlOf(tab).startsWith(ACTIVITY_GEMINI_URL_PREFIX);
const sameWindowOrUnknown = (claimedTab, companionTab) => {
    const claimedWindowId = Number(claimedTab.windowId);
    const companionWindowId = Number(companionTab.windowId);
    return (!Number.isInteger(claimedWindowId) ||
        !Number.isInteger(companionWindowId) ||
        claimedWindowId === companionWindowId);
};
const tabDistance = (claimedTab, companionTab) => {
    const claimedIndex = Number(claimedTab.index);
    const companionIndex = Number(companionTab.index);
    if (!Number.isFinite(claimedIndex) || !Number.isFinite(companionIndex)) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.abs(companionIndex - claimedIndex);
};
export const selectClaimVisualCompanionTabIds = (claimedTab, candidateTabs, alreadyRelatedTabIds = []) => {
    const claimedTabId = tabIdOf(claimedTab);
    const alreadyRelated = new Set(alreadyRelatedTabIds.map(Number).filter((tabId) => Number.isInteger(tabId)));
    const candidates = candidateTabs
        .map((tab) => ({ tab, tabId: tabIdOf(tab) }))
        .filter((item) => Number.isInteger(item.tabId))
        .filter((item) => item.tabId !== claimedTabId)
        .filter((item) => isGeminiActivityTab(item.tab))
        .filter((item) => sameWindowOrUnknown(claimedTab, item.tab))
        .sort((left, right) => tabDistance(claimedTab, left.tab) - tabDistance(claimedTab, right.tab) ||
        left.tabId - right.tabId);
    if (candidates.some((item) => alreadyRelated.has(item.tabId)))
        return [];
    const selected = candidates[0]?.tabId;
    if (!Number.isInteger(selected))
        return [];
    return [selected];
};
