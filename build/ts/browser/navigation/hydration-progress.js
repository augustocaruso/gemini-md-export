const numberValue = (value) => {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
export const hydrationDomProgressChanged = (before, after) => Boolean(before &&
    after &&
    (numberValue(after.containerCount) > numberValue(before.containerCount) ||
        numberValue(after.turnDomCount) > numberValue(before.turnDomCount) ||
        String(after.firstSignature || '') !== String(before.firstSignature || '')));
export const hydrationLayoutOnlyChanged = (before, after) => Boolean(before &&
    after &&
    !hydrationDomProgressChanged(before, after) &&
    numberValue(after.scrollHeight) > numberValue(before.scrollHeight) + 4);
export const hydrationSnapshotLooksLarge = (state) => numberValue(state?.turnDomCount) >= 80 ||
    numberValue(state?.containerCount) >= 80 ||
    numberValue(state?.scrollHeight) >= 30000;
export const hydrationConfirmationWaitMs = (state, { loadWaitMs, topSettleMs, smallSettleMs = 900 }) => {
    if (hydrationSnapshotLooksLarge(state))
        return topSettleMs;
    return Math.min(topSettleMs, Math.max(500, Math.min(loadWaitMs, smallSettleMs)));
};
