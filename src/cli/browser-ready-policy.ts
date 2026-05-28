type ReadySnapshot = Readonly<{
  ready?: boolean;
  blockingIssue?: unknown;
  connectedClientCount?: unknown;
  connectedClients?: readonly unknown[];
  clients?: readonly unknown[];
  diagnosticClients?: readonly unknown[];
  selectableTabCount?: unknown;
  extensionReadiness?: {
    connectedClients?: readonly unknown[];
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

const pageKind = (client: unknown): string => {
  if (!client || typeof client !== 'object') return '';
  const record = client as Record<string, any>;
  return String(record.page?.kind || record.pageKind || '')
    .trim()
    .toLowerCase();
};

const pageUrl = (client: unknown): string => {
  if (!client || typeof client !== 'object') return '';
  const record = client as Record<string, any>;
  return String(record.page?.url || record.url || '').trim();
};

const clientLooksLikeGeminiApp = (client: unknown): boolean => {
  const kind = pageKind(client);
  if (kind === 'chat' || kind === 'gemini' || kind === 'notebook') return true;
  if (kind === 'activity') return false;

  const url = pageUrl(client);
  if (!url) return false;
  try {
    return new URL(url).origin === 'https://gemini.google.com';
  } catch {
    return false;
  }
};

const knownClientsFromReady = (ready: ReadySnapshot): readonly unknown[] => {
  if (Array.isArray(ready.diagnosticClients) && ready.diagnosticClients.length > 0) {
    return ready.diagnosticClients;
  }
  if (Array.isArray(ready.extensionReadiness?.connectedClients)) {
    return ready.extensionReadiness.connectedClients;
  }
  if (Array.isArray(ready.connectedClients)) return ready.connectedClients;
  if (Array.isArray(ready.clients)) return ready.clients;
  return [];
};

const readyHasKnownOnlyNonGeminiClients = (ready: ReadySnapshot): boolean => {
  const clients = knownClientsFromReady(ready);
  return clients.length > 0 && !clients.some(clientLooksLikeGeminiApp);
};

export const shouldWakeBrowserForReady = (ready: ReadySnapshot = {}): boolean => {
  if (ready.ready === true) return false;
  const connected = connectedClientCountFromReady(ready);
  const selectable = toCount(ready.selectableTabCount);
  const issue = blockingIssueCode(ready.blockingIssue);
  if (issue === 'no_connected_clients') return true;
  if (issue === 'no_selectable_gemini_tab') {
    if (readyHasKnownOnlyNonGeminiClients(ready)) return true;
    return connected <= 0 && selectable <= 0;
  }
  return connected <= 0 && selectable <= 0;
};

export const shouldWaitForExistingTabsForReady = (ready: ReadySnapshot = {}): boolean => {
  if (ready.ready === true) return false;
  if (readyHasKnownOnlyNonGeminiClients(ready)) return false;
  const connected = connectedClientCountFromReady(ready);
  if (connected <= 0) return false;
  const issue = blockingIssueCode(ready.blockingIssue);
  if (issue === 'no_selectable_gemini_tab' || issue === 'no_active_claimable_gemini_tab') {
    return true;
  }
  return RELOADABLE_MISMATCH_ISSUES.has(issue) || RELOADABLE_COMMAND_CHANNEL_ISSUES.has(issue);
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
