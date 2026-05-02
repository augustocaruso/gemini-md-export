import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();

const normalizeTabId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeClient = (client = {}) => ({
  clientId: client.clientId || null,
  tabId: normalizeTabId(client.tabId),
  windowId: normalizeTabId(client.windowId),
});

const tabSessionKeyForClient = (client = {}) => {
  const normalized = normalizeClient(client);
  if (normalized.tabId !== null) return `tab:${normalized.tabId}`;
  if (normalized.clientId) return `client:${normalized.clientId}`;
  return 'unknown';
};

export const summarizeTabSession = (session) => {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    epoch: session.epoch,
    state: session.state,
    purpose: session.purpose,
    jobId: session.jobId || null,
    clientId: session.clientId || null,
    tabId: session.tabId ?? null,
    windowId: session.windowId ?? null,
    claimId: session.claimId || null,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt || null,
    finishedAt: session.finishedAt || null,
    finishReason: session.finishReason || null,
    supersededBy: session.supersededBy || null,
    activeOperation: session.activeOperation || null,
    cleanup: session.cleanup || [],
  };
};

export const createTabSessionManager = ({
  idFactory = randomUUID,
  clock = nowIso,
} = {}) => {
  const sessions = new Map();
  const epochs = new Map();

  const createSession = ({ client = {}, claim = null, purpose = 'operation', jobId = null } = {}) => {
    const normalized = normalizeClient(client);
    const key = tabSessionKeyForClient(normalized);
    const epoch = (epochs.get(key) || 0) + 1;
    epochs.set(key, epoch);

    for (const session of sessions.values()) {
      if (session.key !== key || session.state !== 'active') continue;
      session.state = 'superseded';
      session.finishedAt = clock();
      session.finishReason = 'newer-session-created';
    }

    const session = {
      sessionId: `tab-session-${idFactory()}`,
      key,
      epoch,
      state: 'active',
      purpose,
      jobId,
      clientId: normalized.clientId,
      tabId: normalized.tabId,
      windowId: normalized.windowId,
      claimId: claim?.claimId || null,
      createdAt: clock(),
      lastSeenAt: clock(),
      finishedAt: null,
      finishReason: null,
      supersededBy: null,
      activeOperation: null,
      cleanup: [],
    };

    for (const previous of sessions.values()) {
      if (
        previous.key === key &&
        previous.sessionId !== session.sessionId &&
        previous.state === 'superseded' &&
        !previous.supersededBy
      ) {
        previous.supersededBy = session.sessionId;
      }
    }

    sessions.set(session.sessionId, session);
    return session;
  };

  const getSession = (sessionId) => sessions.get(sessionId) || null;

  const assertCurrent = (sessionOrId, client = {}) => {
    const session =
      typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId || null;
    if (!session) {
      return { ok: false, code: 'tab_session_not_found', retryable: false };
    }
    if (session.state !== 'active') {
      return {
        ok: false,
        code: `tab_session_${session.state}`,
        retryable: session.state === 'superseded',
        session: summarizeTabSession(session),
      };
    }
    const key = tabSessionKeyForClient(client);
    const currentEpoch = epochs.get(session.key) || 0;
    if (key !== session.key || currentEpoch !== session.epoch) {
      return {
        ok: false,
        code: 'tab_session_epoch_stale',
        retryable: true,
        expectedKey: session.key,
        actualKey: key,
        expectedEpoch: session.epoch,
        currentEpoch,
      };
    }
    session.lastSeenAt = clock();
    return { ok: true, session: summarizeTabSession(session) };
  };

  const startOperation = (sessionOrId, operation) => {
    const session =
      typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId || null;
    if (!session) return null;
    session.activeOperation = {
      name: operation || 'operation',
      startedAt: clock(),
    };
    session.lastSeenAt = clock();
    return summarizeTabSession(session);
  };

  const finishOperation = (sessionOrId, patch = {}) => {
    const session =
      typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId || null;
    if (!session?.activeOperation) return session ? summarizeTabSession(session) : null;
    session.activeOperation = {
      ...session.activeOperation,
      ...patch,
      finishedAt: clock(),
    };
    session.cleanup.push({
      step: `operation:${session.activeOperation.name}`,
      ok: patch.ok !== false,
      at: clock(),
      ...(patch.error ? { error: patch.error } : {}),
    });
    session.activeOperation = null;
    session.lastSeenAt = clock();
    return summarizeTabSession(session);
  };

  const recordCleanup = (sessionOrId, step, result = {}) => {
    const session =
      typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId || null;
    if (!session) return null;
    session.cleanup.push({
      step,
      ok: result.ok !== false,
      at: clock(),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.code ? { code: result.code } : {}),
    });
    session.lastSeenAt = clock();
    return summarizeTabSession(session);
  };

  const finishSession = (sessionOrId, { state = 'released', reason = null } = {}) => {
    const session =
      typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId || null;
    if (!session) return null;
    if (session.state === 'active') session.state = state;
    session.finishedAt = clock();
    session.finishReason = reason || session.finishReason || state;
    session.activeOperation = null;
    return summarizeTabSession(session);
  };

  const summarizeSessions = () => [...sessions.values()].map(summarizeTabSession);

  return {
    createSession,
    getSession,
    assertCurrent,
    startOperation,
    finishOperation,
    recordCleanup,
    finishSession,
    summarizeSessions,
  };
};

