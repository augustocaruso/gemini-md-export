type RetryRecoveryInput = Readonly<{
  operationId?: unknown;
  targetChatId?: unknown;
  retryAttempt?: unknown;
  retryReason?: unknown;
  error?: unknown;
}>;

const RECOVERY_BEFORE_RETRY_REASONS = new Set<string>();

const nullableString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const positiveAttempt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const errorMessage = (error: unknown): string | null => {
  if (!error) return null;
  if (error instanceof Error) return error.message || null;
  if (typeof error === 'object' && 'message' in error) {
    return nullableString((error as { message?: unknown }).message);
  }
  return nullableString(String(error));
};

export const shouldRecoverTabBeforeConversationRetry = (retryReason: unknown): boolean =>
  RECOVERY_BEFORE_RETRY_REASONS.has(String(retryReason || ''));

export const buildConversationRetryRecoveryContext = (input: RetryRecoveryInput = {}) => ({
  operationId: nullableString(input.operationId),
  targetChatId: nullableString(input.targetChatId),
  retryAttempt: positiveAttempt(input.retryAttempt),
  retryReason: nullableString(input.retryReason),
  error: errorMessage(input.error),
});
