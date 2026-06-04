const integer = (value) => Number.isInteger(value);
const integerArray = (value) => Array.isArray(value) && value.length > 0 && value.every(integer);
export const isTabGroupClaimVisual = (value) => {
    const visual = value;
    return (visual?.mode === 'tab-group' &&
        integer(visual.tabId) &&
        integer(visual.groupId) &&
        integerArray(visual.tabIds) &&
        visual.tabIds.includes(visual.tabId));
};
export const isActionBadgeClaimVisual = (value) => {
    const visual = value;
    return visual?.mode === 'action-badge' && integer(visual.tabId);
};
export const isTabClaimVisual = (value) => isTabGroupClaimVisual(value) || isActionBadgeClaimVisual(value);
export const isTabClaimReceipt = (value) => {
    const receipt = value;
    return receipt?.ok === true && isTabClaimVisual(receipt.visual);
};
export const isTabGroupClaimReceipt = isTabClaimReceipt;
export const tabClaimFailureReason = (value) => {
    const receipt = value;
    const visual = receipt?.visual;
    const reason = visual?.reason ||
        receipt?.reason ||
        receipt?.error ||
        (receipt?.ok === true ? 'missing-tab-claim-visual' : 'claim-command-failed');
    return String(reason || 'missing-tab-claim-visual');
};
export const tabGroupClaimFailureReason = (value) => {
    return tabClaimFailureReason(value);
};
