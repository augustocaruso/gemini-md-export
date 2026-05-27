type ReadySnapshot = Readonly<{
  ready?: boolean;
  blockingIssue?: unknown;
  connectedClientCount?: unknown;
  connectedClients?: readonly unknown[];
  extensionReadiness?: {
    reload?: {
      attempted?: boolean;
      attempts?: unknown;
      worked?: boolean;
    } | null;
  } | null;
  selfHeal?: {
    attempted?: boolean;
    reloadAttempts?: unknown;
  } | null;
  nativeBroker?: {
    available?: boolean;
    response?: {
      result?: {
        tabs?: readonly {
          state?: unknown;
          tab?: {
            active?: unknown;
          } | null;
        }[];
      } | null;
    } | null;
  } | null;
}>;

type BrowserFlags = Readonly<{
  allowReload?: boolean;
}>;

const RELOADABLE_MISMATCH_ISSUES = new Set([
  'extension_version_mismatch',
  'extension_protocol_mismatch',
  'extension_build_mismatch',
  'runtime_epoch_not_ready',
]);

const RELOADABLE_COMMAND_CHANNEL_ISSUES = new Set([
  'command_channel_not_ready',
  'command_channel_stuck',
  'command_timeout_recent',
]);

const toCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const connectedClientCountFromReady = (ready: ReadySnapshot): number => {
  const count = toCount(ready.connectedClientCount);
  if (count > 0) return count;
  return Array.isArray(ready.connectedClients) ? ready.connectedClients.length : 0;
};

const blockingIssueCode = (issue: unknown): string => {
  if (!issue) return '';
  if (typeof issue === 'string') return issue;
  if (typeof issue !== 'object') return String(issue);
  const record = issue as Record<string, unknown>;
  return String(record.code || record.reason || record.type || record.message || '');
};

const nativeBrokerDebuggableTabs = (ready: ReadySnapshot) => {
  const tabs = ready.nativeBroker?.response?.result?.tabs;
  if (!Array.isArray(tabs)) return null;
  return tabs.filter((item) => item?.state === 'debuggable');
};

const nativeBrokerCanReloadExistingTab = (ready: ReadySnapshot): boolean => {
  if (ready.nativeBroker?.available !== true) return false;
  const tabs = nativeBrokerDebuggableTabs(ready);
  if (!Array.isArray(tabs)) return true;
  return tabs.length > 0;
};

export const shouldReloadAllExistingTabsForReady = (
  ready: ReadySnapshot = {},
  flags: BrowserFlags = {},
): boolean => {
  if (flags.allowReload !== true || ready.ready === true) return false;
  if (blockingIssueCode(ready.blockingIssue) !== 'no_connected_clients') return false;
  if (ready.nativeBroker?.available !== true) return false;
  const tabs = nativeBrokerDebuggableTabs(ready);
  if (!Array.isArray(tabs) || tabs.length === 0) return false;
  return !tabs.some((item) => item.tab?.active === true);
};

export const shouldReloadExistingTabsForReady = (
  ready: ReadySnapshot = {},
  flags: BrowserFlags = {},
): boolean => {
  if (flags.allowReload !== true || ready.ready === true) return false;

  const issue = blockingIssueCode(ready.blockingIssue);
  if (connectedClientCountFromReady(ready) > 0 && RELOADABLE_MISMATCH_ISSUES.has(issue)) {
    return true;
  }

  if (
    connectedClientCountFromReady(ready) > 0 &&
    RELOADABLE_COMMAND_CHANNEL_ISSUES.has(issue) &&
    nativeBrokerCanReloadExistingTab(ready)
  ) {
    return true;
  }

  return issue === 'no_connected_clients' && nativeBrokerCanReloadExistingTab(ready);
};
