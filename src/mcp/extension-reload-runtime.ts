export type AssumedExtensionReloadResult = Readonly<{
  ok: true;
  reloading: true;
  assumed: true;
  reason: 'extension-context-invalidated';
  detail: string;
}>;

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
  }
  return String(err || '');
};

export const isExtensionContextInvalidatedError = (err: unknown): boolean =>
  /Extension context invalidated/i.test(errorMessage(err));

export const extensionReloadAssumedResultForError = (
  err: unknown,
): AssumedExtensionReloadResult | null => {
  if (!isExtensionContextInvalidatedError(err)) return null;
  return {
    ok: true,
    reloading: true,
    assumed: true,
    reason: 'extension-context-invalidated',
    detail: errorMessage(err),
  };
};
