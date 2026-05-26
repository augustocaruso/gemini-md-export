import type {
  DesiredRuntimeEvidence,
  ExpectedExtensionRuntime,
  ObservedTabClient,
  RuntimeEpochEvidence,
} from './types.js';

const CLIENT_STALE_AFTER_MS = 30_000;

const epochPart = (value: number | string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return 'unknown';
  return String(value);
};

const timestampMs = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const numberOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const pageKind = (client: ObservedTabClient): string | null => {
  const kind = client.page?.kind;
  if (kind === null || kind === undefined || kind === '') return null;
  return String(kind);
};

const evidenceStrengthRank = (strength: RuntimeEpochEvidence['strength']): number => {
  if (strength === 'strong') return 2;
  if (strength === 'weak') return 1;
  return 0;
};

export const runtimeEpochId = (expected: ExpectedExtensionRuntime): string =>
  [
    `ext:${epochPart(expected.extensionVersion)}`,
    `build:${epochPart(expected.buildStamp)}`,
    `protocol:${epochPart(expected.protocolVersion)}`,
  ].join('|');

export const clientRuntimeEpochId = (client: ObservedTabClient): string =>
  [
    `ext:${epochPart(client.extensionVersion)}`,
    `build:${epochPart(client.buildStamp)}`,
    `protocol:${epochPart(client.protocolVersion)}`,
  ].join('|');

export const clientHasCommandChannel = (client: ObservedTabClient): boolean =>
  client.eventStreamConnected === true ||
  client.commandPollPending === true ||
  client.pendingCommandPoll === true ||
  client.commandChannelStatus === 'ready';

export const classifyRuntimeEvidence = ({
  client,
  expected,
  nowMs,
}: {
  readonly client: ObservedTabClient;
  readonly expected: ExpectedExtensionRuntime;
  readonly nowMs: number;
}): RuntimeEpochEvidence => {
  const epochId = clientRuntimeEpochId(client);
  const expectedEpochId = runtimeEpochId(expected);
  const hasCommandChannel = clientHasCommandChannel(client);
  const lastSeenAt = timestampMs(client.lastSeenAt);
  const ageMs = lastSeenAt === null ? null : nowMs - lastSeenAt;
  const baseEvidence = {
    clientId: client.clientId ? String(client.clientId) : null,
    tabId: numberOrNull(client.tabId),
    pageKind: pageKind(client),
    epochId,
    expectedEpochId,
    hasCommandChannel,
    observedAtMs: nowMs,
    ageMs,
    details: {
      extensionVersion: client.extensionVersion ?? null,
      buildStamp: client.buildStamp ?? null,
      protocolVersion: client.protocolVersion ?? null,
      lastSeenAt: client.lastSeenAt ?? null,
      source: client.source ?? null,
    },
  };

  if (epochId !== expectedEpochId) {
    return {
      ...baseEvidence,
      strength: 'rejected',
      rejectReason: 'runtime_epoch_mismatch',
    };
  }

  if (ageMs === null || ageMs < 0 || ageMs > CLIENT_STALE_AFTER_MS) {
    return {
      ...baseEvidence,
      strength: 'rejected',
      rejectReason: 'client_stale',
    };
  }

  return {
    ...baseEvidence,
    strength: hasCommandChannel ? 'strong' : 'weak',
  };
};

export const runtimeEvidenceSatisfiesDesired = (
  evidence: RuntimeEpochEvidence,
  desired: DesiredRuntimeEvidence,
): boolean => {
  if (evidence.strength === 'rejected') return false;
  if (evidence.epochId !== desired.requiredEpochId) return false;
  if (desired.requireCommandChannel === true && !evidence.hasCommandChannel) return false;

  return evidenceStrengthRank(evidence.strength) >= evidenceStrengthRank(desired.minStrength);
};
