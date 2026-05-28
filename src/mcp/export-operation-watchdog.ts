const elapsedLabel = (ms: number): string => {
  const safeMs = Math.max(0, ms);
  if (safeMs > 0 && safeMs < 1000) return `${safeMs}ms`;
  return `${Math.round(safeMs / 1000)}s`;
};

const isFiniteNonNegativeMs = (value: number): boolean => Number.isFinite(value) && value >= 0;

const safeElapsedMs = ({
  now,
  lastProgressAt,
}: {
  now: number;
  lastProgressAt: number;
}): number => {
  const hasValidNow = isFiniteNonNegativeMs(now);
  const hasValidLastProgress = isFiniteNonNegativeMs(lastProgressAt);
  const safeNow = hasValidNow ? now : hasValidLastProgress ? lastProgressAt : 0;
  const safeLastProgressAt = hasValidLastProgress ? lastProgressAt : safeNow;
  return Math.max(0, safeNow - safeLastProgressAt);
};

export type ConversationOperationWatchdogInput = {
  operationId: string;
  now: number;
  lastProgressAt: number;
  noProgressMs: number;
  cancelRequested?: boolean;
};

export type ConversationOperationWatchdogDecision =
  | { action: 'continue'; elapsedMs: number }
  | { action: 'fail'; elapsedMs: number; code: string; message: string }
  | { action: 'cancel'; elapsedMs: number; code: string; message: string };

export type ConversationNoProgressBudgetInput = {
  requestedMs?: number;
  browserNavigationTimeoutMs?: number;
  recoveryGapMs?: number;
  maxMs?: number;
};

export type ConversationNoProgressBudgetDecision = {
  state: 'normalized';
  requestedMs: number;
  minimumMs: number;
  noProgressMs: number;
  reason: 'requested_ok' | 'raised_above_browser_navigation_timeout';
};

export const evaluateConversationOperationWatchdog = ({
  now,
  lastProgressAt,
  noProgressMs,
  cancelRequested = false,
}: ConversationOperationWatchdogInput): ConversationOperationWatchdogDecision => {
  const elapsedMs = safeElapsedMs({ now, lastProgressAt });
  if (!isFiniteNonNegativeMs(noProgressMs) || noProgressMs <= 0) {
    return { action: 'continue', elapsedMs };
  }
  if (elapsedMs <= noProgressMs) return { action: 'continue', elapsedMs };
  if (cancelRequested) {
    return {
      action: 'cancel',
      elapsedMs,
      code: 'conversation_cancelled_after_no_progress',
      message: `Cancelamento solicitado; operação sem progresso por ${elapsedLabel(elapsedMs)}.`,
    };
  }
  return {
    action: 'fail',
    elapsedMs,
    code: 'conversation_no_progress_timeout',
    message: `Conversa sem progresso por ${elapsedLabel(elapsedMs)}.`,
  };
};

export const evaluateConversationNoProgressBudgetFsm = ({
  requestedMs = 0,
  browserNavigationTimeoutMs = 0,
  recoveryGapMs = 0,
  maxMs = Number.POSITIVE_INFINITY,
}: ConversationNoProgressBudgetInput = {}): ConversationNoProgressBudgetDecision => {
  const safeRequestedMs = isFiniteNonNegativeMs(requestedMs) ? Math.floor(requestedMs) : 0;
  const safeBrowserNavigationTimeoutMs = isFiniteNonNegativeMs(browserNavigationTimeoutMs)
    ? Math.floor(browserNavigationTimeoutMs)
    : 0;
  const safeRecoveryGapMs = isFiniteNonNegativeMs(recoveryGapMs) ? Math.floor(recoveryGapMs) : 0;
  const safeMaxMs =
    isFiniteNonNegativeMs(maxMs) && maxMs > 0 ? Math.floor(maxMs) : Number.POSITIVE_INFINITY;
  const minimumMs = Math.min(safeMaxMs, safeBrowserNavigationTimeoutMs + safeRecoveryGapMs);
  const noProgressMs = Math.min(safeMaxMs, Math.max(safeRequestedMs, minimumMs));
  return {
    state: 'normalized',
    requestedMs: safeRequestedMs,
    minimumMs,
    noProgressMs,
    reason:
      noProgressMs > safeRequestedMs ? 'raised_above_browser_navigation_timeout' : 'requested_ok',
  };
};
