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

const nativeBrokerCanReloadExistingTab = (ready: ReadySnapshot): boolean => {
  if (ready.nativeBroker?.available !== true) return false;
  const tabs = ready.nativeBroker.response?.result?.tabs;
  if (!Array.isArray(tabs)) return true;
  return tabs.some((item) => item?.state === 'debuggable' && item.tab?.active === true);
};

export const shouldReloadExistingTabsForReady = (
  ready: ReadySnapshot = {},
  flags: BrowserFlags = {},
): boolean => {
  if (flags.allowReload !== true || ready.ready === true) return false;

  const issue = String(ready.blockingIssue || '');
  if (connectedClientCountFromReady(ready) > 0 && RELOADABLE_MISMATCH_ISSUES.has(issue)) {
    return true;
  }

  return issue === 'no_connected_clients' && nativeBrokerCanReloadExistingTab(ready);
};
