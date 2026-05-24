export type DurableTabClientState = {
  readonly clientId: string;
  readonly tabId?: number | string | null;
  readonly claimId?: string | null;
  readonly sessionId?: string | null;
  readonly conversationCount?: number | null;
  readonly hasPendingCommand?: boolean;
  readonly lastSeenAt?: number | null;
};

export type ReconnectSourceSelection = {
  readonly abortClientIds: string[];
  readonly cacheSourceClientId: string | null;
};

export type HeartbeatJobProgressDecision = {
  readonly hasJobProgress?: boolean;
  readonly status?: string | null;
  readonly eventStreamUsable?: boolean;
  readonly terminalAgeMs?: number | null;
  readonly terminalTtlMs?: number | null;
};

export type BrowserClientRuntimeEvidence = {
  readonly clientId?: string | null;
  readonly tabId?: number | string | null;
  readonly lastSeenAt?: number | null;
  readonly lastHeartbeatAt?: number | null;
  readonly lastSnapshotAt?: number | null;
  readonly extensionVersion?: string | null;
  readonly protocolVersion?: number | string | null;
  readonly buildStamp?: string | null;
  readonly page?: {
    readonly url?: string | null;
    readonly pathname?: string | null;
    readonly path?: string | null;
    readonly chatId?: string | null;
    readonly notebookId?: string | null;
    readonly buildStamp?: string | null;
  } | null;
};

export type BrowserClientRuntimeEvidenceOptions = {
  readonly now?: number;
  readonly staleAfterMs: number;
  readonly warmupGraceMs?: number;
  readonly eventStreamConnected?: boolean;
  readonly longPollConnected?: boolean;
  readonly expectedExtensionVersion?: string | null;
  readonly expectedProtocolVersion?: number | string | null;
  readonly expectedBuildStamp?: string | null;
};

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

const normalizeId = (value: number | string | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

const normalizeNumber = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const freshTimestamp = (
  value: number | string | null | undefined,
  now: number,
  maxAgeMs: number,
) => {
  const timestamp = normalizeNumber(value);
  return timestamp !== null && now - timestamp >= 0 && now - timestamp <= maxAgeMs;
};

const expectedRuntimeMatches = (
  client: BrowserClientRuntimeEvidence,
  options: BrowserClientRuntimeEvidenceOptions,
) => {
  if (
    options.expectedExtensionVersion &&
    String(client.extensionVersion || '') !== String(options.expectedExtensionVersion)
  ) {
    return false;
  }
  if (
    options.expectedProtocolVersion !== null &&
    options.expectedProtocolVersion !== undefined &&
    Number(client.protocolVersion) !== Number(options.expectedProtocolVersion)
  ) {
    return false;
  }
  const expectedBuildStamp = options.expectedBuildStamp;
  const clientBuildStamp = client.buildStamp || client.page?.buildStamp || null;
  if (expectedBuildStamp && String(clientBuildStamp || '') !== String(expectedBuildStamp)) {
    return false;
  }
  return true;
};

const clientHasPageEvidence = (client: BrowserClientRuntimeEvidence) =>
  Boolean(
    normalizeId(client.page?.url) ||
      normalizeId(client.page?.pathname) ||
      normalizeId(client.page?.path) ||
      normalizeId(client.page?.chatId) ||
      normalizeId(client.page?.notebookId),
  );

export const clientHasLiveRuntimeEvidence = (
  client: BrowserClientRuntimeEvidence,
  options: BrowserClientRuntimeEvidenceOptions,
): boolean => {
  const now = Number(options.now ?? Date.now());
  if (
    freshTimestamp(client.lastHeartbeatAt, now, options.staleAfterMs) ||
    freshTimestamp(client.lastSnapshotAt, now, options.staleAfterMs)
  ) {
    return true;
  }

  const warmupGraceMs = Number(options.warmupGraceMs ?? 4000);
  if (!freshTimestamp(client.lastSeenAt, now, warmupGraceMs)) return false;
  if (!expectedRuntimeMatches(client, options)) return false;
  if (options.eventStreamConnected !== true && options.longPollConnected !== true) return false;
  return normalizeId(client.tabId) !== null || clientHasPageEvidence(client);
};

const sameConcreteTab = (left: DurableTabClientState, right: DurableTabClientState) => {
  const leftTabId = normalizeId(left.tabId);
  const rightTabId = normalizeId(right.tabId);
  return leftTabId !== null && leftTabId === rightTabId;
};

const sameClaim = (left: DurableTabClientState, right: DurableTabClientState) => {
  const leftClaimId = normalizeId(left.claimId);
  const rightClaimId = normalizeId(right.claimId);
  if (leftClaimId !== null && leftClaimId === rightClaimId) return true;
  if (leftClaimId !== null && rightClaimId !== null) return false;

  const leftSessionId = normalizeId(left.sessionId);
  const rightSessionId = normalizeId(right.sessionId);
  return (
    leftSessionId !== null &&
    leftSessionId === rightSessionId &&
    (sameConcreteTab(left, right) || leftClaimId !== null || rightClaimId !== null)
  );
};

const sameDurableTab = (left: DurableTabClientState, right: DurableTabClientState) =>
  sameConcreteTab(left, right) || sameClaim(left, right);

const cacheScore = (client: DurableTabClientState) =>
  Number(client.conversationCount || 0) * 1_000_000_000 + Number(client.lastSeenAt || 0);

export const selectReconnectSourcesForTab = ({
  nextClient,
  candidates = [],
}: {
  readonly nextClient: DurableTabClientState;
  readonly candidates?: readonly DurableTabClientState[];
}): ReconnectSourceSelection => {
  const matches = candidates.filter(
    (candidate) =>
      candidate.clientId !== nextClient.clientId && sameDurableTab(candidate, nextClient),
  );
  const cacheSource = [...matches].sort((a, b) => cacheScore(b) - cacheScore(a))[0] || null;
  return {
    abortClientIds: matches.map((candidate) => candidate.clientId),
    cacheSourceClientId: cacheSource?.clientId || null,
  };
};

export const shouldIncludeHeartbeatJobProgress = ({
  hasJobProgress = false,
  status = null,
  terminalAgeMs = null,
  terminalTtlMs = null,
}: HeartbeatJobProgressDecision): boolean => {
  if (!hasJobProgress) return false;
  if (!status || !TERMINAL_STATUSES.has(status)) return true;
  if (terminalAgeMs === null || terminalTtlMs === null) return true;
  return terminalAgeMs <= terminalTtlMs;
};
