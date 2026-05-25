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
