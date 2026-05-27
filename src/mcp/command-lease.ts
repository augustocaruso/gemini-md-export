const COMMAND_CLIENT_LEASE: unique symbol = Symbol('CommandClientLease');

export type CommandClientSelector = {
  readonly clientId?: string | null;
  readonly tabId?: number | string | null;
  readonly claimId?: string | null;
  readonly sessionId?: string | null;
};

export type CommandClientState = {
  readonly clientId: string;
  readonly tabId?: number | string | null;
  readonly claimId?: string | null;
  readonly sessionId?: string | null;
  readonly live?: boolean;
  readonly commandReady?: boolean;
  readonly recentCommandFailure?: boolean;
  readonly lastSeenAt?: number | null;
};

export type CommandClientPool = {
  readonly current?: CommandClientState | null;
  readonly replacement?: CommandClientState | null;
  readonly claim?: CommandClientState | null;
  readonly sameTab?: readonly CommandClientState[];
  readonly sessionClaim?: CommandClientState | null;
  readonly fallback?: CommandClientState | null;
};

export type CommandClientLeaseReason =
  | 'current'
  | 'replacement'
  | 'claim'
  | 'same-tab'
  | 'session-claim'
  | 'fallback';

export type CommandClientLease = Readonly<{
  readonly [COMMAND_CLIENT_LEASE]: true;
  readonly clientId: string;
  readonly tabId: number | string | null;
  readonly claimId: string | null;
  readonly sessionId: string | null;
  readonly reason: CommandClientLeaseReason;
  readonly issuedAt: number;
}>;

export type RecoverableCommandErrorInfo = {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly commandDispatched?: boolean | null;
  readonly replacementClientId?: string | null;
};

export type BrowserCommandRequest = {
  readonly type: string;
  readonly args?: unknown;
  readonly options?: unknown;
};

export type BrowserCommandDispatcher<T> = (
  lease: CommandClientLease,
  request: BrowserCommandRequest,
) => Promise<T>;

export type BrowserCommandRecoveryInput<T> = {
  readonly initialClient?: CommandClientState | null;
  readonly selector?: CommandClientSelector;
  readonly request: BrowserCommandRequest;
  readonly getPool: (input: {
    readonly activeLease?: CommandClientLease | null;
    readonly error?: RecoverableCommandErrorInfo | null;
  }) => CommandClientPool | Promise<CommandClientPool>;
  readonly dispatch: BrowserCommandDispatcher<T>;
  readonly isRecoverableError: (error: unknown) => boolean;
  readonly describeError: (error: unknown) => RecoverableCommandErrorInfo;
  readonly waitMs?: number;
  readonly pollMs?: number;
};

export type BrowserCommandRecoveryResult<T> = {
  readonly lease: CommandClientLease;
  readonly result: T;
  readonly recovered: boolean;
};

const isLive = (client?: CommandClientState | null): client is CommandClientState =>
  !!client?.clientId && client.live !== false;

const sameClient = (left?: CommandClientState | null, right?: CommandClientState | null) =>
  !!left?.clientId && left.clientId === right?.clientId;

const normalizeTabId = (value: number | string | null | undefined): number | string | null => {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
};

const tabIdsMatch = (
  left: number | string | null | undefined,
  right: number | string | null | undefined,
) => {
  const normalizedLeft = normalizeTabId(left);
  const normalizedRight = normalizeTabId(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
};

const issueCommandClientLease = (
  client: CommandClientState,
  reason: CommandClientLeaseReason,
): CommandClientLease =>
  ({
    [COMMAND_CLIENT_LEASE]: true,
    clientId: client.clientId,
    tabId: normalizeTabId(client.tabId),
    claimId: client.claimId || null,
    sessionId: client.sessionId || null,
    reason,
    issuedAt: Date.now(),
  }) satisfies CommandClientLease;

const commandClientUnavailableError = () => {
  const error = new Error('Nenhum cliente de comando do Gemini está disponível.') as Error & {
    code?: string;
    recoverable?: boolean;
  };
  error.code = 'no_command_client_available';
  error.recoverable = true;
  return error;
};

const commandClientPreferenceScore = (client: CommandClientState) =>
  Number(client.commandReady === true) * 100 +
  Number(client.recentCommandFailure !== true) * 50 +
  Number(client.lastSeenAt || 0) / 1_000_000_000_000;

const preferredClient = (clients: readonly CommandClientState[] = []): CommandClientState | null =>
  clients
    .filter(isLive)
    .sort((a, b) => commandClientPreferenceScore(b) - commandClientPreferenceScore(a))[0] || null;

const shouldPreferReplacementOverCurrent = (
  current: CommandClientState | null | undefined,
  candidate: CommandClientState | null | undefined,
) => {
  if (!isLive(candidate) || sameClient(current, candidate)) return false;
  if (!isLive(current)) return true;
  if (current.recentCommandFailure === true) return true;
  if (current.commandReady !== true && candidate.commandReady === true) return true;
  return Number(candidate.lastSeenAt || 0) > Number(current.lastSeenAt || 0);
};

const selectorPinsDifferentClient = (
  selector: CommandClientSelector | undefined,
  client: CommandClientState | null | undefined,
) => !!selector?.clientId && !!client?.clientId && selector.clientId !== client.clientId;

const selectorAllowsClient = (
  selector: CommandClientSelector | undefined,
  client: CommandClientState | null | undefined,
): client is CommandClientState => {
  if (!isLive(client)) return false;
  if (selector?.clientId && selector.clientId !== client.clientId) return false;
  if (selector?.claimId && client.claimId && selector.claimId !== client.claimId) return false;
  if (
    selector?.tabId !== undefined &&
    selector.tabId !== null &&
    !tabIdsMatch(selector.tabId, client.tabId)
  ) {
    return false;
  }
  return true;
};

export const selectCommandClientLease = ({
  selector = {},
  pool = {},
}: {
  readonly selector?: CommandClientSelector;
  readonly pool?: CommandClientPool;
}): CommandClientLease | null => {
  const current = isLive(pool.current) ? pool.current : null;
  const explicitCurrent = !!selector.clientId && current?.clientId === selector.clientId;

  if (selectorAllowsClient(selector, pool.replacement)) {
    return issueCommandClientLease(pool.replacement, 'replacement');
  }

  if (!explicitCurrent && selectorAllowsClient(selector, pool.claim)) {
    if (shouldPreferReplacementOverCurrent(current, pool.claim)) {
      return issueCommandClientLease(pool.claim, 'claim');
    }
  }

  const sameTab = preferredClient(
    (pool.sameTab || []).filter((client) => !selectorPinsDifferentClient(selector, client)),
  );
  if (!explicitCurrent && sameTab && shouldPreferReplacementOverCurrent(current, sameTab)) {
    return issueCommandClientLease(sameTab, 'same-tab');
  }

  if (!explicitCurrent && selectorAllowsClient(selector, pool.sessionClaim)) {
    if (shouldPreferReplacementOverCurrent(current, pool.sessionClaim)) {
      return issueCommandClientLease(pool.sessionClaim, 'session-claim');
    }
  }

  if (selectorAllowsClient(selector, current)) {
    return issueCommandClientLease(current, 'current');
  }

  if (selectorAllowsClient(selector, pool.claim)) {
    return issueCommandClientLease(pool.claim, 'claim');
  }

  if (selectorAllowsClient(selector, sameTab)) {
    return issueCommandClientLease(sameTab, 'same-tab');
  }

  if (selectorAllowsClient(selector, pool.sessionClaim)) {
    return issueCommandClientLease(pool.sessionClaim, 'session-claim');
  }

  if (selectorAllowsClient(selector, pool.fallback)) {
    return issueCommandClientLease(pool.fallback, 'fallback');
  }

  return null;
};

export const selectRecoveryCommandClientLease = ({
  selector = {},
  pool = {},
  error = {},
}: {
  readonly selector?: CommandClientSelector;
  readonly pool?: CommandClientPool;
  readonly error?: RecoverableCommandErrorInfo;
}): CommandClientLease | null => {
  if (error.replacementClientId && pool.replacement?.clientId === error.replacementClientId) {
    return isLive(pool.replacement)
      ? issueCommandClientLease(pool.replacement, 'replacement')
      : null;
  }
  return selectCommandClientLease({ selector, pool });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForRecoveryCommandClientLease = async ({
  selector = {},
  error = {},
  getPool,
  waitMs = 10_000,
  pollMs = 500,
}: {
  readonly selector?: CommandClientSelector;
  readonly error?: RecoverableCommandErrorInfo;
  readonly getPool: () => CommandClientPool | Promise<CommandClientPool>;
  readonly waitMs?: number;
  readonly pollMs?: number;
}): Promise<CommandClientLease | null> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= waitMs) {
    const lease = selectRecoveryCommandClientLease({
      selector,
      error,
      pool: await getPool(),
    });
    if (lease) return lease;
    await sleep(pollMs);
  }
  return null;
};

export const runBrowserCommandWithClientRecovery = async <T>({
  initialClient = null,
  selector = {},
  request,
  getPool,
  dispatch,
  isRecoverableError,
  describeError,
  waitMs,
  pollMs,
}: BrowserCommandRecoveryInput<T>): Promise<BrowserCommandRecoveryResult<T>> => {
  const initialLease = selectCommandClientLease({
    selector,
    pool: await getPool({ activeLease: null, error: null }),
  });
  const lease =
    initialLease ||
    (isLive(initialClient) ? issueCommandClientLease(initialClient, 'fallback') : null);
  if (!lease) {
    throw commandClientUnavailableError();
  }

  try {
    const result = await dispatch(lease, request);
    return {
      lease,
      result,
      recovered: lease.clientId !== initialClient?.clientId,
    };
  } catch (error) {
    if (!isRecoverableError(error)) throw error;
    const errorInfo = describeError(error);
    const recoveredLease = await waitForRecoveryCommandClientLease({
      selector,
      error: errorInfo,
      waitMs,
      pollMs,
      getPool: () => getPool({ activeLease: lease, error: errorInfo }),
    });
    if (!recoveredLease) throw error;
    const result = await dispatch(recoveredLease, request);
    return {
      lease: recoveredLease,
      result,
      recovered: true,
    };
  }
};

export const enqueueBrowserCommandWithLease = async <T>(
  lease: CommandClientLease,
  request: BrowserCommandRequest,
  dispatch: BrowserCommandDispatcher<T>,
): Promise<BrowserCommandRecoveryResult<T>> => ({
  lease,
  result: await dispatch(lease, request),
  recovered: false,
});
