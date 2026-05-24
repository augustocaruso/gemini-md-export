export type HydrationProgressSnapshot = {
  containerCount?: number;
  turnDomCount?: number;
  firstSignature?: string;
  scrollHeight?: number;
};

export type HydrationConfirmationOptions = {
  loadWaitMs: number;
  topSettleMs: number;
  smallSettleMs?: number;
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const hydrationDomProgressChanged = (
  before: HydrationProgressSnapshot | null | undefined,
  after: HydrationProgressSnapshot | null | undefined,
): boolean =>
  Boolean(
    before &&
      after &&
      (numberValue(after.containerCount) > numberValue(before.containerCount) ||
        numberValue(after.turnDomCount) > numberValue(before.turnDomCount) ||
        String(after.firstSignature || '') !== String(before.firstSignature || '')),
  );

export const hydrationLayoutOnlyChanged = (
  before: HydrationProgressSnapshot | null | undefined,
  after: HydrationProgressSnapshot | null | undefined,
): boolean =>
  Boolean(
    before &&
      after &&
      !hydrationDomProgressChanged(before, after) &&
      numberValue(after.scrollHeight) > numberValue(before.scrollHeight) + 4,
  );

export const hydrationSnapshotLooksLarge = (
  state: HydrationProgressSnapshot | null | undefined,
): boolean =>
  numberValue(state?.turnDomCount) >= 80 ||
  numberValue(state?.containerCount) >= 80 ||
  numberValue(state?.scrollHeight) >= 30000;

export const hydrationConfirmationWaitMs = (
  state: HydrationProgressSnapshot | null | undefined,
  { loadWaitMs, topSettleMs, smallSettleMs = 900 }: HydrationConfirmationOptions,
): number => {
  if (hydrationSnapshotLooksLarge(state)) return topSettleMs;
  return Math.min(topSettleMs, Math.max(500, Math.min(loadWaitMs, smallSettleMs)));
};
