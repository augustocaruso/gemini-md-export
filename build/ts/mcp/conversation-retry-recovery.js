const RECOVERY_BEFORE_RETRY_REASONS = new Set(['no_command_client_available']);
export const DEFAULT_TAB_BUSY_RETRY_LIMIT = 12;
export const DEFAULT_TAB_BUSY_RETRY_BASE_MS = 1500;
export const DEFAULT_TAB_BUSY_RETRY_MAX_DELAY_MS = 10_000;
const nullableString = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};
const positiveAttempt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const positiveInteger = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1)
        return fallback;
    return parsed;
};
const positiveDelayMs = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1)
        return fallback;
    return Math.floor(parsed);
};
const boundedInteger = (value, fallback, min, max) => Math.max(min, Math.min(max, positiveInteger(value, fallback)));
const boundedDelayMs = (value, fallback, min, max) => Math.max(min, Math.min(max, positiveDelayMs(value, fallback)));
const errorMessage = (error) => {
    if (!error)
        return null;
    if (error instanceof Error)
        return error.message || null;
    if (typeof error === 'object' && 'message' in error) {
        return nullableString(error.message);
    }
    return nullableString(String(error));
};
export const shouldRecoverTabBeforeConversationRetry = (retryReason) => RECOVERY_BEFORE_RETRY_REASONS.has(String(retryReason || ''));
export const evaluateConversationRetryDelayFsm = ({ retryReason = null, attempt = 1, defaultRetryLimit = 5, defaultBaseMs = 600, tabBusyRetryLimit = DEFAULT_TAB_BUSY_RETRY_LIMIT, tabBusyBaseMs = DEFAULT_TAB_BUSY_RETRY_BASE_MS, tabBusyMaxDelayMs = DEFAULT_TAB_BUSY_RETRY_MAX_DELAY_MS, } = {}) => {
    const normalizedReason = nullableString(retryReason) || 'unknown';
    const safeAttempt = positiveInteger(attempt, 1);
    const isTabBusy = normalizedReason === 'tab_operation_in_progress';
    const needsCommandClientRecovery = normalizedReason === 'no_command_client_available';
    const usesExtendedTabBudget = isTabBusy || needsCommandClientRecovery;
    const retryLimit = usesExtendedTabBudget
        ? positiveInteger(tabBusyRetryLimit, DEFAULT_TAB_BUSY_RETRY_LIMIT)
        : positiveInteger(defaultRetryLimit, 5);
    if (safeAttempt >= retryLimit) {
        return {
            state: 'record_failure',
            reason: 'retry_limit_exhausted',
            attempt: safeAttempt,
            retryLimit,
            delayMs: null,
        };
    }
    const baseMs = usesExtendedTabBudget
        ? positiveDelayMs(tabBusyBaseMs, DEFAULT_TAB_BUSY_RETRY_BASE_MS)
        : positiveDelayMs(defaultBaseMs, 600);
    const maxDelayMs = usesExtendedTabBudget
        ? Math.max(baseMs, positiveDelayMs(tabBusyMaxDelayMs, DEFAULT_TAB_BUSY_RETRY_MAX_DELAY_MS))
        : Number.POSITIVE_INFINITY;
    return {
        state: 'retry_after_delay',
        reason: needsCommandClientRecovery
            ? 'no_command_client_available_wait_for_recovery'
            : isTabBusy
                ? 'tab_operation_in_progress_wait_for_idle'
                : `${normalizedReason}_retry_after_delay`,
        attempt: safeAttempt,
        retryLimit,
        delayMs: Math.min(maxDelayMs, baseMs * safeAttempt),
    };
};
export const evaluateConversationRetryDelayForJobFsm = ({ retryReason = null, attempt = 1, retryLimit = 5, retryBaseMs = 600, jobType = null, env = {}, } = {}) => {
    const safeRetryLimit = positiveInteger(retryLimit, 5);
    const safeRetryBaseMs = positiveDelayMs(retryBaseMs, 600);
    const isDirectExport = nullableString(jobType) === 'direct-chats-export';
    const tabBusyBaseMs = isDirectExport
        ? safeRetryBaseMs
        : boundedDelayMs(env.GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_BASE_MS, DEFAULT_TAB_BUSY_RETRY_BASE_MS, 100, 30_000);
    return evaluateConversationRetryDelayFsm({
        retryReason,
        attempt,
        defaultRetryLimit: safeRetryLimit,
        defaultBaseMs: safeRetryBaseMs,
        tabBusyRetryLimit: isDirectExport
            ? safeRetryLimit
            : boundedInteger(env.GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_LIMIT, DEFAULT_TAB_BUSY_RETRY_LIMIT, 1, 30),
        tabBusyBaseMs,
        tabBusyMaxDelayMs: isDirectExport
            ? Math.max(safeRetryBaseMs, safeRetryBaseMs * safeRetryLimit)
            : Math.max(tabBusyBaseMs, boundedDelayMs(env.GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_MAX_DELAY_MS, DEFAULT_TAB_BUSY_RETRY_MAX_DELAY_MS, tabBusyBaseMs, 60_000)),
    });
};
export const buildConversationRetryRecoveryContext = (input = {}) => ({
    operationId: nullableString(input.operationId),
    targetChatId: nullableString(input.targetChatId),
    retryAttempt: positiveAttempt(input.retryAttempt),
    retryReason: nullableString(input.retryReason),
    error: errorMessage(input.error),
});
