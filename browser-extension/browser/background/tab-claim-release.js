export const trackedTabIdsForClaimRelease = (primaryTabId, claim) => {
    const tabIds = [primaryTabId, ...(Array.isArray(claim?.tabIds) ? claim.tabIds : [])]
        .filter((value) => typeof value === 'number' || typeof value === 'string')
        .map(Number)
        .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    return Array.from(new Set(tabIds));
};
const claimIdOf = (claim) => typeof claim?.claimId === 'string' ? claim.claimId.trim() : '';
export const trackedTabIdsForOwnedClaimRelease = (primaryTabId, claim, claimsByTabId = {}) => {
    const releaseClaimId = claimIdOf(claim);
    return trackedTabIdsForClaimRelease(primaryTabId, claim).filter((tabId) => {
        if (tabId === primaryTabId)
            return true;
        const otherClaimId = claimIdOf(claimsByTabId[String(tabId)]);
        return !releaseClaimId || !otherClaimId || otherClaimId === releaseClaimId;
    });
};
export const storedManagedClaimGroupIdForRelease = (claim) => {
    if (claim?.mode !== 'tab-group')
        return null;
    if (Number(claim.originalGroupId) !== -1)
        return null;
    const groupId = Number(claim.groupId);
    return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
};
