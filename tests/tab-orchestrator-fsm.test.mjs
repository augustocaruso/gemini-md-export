import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRuntimeEvidence,
  allocateTabForPurpose,
  initialTabPoolState,
  initialRecoveryState,
  reduceTabLifecycle,
  reduceRuntimeRecovery,
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

const matchingClient = (overrides = {}) => ({
  clientId: 'matching-runtime',
  extensionVersion: '1.2.3',
  buildStamp: '20260526-1200',
  protocolVersion: 2,
  lastSeenAt: 1000,
  eventStreamConnected: false,
  commandPollPending: false,
  pendingCommandPoll: false,
  source: 'content-script',
  page: { kind: 'activity' },
  ...overrides,
});

test('runtime epoch id is stable for expected version/build/protocol', () => {
  assert.equal(
    runtimeEpochId(expected),
    'ext:1.2.3|build:20260526-1200|protocol:2',
  );
});

test('runtime epoch id uses unknown for missing expected runtime parts', () => {
  assert.equal(runtimeEpochId({}), 'ext:unknown|build:unknown|protocol:unknown');
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

test('stale numeric timestamp is rejected as client_stale', () => {
  const evidence = classifyRuntimeEvidence({
    client: matchingClient({ lastSeenAt: 1000 }),
    expected,
    nowMs: 31_001,
  });

  assert.equal(evidence.strength, 'rejected');
  assert.equal(evidence.rejectReason, 'client_stale');
});

test('future timestamp is rejected as client_stale', () => {
  const evidence = classifyRuntimeEvidence({
    client: matchingClient({ lastSeenAt: 2000 }),
    expected,
    nowMs: 1000,
  });

  assert.equal(evidence.strength, 'rejected');
  assert.equal(evidence.rejectReason, 'client_stale');
});

test('missing timestamp is rejected as client_stale', () => {
  const evidence = classifyRuntimeEvidence({
    client: matchingClient({ lastSeenAt: null }),
    expected,
    nowMs: 1000,
  });

  assert.equal(evidence.strength, 'rejected');
  assert.equal(evidence.rejectReason, 'client_stale');
});

test('fresh ISO timestamp is accepted as live runtime evidence', () => {
  const evidence = classifyRuntimeEvidence({
    client: matchingClient({
      lastSeenAt: '2026-05-26T15:00:00.000Z',
      eventStreamConnected: true,
    }),
    expected,
    nowMs: Date.parse('2026-05-26T15:00:01.000Z'),
  });

  assert.equal(evidence.strength, 'strong');
  assert.equal(evidence.rejectReason, undefined);
});

test('weak evidence satisfies desired weak runtime without command channel', () => {
  const evidence = classifyRuntimeEvidence({
    client: matchingClient(),
    expected,
    nowMs: 1200,
  });

  assert.equal(evidence.strength, 'weak');
  assert.equal(
    runtimeEvidenceSatisfiesDesired(evidence, {
      requiredEpochId: runtimeEpochId(expected),
      minStrength: 'weak',
      requireCommandChannel: false,
    }),
    true,
  );
});

const desiredEpochId = runtimeEpochId(expected);

const strongDesiredEvidence = (overrides = {}) =>
  classifyRuntimeEvidence({
    client: matchingClient({
      tabId: 42,
      eventStreamConnected: true,
      ...overrides,
    }),
    expected,
    nowMs: 1400,
  });

const weakDesiredEvidence = (overrides = {}) =>
  classifyRuntimeEvidence({
    client: matchingClient({
      tabId: 43,
      eventStreamConnected: false,
      ...overrides,
    }),
    expected,
    nowMs: 1400,
  });

const observedPoolWith = (...evidenceItems) => {
  let state = initialTabPoolState({ desiredEpochId, nowMs: 1000 });
  for (const evidence of evidenceItems) {
    state = reduceTabLifecycle(state, {
      type: 'tabObserved',
      nowMs: evidence.observedAtMs,
      evidence,
    }).state;
  }
  return state;
};

const allocationRequest = (overrides = {}) => ({
  purpose: 'export-current-chat',
  pageKind: 'activity',
  requireStrongRuntime: true,
  allowCreate: false,
  claimId: 'claim-export-1',
  ...overrides,
});

test('initial tab pool is empty for the desired epoch', () => {
  assert.deepEqual(initialTabPoolState({ desiredEpochId, nowMs: 1000 }), {
    desiredEpochId,
    tabs: [],
    updatedAtMs: 1000,
  });
});

test('ready observed tab is allocated and emits tab.claim', () => {
  const state = observedPoolWith(strongDesiredEvidence({ tabId: 7, page: { kind: 'activity' } }));

  const result = allocateTabForPurpose(state, allocationRequest({ claimId: 'claim-7' }));

  assert.equal(result.status, 'allocated');
  assert.equal(result.tab.tabId, 7);
  assert.deepEqual(result.effects, [
    {
      type: 'tab.claim',
      reason: 'export-current-chat',
      tabId: 7,
      claimId: 'claim-7',
    },
  ]);
});

test('page-kind mismatch is not allocated', () => {
  const state = observedPoolWith(strongDesiredEvidence({ tabId: 8, page: { kind: 'chat' } }));

  const result = allocateTabForPurpose(state, allocationRequest());

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no_ready_tab_for_purpose');
  assert.deepEqual(result.candidates, []);
});

test('quarantined tab is skipped and another matching ready tab is allocated', () => {
  let state = observedPoolWith(
    strongDesiredEvidence({ tabId: 9, page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: 10, clientId: 'other-ready', page: { kind: 'activity' } }),
  );
  state = reduceTabLifecycle(state, {
    type: 'tabQuarantined',
    nowMs: 1500,
    tabId: 9,
    reason: 'runtime_epoch_timeout',
  }).state;

  const result = allocateTabForPurpose(state, allocationRequest({ claimId: 'claim-10' }));

  assert.equal(result.status, 'allocated');
  assert.equal(result.tab.tabId, 10);
  assert.deepEqual(result.effects, [
    {
      type: 'tab.claim',
      reason: 'export-current-chat',
      tabId: 10,
      claimId: 'claim-10',
    },
  ]);
});

test('busy tab is skipped', () => {
  let state = observedPoolWith(strongDesiredEvidence({ tabId: 11, page: { kind: 'activity' } }));
  state = reduceTabLifecycle(state, {
    type: 'tabBusy',
    nowMs: 1500,
    tabId: 11,
    reason: 'hydrating_chat',
  }).state;

  const result = allocateTabForPurpose(state, allocationRequest());

  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.candidates, []);
});

test('ambiguous ready candidates return ambiguous and diagnostic effect', () => {
  const state = observedPoolWith(
    strongDesiredEvidence({ tabId: 12, page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: 13, clientId: 'second-ready', page: { kind: 'activity' } }),
  );

  const result = allocateTabForPurpose(state, allocationRequest());

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.tabId),
    [12, 13],
  );
  assert.deepEqual(result.effects, [
    {
      type: 'diagnostic.record',
      reason: 'export-current-chat',
      code: 'ambiguous_tab_allocation',
      severity: 'warning',
    },
  ]);
});

test('no candidate with allowCreate opens browser', () => {
  const state = initialTabPoolState({ desiredEpochId, nowMs: 1000 });

  const result = allocateTabForPurpose(
    state,
    allocationRequest({
      allowCreate: true,
      createUrl: 'https://gemini.google.com/app',
    }),
  );

  assert.equal(result.status, 'needs_create');
  assert.deepEqual(result.effects, [
    {
      type: 'browser.open',
      reason: 'export-current-chat',
      url: 'https://gemini.google.com/app',
      pageKind: 'activity',
    },
  ]);
});

test('no candidate without create returns unavailable diagnostic', () => {
  const state = initialTabPoolState({ desiredEpochId, nowMs: 1000 });

  const result = allocateTabForPurpose(state, allocationRequest());

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no_ready_tab_for_purpose');
  assert.deepEqual(result.effects, [
    {
      type: 'diagnostic.record',
      reason: 'export-current-chat',
      code: 'no_ready_tab_for_purpose',
      severity: 'warning',
    },
  ]);
});

test('observed weak wrong or rejected evidence is not considered ready when strong runtime is required', () => {
  const weak = weakDesiredEvidence({ tabId: 14, page: { kind: 'activity' } });
  const wrongEpoch = classifyRuntimeEvidence({
    client: matchingClient({
      clientId: 'wrong-epoch',
      tabId: 15,
      buildStamp: '20260526-1100',
      eventStreamConnected: true,
      page: { kind: 'activity' },
    }),
    expected,
    nowMs: 1400,
  });
  const rejected = classifyRuntimeEvidence({
    client: matchingClient({
      clientId: 'stale-client',
      tabId: 16,
      lastSeenAt: null,
      eventStreamConnected: true,
      page: { kind: 'activity' },
    }),
    expected,
    nowMs: 1400,
  });
  const state = observedPoolWith(weak, wrongEpoch, rejected);

  assert.deepEqual(
    state.tabs.map((tab) => [tab.tabId, tab.status]),
    [
      [14, 'observed'],
      [15, 'observed'],
      [16, 'observed'],
    ],
  );

  const result = allocateTabForPurpose(state, allocationRequest());

  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.candidates, []);
});

test('tabObserved upserts by tabId and clientId rather than duplicating', () => {
  let state = initialTabPoolState({ desiredEpochId, nowMs: 1000 });

  state = reduceTabLifecycle(state, {
    type: 'tabObserved',
    nowMs: 1400,
    evidence: strongDesiredEvidence({
      tabId: 17,
      clientId: 'first-client-for-tab',
      page: { kind: 'activity' },
    }),
  }).state;
  state = reduceTabLifecycle(state, {
    type: 'tabObserved',
    nowMs: 1500,
    evidence: strongDesiredEvidence({
      tabId: 17,
      clientId: 'second-client-for-tab',
      page: { kind: 'activity' },
    }),
  }).state;
  state = reduceTabLifecycle(state, {
    type: 'tabObserved',
    nowMs: 1600,
    evidence: strongDesiredEvidence({
      tabId: null,
      clientId: 'client-only',
      page: { kind: 'activity' },
    }),
  }).state;
  state = reduceTabLifecycle(state, {
    type: 'tabObserved',
    nowMs: 1700,
    evidence: strongDesiredEvidence({
      tabId: null,
      clientId: 'client-only',
      page: { kind: 'chat' },
    }),
  }).state;

  assert.equal(state.tabs.length, 2);
  assert.deepEqual(
    state.tabs.map((tab) => ({
      tabId: tab.tabId,
      clientId: tab.clientId,
      pageKind: tab.pageKind,
      status: tab.status,
    })),
    [
      {
        tabId: 17,
        clientId: 'second-client-for-tab',
        pageKind: 'activity',
        status: 'ready',
      },
      {
        tabId: null,
        clientId: 'client-only',
        pageKind: 'chat',
        status: 'ready',
      },
    ],
  );
});

test('client-only tabBusy updates only the matching clientId', () => {
  let state = observedPoolWith(
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-a', page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-b', page: { kind: 'activity' } }),
  );

  state = reduceTabLifecycle(state, {
    type: 'tabBusy',
    nowMs: 1800,
    tabId: null,
    clientId: 'client-only-a',
    reason: 'hydrating_chat',
  }).state;

  assert.deepEqual(
    state.tabs.map((tab) => [tab.clientId, tab.status, tab.updatedAtMs]),
    [
      ['client-only-a', 'busy', 1800],
      ['client-only-b', 'ready', 1400],
    ],
  );
});

test('client-only tabQuarantined updates only the matching clientId', () => {
  let state = observedPoolWith(
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-a', page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-b', page: { kind: 'activity' } }),
  );

  state = reduceTabLifecycle(state, {
    type: 'tabQuarantined',
    nowMs: 1800,
    tabId: null,
    clientId: 'client-only-b',
    reason: 'runtime_epoch_timeout',
  }).state;

  assert.deepEqual(
    state.tabs.map((tab) => [tab.clientId, tab.status, tab.quarantineReason, tab.updatedAtMs]),
    [
      ['client-only-a', 'ready', undefined, 1400],
      ['client-only-b', 'quarantined', 'runtime_epoch_timeout', 1800],
    ],
  );
});

test('client-only tabReleased updates only the matching clientId', () => {
  let state = observedPoolWith(
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-a', page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-b', page: { kind: 'activity' } }),
  );
  state = reduceTabLifecycle(state, {
    type: 'tabBusy',
    nowMs: 1800,
    tabId: null,
    clientId: 'client-only-a',
    reason: 'hydrating_chat',
  }).state;

  state = reduceTabLifecycle(state, {
    type: 'tabReleased',
    nowMs: 1900,
    tabId: null,
    clientId: 'client-only-a',
    claimId: 'claim-client-a',
  }).state;

  assert.deepEqual(
    state.tabs.map((tab) => [tab.clientId, tab.status, tab.updatedAtMs]),
    [
      ['client-only-a', 'ready', 1900],
      ['client-only-b', 'ready', 1400],
    ],
  );
});

test('anonymous lifecycle event with no tabId or clientId does not update client-only tabs', () => {
  const state = observedPoolWith(
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-a', page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: null, clientId: 'client-only-b', page: { kind: 'activity' } }),
  );

  const transition = reduceTabLifecycle(state, {
    type: 'tabBusy',
    nowMs: 1800,
    tabId: null,
    reason: 'missing_identity',
  });

  assert.deepEqual(transition.state.tabs, state.tabs);
  assert.equal(transition.state.updatedAtMs, 1800);
});

test('tabId lifecycle events still match by tabId before clientId', () => {
  let state = observedPoolWith(
    strongDesiredEvidence({ tabId: 18, clientId: 'old-client', page: { kind: 'activity' } }),
    strongDesiredEvidence({ tabId: 19, clientId: 'target-client', page: { kind: 'activity' } }),
  );

  state = reduceTabLifecycle(state, {
    type: 'tabBusy',
    nowMs: 1800,
    tabId: 18,
    clientId: 'target-client',
    reason: 'hydrate_by_tab_id',
  }).state;

  assert.deepEqual(
    state.tabs.map((tab) => [tab.tabId, tab.clientId, tab.status]),
    [
      [18, 'old-client', 'busy'],
      [19, 'target-client', 'ready'],
    ],
  );
});

test('initial recovery state shape', () => {
  assert.deepEqual(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    status: 'idle',
    desiredEpochId,
    startedAtMs: 1000,
    updatedAtMs: 1000,
    attempts: 0,
    rejectedEvidenceCount: 0,
    backoffMs: 8000,
  });
});

test('reloadRequested separates reload request from runtime readiness and emits reloadSelf plus waitForEpoch', () => {
  const state = initialRecoveryState({ desiredEpochId, nowMs: 1000 });

  const transition = reduceRuntimeRecovery(state, {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  });

  assert.deepEqual(transition.state, {
    status: 'reload_requested',
    desiredEpochId,
    startedAtMs: 1000,
    updatedAtMs: 1100,
    attempts: 1,
    rejectedEvidenceCount: 0,
    deadlineAtMs: 9100,
    backoffMs: 8000,
    lastReason: 'extension_updated',
  });
  assert.deepEqual(transition.effects, [
    { type: 'extension.reloadSelf', reason: 'extension_updated' },
    {
      type: 'runtime.waitForEpoch',
      reason: 'extension_updated',
      epochId: desiredEpochId,
      timeoutMs: 8000,
    },
  ]);
});

test('extension context invalidated moves recovery to awaiting runtime epoch and emits wait plus self-heal', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;

  const transition = reduceRuntimeRecovery(state, {
    type: 'extensionContextInvalidated',
    nowMs: 1200,
    message: 'Extension context invalidated.',
  });

  assert.equal(transition.state.status, 'awaiting_runtime_epoch');
  assert.equal(transition.state.lastReason, 'extension_context_invalidated');
  assert.equal(transition.state.updatedAtMs, 1200);
  assert.equal(transition.state.attempts, 1);
  assert.equal(transition.state.deadlineAtMs, 9200);
  assert.deepEqual(transition.effects, [
    {
      type: 'runtime.waitForEpoch',
      reason: 'extension_context_invalidated',
      epochId: desiredEpochId,
      timeoutMs: 8000,
    },
    {
      type: 'serviceWorker.selfHeal',
      reason: 'extension_context_invalidated',
      target: 'extension-runtime',
    },
  ]);
});

test('old heartbeat rejected evidence while awaiting runtime epoch does not complete recovery and records diagnostic', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'extensionContextInvalidated',
    nowMs: 1100,
    message: 'Extension context invalidated.',
  }).state;
  const staleEvidence = classifyRuntimeEvidence({
    client: matchingClient({
      buildStamp: '20260526-1100',
      eventStreamConnected: true,
    }),
    expected,
    nowMs: 1200,
  });

  const transition = reduceRuntimeRecovery(state, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1200,
    evidence: staleEvidence,
  });

  assert.equal(transition.state.status, 'awaiting_runtime_epoch');
  assert.equal(transition.state.rejectedEvidenceCount, 1);
  assert.equal(transition.state.lastReason, 'runtime_epoch_mismatch');
  assert.deepEqual(transition.effects, [
    {
      type: 'diagnostic.record',
      reason: 'runtime_epoch_mismatch',
      code: 'stale_runtime_ignored',
      severity: 'warning',
    },
  ]);
});

test('weak matching evidence without command channel does not complete recovery', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;
  const evidence = classifyRuntimeEvidence({
    client: matchingClient(),
    expected,
    nowMs: 1200,
  });

  const transition = reduceRuntimeRecovery(state, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1200,
    evidence,
  });

  assert.equal(transition.state.status, 'awaiting_runtime_epoch');
  assert.equal(transition.state.rejectedEvidenceCount, 1);
  assert.equal(transition.state.lastReason, 'insufficient_runtime_evidence');
  assert.deepEqual(transition.effects, [
    {
      type: 'diagnostic.record',
      reason: 'insufficient_runtime_evidence',
      code: 'stale_runtime_ignored',
      severity: 'warning',
    },
  ]);
});

test('strong evidence for desired epoch completes recovery with no effects', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;

  const transition = reduceRuntimeRecovery(state, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1200,
    evidence: strongDesiredEvidence(),
  });

  assert.equal(transition.state.status, 'ready');
  assert.equal(transition.state.updatedAtMs, 1200);
  assert.deepEqual(transition.effects, []);
});

test('weak evidence from idle keeps idle and emits no effects', () => {
  const idle = initialRecoveryState({ desiredEpochId, nowMs: 1000 });
  const weakEvidence = classifyRuntimeEvidence({
    client: matchingClient(),
    expected,
    nowMs: 1100,
  });

  const transition = reduceRuntimeRecovery(idle, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1100,
    evidence: weakEvidence,
  });

  assert.deepEqual(transition.state, idle);
  assert.deepEqual(transition.effects, []);
});

test('rejected stale evidence from idle keeps idle and emits no effects', () => {
  const idle = initialRecoveryState({ desiredEpochId, nowMs: 1000 });
  const staleEvidence = classifyRuntimeEvidence({
    client: matchingClient({ lastSeenAt: 1000 }),
    expected,
    nowMs: 31_001,
  });

  const transition = reduceRuntimeRecovery(idle, {
    type: 'runtimeEvidenceObserved',
    nowMs: 31_001,
    evidence: staleEvidence,
  });

  assert.deepEqual(transition.state, idle);
  assert.deepEqual(transition.effects, []);
});

test('strong evidence from idle moves to ready with no effects', () => {
  const idle = initialRecoveryState({ desiredEpochId, nowMs: 1000 });

  const transition = reduceRuntimeRecovery(idle, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1100,
    evidence: strongDesiredEvidence(),
  });

  assert.equal(transition.state.status, 'ready');
  assert.equal(transition.state.updatedAtMs, 1100);
  assert.equal(transition.state.attempts, 0);
  assert.equal(transition.state.rejectedEvidenceCount, 0);
  assert.deepEqual(transition.effects, []);
});

test('stale or weak evidence after ready keeps ready and emits no effects', () => {
  const ready = reduceRuntimeRecovery(
    reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
      type: 'reloadRequested',
      nowMs: 1100,
      reason: 'extension_updated',
    }).state,
    {
      type: 'runtimeEvidenceObserved',
      nowMs: 1200,
      evidence: strongDesiredEvidence(),
    },
  ).state;
  const weakEvidence = classifyRuntimeEvidence({
    client: matchingClient(),
    expected,
    nowMs: 1300,
  });

  const transition = reduceRuntimeRecovery(ready, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1300,
    evidence: weakEvidence,
  });

  assert.deepEqual(transition.state, ready);
  assert.deepEqual(transition.effects, []);
});

test('timeout from idle keeps idle and emits no effects', () => {
  const idle = initialRecoveryState({ desiredEpochId, nowMs: 1000 });

  const transition = reduceRuntimeRecovery(idle, { type: 'timeout', nowMs: 9000 });

  assert.deepEqual(transition.state, idle);
  assert.deepEqual(transition.effects, []);
});

test('early timeout before deadline does not retry', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;

  const transition = reduceRuntimeRecovery(state, { type: 'timeout', nowMs: 9000 });

  assert.deepEqual(transition.state, state);
  assert.deepEqual(transition.effects, []);
});

test('timeout retries first, then quarantines after attempts threshold', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;

  const retry = reduceRuntimeRecovery(state, { type: 'timeout', nowMs: 9100 });

  assert.equal(retry.state.status, 'awaiting_runtime_epoch');
  assert.equal(retry.state.attempts, 2);
  assert.equal(retry.state.lastReason, 'runtime_epoch_timeout');
  assert.equal(retry.state.deadlineAtMs, 17_100);
  assert.deepEqual(retry.effects, [
    {
      type: 'serviceWorker.selfHeal',
      reason: 'runtime_epoch_timeout',
      target: 'extension-runtime',
    },
    {
      type: 'runtime.waitForEpoch',
      reason: 'runtime_epoch_timeout',
      epochId: desiredEpochId,
      timeoutMs: 8000,
    },
  ]);

  const quarantine = reduceRuntimeRecovery(retry.state, { type: 'timeout', nowMs: 17_100 });

  assert.equal(quarantine.state.status, 'quarantined');
  assert.equal(quarantine.state.attempts, 2);
  assert.deepEqual(quarantine.effects, [
    {
      type: 'diagnostic.record',
      reason: 'runtime_epoch_timeout',
      code: 'runtime_epoch_timeout',
      severity: 'error',
    },
  ]);
});

test('timeout at deadline quarantines after rejected evidence threshold', () => {
  let state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;
  const weakEvidence = classifyRuntimeEvidence({
    client: matchingClient(),
    expected,
    nowMs: 1200,
  });

  for (const nowMs of [1200, 1300, 1400]) {
    state = reduceRuntimeRecovery(state, {
      type: 'runtimeEvidenceObserved',
      nowMs,
      evidence: weakEvidence,
    }).state;
  }

  const transition = reduceRuntimeRecovery(state, { type: 'timeout', nowMs: 9100 });

  assert.equal(transition.state.status, 'quarantined');
  assert.equal(transition.state.rejectedEvidenceCount, 3);
  assert.deepEqual(transition.effects, [
    {
      type: 'diagnostic.record',
      reason: 'runtime_epoch_timeout',
      code: 'runtime_epoch_timeout',
      severity: 'error',
    },
  ]);
});

test('manualAbort fails with diagnostic', () => {
  const state = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'reloadRequested',
    nowMs: 1100,
    reason: 'extension_updated',
  }).state;

  const transition = reduceRuntimeRecovery(state, {
    type: 'manualAbort',
    nowMs: 1200,
    reason: 'operator_cancelled',
  });

  assert.equal(transition.state.status, 'failed');
  assert.equal(transition.state.lastReason, 'operator_cancelled');
  assert.deepEqual(transition.effects, [
    {
      type: 'diagnostic.record',
      reason: 'operator_cancelled',
      code: 'runtime_recovery_aborted',
      severity: 'error',
    },
  ]);
});

test('events after quarantined keep quarantined and emit no effects', () => {
  const state = {
    ...initialRecoveryState({ desiredEpochId, nowMs: 1000 }),
    status: 'quarantined',
    updatedAtMs: 9100,
    attempts: 2,
    deadlineAtMs: 9100,
    lastReason: 'runtime_epoch_timeout',
  };

  for (const event of [
    { type: 'reloadRequested', nowMs: 9200, reason: 'retry_again' },
    { type: 'runtimeEvidenceObserved', nowMs: 9300, evidence: strongDesiredEvidence() },
    { type: 'timeout', nowMs: 9400 },
    { type: 'manualAbort', nowMs: 9500, reason: 'operator_cancelled' },
  ]) {
    const transition = reduceRuntimeRecovery(state, event);
    assert.deepEqual(transition.state, state);
    assert.deepEqual(transition.effects, []);
  }
});

test('reloadRequested after failed keeps failed and emits no effects', () => {
  const failed = reduceRuntimeRecovery(initialRecoveryState({ desiredEpochId, nowMs: 1000 }), {
    type: 'manualAbort',
    nowMs: 1100,
    reason: 'operator_cancelled',
  }).state;

  const transition = reduceRuntimeRecovery(failed, {
    type: 'reloadRequested',
    nowMs: 1200,
    reason: 'extension_updated',
  });

  assert.deepEqual(transition.state, failed);
  assert.deepEqual(transition.effects, []);
});
