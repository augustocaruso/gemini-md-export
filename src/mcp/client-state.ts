import type { GeminiClientSnapshot } from './client-lifecycle.js';

export type TabClaimState = Readonly<Record<string, unknown>>;

export type ClientMetricsState = Readonly<{
  tabOperation?: {
    active?: unknown;
    completed?: unknown;
    rejected?: unknown;
  } | null;
  [key: string]: unknown;
}>;

export type ClientRuntimeState = Readonly<{
  tabClaim?: TabClaimState | null;
  metrics?: ClientMetricsState | null;
}>;

export type ClientRuntimePayload = Readonly<{
  tabClaim?: TabClaimState | null;
  metrics?: ClientMetricsState | null;
}>;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export const mergeExplicitNullableClientState = (
  current: ClientRuntimeState,
  payload: ClientRuntimePayload,
): Required<ClientRuntimeState> => ({
  tabClaim: hasOwn(payload, 'tabClaim') ? (payload.tabClaim ?? null) : (current.tabClaim ?? null),
  metrics: hasOwn(payload, 'metrics') ? (payload.metrics ?? null) : (current.metrics ?? null),
});

export const currentTabOperationInProgress = (
  client: Pick<GeminiClientSnapshot, 'metrics' | 'summary'>,
): boolean =>
  Boolean(client.metrics?.tabOperation?.active) ||
  Boolean(client.summary?.metrics?.tabOperation?.active);
