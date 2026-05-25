export type AssumedExtensionReloadResult = Readonly<{
  ok: true;
  reloading: true;
  assumed: true;
  reason: 'extension-context-invalidated';
  detail: string;
}>;

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
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
