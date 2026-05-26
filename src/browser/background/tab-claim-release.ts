type TrackedTabClaim = Readonly<{
  claimId?: unknown;
  mode?: unknown;
  originalGroupId?: unknown;
  groupId?: unknown;
  tabIds?: readonly unknown[] | null;
}>;

export const trackedTabIdsForClaimRelease = (
  primaryTabId: number,
  claim: TrackedTabClaim | null | undefined,
): readonly number[] => {
  const tabIds = [primaryTabId, ...(Array.isArray(claim?.tabIds) ? claim.tabIds : [])]
    .filter((value) => typeof value === 'number' || typeof value === 'string')
    .map(Number)
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
  return Array.from(new Set(tabIds));
};

const claimIdOf = (claim: TrackedTabClaim | null | undefined): string =>
  typeof claim?.claimId === 'string' ? claim.claimId.trim() : '';

export const trackedTabIdsForOwnedClaimRelease = (
  primaryTabId: number,
  claim: TrackedTabClaim | null | undefined,
  claimsByTabId: Readonly<Record<string, TrackedTabClaim | null | undefined>> = {},
): readonly number[] => {
  const releaseClaimId = claimIdOf(claim);
  return trackedTabIdsForClaimRelease(primaryTabId, claim).filter((tabId) => {
    if (tabId === primaryTabId) return true;
    const otherClaimId = claimIdOf(claimsByTabId[String(tabId)]);
    return !releaseClaimId || !otherClaimId || otherClaimId === releaseClaimId;
  });
};

export const storedManagedClaimGroupIdForRelease = (
  claim: TrackedTabClaim | null | undefined,
): number | null => {
  if (claim?.mode !== 'tab-group') return null;
  if (Number(claim.originalGroupId) !== -1) return null;
  const groupId = Number(claim.groupId);
  return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
};
