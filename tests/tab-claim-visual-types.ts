import type {
  TabClaimReceipt,
  TabClaimVisual,
  TabGroupClaimVisual,
} from '../src/mcp/tab-claim-visual.js';

const visual = {
  mode: 'tab-group',
  tabId: 42,
  groupId: 99,
} satisfies TabGroupClaimVisual;

const receipt = {
  ok: true,
  visual,
} satisfies TabClaimReceipt;

void receipt;

const badgeVisual = {
  mode: 'action-badge',
  tabId: 42,
  groupId: 99,
} satisfies TabClaimVisual;

void badgeVisual;

const badgeReceipt = {
  ok: true,
  visual: {
    mode: 'action-badge',
    tabId: 42,
    reason: 'tab-already-in-user-group',
  },
} satisfies TabClaimReceipt;

void badgeReceipt;

const invalidBadge = {
  mode: 'action-badge',
  // @ts-expect-error action-badge claim visual must include the claimed tab id.
  tabId: null,
} satisfies TabClaimVisual;

void invalidBadge;

const missingGroup = {
  mode: 'tab-group',
  tabId: 42,
  // @ts-expect-error tab-group claim visual must include a concrete group id.
  groupId: null,
} satisfies TabGroupClaimVisual;

void missingGroup;
