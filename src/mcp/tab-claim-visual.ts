export type TabGroupClaimVisual = Readonly<{
  mode: 'tab-group';
  tabId: number;
  tabIds: readonly [number, ...number[]];
  groupId: number;
  color?: string | null;
  label?: string | null;
  reason?: string | null;
}>;

export type ActionBadgeClaimVisual = Readonly<{
  mode: 'action-badge';
  tabId: number;
  groupId?: number | null;
  reason?: string | null;
}>;

export type TabClaimVisual = TabGroupClaimVisual | ActionBadgeClaimVisual;

export type TabClaimReceipt = Readonly<{
  ok: true;
  visual: TabClaimVisual;
}>;

const integer = (value: unknown): value is number => Number.isInteger(value);
const integerArray = (value: unknown): value is readonly [number, ...number[]] =>
  Array.isArray(value) && value.length > 0 && value.every(integer);

export const isTabGroupClaimVisual = (value: unknown): value is TabGroupClaimVisual => {
  const visual = value as Partial<TabGroupClaimVisual> | null | undefined;
  return (
    visual?.mode === 'tab-group' &&
    integer(visual.tabId) &&
    integer(visual.groupId) &&
    integerArray(visual.tabIds) &&
    visual.tabIds.includes(visual.tabId)
  );
};

export const isActionBadgeClaimVisual = (value: unknown): value is ActionBadgeClaimVisual => {
  const visual = value as Partial<ActionBadgeClaimVisual> | null | undefined;
  return visual?.mode === 'action-badge' && integer(visual.tabId);
};

export const isTabClaimVisual = (value: unknown): value is TabClaimVisual =>
  isTabGroupClaimVisual(value) || isActionBadgeClaimVisual(value);

export const isTabClaimReceipt = (value: unknown): value is TabClaimReceipt => {
  const receipt = value as Partial<TabClaimReceipt> | null | undefined;
  return receipt?.ok === true && isTabClaimVisual(receipt.visual);
};

export const isTabGroupClaimReceipt = isTabClaimReceipt;

export const tabClaimFailureReason = (value: unknown): string => {
  const receipt = value as Record<string, unknown> | null | undefined;
  const visual = receipt?.visual as Record<string, unknown> | null | undefined;
  const reason =
    visual?.reason ||
    receipt?.reason ||
    receipt?.error ||
    (receipt?.ok === true ? 'missing-tab-claim-visual' : 'claim-command-failed');
  return String(reason || 'missing-tab-claim-visual');
};

export const tabGroupClaimFailureReason = (value: unknown): string => {
  return tabClaimFailureReason(value);
};

export type TabGroupClaimReceipt = TabClaimReceipt;
