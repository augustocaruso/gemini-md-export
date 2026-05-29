export type BrowserAuthorityOwner = 'cli' | 'mcp' | 'extension-ui' | 'repair' | 'test';

export type BrowserAuthorityPolicy = 'none' | 'private_first' | 'job_safe' | 'interactive_explicit';

export type BrowserAuthorityOperationKind =
  | 'selected_export'
  | 'recent_export'
  | 'sync_export'
  | 'missing_export'
  | 'reexport'
  | 'fix_vault'
  | 'ready_check'
  | 'tab_management'
  | 'diagnostic';

export type BrowserAuthorityBudget = Readonly<{
  maxNewTabs: number;
  maxReloads: number;
  maxActivations: number;
  maxNavigations: number;
  deadlineAtMs: number;
}>;

export type BrowserAuthorityBlockerCode =
  | 'google_verification_required'
  | 'google_login_required'
  | 'extension_build_mismatch_unrecoverable'
  | 'runtime_epoch_timeout'
  | 'ambiguous_gemini_tabs'
  | 'native_broker_unavailable_for_required_effect'
  | 'browser_side_effects_disabled'
  | 'operation_budget_exhausted'
  | 'lease_missing'
  | 'lease_expired'
  | 'lease_mismatch';

export type BrowserAuthorityBlocker = Readonly<{
  code: BrowserAuthorityBlockerCode;
  scope: 'operation' | 'tab' | 'profile';
  terminal: true;
  message: string;
  nextAction: string;
  observedAtMs: number;
}>;

export type BrowserLease = Readonly<{
  leaseId: string;
  operationId: string;
  operationKind: BrowserAuthorityOperationKind;
  owner: BrowserAuthorityOwner;
  policy: BrowserAuthorityPolicy;
  budget: BrowserAuthorityBudget;
  managedTabIds: readonly number[];
  expectedEpochId?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  blocker?: BrowserAuthorityBlocker | null;
  releasedAtMs?: number | null;
}>;

export type BrowserAuthorityEffectType =
  | 'browser.launch'
  | 'tab.activate'
  | 'tab.reload'
  | 'tab.navigate'
  | 'extension.reload'
  | 'contentScript.command'
  | 'tab.claimVisual'
  | 'tab.releaseVisual'
  | 'managedTab.cleanup'
  | 'diagnostic.record';

export type BrowserAuthorityEffect = Readonly<{
  type: BrowserAuthorityEffectType;
  reason: string;
  leaseId?: string;
  tabId?: number | null;
  url?: string | null;
  commandType?: string | null;
  blocker?: BrowserAuthorityBlocker | null;
}>;

export type LeasedBrowserAuthorityEffect = BrowserAuthorityEffect & Readonly<{ leaseId: string }>;

export type BrowserAuthorityState = Readonly<{
  leases: readonly BrowserLease[];
  profileBlocker?: BrowserAuthorityBlocker | null;
  updatedAtMs: number;
}>;
