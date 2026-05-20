export type ManagedTabsReloadRuntimeSnapshot = Readonly<{
  extensionVersion?: unknown;
  version?: unknown;
  protocolVersion?: unknown;
  buildStamp?: unknown;
}>;

export type ManagedTabsReloadRecord = Readonly<{
  reloadId: string;
  reason: string;
  runtimeKey: string;
  reloadedAtMs: number;
  reloadedAt: string;
  forced: boolean;
}>;

export type ManagedTabsReloadDecision =
  | Readonly<{
      ok: true;
      status: 'allowed';
      current: ManagedTabsReloadRecord;
      previous: unknown;
    }>
  | Readonly<{
      ok: false;
      status: 'cooldown' | 'already-reloaded-current-runtime';
      reason: string;
      previous: unknown;
      cooldownMs?: number;
      runtimeKey?: string;
    }>;

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

export const managedTabsReloadRuntimeKey = (
  runtime: ManagedTabsReloadRuntimeSnapshot = {},
): string =>
  [
    text(runtime.extensionVersion || runtime.version),
    text(runtime.protocolVersion),
    text(runtime.buildStamp),
  ].join('|');

const reloadId = (runtimeKey: string, nowMs: number): string =>
  `${runtimeKey || 'unknown-runtime'}:${nowMs.toString(36)}`;

export const decideManagedTabsReload = ({
  previous = null,
  runtimeKey,
  reason = 'manual',
  nowMs = Date.now(),
  cooldownMs,
  force = false,
}: {
  previous?: unknown;
  runtimeKey: string;
  reason?: string;
  nowMs?: number;
  cooldownMs: number;
  force?: boolean;
}): ManagedTabsReloadDecision => {
  const previousRecord = previous as Partial<ManagedTabsReloadRecord> | null;
  const previousReloadedAtMs = Number(previousRecord?.reloadedAtMs || 0);

  if (!force && previousReloadedAtMs > 0 && nowMs - previousReloadedAtMs < cooldownMs) {
    return {
      ok: false,
      status: 'cooldown',
      reason,
      previous,
      cooldownMs: cooldownMs - (nowMs - previousReloadedAtMs),
      runtimeKey,
    };
  }

  if (!force && previousRecord?.runtimeKey && previousRecord.runtimeKey === runtimeKey) {
    return {
      ok: false,
      status: 'already-reloaded-current-runtime',
      reason,
      previous,
      runtimeKey,
    };
  }

  return {
    ok: true,
    status: 'allowed',
    previous,
    current: {
      reloadId: reloadId(runtimeKey, nowMs),
      reason,
      runtimeKey,
      reloadedAtMs: nowMs,
      reloadedAt: new Date(nowMs).toISOString(),
      forced: force,
    },
  };
};
