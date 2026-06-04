import { inspectTabWithDebugger, } from './chrome-debugger-controller.js';
import { selectClaimVisualCompanionTabIds } from './tab-claim-companion-tabs.js';
const INSPECTABLE_BROWSER_TAB = Symbol('InspectableBrowserTab');
const DEBUGGABLE_GEMINI_TAB = Symbol('DebuggableGeminiTab');
const CLAIMED_DEBUGGABLE_GEMINI_TAB = Symbol('ClaimedDebuggableGeminiTab');
const randomClaimId = () => {
    try {
        return crypto.randomUUID();
    }
    catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
};
const toDebuggableGeminiTab = (tab, tabId, url) => ({
    ...tab,
    tabId,
    url,
    [INSPECTABLE_BROWSER_TAB]: true,
    [DEBUGGABLE_GEMINI_TAB]: true,
});
const toClaimedDebuggableGeminiTab = (tab, claimId) => ({
    ...tab,
    claimId,
    [CLAIMED_DEBUGGABLE_GEMINI_TAB]: true,
});
export const classifyBrowserTabs = async (tabs, options = {}) => {
    const inspectTab = options.inspectTab || ((tabId) => inspectTabWithDebugger(tabId));
    const result = [];
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
export const getDebuggableGeminiTabs = async (tabs, options = {}) => {
    const classified = await classifyBrowserTabs(tabs, options);
    const debuggable = classified
        .filter((item) => item.state === 'debuggable')
        .map((item) => item.tab);
    return { ok: true, tabs: debuggable, classified };
};
export const visualCompanionTabIdsForClaim = (claimedTab, classified, alreadyRelatedTabIds = []) => selectClaimVisualCompanionTabIds(claimedTab, classified
    .filter((item) => item.inspection?.pageKind === 'my_activity')
    .map((item) => item.tab), alreadyRelatedTabIds);
export const claimDebuggableGeminiTab = async (tabs, options = {}) => {
    const listed = await getDebuggableGeminiTabs(tabs, options);
    const candidates = options.requestedTabId
        ? listed.tabs.filter((candidate) => candidate.tabId === options.requestedTabId)
        : listed.tabs;
    if (candidates.length === 0) {
        return { ok: false, code: 'no_debuggable_gemini_tab', tabs: listed.tabs };
    }
    if (candidates.length > 1) {
        return { ok: false, code: 'ambiguous_gemini_tabs', tabs: candidates };
    }
    return {
        ok: true,
        tab: toClaimedDebuggableGeminiTab(candidates[0], options.claimId || randomClaimId()),
        visualCompanionTabIds: visualCompanionTabIdsForClaim(candidates[0], listed.classified, Array.isArray(options.relatedTabIds) ? options.relatedTabIds : []),
    };
};
