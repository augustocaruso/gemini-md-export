import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRuntimeEvidence,
  runtimeEpochId,
  runtimeEvidenceSatisfiesDesired,
} from '../build/ts/mcp/tab-orchestrator/index.js';

const expected = {
  extensionVersion: '1.2.3',
  buildStamp: '20260526-1200',
  protocolVersion: 2,
};

const previousExpected = {
  extensionVersion: '1.2.3',
  buildStamp: '20260526-1100',
  protocolVersion: 2,
};

test('runtime epoch id is stable for expected version/build/protocol', () => {
  assert.equal(
    runtimeEpochId(expected),
    'ext:1.2.3|build:20260526-1200|protocol:2',
  );
});

test('heartbeat-only matching runtime is weak evidence and not sufficient for command readiness', () => {
  const evidence = classifyRuntimeEvidence({
    client: {
      clientId: 'heartbeat-only',
      extensionVersion: '1.2.3',
      buildStamp: '20260526-1200',
      protocolVersion: 2,
      lastSeenAt: 1000,
      eventStreamConnected: false,
      commandPollPending: false,
      pendingCommandPoll: false,
      source: 'content-script',
      page: { kind: 'activity' },
    },
    expected,
    nowMs: 1200,
  });

  assert.equal(evidence.strength, 'weak');
  assert.equal(evidence.epochId, runtimeEpochId(expected));
  assert.equal(
    runtimeEvidenceSatisfiesDesired(evidence, {
      requiredEpochId: runtimeEpochId(expected),
      minStrength: 'strong',
      requireCommandChannel: true,
    }),
    false,
  );
});

test('persistent command channel in the expected runtime epoch is strong evidence', () => {
  const evidence = classifyRuntimeEvidence({
    client: {
      clientId: 'sse-ready',
      extensionVersion: '1.2.3',
      buildStamp: '20260526-1200',
      protocolVersion: 2,
      lastSeenAt: 1000,
      eventStreamConnected: true,
      commandPollPending: false,
      pendingCommandPoll: false,
      source: 'content-script',
      page: { kind: 'activity' },
    },
    expected,
    nowMs: 1200,
  });

  assert.equal(evidence.strength, 'strong');
  assert.equal(
    runtimeEvidenceSatisfiesDesired(evidence, {
      requiredEpochId: runtimeEpochId(expected),
      minStrength: 'strong',
      requireCommandChannel: true,
    }),
    true,
  );
});

test('old build in a live heartbeat is rejected for the desired epoch', () => {
  const evidence = classifyRuntimeEvidence({
    client: {
      clientId: 'old-runtime',
      extensionVersion: '1.2.3',
      buildStamp: '20260526-1100',
      protocolVersion: 2,
      lastSeenAt: 1000,
      eventStreamConnected: true,
      commandPollPending: false,
      pendingCommandPoll: false,
      source: 'content-script',
      page: { kind: 'activity' },
    },
    expected,
    nowMs: 1200,
  });

  assert.equal(evidence.strength, 'rejected');
  assert.equal(evidence.rejectReason, 'runtime_epoch_mismatch');
});

test('runtime evidence satisfaction always rejects epoch mismatch', () => {
  assert.equal(
    runtimeEvidenceSatisfiesDesired(
      {
        clientId: 'other-epoch',
        tabId: 42,
        pageKind: 'activity',
        epochId: runtimeEpochId(expected),
        expectedEpochId: runtimeEpochId(expected),
        strength: 'strong',
        hasCommandChannel: true,
        observedAtMs: 1300,
        ageMs: 300,
        details: {
          extensionVersion: '1.2.3',
          buildStamp: '20260526-1200',
          protocolVersion: 2,
          lastSeenAt: 1000,
          source: 'content-script',
        },
      },
      {
        requiredEpochId: '',
        minStrength: 'strong',
        requireCommandChannel: true,
      },
    ),
    false,
  );
  assert.equal(
    runtimeEvidenceSatisfiesDesired(
      {
        clientId: 'other-epoch',
        tabId: 42,
        pageKind: 'activity',
        epochId: runtimeEpochId(expected),
        expectedEpochId: runtimeEpochId(expected),
        strength: 'strong',
        hasCommandChannel: true,
        observedAtMs: 1300,
        ageMs: 300,
        details: {
          extensionVersion: '1.2.3',
          buildStamp: '20260526-1200',
          protocolVersion: 2,
          lastSeenAt: 1000,
          source: 'content-script',
        },
      },
      {
        requiredEpochId: runtimeEpochId(previousExpected),
        minStrength: 'strong',
        requireCommandChannel: true,
      },
    ),
    false,
  );
});

test('classified evidence includes tab identity, page kind, observed time, and runtime details', () => {
  const evidence = classifyRuntimeEvidence({
    client: {
      clientId: 'detailed-runtime',
      tabId: 42,
      windowId: 7,
      url: 'https://gemini.google.com/app',
      extensionVersion: '1.2.3',
      buildStamp: '20260526-1200',
      protocolVersion: 2,
      lastSeenAt: 1000,
      eventStreamConnected: true,
      commandPollPending: false,
      pendingCommandPoll: false,
      commandChannelStatus: 'ready',
      source: 'content-script',
      page: { kind: 'activity' },
      tabClaim: { claimId: 'claim-1' },
    },
    expected,
    nowMs: 1300,
  });

  assert.equal(evidence.clientId, 'detailed-runtime');
  assert.equal(evidence.tabId, 42);
  assert.equal(evidence.pageKind, 'activity');
  assert.equal(evidence.observedAtMs, 1300);
  assert.deepEqual(evidence.details, {
    extensionVersion: '1.2.3',
    buildStamp: '20260526-1200',
    protocolVersion: 2,
    lastSeenAt: 1000,
    source: 'content-script',
  });
});
