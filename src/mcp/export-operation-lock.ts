export type ActiveTabOperationState = {
  operationId: string;
  jobId?: string | null;
  targetChatId?: string | null;
  phase: string;
  startedAt: number;
  lastProgressAt: number;
  cancelRequestedAt?: number | null;
  abortReason?: string | null;
};

const isFiniteNonNegativeMs = (value: number): boolean => Number.isFinite(value) && value >= 0;

const finiteNonNegativeMs = (value: number, fallback = 0): number => {
  if (isFiniteNonNegativeMs(value)) return value;
  if (isFiniteNonNegativeMs(fallback)) return fallback;
  return 0;
};

const hasOperationIdFilter = (operationId: string | null | undefined): operationId is string =>
  operationId !== null && operationId !== undefined;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordAt = (value: unknown, key: string): UnknownRecord | null => {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? (value[key] as UnknownRecord) : null;
};

const timestampMsFromUnknown = (value: unknown): number | null => {
  if (typeof value === 'number') return isFiniteNonNegativeMs(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return isFiniteNonNegativeMs(parsed) ? parsed : null;
};

const activeBrowserOperationCandidates = (client: unknown): UnknownRecord[] => {
  if (!isRecord(client)) return [];
  const metrics = recordAt(client, 'metrics');
  const summary = recordAt(client, 'summary');
  const summaryMetrics = recordAt(summary, 'metrics');
  const page = recordAt(client, 'page');
  return [
    recordAt(recordAt(metrics, 'tabOperation'), 'active'),
    recordAt(recordAt(summaryMetrics, 'tabOperation'), 'active'),
    recordAt(client, 'activeTabOperation'),
    recordAt(summary, 'activeTabOperation'),
    recordAt(page, 'activeTabOperation'),
  ].filter((candidate): candidate is UnknownRecord => Boolean(candidate));
};

export const matchingActiveBrowserOperationProgressAt = (
  client: unknown,
  operationId: string | null | undefined,
): number | null => {
  if (typeof operationId !== 'string' || operationId.length <= 0) return null;
  let latestProgressAt: number | null = null;
  for (const active of activeBrowserOperationCandidates(client)) {
    if (active.operationId !== operationId) continue;
    const progressAt = timestampMsFromUnknown(active.lastProgressAt);
    if (progressAt === null) continue;
    latestProgressAt =
      latestProgressAt === null ? progressAt : Math.max(latestProgressAt, progressAt);
  }
  return latestProgressAt;
};

const sanitizeActiveTabOperationState = (
  active: ActiveTabOperationState,
): ActiveTabOperationState => {
  const startedAt = finiteNonNegativeMs(active.startedAt);
  const lastProgressAt = finiteNonNegativeMs(active.lastProgressAt, startedAt);
  const cancelRequestedAt =
    active.cancelRequestedAt === undefined || active.cancelRequestedAt === null
      ? active.cancelRequestedAt
      : finiteNonNegativeMs(active.cancelRequestedAt, lastProgressAt);
  return {
    ...active,
    startedAt,
    lastProgressAt,
    ...(active.cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
  };
};

export const startActiveTabOperation = ({
  operationId,
  jobId = null,
  targetChatId = null,
  phase,
  now = Date.now(),
}: {
  operationId: string;
  jobId?: string | null;
  targetChatId?: string | null;
  phase: string;
  now?: number;
}): ActiveTabOperationState => {
  const startedAt = finiteNonNegativeMs(now);
  return {
    operationId,
    jobId,
    targetChatId,
    phase,
    startedAt,
    lastProgressAt: startedAt,
  };
};

export const updateActiveTabOperationProgress = (
  active: ActiveTabOperationState,
  { phase = active.phase, now = Date.now() }: { phase?: string; now?: number } = {},
): ActiveTabOperationState => {
  const safeActive = sanitizeActiveTabOperationState(active);
  const lastProgressAt = Math.max(
    safeActive.startedAt,
    safeActive.lastProgressAt,
    finiteNonNegativeMs(now, safeActive.lastProgressAt),
  );
  return {
    ...safeActive,
    phase,
    lastProgressAt,
  };
};

export const requestActiveTabOperationCancel = (
  active: ActiveTabOperationState | null,
  {
    operationId = null,
    reason = 'bridge-command',
    now = Date.now(),
  }: { operationId?: string | null; reason?: string; now?: number } = {},
) => {
  if (!active) return { active: null, cancelled: false, reason: 'no-active-operation' };
  const safeActive = sanitizeActiveTabOperationState(active);
  if (hasOperationIdFilter(operationId) && safeActive.operationId !== operationId) {
    return { active: safeActive, cancelled: false, reason: 'operation-id-mismatch' };
  }
  return {
    active: {
      ...safeActive,
      cancelRequestedAt: finiteNonNegativeMs(now, safeActive.lastProgressAt),
      abortReason: reason,
    },
    cancelled: true,
    reason,
  };
};

export const finishActiveTabOperation = (
  active: ActiveTabOperationState | null,
  { operationId = null }: { operationId?: string | null } = {},
): ActiveTabOperationState | null => {
  if (!active) return null;
  if (hasOperationIdFilter(operationId) && active.operationId !== operationId) return active;
  return null;
};

export const reapStaleActiveTabOperation = (
  active: ActiveTabOperationState | null,
  { now = Date.now(), staleAfterMs }: { now?: number; staleAfterMs: number },
) => {
  if (!active) return { active: null, reaped: false, receipt: null };
  const safeActive = sanitizeActiveTabOperationState(active);
  const safeStaleAfterMs = finiteNonNegativeMs(staleAfterMs);
  if (safeStaleAfterMs <= 0) return { active: safeActive, reaped: false, receipt: null };

  const lastActivityAt = Math.max(safeActive.lastProgressAt, safeActive.startedAt);
  const safeNow = finiteNonNegativeMs(now, lastActivityAt);
  const elapsedMs = Math.max(0, safeNow - lastActivityAt);
  if (elapsedMs <= safeStaleAfterMs) return { active: safeActive, reaped: false, receipt: null };
  return {
    active: null,
    reaped: true,
    receipt: {
      code: 'operation_lock_reaped',
      operationId: safeActive.operationId,
      jobId: safeActive.jobId || null,
      targetChatId: safeActive.targetChatId || null,
      elapsedMs,
      staleAfterMs: safeStaleAfterMs,
    },
  };
};
