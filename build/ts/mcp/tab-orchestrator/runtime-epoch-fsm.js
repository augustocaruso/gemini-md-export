const CLIENT_STALE_AFTER_MS = 30_000;
const epochPart = (value) => {
    if (value === null || value === undefined || value === '')
        return 'unknown';
    return String(value);
};
const timestampMs = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    const numericTimestamp = Number(value);
    if (Number.isFinite(numericTimestamp))
        return numericTimestamp;
    const parsedTimestamp = Date.parse(value);
    return Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
};
const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};
const pageKind = (client) => {
    const kind = client.page?.kind;
    if (kind === null || kind === undefined || kind === '')
        return null;
    return String(kind);
};
const evidenceStrengthRank = (strength) => {
    if (strength === 'strong')
        return 2;
    if (strength === 'weak')
        return 1;
    return 0;
};
export const runtimeEpochId = (expected) => [
    `ext:${epochPart(expected.extensionVersion)}`,
    `build:${epochPart(expected.buildStamp)}`,
    `protocol:${epochPart(expected.protocolVersion)}`,
].join('|');
export const clientRuntimeEpochId = (client) => [
    `ext:${epochPart(client.extensionVersion)}`,
    `build:${epochPart(client.buildStamp)}`,
    `protocol:${epochPart(client.protocolVersion)}`,
].join('|');
export const clientHasCommandChannel = (client) => client.eventStreamConnected === true ||
    client.commandPollPending === true ||
    client.pendingCommandPoll === true ||
    client.commandChannelStatus === 'ready';
export const classifyRuntimeEvidence = ({ client, expected, nowMs, }) => {
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
export const runtimeEvidenceSatisfiesDesired = (evidence, desired) => {
    if (evidence.strength === 'rejected')
        return false;
    if (evidence.epochId !== desired.requiredEpochId)
        return false;
    if (desired.requireCommandChannel === true && !evidence.hasCommandChannel)
        return false;
    return evidenceStrengthRank(evidence.strength) >= evidenceStrengthRank(desired.minStrength);
};
