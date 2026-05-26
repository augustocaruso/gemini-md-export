# Tab Orchestrator Runtime Epoch FSM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a centralized tab orchestrator that treats browser tabs, extension runtime freshness, leases, recovery, and diagnostics as explicit TypeScript FSMs. The first slice must prevent stale heartbeats or old content-script runtimes from satisfying readiness, especially for `gemini_ready`, `gemini_tabs reload`, and My Activity scans.

**Architecture:** Pure TypeScript FSM modules produce state transitions plus declarative effects. The existing MCP server remains the runtime executor: it collects observed browser state, asks the FSMs for a plan, runs effects through existing bridge/native-broker helpers, and returns diagnostics derived from the FSM history.

**Tech Stack:** TypeScript source under `src/mcp/tab-orchestrator/`, Node MCP runtime in `src/mcp-server.js`, existing TS build output under `build/ts/`, Node test runner with `.mjs` tests, existing native broker and Chrome extension guard helpers.

---

## Implementation Contract

All new pure workflow, policy, readiness, lifecycle, lease, and recovery logic in this slice must be TypeScript FSM logic. Pure scalar helpers are allowed only when they are called by a state transition or evidence classifier.

The executor may be JavaScript if it must live in `src/mcp-server.js`, but every decision it applies must come from a TypeScript FSM result:

```ts
export type FsmTransition<State, Event, Effect> = {
  state: State;
  effects: Effect[];
};

export type FsmReducer<State, Event, Effect> = (
  state: State,
  event: Event,
) => FsmTransition<State, Event, Effect>;
```

Readiness must be evidence-strength based:

- Strong evidence: current service-worker/native-broker runtime info, persistent command channel in the expected epoch, or validated debugger/native snapshot.
- Weak evidence: heartbeat-only content script signal.
- Rejected evidence: stale build, stale epoch, stale timestamp, mismatched protocol, missing command channel for an operation that requires commands.

Old heartbeat after an extension reload must not satisfy runtime readiness. `Extension context invalidated` means reload started; it is not proof that the new runtime is ready.

---

## Files To Add

- `src/mcp/tab-orchestrator/types.ts`
- `src/mcp/tab-orchestrator/runtime-epoch-fsm.ts`
- `src/mcp/tab-orchestrator/recovery-fsm.ts`
- `src/mcp/tab-orchestrator/tab-lifecycle-fsm.ts`
- `src/mcp/tab-orchestrator/orchestrator.ts`
- `src/mcp/tab-orchestrator/executor.ts`
- `src/mcp/tab-orchestrator/index.ts`
- `tests/tab-orchestrator-fsm.test.mjs`
- `tests/tab-orchestrator-executor.test.mjs`

## Files To Modify

- `src/mcp-server.js`
- `tests/mcp-command-channel.test.mjs`
- `tests/native-browser-broker.test.mjs`
- `AGENTS.md`
- `CLAUDE.md`

---

## Task 1: Add The Shared FSM Types And Runtime Evidence Classifier

**Files:**

- Create `src/mcp/tab-orchestrator/types.ts`
- Create `src/mcp/tab-orchestrator/runtime-epoch-fsm.ts`
- Create `src/mcp/tab-orchestrator/index.ts`
- Create `tests/tab-orchestrator-fsm.test.mjs`

**Steps:**

- [ ] Add failing tests for runtime evidence strength.
- [ ] Add shared TypeScript types for clients, expected runtime, evidence, effects, and orchestrator modes.
- [ ] Add runtime epoch helpers that classify observed clients without side effects.
- [ ] Export the new modules through `index.ts`.
- [ ] Run the focused test and confirm it fails before implementation, then passes after implementation.

**Test skeleton:**

```js
// tests/tab-orchestrator-fsm.test.mjs
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
```

**Implementation shape:**

```ts
// src/mcp/tab-orchestrator/types.ts
export type TabOrchestratorMode =
  | 'diagnostic'
  | 'interactive'
  | 'job_safe'
  | 'activity_scan';

export type RuntimeEvidenceStrength = 'rejected' | 'weak' | 'strong';

export type ExpectedExtensionRuntime = {
  extensionVersion?: string | null;
  buildStamp?: string | null;
  protocolVersion?: number | string | null;
};

export type ObservedTabClient = {
  clientId?: string | null;
  tabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  source?: string | null;
  page?: { kind?: string | null; url?: string | null } | null;
  extensionVersion?: string | null;
  buildStamp?: string | null;
  protocolVersion?: number | string | null;
  lastSeenAt?: number | null;
  eventStreamConnected?: boolean | null;
  commandPollPending?: boolean | null;
  pendingCommandPoll?: boolean | null;
  commandChannelStatus?: string | null;
  tabClaim?: { claimId?: string | null; sessionId?: string | null } | null;
};

export type RuntimeEpochEvidence = {
  clientId: string | null;
  tabId: number | null;
  pageKind: string | null;
  epochId: string;
  expectedEpochId: string;
  strength: RuntimeEvidenceStrength;
  hasCommandChannel: boolean;
  observedAtMs: number;
  rejectReason?: string;
  details: Record<string, unknown>;
};

export type DesiredRuntimeEvidence = {
  requiredEpochId: string;
  minStrength: Exclude<RuntimeEvidenceStrength, 'rejected'>;
  requireCommandChannel: boolean;
};

export type TabOrchestratorEffect =
  | { type: 'extension.reloadSelf'; reason: string; clientId?: string | null }
  | { type: 'serviceWorker.selfHeal'; reason: string; target?: string }
  | { type: 'browser.open'; reason: string; url: string; pageKind?: string }
  | { type: 'tab.reload'; reason: string; tabId?: number | null; url?: string | null }
  | { type: 'tab.claim'; reason: string; tabId?: number | null; claimId: string }
  | { type: 'runtime.waitForEpoch'; reason: string; epochId: string; timeoutMs: number }
  | { type: 'diagnostic.record'; reason: string; code: string; severity: 'info' | 'warning' | 'error' };

export type FsmTransition<State, Event, Effect> = {
  state: State;
  effects: Effect[];
};
```

```ts
// src/mcp/tab-orchestrator/runtime-epoch-fsm.ts
import type {
  DesiredRuntimeEvidence,
  ExpectedExtensionRuntime,
  ObservedTabClient,
  RuntimeEpochEvidence,
} from './types.js';

const STALE_CLIENT_MS = 30_000;

function valueOrUnknown(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'unknown';
  return String(value);
}

export function runtimeEpochId(expected: ExpectedExtensionRuntime): string {
  return [
    `ext:${valueOrUnknown(expected.extensionVersion)}`,
    `build:${valueOrUnknown(expected.buildStamp)}`,
    `protocol:${valueOrUnknown(expected.protocolVersion)}`,
  ].join('|');
}

export function clientRuntimeEpochId(client: ObservedTabClient): string {
  return runtimeEpochId({
    extensionVersion: client.extensionVersion,
    buildStamp: client.buildStamp,
    protocolVersion: client.protocolVersion,
  });
}

export function clientHasCommandChannel(client: ObservedTabClient): boolean {
  return Boolean(
    client.eventStreamConnected ||
      client.commandPollPending ||
      client.pendingCommandPoll ||
      client.commandChannelStatus === 'ready',
  );
}

export function classifyRuntimeEvidence(args: {
  client: ObservedTabClient;
  expected: ExpectedExtensionRuntime;
  nowMs: number;
}): RuntimeEpochEvidence {
  const expectedEpochId = runtimeEpochId(args.expected);
  const epochId = clientRuntimeEpochId(args.client);
  const lastSeenAt = Number(args.client.lastSeenAt || 0);
  const stale = lastSeenAt > 0 && args.nowMs - lastSeenAt > STALE_CLIENT_MS;
  const hasCommandChannel = clientHasCommandChannel(args.client);
  const base = {
    clientId: args.client.clientId ?? null,
    tabId: args.client.tabId ?? null,
    pageKind: args.client.page?.kind ?? null,
    epochId,
    expectedEpochId,
    hasCommandChannel,
    observedAtMs: args.nowMs,
    details: {
      extensionVersion: args.client.extensionVersion ?? null,
      buildStamp: args.client.buildStamp ?? null,
      protocolVersion: args.client.protocolVersion ?? null,
      lastSeenAt: args.client.lastSeenAt ?? null,
      source: args.client.source ?? null,
    },
  };

  if (epochId !== expectedEpochId) {
    return { ...base, strength: 'rejected', rejectReason: 'runtime_epoch_mismatch' };
  }
  if (stale) {
    return { ...base, strength: 'rejected', rejectReason: 'client_stale' };
  }
  if (hasCommandChannel) {
    return { ...base, strength: 'strong' };
  }
  return { ...base, strength: 'weak' };
}

export function runtimeEvidenceSatisfiesDesired(
  evidence: RuntimeEpochEvidence,
  desired: DesiredRuntimeEvidence,
): boolean {
  if (evidence.strength === 'rejected') return false;
  if (evidence.epochId !== desired.requiredEpochId) return false;
  if (desired.requireCommandChannel && !evidence.hasCommandChannel) return false;
  if (desired.minStrength === 'strong') return evidence.strength === 'strong';
  return evidence.strength === 'weak' || evidence.strength === 'strong';
}
```

```ts
// src/mcp/tab-orchestrator/index.ts
export * from './types.js';
export * from './runtime-epoch-fsm.js';
```

**Commands:**

```bash
npm run build:ts
node --test tests/tab-orchestrator-fsm.test.mjs
```

**Expected output:**

The focused test file passes. Before implementation, it fails because `build/ts/mcp/tab-orchestrator/index.js` does not exist.

---

## Task 2: Add The Runtime Recovery FSM

**Files:**

- Modify `src/mcp/tab-orchestrator/types.ts`
- Create `src/mcp/tab-orchestrator/recovery-fsm.ts`
- Modify `src/mcp/tab-orchestrator/index.ts`
- Modify `tests/tab-orchestrator-fsm.test.mjs`

**Steps:**

- [ ] Add tests for reload-started, invalidated-context, stale heartbeat, timeout, and recovery success.
- [ ] Add a pure recovery state machine that separates "reload requested" from "new epoch observed".
- [ ] Emit recovery effects instead of running side effects directly.
- [ ] Keep all timeout/backoff/quarantine decisions inside the FSM state.

**Test additions:**

```js
import {
  initialRecoveryState,
  reduceRuntimeRecovery,
} from '../build/ts/mcp/tab-orchestrator/index.js';

test('extension context invalidated moves recovery to awaiting runtime epoch', () => {
  const result = reduceRuntimeRecovery(initialRecoveryState({
    desiredEpochId: runtimeEpochId(expected),
    nowMs: 1000,
  }), {
    type: 'extensionContextInvalidated',
    nowMs: 1100,
    message: 'Extension context invalidated.',
  });

  assert.equal(result.state.status, 'awaiting_runtime_epoch');
  assert.deepEqual(result.effects.map((effect) => effect.type), [
    'runtime.waitForEpoch',
    'serviceWorker.selfHeal',
  ]);
});

test('old heartbeat while awaiting runtime epoch does not complete recovery', () => {
  const start = reduceRuntimeRecovery(initialRecoveryState({
    desiredEpochId: runtimeEpochId(expected),
    nowMs: 1000,
  }), {
    type: 'extensionContextInvalidated',
    nowMs: 1100,
    message: 'Extension context invalidated.',
  }).state;

  const result = reduceRuntimeRecovery(start, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1200,
    evidence: {
      clientId: 'old',
      tabId: 1,
      pageKind: 'activity',
      epochId: 'ext:1.2.3|build:old|protocol:2',
      expectedEpochId: runtimeEpochId(expected),
      strength: 'rejected',
      hasCommandChannel: true,
      observedAtMs: 1200,
      rejectReason: 'runtime_epoch_mismatch',
      details: {},
    },
  });

  assert.equal(result.state.status, 'awaiting_runtime_epoch');
  assert.equal(result.effects.at(-1).type, 'diagnostic.record');
  assert.equal(result.effects.at(-1).code, 'stale_runtime_ignored');
});

test('strong evidence for desired epoch completes recovery', () => {
  const start = reduceRuntimeRecovery(initialRecoveryState({
    desiredEpochId: runtimeEpochId(expected),
    nowMs: 1000,
  }), {
    type: 'extensionContextInvalidated',
    nowMs: 1100,
    message: 'Extension context invalidated.',
  }).state;

  const result = reduceRuntimeRecovery(start, {
    type: 'runtimeEvidenceObserved',
    nowMs: 1300,
    evidence: {
      clientId: 'new',
      tabId: 1,
      pageKind: 'activity',
      epochId: runtimeEpochId(expected),
      expectedEpochId: runtimeEpochId(expected),
      strength: 'strong',
      hasCommandChannel: true,
      observedAtMs: 1300,
      details: {},
    },
  });

  assert.equal(result.state.status, 'ready');
  assert.equal(result.effects.length, 0);
});
```

**Implementation shape:**

```ts
// src/mcp/tab-orchestrator/recovery-fsm.ts
import type {
  FsmTransition,
  RuntimeEpochEvidence,
  TabOrchestratorEffect,
} from './types.js';

export type RuntimeRecoveryStatus =
  | 'idle'
  | 'reload_requested'
  | 'awaiting_runtime_epoch'
  | 'ready'
  | 'quarantined'
  | 'failed';

export type RuntimeRecoveryState = {
  status: RuntimeRecoveryStatus;
  desiredEpochId: string;
  startedAtMs: number;
  updatedAtMs: number;
  attempts: number;
  rejectedEvidenceCount: number;
  lastReason?: string;
};

export type RuntimeRecoveryEvent =
  | { type: 'reloadRequested'; nowMs: number; reason: string }
  | { type: 'extensionContextInvalidated'; nowMs: number; message: string }
  | { type: 'runtimeEvidenceObserved'; nowMs: number; evidence: RuntimeEpochEvidence }
  | { type: 'timeout'; nowMs: number }
  | { type: 'manualAbort'; nowMs: number; reason: string };

export function initialRecoveryState(args: {
  desiredEpochId: string;
  nowMs: number;
}): RuntimeRecoveryState {
  return {
    status: 'idle',
    desiredEpochId: args.desiredEpochId,
    startedAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    attempts: 0,
    rejectedEvidenceCount: 0,
  };
}

export function reduceRuntimeRecovery(
  state: RuntimeRecoveryState,
  event: RuntimeRecoveryEvent,
): FsmTransition<RuntimeRecoveryState, RuntimeRecoveryEvent, TabOrchestratorEffect> {
  switch (event.type) {
    case 'reloadRequested':
      return {
        state: {
          ...state,
          status: 'reload_requested',
          updatedAtMs: event.nowMs,
          attempts: state.attempts + 1,
          lastReason: event.reason,
        },
        effects: [
          { type: 'extension.reloadSelf', reason: event.reason },
          {
            type: 'runtime.waitForEpoch',
            reason: 'reload_requested_wait_for_desired_epoch',
            epochId: state.desiredEpochId,
            timeoutMs: 8_000,
          },
        ],
      };

    case 'extensionContextInvalidated':
      return {
        state: {
          ...state,
          status: 'awaiting_runtime_epoch',
          updatedAtMs: event.nowMs,
          lastReason: 'extension_context_invalidated',
        },
        effects: [
          {
            type: 'runtime.waitForEpoch',
            reason: 'extension_context_invalidated_wait_for_new_epoch',
            epochId: state.desiredEpochId,
            timeoutMs: 8_000,
          },
          {
            type: 'serviceWorker.selfHeal',
            reason: 'extension_context_invalidated',
            target: 'extension-runtime',
          },
        ],
      };

    case 'runtimeEvidenceObserved':
      if (
        event.evidence.epochId === state.desiredEpochId &&
        event.evidence.strength === 'strong' &&
        event.evidence.hasCommandChannel
      ) {
        return {
          state: { ...state, status: 'ready', updatedAtMs: event.nowMs },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          status:
            state.status === 'idle' ? 'awaiting_runtime_epoch' : state.status,
          updatedAtMs: event.nowMs,
          rejectedEvidenceCount: state.rejectedEvidenceCount + 1,
          lastReason: event.evidence.rejectReason || 'insufficient_runtime_evidence',
        },
        effects: [
          {
            type: 'diagnostic.record',
            severity: 'warning',
            code: 'stale_runtime_ignored',
            reason: event.evidence.rejectReason || 'insufficient_runtime_evidence',
          },
        ],
      };

    case 'timeout':
      if (state.attempts >= 2 || state.rejectedEvidenceCount >= 3) {
        return {
          state: {
            ...state,
            status: 'quarantined',
            updatedAtMs: event.nowMs,
            lastReason: 'runtime_epoch_timeout',
          },
          effects: [
            {
              type: 'diagnostic.record',
              severity: 'error',
              code: 'runtime_epoch_timeout',
              reason: 'desired_runtime_epoch_not_observed',
            },
          ],
        };
      }
      return {
        state: {
          ...state,
          status: 'awaiting_runtime_epoch',
          updatedAtMs: event.nowMs,
          attempts: state.attempts + 1,
          lastReason: 'runtime_epoch_timeout_retry',
        },
        effects: [
          {
            type: 'serviceWorker.selfHeal',
            reason: 'runtime_epoch_timeout_retry',
            target: 'extension-runtime',
          },
          {
            type: 'runtime.waitForEpoch',
            reason: 'runtime_epoch_timeout_retry',
            epochId: state.desiredEpochId,
            timeoutMs: 8_000,
          },
        ],
      };

    case 'manualAbort':
      return {
        state: {
          ...state,
          status: 'failed',
          updatedAtMs: event.nowMs,
          lastReason: event.reason,
        },
        effects: [
          {
            type: 'diagnostic.record',
            severity: 'error',
            code: 'runtime_recovery_aborted',
            reason: event.reason,
          },
        ],
      };
  }
}
```

**Command:**

```bash
npm run build:ts && node --test tests/tab-orchestrator-fsm.test.mjs
```

**Expected output:**

The recovery tests pass and no side effects are executed by the FSM itself.

---

## Task 3: Add Tab Lifecycle, Lease, And Allocation FSM

**Files:**

- Modify `src/mcp/tab-orchestrator/types.ts`
- Create `src/mcp/tab-orchestrator/tab-lifecycle-fsm.ts`
- Modify `src/mcp/tab-orchestrator/index.ts`
- Modify `tests/tab-orchestrator-fsm.test.mjs`

**Steps:**

- [ ] Add tests for preferred ready tab, page-kind mismatch, quarantine skip, and ambiguous tabs.
- [ ] Add a pure tab lifecycle reducer.
- [ ] Add an allocation function that chooses an existing tab only when it satisfies the requested page kind and runtime evidence.
- [ ] Represent leases as desired state, not as an implicit MCP fallback.

**Test additions:**

```js
import {
  allocateTabForPurpose,
  initialTabPoolState,
  reduceTabLifecycle,
} from '../build/ts/mcp/tab-orchestrator/index.js';

test('allocation skips quarantined tabs and page kind mismatches', () => {
  const pool = initialTabPoolState({
    desiredEpochId: runtimeEpochId(expected),
    nowMs: 1000,
  });
  const activityEvidence = {
    clientId: 'activity-ready',
    tabId: 10,
    pageKind: 'activity',
    epochId: runtimeEpochId(expected),
    expectedEpochId: runtimeEpochId(expected),
    strength: 'strong',
    hasCommandChannel: true,
    observedAtMs: 1000,
    details: {},
  };
  const chatEvidence = {
    ...activityEvidence,
    clientId: 'chat-ready',
    tabId: 11,
    pageKind: 'gemini-chat',
  };

  const withActivity = reduceTabLifecycle(pool, {
    type: 'tabObserved',
    nowMs: 1000,
    evidence: activityEvidence,
  }).state;
  const withChat = reduceTabLifecycle(withActivity, {
    type: 'tabObserved',
    nowMs: 1000,
    evidence: chatEvidence,
  }).state;
  const quarantined = reduceTabLifecycle(withChat, {
    type: 'tabQuarantined',
    nowMs: 1001,
    tabId: 11,
    reason: 'command_channel_stuck',
  }).state;

  const allocation = allocateTabForPurpose(quarantined, {
    purpose: 'activity_scan',
    pageKind: 'activity',
    requireStrongRuntime: true,
    allowCreate: false,
    claimId: 'claim-activity',
  });

  assert.equal(allocation.status, 'allocated');
  assert.equal(allocation.tabId, 10);
  assert.deepEqual(allocation.effects.map((effect) => effect.type), ['tab.claim']);
});
```

**Implementation shape:**

```ts
// src/mcp/tab-orchestrator/tab-lifecycle-fsm.ts
import type {
  FsmTransition,
  RuntimeEpochEvidence,
  TabOrchestratorEffect,
} from './types.js';

export type TabLifecycleStatus =
  | 'observed'
  | 'ready'
  | 'busy'
  | 'reloading'
  | 'quarantined';

export type ManagedTab = {
  tabId: number | null;
  clientId: string | null;
  pageKind: string | null;
  status: TabLifecycleStatus;
  evidence: RuntimeEpochEvidence;
  leaseClaimId?: string;
  quarantineReason?: string;
  updatedAtMs: number;
};

export type TabPoolState = {
  desiredEpochId: string;
  tabs: ManagedTab[];
  updatedAtMs: number;
};

export type TabLifecycleEvent =
  | { type: 'tabObserved'; nowMs: number; evidence: RuntimeEpochEvidence }
  | { type: 'tabBusy'; nowMs: number; tabId: number | null; reason: string }
  | { type: 'tabReleased'; nowMs: number; tabId: number | null; claimId?: string }
  | { type: 'tabQuarantined'; nowMs: number; tabId: number | null; reason: string };

export type TabAllocationRequest = {
  purpose: string;
  pageKind: string;
  requireStrongRuntime: boolean;
  allowCreate: boolean;
  createUrl?: string;
  claimId: string;
};

export type TabAllocationResult =
  | { status: 'allocated'; tabId: number | null; clientId: string | null; effects: TabOrchestratorEffect[] }
  | { status: 'needs_create'; effects: TabOrchestratorEffect[] }
  | { status: 'ambiguous'; candidates: ManagedTab[]; effects: TabOrchestratorEffect[] }
  | { status: 'unavailable'; reason: string; effects: TabOrchestratorEffect[] };

export function initialTabPoolState(args: {
  desiredEpochId: string;
  nowMs: number;
}): TabPoolState {
  return { desiredEpochId: args.desiredEpochId, tabs: [], updatedAtMs: args.nowMs };
}

function tabKey(tab: ManagedTab): string {
  return tab.tabId === null ? `client:${tab.clientId}` : `tab:${tab.tabId}`;
}

function managedTabFromEvidence(
  evidence: RuntimeEpochEvidence,
  nowMs: number,
): ManagedTab {
  const ready =
    evidence.epochId === evidence.expectedEpochId &&
    evidence.strength === 'strong' &&
    evidence.hasCommandChannel;
  return {
    tabId: evidence.tabId,
    clientId: evidence.clientId,
    pageKind: evidence.pageKind,
    status: ready ? 'ready' : 'observed',
    evidence,
    updatedAtMs: nowMs,
  };
}

export function reduceTabLifecycle(
  state: TabPoolState,
  event: TabLifecycleEvent,
): FsmTransition<TabPoolState, TabLifecycleEvent, TabOrchestratorEffect> {
  if (event.type === 'tabObserved') {
    const nextTab = managedTabFromEvidence(event.evidence, event.nowMs);
    const nextKey = tabKey(nextTab);
    return {
      state: {
        ...state,
        tabs: [
          ...state.tabs.filter((tab) => tabKey(tab) !== nextKey),
          nextTab,
        ],
        updatedAtMs: event.nowMs,
      },
      effects: [],
    };
  }

  const tabs = state.tabs.map((tab) => {
    const matches = tab.tabId === event.tabId;
    if (!matches) return tab;
    if (event.type === 'tabBusy') {
      return { ...tab, status: 'busy' as const, updatedAtMs: event.nowMs };
    }
    if (event.type === 'tabReleased') {
      return { ...tab, status: 'ready' as const, leaseClaimId: undefined, updatedAtMs: event.nowMs };
    }
    return {
      ...tab,
      status: 'quarantined' as const,
      quarantineReason: event.reason,
      updatedAtMs: event.nowMs,
    };
  });
  return { state: { ...state, tabs, updatedAtMs: event.nowMs }, effects: [] };
}

export function allocateTabForPurpose(
  state: TabPoolState,
  request: TabAllocationRequest,
): TabAllocationResult {
  const candidates = state.tabs.filter((tab) => {
    if (tab.pageKind !== request.pageKind) return false;
    if (tab.status === 'quarantined' || tab.status === 'busy') return false;
    if (request.requireStrongRuntime) {
      return tab.evidence.strength === 'strong' && tab.evidence.hasCommandChannel;
    }
    return tab.evidence.strength !== 'rejected';
  });

  if (candidates.length === 1) {
    const tab = candidates[0];
    return {
      status: 'allocated',
      tabId: tab.tabId,
      clientId: tab.clientId,
      effects: [
        {
          type: 'tab.claim',
          reason: `allocate_${request.purpose}`,
          tabId: tab.tabId,
          claimId: request.claimId,
        },
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates,
      effects: [
        {
          type: 'diagnostic.record',
          severity: 'warning',
          code: 'ambiguous_tab_allocation',
          reason: request.purpose,
        },
      ],
    };
  }
  if (request.allowCreate && request.createUrl) {
    return {
      status: 'needs_create',
      effects: [
        {
          type: 'browser.open',
          reason: `create_tab_for_${request.purpose}`,
          url: request.createUrl,
          pageKind: request.pageKind,
        },
      ],
    };
  }
  return {
    status: 'unavailable',
    reason: 'no_ready_tab_for_purpose',
    effects: [
      {
        type: 'diagnostic.record',
        severity: 'warning',
        code: 'no_ready_tab_for_purpose',
        reason: request.purpose,
      },
    ],
  };
}
```

**Command:**

```bash
npm run build:ts && node --test tests/tab-orchestrator-fsm.test.mjs
```

**Expected output:**

The tab lifecycle tests pass. The FSM returns allocation effects but does not call Chrome, the native broker, or MCP helpers directly.

---

## Task 4: Add The High-Level Orchestrator Planner

**Files:**

- Create `src/mcp/tab-orchestrator/orchestrator.ts`
- Modify `src/mcp/tab-orchestrator/index.ts`
- Modify `tests/tab-orchestrator-fsm.test.mjs`

**Steps:**

- [ ] Add tests for diagnostic readiness, My Activity scan readiness, and job-safe behavior.
- [ ] Build an orchestrator snapshot from observed clients and expected runtime.
- [ ] Return a readiness result with `ready`, `blocker`, `effects`, `evidence`, and `diagnostics`.
- [ ] Make stale runtime evidence produce a blocker instead of a ready state.

**Test additions:**

```js
import {
  planTabOrchestration,
} from '../build/ts/mcp/tab-orchestrator/index.js';

test('activity scan plan blocks stale runtime and emits recovery effects', () => {
  const result = planTabOrchestration({
    mode: 'activity_scan',
    expected,
    nowMs: 2000,
    desiredPageKind: 'activity',
    purpose: 'my_activity_scan',
    claimId: 'activity-claim',
    clients: [
      {
        clientId: 'old-activity',
        tabId: 1,
        extensionVersion: '1.2.3',
        buildStamp: '20260526-1100',
        protocolVersion: 2,
        lastSeenAt: 1900,
        eventStreamConnected: true,
        page: { kind: 'activity' },
      },
    ],
    allowCreate: false,
  });

  assert.equal(result.ready, false);
  assert.equal(result.blocker?.code, 'runtime_epoch_not_ready');
  assert.equal(
    result.effects.some((effect) => effect.type === 'serviceWorker.selfHeal'),
    true,
  );
});

test('diagnostic mode reports weak heartbeat without claiming readiness', () => {
  const result = planTabOrchestration({
    mode: 'diagnostic',
    expected,
    nowMs: 2000,
    desiredPageKind: 'activity',
    purpose: 'diagnostic',
    claimId: 'diagnostic-claim',
    clients: [
      {
        clientId: 'weak',
        tabId: 1,
        extensionVersion: '1.2.3',
        buildStamp: '20260526-1200',
        protocolVersion: 2,
        lastSeenAt: 1900,
        eventStreamConnected: false,
        page: { kind: 'activity' },
      },
    ],
    allowCreate: false,
  });

  assert.equal(result.ready, false);
  assert.equal(result.blocker?.code, 'command_channel_not_ready');
  assert.equal(result.evidence[0].strength, 'weak');
});
```

**Implementation shape:**

```ts
// src/mcp/tab-orchestrator/orchestrator.ts
import {
  classifyRuntimeEvidence,
  runtimeEpochId,
} from './runtime-epoch-fsm.js';
import {
  allocateTabForPurpose,
  initialTabPoolState,
  reduceTabLifecycle,
} from './tab-lifecycle-fsm.js';
import {
  initialRecoveryState,
  reduceRuntimeRecovery,
} from './recovery-fsm.js';
import type {
  ExpectedExtensionRuntime,
  ObservedTabClient,
  RuntimeEpochEvidence,
  TabOrchestratorEffect,
  TabOrchestratorMode,
} from './types.js';

export type TabOrchestrationRequest = {
  mode: TabOrchestratorMode;
  expected: ExpectedExtensionRuntime;
  nowMs: number;
  desiredPageKind: string;
  purpose: string;
  claimId: string;
  clients: ObservedTabClient[];
  allowCreate: boolean;
  createUrl?: string;
};

export type TabOrchestrationBlocker = {
  code:
    | 'runtime_epoch_not_ready'
    | 'command_channel_not_ready'
    | 'no_ready_tab_for_purpose'
    | 'ambiguous_tabs';
  message: string;
  severity: 'info' | 'warning' | 'error';
};

export type TabOrchestrationResult = {
  ready: boolean;
  blocker: TabOrchestrationBlocker | null;
  effects: TabOrchestratorEffect[];
  evidence: RuntimeEpochEvidence[];
  selected?: { tabId: number | null; clientId: string | null };
  diagnostics: Record<string, unknown>;
};

function requiredStrengthForMode(
  mode: TabOrchestratorMode,
): 'weak' | 'strong' {
  return mode === 'diagnostic' ? 'strong' : 'strong';
}

export function planTabOrchestration(
  request: TabOrchestrationRequest,
): TabOrchestrationResult {
  const desiredEpochId = runtimeEpochId(request.expected);
  const evidence = request.clients.map((client) =>
    classifyRuntimeEvidence({
      client,
      expected: request.expected,
      nowMs: request.nowMs,
    }),
  );

  let pool = initialTabPoolState({
    desiredEpochId,
    nowMs: request.nowMs,
  });
  for (const item of evidence) {
    pool = reduceTabLifecycle(pool, {
      type: 'tabObserved',
      nowMs: request.nowMs,
      evidence: item,
    }).state;
  }

  const allocation = allocateTabForPurpose(pool, {
    purpose: request.purpose,
    pageKind: request.desiredPageKind,
    requireStrongRuntime: requiredStrengthForMode(request.mode) === 'strong',
    allowCreate: request.allowCreate,
    createUrl: request.createUrl,
    claimId: request.claimId,
  });

  const strongDesiredEvidence = evidence.find(
    (item) =>
      item.epochId === desiredEpochId &&
      item.strength === 'strong' &&
      item.hasCommandChannel &&
      item.pageKind === request.desiredPageKind,
  );

  if (allocation.status === 'allocated' && strongDesiredEvidence) {
    return {
      ready: true,
      blocker: null,
      effects: allocation.effects,
      evidence,
      selected: { tabId: allocation.tabId, clientId: allocation.clientId },
      diagnostics: { desiredEpochId, allocationStatus: allocation.status },
    };
  }

  const rejected = evidence.some((item) => item.strength === 'rejected');
  const weak = evidence.some(
    (item) =>
      item.pageKind === request.desiredPageKind &&
      item.epochId === desiredEpochId &&
      item.strength === 'weak',
  );
  const recovery = initialRecoveryState({
    desiredEpochId,
    nowMs: request.nowMs,
  });
  const recoveryEvent = rejected || weak
    ? {
        type: 'runtimeEvidenceObserved' as const,
        nowMs: request.nowMs,
        evidence:
          evidence.find((item) => item.strength === 'rejected') ||
          evidence.find((item) => item.strength === 'weak')!,
      }
    : {
        type: 'timeout' as const,
        nowMs: request.nowMs,
      };
  const recoveryResult = reduceRuntimeRecovery(recovery, recoveryEvent);
  const effects = [...allocation.effects, ...recoveryResult.effects];

  if (allocation.status === 'ambiguous') {
    return {
      ready: false,
      blocker: {
        code: 'ambiguous_tabs',
        message: 'Mais de uma aba atende parcialmente ao pedido; escolha uma aba ou use uma claim explicita.',
        severity: 'warning',
      },
      effects,
      evidence,
      diagnostics: { desiredEpochId, allocationStatus: allocation.status },
    };
  }

  if (weak) {
    return {
      ready: false,
      blocker: {
        code: 'command_channel_not_ready',
        message: 'A extensao respondeu por heartbeat, mas ainda nao ha canal de comando forte no runtime esperado.',
        severity: 'warning',
      },
      effects,
      evidence,
      diagnostics: { desiredEpochId, allocationStatus: allocation.status },
    };
  }

  return {
    ready: false,
    blocker: {
      code: rejected ? 'runtime_epoch_not_ready' : 'no_ready_tab_for_purpose',
      message: rejected
        ? 'A aba observada pertence a outro runtime da extensao.'
        : 'Nao ha aba pronta para esta operacao.',
      severity: rejected ? 'error' : 'warning',
    },
    effects,
    evidence,
    diagnostics: {
      desiredEpochId,
      allocationStatus: allocation.status,
      recoveryStatus: recoveryResult.state.status,
    },
  };
}
```

**Command:**

```bash
npm run build:ts && node --test tests/tab-orchestrator-fsm.test.mjs
```

**Expected output:**

The planner tests pass and stale runtime evidence produces a `runtime_epoch_not_ready` blocker.

---

## Task 5: Add The Effect Executor Interface With Fake-Adapter Tests

**Files:**

- Create `src/mcp/tab-orchestrator/executor.ts`
- Modify `src/mcp/tab-orchestrator/index.ts`
- Create `tests/tab-orchestrator-executor.test.mjs`

**Steps:**

- [ ] Add fake-adapter tests that prove effects execute in order.
- [ ] Add an executor interface that maps declarative effects to adapter calls.
- [ ] Keep adapter implementation injectable so `src/mcp-server.js` can wire existing helpers without importing them into pure FSM modules.
- [ ] Return an execution report that can be attached to diagnostics.

**Test skeleton:**

```js
// tests/tab-orchestrator-executor.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeTabOrchestratorEffects,
} from '../build/ts/mcp/tab-orchestrator/index.js';

test('effect executor invokes adapter calls in order', async () => {
  const calls = [];
  const result = await executeTabOrchestratorEffects([
    { type: 'serviceWorker.selfHeal', reason: 'runtime_epoch_timeout_retry', target: 'extension-runtime' },
    { type: 'runtime.waitForEpoch', reason: 'wait', epochId: 'epoch-a', timeoutMs: 10 },
    { type: 'tab.claim', reason: 'allocate_activity', tabId: 7, claimId: 'claim-a' },
  ], {
    async reloadExtensionSelf(effect) { calls.push(['reloadExtensionSelf', effect.reason]); },
    async serviceWorkerSelfHeal(effect) { calls.push(['serviceWorkerSelfHeal', effect.target]); },
    async openBrowser(effect) { calls.push(['openBrowser', effect.url]); },
    async reloadTab(effect) { calls.push(['reloadTab', effect.tabId]); },
    async claimTab(effect) { calls.push(['claimTab', effect.tabId, effect.claimId]); },
    async waitForRuntimeEpoch(effect) { calls.push(['waitForRuntimeEpoch', effect.epochId]); },
    async recordDiagnostic(effect) { calls.push(['recordDiagnostic', effect.code]); },
  });

  assert.deepEqual(calls, [
    ['serviceWorkerSelfHeal', 'extension-runtime'],
    ['waitForRuntimeEpoch', 'epoch-a'],
    ['claimTab', 7, 'claim-a'],
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.executed.length, 3);
});
```

**Implementation shape:**

```ts
// src/mcp/tab-orchestrator/executor.ts
import type { TabOrchestratorEffect } from './types.js';

export type TabOrchestratorEffectAdapter = {
  reloadExtensionSelf(effect: Extract<TabOrchestratorEffect, { type: 'extension.reloadSelf' }>): Promise<unknown>;
  serviceWorkerSelfHeal(effect: Extract<TabOrchestratorEffect, { type: 'serviceWorker.selfHeal' }>): Promise<unknown>;
  openBrowser(effect: Extract<TabOrchestratorEffect, { type: 'browser.open' }>): Promise<unknown>;
  reloadTab(effect: Extract<TabOrchestratorEffect, { type: 'tab.reload' }>): Promise<unknown>;
  claimTab(effect: Extract<TabOrchestratorEffect, { type: 'tab.claim' }>): Promise<unknown>;
  waitForRuntimeEpoch(effect: Extract<TabOrchestratorEffect, { type: 'runtime.waitForEpoch' }>): Promise<unknown>;
  recordDiagnostic(effect: Extract<TabOrchestratorEffect, { type: 'diagnostic.record' }>): Promise<unknown>;
};

export type TabOrchestratorEffectExecution = {
  effect: TabOrchestratorEffect;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type TabOrchestratorEffectExecutionReport = {
  status: 'completed' | 'completed_with_errors';
  executed: TabOrchestratorEffectExecution[];
};

export async function executeTabOrchestratorEffects(
  effects: TabOrchestratorEffect[],
  adapter: TabOrchestratorEffectAdapter,
): Promise<TabOrchestratorEffectExecutionReport> {
  const executed: TabOrchestratorEffectExecution[] = [];
  for (const effect of effects) {
    try {
      let result: unknown;
      switch (effect.type) {
        case 'extension.reloadSelf':
          result = await adapter.reloadExtensionSelf(effect);
          break;
        case 'serviceWorker.selfHeal':
          result = await adapter.serviceWorkerSelfHeal(effect);
          break;
        case 'browser.open':
          result = await adapter.openBrowser(effect);
          break;
        case 'tab.reload':
          result = await adapter.reloadTab(effect);
          break;
        case 'tab.claim':
          result = await adapter.claimTab(effect);
          break;
        case 'runtime.waitForEpoch':
          result = await adapter.waitForRuntimeEpoch(effect);
          break;
        case 'diagnostic.record':
          result = await adapter.recordDiagnostic(effect);
          break;
      }
      executed.push({ effect, ok: true, result });
    } catch (error) {
      executed.push({
        effect,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    status: executed.every((item) => item.ok) ? 'completed' : 'completed_with_errors',
    executed,
  };
}
```

**Command:**

```bash
npm run build:ts && node --test tests/tab-orchestrator-executor.test.mjs
```

**Expected output:**

The executor tests pass and prove the FSM layer remains side-effect free.

---

## Task 6: Route `gemini_ready` Diagnostics Through The Orchestrator

**Files:**

- Modify `src/mcp-server.js`
- Modify `tests/mcp-command-channel.test.mjs`

**Steps:**

- [ ] Add a contract test proving `buildLightweightBrowserReady` includes orchestrator diagnostics.
- [ ] Import the compiled orchestrator module using the repo's existing `compiledTsModuleUrl(...)` pattern.
- [ ] In `buildLightweightBrowserReady(args)`, build an orchestrator plan from `connectedClients`, `EXPECTED_CHROME_EXTENSION_INFO`, and the current mode.
- [ ] Preserve existing response fields, and add a new `tabOrchestrator` object for diagnostics.
- [ ] Use the orchestrator blocker to improve `blockingIssue` when it is more precise than the legacy readiness blocker.

**Test shape:**

Add a test near the existing `buildLightweightBrowserReady` tests:

```js
test('buildLightweightBrowserReady reports tab orchestrator runtime epoch blocker for stale runtime', async () => {
  const { buildLightweightBrowserReady, setConnectedClientsForTest } =
    await import('../src/mcp-server.js');

  setConnectedClientsForTest([
    {
      clientId: 'old-activity',
      tabId: 1,
      extensionVersion: '1.2.3',
      buildStamp: 'old-build',
      protocolVersion: 2,
      lastSeenAt: Date.now(),
      eventStreamConnected: true,
      page: { kind: 'activity' },
    },
  ]);

  const result = await buildLightweightBrowserReady({
    action: 'status',
    diagnostic: true,
    selfHeal: false,
  });

  assert.equal(result.tabOrchestrator.ready, false);
  assert.equal(result.tabOrchestrator.blocker.code, 'runtime_epoch_not_ready');
});
```

Adjust the test harness to use existing test-only setters if the current file already exposes a different helper name. Keep the assertion focused on the new `tabOrchestrator` field.

**Implementation shape in `src/mcp-server.js`:**

```js
const {
  planTabOrchestration,
} = await import(compiledTsModuleUrl('mcp', 'tab-orchestrator', 'index.js'));
```

Inside `buildLightweightBrowserReady(args)` after `matchingClients` and legacy `readiness` are computed:

```js
  const tabOrchestrator = planTabOrchestration({
    mode: args?.action === 'check' ? 'diagnostic' : 'diagnostic',
    expected: EXPECTED_CHROME_EXTENSION_INFO,
    nowMs: Date.now(),
    desiredPageKind: 'gemini-chat',
    purpose: 'gemini_ready',
    claimId: `ready-${Date.now()}`,
    clients: connectedClientsArray(),
    allowCreate: Boolean(args?.wakeBrowser),
    createUrl: 'https://gemini.google.com/app',
  });
```

Add to the returned object:

```js
    tabOrchestrator: {
      ready: tabOrchestrator.ready,
      blocker: tabOrchestrator.blocker,
      effects: tabOrchestrator.effects,
      diagnostics: tabOrchestrator.diagnostics,
      evidence: tabOrchestrator.evidence.map((item) => ({
        clientId: item.clientId,
        tabId: item.tabId,
        pageKind: item.pageKind,
        epochId: item.epochId,
        strength: item.strength,
        hasCommandChannel: item.hasCommandChannel,
        rejectReason: item.rejectReason || null,
      })),
    },
```

When selecting `blockingIssue`, prefer:

```js
  const orchestratorBlockingIssue = tabOrchestrator.blocker
    ? {
        code: tabOrchestrator.blocker.code,
        message: tabOrchestrator.blocker.message,
        severity: tabOrchestrator.blocker.severity,
      }
    : null;
```

Only replace the legacy blocker when `orchestratorBlockingIssue.severity === 'error'` or when the legacy blocker is absent.

**Command:**

```bash
npm run build:ts
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "orchestrator|buildLightweightBrowserReady"
```

**Expected output:**

`gemini_ready` retains existing fields and gains `tabOrchestrator` diagnostics. A stale runtime no longer looks ready in the diagnostic layer.

---

## Task 7: Route `gemini_tabs reload` Through The Recovery Planner

**Files:**

- Modify `src/mcp-server.js`
- Modify `tests/native-browser-broker.test.mjs`
- Modify `tests/mcp-command-channel.test.mjs`

**Steps:**

- [ ] Add a test for `reloadGeminiTabs` where native broker reload succeeds but no desired runtime epoch appears.
- [ ] Represent reload as a recovery FSM event and expose the recovery status in the response.
- [ ] Preserve the existing native-broker-first behavior.
- [ ] Treat `Extension context invalidated` as `awaiting_runtime_epoch`, not success.

**Test shape:**

```js
test('reloadGeminiTabs reports awaiting runtime epoch after extension context invalidated', async () => {
  const result = await reloadGeminiTabs({
    diagnostic: true,
    waitMs: 50,
    useNativeBroker: true,
  });

  assert.equal(result.tabOrchestrator?.recovery?.status, 'awaiting_runtime_epoch');
  assert.equal(
    result.tabOrchestrator.effects.some((effect) => effect.type === 'runtime.waitForEpoch'),
    true,
  );
});
```

Use the existing fake native broker setup in `tests/native-browser-broker.test.mjs`. The fake broker should return the same shape as the real `tryNativeBrowserBrokerTabsAction('reload', args)` success path and then withhold a matching client so the FSM remains in `awaiting_runtime_epoch`.

**Implementation shape:**

Before returning from the native reload path in `reloadGeminiTabs(args = {})`, compute:

```js
  const desiredEpochId = runtimeEpochId(EXPECTED_CHROME_EXTENSION_INFO);
  const recoveryStart = initialRecoveryState({
    desiredEpochId,
    nowMs: Date.now(),
  });
  const recovery = reduceRuntimeRecovery(recoveryStart, {
    type: 'extensionContextInvalidated',
    nowMs: Date.now(),
    message: 'Extension context invalidated after reload',
  });
```

Attach:

```js
    tabOrchestrator: {
      recovery: recovery.state,
      effects: recovery.effects,
      desiredEpochId,
    },
```

If the function already waits for reconnecting clients, feed each classified evidence item back through `reduceRuntimeRecovery(..., { type: 'runtimeEvidenceObserved', ... })` and return `status: 'ready'` only after strong evidence for the desired epoch appears.

**Command:**

```bash
npm run build:ts
node --test tests/native-browser-broker.test.mjs tests/mcp-command-channel.test.mjs --test-name-pattern "reloadGeminiTabs|runtime epoch|orchestrator"
```

**Expected output:**

Reload responses distinguish "reload command accepted" from "new extension runtime ready".

---

## Task 8: Gate My Activity Scan Readiness With The Orchestrator

**Files:**

- Modify `src/mcp-server.js`
- Modify `tests/mcp-command-channel.test.mjs`

**Steps:**

- [ ] Add a test where My Activity has a stale content script heartbeat and `scanActivityWithClient` refuses to start.
- [ ] Add a test where My Activity has a strong matching runtime and scan proceeds.
- [ ] In `ensureActivityClientForScan(args)`, call the orchestrator before returning a client.
- [ ] Execute recovery effects only through the new executor adapter, using existing MCP helpers.
- [ ] Preserve public error compatibility by keeping existing error codes where external callers already rely on them, and include `tabOrchestrator` details in `error.data`.

**Test shape:**

```js
test('ensureActivityClientForScan rejects stale activity runtime before scan starts', async () => {
  setConnectedClientsForTest([
    {
      clientId: 'old-activity',
      tabId: 2,
      extensionVersion: '1.2.3',
      buildStamp: 'old-build',
      protocolVersion: 2,
      lastSeenAt: Date.now(),
      eventStreamConnected: true,
      page: { kind: 'activity' },
    },
  ]);

  await assert.rejects(
    () => ensureActivityClientForScan({ noLaunch: true }),
    (error) => {
      assert.equal(error?.code, 'activity_client_version_mismatch');
      assert.equal(error?.data?.tabOrchestrator?.blocker?.code, 'runtime_epoch_not_ready');
      return true;
    },
  );
});
```

**Implementation shape in `ensureActivityClientForScan(args = {})`:**

```js
  const tabOrchestrator = planTabOrchestration({
    mode: 'activity_scan',
    expected: EXPECTED_CHROME_EXTENSION_INFO,
    nowMs: Date.now(),
    desiredPageKind: 'activity',
    purpose: 'my_activity_scan',
    claimId: args.claimId || `activity-scan-${Date.now()}`,
    clients: connectedClientsArray(),
    allowCreate: !args.noLaunch,
    createUrl: MY_ACTIVITY_URL,
  });

  if (!tabOrchestrator.ready) {
    const execution = await executeTabOrchestratorEffects(
      tabOrchestrator.effects,
      createTabOrchestratorMcpAdapter(),
    );
    const error = activityClientVersionMismatchError(
      connectedClientsArray().filter((client) => client.page?.kind === 'activity'),
    );
    error.data = {
      ...(error.data || {}),
      tabOrchestrator: {
        ready: tabOrchestrator.ready,
        blocker: tabOrchestrator.blocker,
        diagnostics: tabOrchestrator.diagnostics,
        effectExecution: execution,
      },
    };
    throw error;
  }
```

The matching ready case should continue into the existing `requireActivityClient(...)` path. Keep this gate close to the start of `ensureActivityClientForScan` so `scanActivityWithClient` cannot enqueue `activity-scan-batch` against a stale runtime.

**Command:**

```bash
npm run build:ts
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "Activity|activity|runtime epoch|orchestrator"
```

**Expected output:**

My Activity scan does not start from weak or stale runtime evidence. Error output contains the orchestrator blocker and effect execution report.

---

## Task 9: Wire The MCP Effect Adapter

**Files:**

- Modify `src/mcp-server.js`
- Modify `tests/mcp-command-channel.test.mjs`

**Steps:**

- [ ] Add `createTabOrchestratorMcpAdapter()` inside `src/mcp-server.js`.
- [ ] Map each declarative effect to an existing helper.
- [ ] Make diagnostic effects append to an in-memory local array returned in the execution report.
- [ ] Keep all calls bounded by existing timeouts and cooldowns.

**Implementation shape:**

```js
function createTabOrchestratorMcpAdapter() {
  return {
    async reloadExtensionSelf(effect) {
      const clients = connectedClientsArray();
      const client = effect.clientId
        ? clients.find((item) => item.clientId === effect.clientId)
        : clients[0];
      if (!client) return { skipped: true, reason: 'no_client_for_reload_self' };
      return reloadChromeExtensionForClient(client, {
        reason: effect.reason,
        waitMs: 2500,
      });
    },
    async serviceWorkerSelfHeal(effect) {
      return tryNativeBrowserBrokerSelfHeal({
        reason: effect.reason,
        target: effect.target || 'extension-runtime',
      });
    },
    async openBrowser(effect) {
      return launchBrowserForBridge({
        url: effect.url,
        reason: effect.reason,
      });
    },
    async reloadTab(effect) {
      return tryNativeBrowserBrokerTabsAction('reload', {
        tabId: effect.tabId,
        url: effect.url,
        reason: effect.reason,
      });
    },
    async claimTab(effect) {
      return claimGeminiTab({
        tabId: effect.tabId,
        claimId: effect.claimId,
        reason: effect.reason,
      });
    },
    async waitForRuntimeEpoch(effect) {
      return waitForContinuationClientWithRecovery({
        expected: EXPECTED_CHROME_EXTENSION_INFO,
        timeoutMs: effect.timeoutMs,
        reason: effect.reason,
      });
    },
    async recordDiagnostic(effect) {
      return {
        recorded: true,
        severity: effect.severity,
        code: effect.code,
        reason: effect.reason,
      };
    },
  };
}
```

Adapt helper names to the current runtime names in `src/mcp-server.js`; do not duplicate native broker or browser launch logic. If a helper has a different signature, wrap it in this adapter instead of changing the helper globally.

**Command:**

```bash
npm run build:ts
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "orchestrator|Activity|reloadGeminiTabs"
```

**Expected output:**

The MCP server can execute orchestrator effects through existing runtime helpers, and tests prove no effect is silently ignored.

---

## Task 10: Document The New Project Policy

**Files:**

- Modify `AGENTS.md`
- Modify `CLAUDE.md`

**Steps:**

- [ ] Add a concise architecture rule to both files.
- [ ] Keep the language consistent between the mirrored project instructions.
- [ ] Do not replace existing TypeScript migration guidance; extend it.

**Text to add under the architecture section:**

```md
- **Nova politica de logica pura como FSM:** qualquer nova logica pura de workflow, readiness, recovery, alocacao de abas, leases, politicas de retry/backoff, lifecycle ou decisao operacional deve ser modelada como FSM TypeScript explicita: `transition(state, event) -> { state, effects }`. O executor pode continuar em JS/MCP quando precisa chamar navegador, native broker ou filesystem, mas a decisao que ele executa deve vir da FSM. Helpers puros escalares como parse, normalizacao, hash, score ou formatacao podem ser funcoes comuns se nao carregam lifecycle ou politica temporal.
```

**Command:**

```bash
rg -n "Nova politica de logica pura como FSM|transition\\(state, event\\)" AGENTS.md CLAUDE.md
```

**Expected output:**

Both instruction files contain the same policy text.

---

## Task 11: Full Verification

**Files:**

- No new files.

**Steps:**

- [ ] Run the TypeScript build.
- [ ] Run the focused orchestrator tests.
- [ ] Run the existing MCP/native broker contract tests touched by this slice.
- [ ] Run the broader test suite if the focused tests pass.
- [ ] Inspect `git diff` to confirm only intended files changed.

**Commands:**

```bash
npm run build:ts
node --test tests/tab-orchestrator-fsm.test.mjs tests/tab-orchestrator-executor.test.mjs
node --test tests/mcp-command-channel.test.mjs tests/native-browser-broker.test.mjs --test-name-pattern "orchestrator|runtime epoch|Activity|activity|reloadGeminiTabs|buildLightweightBrowserReady"
npm test
git diff -- src/mcp/tab-orchestrator src/mcp-server.js tests/tab-orchestrator-fsm.test.mjs tests/tab-orchestrator-executor.test.mjs tests/mcp-command-channel.test.mjs tests/native-browser-broker.test.mjs AGENTS.md CLAUDE.md
```

**Expected output:**

- `npm run build:ts` exits `0`.
- Focused orchestrator tests exit `0`.
- MCP/native broker contract tests exit `0`.
- `npm test` exits `0`, or any pre-existing unrelated failures are listed with exact failing test names and evidence.
- `git diff` shows only the orchestrator implementation, integration points, tests, and project-policy documentation.

---

## Task 12: Manual Runtime Smoke After Tests Pass

**Files:**

- No code files.

**Steps:**

- [ ] Confirm no export job is active.
- [ ] Run bridge diagnostics.
- [ ] Run `gemini_ready` status and inspect `tabOrchestrator`.
- [ ] Trigger reload diagnostics and confirm the response distinguishes reload accepted from runtime ready.
- [ ] Run My Activity date import without Takeout and confirm stale runtime evidence blocks the scan before a batch starts.

**Commands:**

```bash
node scripts/bridge-smoke.mjs --bridge-url http://127.0.0.1:47283 --json
```

Then call the MCP tools from the local session:

```json
{ "action": "status", "diagnostic": true, "selfHeal": true }
```

for `gemini_ready`, and:

```json
{ "action": "reload", "intent": "tab_management", "diagnostic": true }
```

for `gemini_tabs`.

For My Activity-only date import, run the repo's existing export command or MCP path with Takeout omitted:

```json
{ "action": "recent", "useMyActivity": true, "noMyActivity": false, "takeout": "", "limit": 5 }
```

**Expected output:**

- Bridge smoke passes.
- `gemini_ready` includes `tabOrchestrator.ready`, `tabOrchestrator.blocker`, and runtime evidence.
- `gemini_tabs reload` reports recovery status as `awaiting_runtime_epoch` until strong evidence for the expected epoch appears.
- My Activity scan either starts with strong current runtime evidence or fails before enqueueing a scan with a `tabOrchestrator.blocker.code` such as `runtime_epoch_not_ready` or `command_channel_not_ready`.

---

## Completion Criteria

- Pure orchestrator decisions live in TypeScript FSM modules.
- No new runtime policy is hidden directly in `src/mcp-server.js`.
- Stale heartbeats cannot satisfy readiness for `gemini_ready`, `gemini_tabs reload`, or My Activity scan.
- Reload success and runtime readiness are distinct states in diagnostics.
- My Activity scanning cannot begin until a strong command-capable runtime in the desired epoch exists.
- Tests cover the FSM transitions, effect executor, and MCP integration points.
- `AGENTS.md` and `CLAUDE.md` document the new FSM policy.
