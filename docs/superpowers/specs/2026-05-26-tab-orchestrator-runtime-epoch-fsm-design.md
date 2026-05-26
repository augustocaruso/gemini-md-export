# Tab Orchestrator Runtime Epoch FSM Design

Date: 2026-05-26
Status: Approved design, awaiting written-spec review

## Context

The exporter already has several browser-control mechanisms: content-script
heartbeat, long-poll/SSE command channels, native broker, service-worker
self-heal, tab claims, and My Activity companion tabs. These pieces work in many
normal cases, but they are not coordinated by one policy owner.

The failure that motivated this design was a stale My Activity content script:
the unpacked extension files had been updated on disk, but Dia continued to send
heartbeats from the previous build. The automatic self-reload reached the
`Extension context invalidated` phase, which normally means a reload was in
progress, but the next ready runtime did not arrive. The scan correctly blocked
with a build mismatch, but the recovery path did not converge the browser to the
desired state.

The root problem is broader than extension reload. Commands still reason about
tabs through scattered fallback logic. A robust solution needs a central tab
orchestrator that manages desired state, observed state, leases, runtime epochs,
recovery, quarantine, and diagnostics as explicit finite state machines.

## Decision

Create a TypeScript-first Tab Orchestrator whose pure decision logic is modeled
as finite state machines.

New pure logic that models workflow state, recovery, allocation, readiness,
leases, blockers, retries, or runtime lifecycle must be implemented as explicit
TypeScript FSMs. Pure utility helpers such as date parsers, ID normalizers,
hashing, and scoring can remain simple functions when they do not own a
stateful workflow.

The orchestrator becomes the official owner for selecting, creating,
resurrecting, allocating, and retiring browser tabs. Heavy browser operations
must request a lease from the orchestrator instead of selecting the newest
heartbeat or a loosely matching client.

## Scope Boundary

This design does not replace the native broker, service worker, bridge, or
content scripts. It centralizes policy and readiness decisions above those
mechanisms.

Non-goals:

- redesigning the export UI;
- changing Markdown extraction;
- changing My Activity date matching rules;
- removing existing compatibility paths in the first implementation slice;
- creating a new browser automation backend.

First implementation slice:

1. Add pure FSM modules and transition tests.
2. Add an executor interface with fake adapters for tests.
3. Route `gemini_ready` and `gemini_tabs reload` diagnostics through the
   orchestrator.
4. Route My Activity scan readiness through the orchestrator so stale runtime
   evidence cannot start a scan.

Recent export integration can follow once the readiness and recovery contracts
are proven in those smaller surfaces.

## Architecture

```text
Operation
  -> Tab Orchestrator
    -> pure FSMs
      -> effects
        -> Recovery Executor
          -> native broker / service worker / bridge / content script
```

The FSMs are pure. They do not call `chrome.*`, `fetch`, native broker, timers,
or filesystem. They return the next state plus typed effects. The executor runs
those effects and feeds results back as events.

The initial orchestrator should be composed from smaller FSMs:

- `RuntimeEpochFSM`: expected build/protocol generation and evidence freshness.
- `TabLifecycleFSM`: discovered, classified, ready, stale, busy, blocked,
  discarded, or quarantined tab states.
- `LeaseFSM`: requested, allocated, active, releasing, released, expired, or
  failed operation leases.
- `RecoveryFSM`: diagnose, reload extension, self-heal service worker, reinject
  content scripts, reload managed tabs, wait for epoch, succeed, or fail.
- `OperationTabFSM`: operation-level preparation of Gemini and My Activity tabs
  before export, scan, list, or diagnostics commands.

The Tab Orchestrator composes these machines and exposes one main contract:

```ts
ensureTabs({
  operation: 'export_recent' | 'my_activity_scan' | 'diagnostics',
  needs: ['gemini'] | ['my_activity'] | ['gemini', 'my_activity'],
  expectedRuntime,
  recoveryPolicy,
  sessionId,
  jobId,
  claimId,
});
```

It returns either a ready lease with verified tabs or a typed blocker with the
final state, recovery history, and next action.

## Desired And Observed State

The orchestrator must separate desired state from observed evidence.

Desired state is what the caller needs. Examples:

- one exportable Gemini tab in the expected runtime epoch;
- one My Activity companion tab in the same visual claim group;
- a live command channel for a heavy DOM operation;
- no Google login or verification blocker;
- recovery limited to the current job lease.

Observed state is everything the system has seen, including stale evidence:

- raw `chrome.tabs` inventory;
- native broker inspection;
- service-worker runtime status;
- content-script persistent channel status;
- heartbeat payloads;
- page snapshots;
- Google Sorry/login classification;
- previous failures and quarantine metadata.

Readiness is only true when observed state satisfies desired state using
evidence allowed by the active policy.

## Evidence Strength

The FSM must classify evidence explicitly:

- Strong: native broker or service-worker status from the current runtime,
  persistent channel opened in the expected epoch, validated debugger snapshot.
- Medium: direct extension info response from a content script that is already
  in the expected epoch.
- Weak: stale heartbeat, cached client inventory, tab title, tab URL, or old
  snapshot.
- Terminal: Google verification, Google login, missing permission, wrong
  unpacked path, unsupported browser control, or explicit user-disabled browser
  side effects.

Heavy commands cannot become ready from weak evidence alone. Heartbeats remain
useful for compatibility and diagnostics, but after WebSocket/SSE/native broker
support they are not the canonical readiness signal.

## Runtime Epoch Barrier

Every expected extension runtime has an epoch derived from version, protocol,
build stamp, and recovery attempt generation. When the expected build changes or
the orchestrator initiates reload, a new epoch is created.

Rules:

- clients from older epochs remain visible for diagnostics;
- old heartbeats never satisfy readiness for a new epoch;
- a tab becomes ready only after strong or medium evidence for the expected
  epoch;
- `Extension context invalidated` is treated as evidence that reload started,
  not as proof that the new epoch is ready;
- if only old-heartbeat evidence returns after reload, the FSM escalates
  recovery instead of accepting the tab.

This directly prevents stale content scripts from being reused after local
extension updates.

## Allocation And Creation Policy

The orchestrator owns tab allocation:

- prefer an existing ready tab;
- prefer a tab already leased to the same operation;
- prefer the same window or visual claim group for Gemini and My Activity;
- do not allocate a busy tab to another operation;
- do not use My Activity as a Gemini export target;
- do not create duplicate My Activity companion tabs when a valid companion
  exists;
- honor caller limits such as `maxNewTabs`;
- classify login and Google verification as blockers, not retryable creation
  failures.

Creation is explicit. If a valid tab does not exist and policy allows opening
one, the executor opens the exact URL, associates it with the operation, waits
for strong evidence in the expected epoch, and either returns a lease or a typed
blocker.

## Recovery Ladder

Recovery is an ordered FSM, not scattered fallbacks. A typical ladder is:

1. Classify tabs through native broker and current clients.
2. Reject stale-epoch clients for readiness.
3. Query extension/service-worker status.
4. Request extension self-reload.
5. Create a new runtime epoch.
6. Ask service worker/native broker to self-heal content scripts.
7. Reinject content scripts into managed tabs when safe.
8. Reload only tabs owned by the current lease or allowed policy.
9. Wait for a persistent channel or service-worker/native evidence in the new
   epoch.
10. Validate page classification and blockers.
11. Return ready lease or terminal blocker.

The ladder must be budgeted. It records each attempted effect and stops when the
operation policy forbids further mutation.

## Recovery Policies

Recovery behavior depends on context:

- `none`: diagnostics only; do not mutate browser state.
- `conservative`: no new tabs and no broad reload; reinject or inspect only
  when safe.
- `job_safe`: mutate only tabs owned by the current job lease; never disturb
  unrelated tabs.
- `interactive_aggressive`: manual diagnostics may reload/reinject managed tabs
  and create missing tabs when the caller explicitly allows it.

Export jobs should use `job_safe`. Browser status and explicit tab-management
commands can use `interactive_aggressive` only when the user requested browser
side effects.

## Quarantine And Backoff

Tabs that repeatedly fail recovery enter quarantine with:

- `quarantinedUntil`;
- failure code history;
- last recovery plan;
- retry count;
- next allowed action.

The allocator excludes quarantined tabs unless the caller explicitly requests a
diagnostic override. This prevents loops that repeatedly select the same stale
or blocked tab.

## Effects Contract

FSM effects are typed and executable by adapters:

```ts
type Effect =
  | { type: 'extension.reload'; reason: string; expectedEpoch: string }
  | { type: 'runtime.waitForEpoch'; epoch: string; timeoutMs: number }
  | { type: 'serviceWorker.selfHeal'; tabIds: number[]; reason: string }
  | { type: 'content.inject'; tabId: number; expectedEpoch: string }
  | { type: 'tab.reload'; tabId: number; scope: 'lease_only' | 'managed' }
  | { type: 'tab.open'; kind: 'gemini' | 'my_activity'; url: string }
  | { type: 'tab.claim'; tabIds: number[]; claimId: string }
  | { type: 'tab.quarantine'; tabId: number; code: string; ttlMs: number }
  | { type: 'diagnostic.record'; code: string; detail?: unknown };
```

Adapters translate effects to existing mechanisms: native broker, service
worker messages, content-script commands, HTTP bridge, and CLI endpoints.

## Diagnostics

Diagnostics must be derived from FSM history rather than assembled from
scattered catch blocks. Each transition records:

- previous state;
- event;
- next state;
- effects emitted;
- effect result;
- evidence used;
- reason code.

Final public messages should identify the failing layer and action:

- files updated but browser runtime still old;
- service worker unreachable;
- content script from old epoch still sending weak heartbeat;
- native broker unavailable;
- tab blocked by Google verification;
- tab in wrong profile or wrong unpacked path;
- recovery budget exhausted.

## Integration Plan

The implementation should be incremental:

1. Add pure FSM modules and tests without changing runtime behavior.
2. Add an executor that maps FSM effects to existing native broker,
   service-worker, bridge, and content-script operations.
3. Route `gemini_ready` through the orchestrator for diagnostics first.
4. Route `gemini_tabs list/claim/reload` through the orchestrator.
5. Route My Activity scan preparation through the orchestrator.
6. Route recent export companion preparation through the orchestrator.
7. Deprecate direct selection by newest heartbeat in heavy operations.
8. Keep compatibility fallback paths explicit and visible in diagnostics.

## Testing

Unit tests must cover the pure FSMs:

- stale build plus old heartbeat does not become ready;
- `Extension context invalidated` moves recovery to awaiting new epoch;
- new persistent channel in expected epoch becomes ready;
- old heartbeat after reload escalates recovery;
- Google Sorry and login become terminal blockers;
- repeated recovery failure quarantines a tab;
- allocator prefers existing ready tab before opening a new one;
- allocator rejects My Activity as Gemini export target;
- job-safe policy mutates only leased tabs;
- aggressive diagnostic policy can create or reload managed tabs.

Contract tests must cover endpoints:

- `gemini_ready` reports stale epoch separately from no client;
- `gemini_tabs reload` can recover without relying on content-script heartbeat;
- My Activity scan refuses stale clients and requests orchestrator recovery;
- recent export cannot start from weak evidence;
- recovery history appears in reports without leaking prompt text.

Real smoke:

1. Build and sync the unpacked extension.
2. Leave a My Activity tab running an old content script.
3. Start the bridge with browser side effects allowed.
4. Run browser status with self-heal.
5. Confirm the orchestrator rejects old heartbeat evidence.
6. Confirm recovery reaches a new runtime epoch or returns a precise blocker.
7. Run My Activity-only date scan after readiness is proven.

## Success Criteria

- Heavy browser operations obtain tabs only through orchestrator leases.
- Stale heartbeat cannot satisfy readiness after a runtime epoch change.
- Extension reload recovery either reaches a proven new epoch or returns a typed
  blocker with exact next action.
- My Activity companion tabs are reused, created, or quarantined predictably.
- Export jobs mutate only their leased tabs during recovery.
- Tab allocation does not create avoidable duplicate Gemini or My Activity tabs.
- Diagnostics explain browser state in plain language while preserving detailed
  operator evidence.
- New workflow state logic is TypeScript FSM logic with transition tests and
  effect contracts.
