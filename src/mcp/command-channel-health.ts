export type CommandFailureClientSnapshot = Readonly<{
  isActiveTab?: boolean | null;
  lastCommandTimeoutAt?: number | string | null;
  lastCommandTimeoutType?: string | null;
  page?: {
    isActiveTab?: boolean | null;
  } | null;
}>;

export const isActivationTimeoutAlreadyReflected = (
  client: CommandFailureClientSnapshot | null | undefined,
): boolean =>
  client?.lastCommandTimeoutType === 'activate-browser-tab' &&
  (client.isActiveTab === true || client.page?.isActiveTab === true);

export const isRecentCommandFailureBlocking = (
  client: CommandFailureClientSnapshot | null | undefined,
  now: number,
  cooldownMs: number,
): boolean => {
  const timedOutAt = Number(client?.lastCommandTimeoutAt || 0);
  if (!Number.isFinite(timedOutAt) || timedOutAt <= 0) return false;
  if (now - timedOutAt > cooldownMs) return false;
  return !isActivationTimeoutAlreadyReflected(client);
};
