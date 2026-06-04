const isFiniteNonNegativeMs = (value) => Number.isFinite(value) && value >= 0;
const finiteNonNegativeMs = (value, fallback = 0) => {
    if (isFiniteNonNegativeMs(value))
        return value;
    if (isFiniteNonNegativeMs(fallback))
        return fallback;
    return 0;
};
const hasOperationIdFilter = (operationId) => operationId !== null && operationId !== undefined;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const recordAt = (value, key) => {
    if (!isRecord(value))
        return null;
    return isRecord(value[key]) ? value[key] : null;
};
const timestampMsFromUnknown = (value) => {
    if (typeof value === 'number')
        return isFiniteNonNegativeMs(value) ? value : null;
    if (typeof value !== 'string')
        return null;
    const parsed = Date.parse(value);
    return isFiniteNonNegativeMs(parsed) ? parsed : null;
};
const activeBrowserOperationCandidates = (client) => {
    if (!isRecord(client))
        return [];
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
    ].filter((candidate) => Boolean(candidate));
};
export const matchingActiveBrowserOperationProgressAt = (client, operationId) => {
    if (typeof operationId !== 'string' || operationId.length <= 0)
        return null;
    let latestProgressAt = null;
    for (const active of activeBrowserOperationCandidates(client)) {
        if (active.operationId !== operationId)
            continue;
        const progressAt = timestampMsFromUnknown(active.lastProgressAt);
        if (progressAt === null)
            continue;
        latestProgressAt =
            latestProgressAt === null ? progressAt : Math.max(latestProgressAt, progressAt);
    }
    return latestProgressAt;
};
const sanitizeActiveTabOperationState = (active) => {
    const startedAt = finiteNonNegativeMs(active.startedAt);
    const lastProgressAt = finiteNonNegativeMs(active.lastProgressAt, startedAt);
    const cancelRequestedAt = active.cancelRequestedAt === undefined || active.cancelRequestedAt === null
        ? active.cancelRequestedAt
        : finiteNonNegativeMs(active.cancelRequestedAt, lastProgressAt);
    return {
        ...active,
        startedAt,
        lastProgressAt,
        ...(active.cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
    };
};
export const startActiveTabOperation = ({ operationId, jobId = null, targetChatId = null, phase, now = Date.now(), }) => {
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
export const updateActiveTabOperationProgress = (active, { phase = active.phase, now = Date.now() } = {}) => {
    const safeActive = sanitizeActiveTabOperationState(active);
    const lastProgressAt = Math.max(safeActive.startedAt, safeActive.lastProgressAt, finiteNonNegativeMs(now, safeActive.lastProgressAt));
    return {
        ...safeActive,
        phase,
        lastProgressAt,
    };
};
export const requestActiveTabOperationCancel = (active, { operationId = null, reason = 'bridge-command', now = Date.now(), } = {}) => {
    if (!active)
        return { active: null, cancelled: false, reason: 'no-active-operation' };
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
export const finishActiveTabOperation = (active, { operationId = null } = {}) => {
    if (!active)
        return null;
    if (hasOperationIdFilter(operationId) && active.operationId !== operationId)
        return active;
    return null;
};
export const reapStaleActiveTabOperation = (active, { now = Date.now(), staleAfterMs }) => {
    if (!active)
        return { active: null, reaped: false, receipt: null };
    const safeActive = sanitizeActiveTabOperationState(active);
    const safeStaleAfterMs = finiteNonNegativeMs(staleAfterMs);
    if (safeStaleAfterMs <= 0)
        return { active: safeActive, reaped: false, receipt: null };
    const lastActivityAt = Math.max(safeActive.lastProgressAt, safeActive.startedAt);
    const safeNow = finiteNonNegativeMs(now, lastActivityAt);
    const elapsedMs = Math.max(0, safeNow - lastActivityAt);
    if (elapsedMs <= safeStaleAfterMs)
        return { active: safeActive, reaped: false, receipt: null };
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
