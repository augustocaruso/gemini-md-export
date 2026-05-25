# Export Runtime Refactor Phase 1 Design

Date: 2026-05-24
Status: approved design, pending implementation plan

## Goal

Refactor the Gemini export runtime so a batch export is a sequence of auditable conversation operations instead of a loose loop of browser commands.

The immediate product goal is to make `export recent` safe and understandable:

- dates are resolved by default whenever possible;
- progress counters do not lie or duplicate themselves;
- one slow conversation cannot silently hold the whole batch;
- cancellation aborts the active browser operation instead of waiting indefinitely;
- tab locks are cleaned deterministically;
- a Gemini `/app` home tab can be claimed for recent-chat export when command/sidebar state is ready;
- terminal progress in the browser dock stops cleanly.

## Scope

Phase 1 implements the structural export runtime refactor for recent-chat export.

In scope:

- new typed contracts for batch targets, conversation operations, operation progress, terminal outcomes, and receipts;
- a scheduler that owns batch order, retries, skip/fail/continue policy, and global cancellation;
- a per-conversation operation pipeline;
- abortable navigation and hydration;
- date resolution as a normal export stage;
- canonical progress fields shared by CLI, MCP job reports, and browser dock;
- deterministic lock lifecycle tied to `operationId`;
- lifecycle distinction between tabs claimable for recent export and tabs claimable for current-chat export;
- minimal documentation of the local unpacked-extension test protocol.

Out of scope for Phase 1:

- fully automated syncing of the local build into the loaded unpacked-extension folder;
- a new CLI command such as `gemini-md-export browser sync-extension --reload`;
- migration of every notebook/direct export path to the new runtime if that would expand the implementation beyond the recent-export safety work;
- release/version bump work.

Those runtime-environment automation items belong to Phase 2.

## Current Problems

The current implementation has several symptoms that share one root cause: there is no single authoritative unit called "export this conversation and return one terminal result".

Observed problems:

- progress labels mix batch position, history index, and human text, causing redundant labels like `25 de 30` in two places;
- `--start-index` can make visible progress clamp at `30/30` while the loop is still processing later batch positions;
- cancellation marks intent but waits for the content script command to return;
- `tab_operation_in_progress` can remain visible until a stuck command eventually resolves;
- dates can be skipped by CLI defaults even though the public contract says to import dates whenever possible;
- MCP terminal progress can remain visible in the browser dock after completion;
- lifecycle checks treat `/app/<chatId>` and `/app` too similarly, even though recent export only needs a ready Gemini app/sidebar, not a current chat.

## Architecture

Phase 1 separates the export runtime into explicit units.

### Export Scheduler

The scheduler owns the job-level policy:

- normalize the batch into ordered targets;
- apply `startIndex`, `maxChats`, skip-existing, retry, and failure-continuation policy;
- create one conversation operation per target;
- stop starting new operations when the job is cancelled;
- decide when the job is `completed`, `completed_with_errors`, `failed`, or `cancelled`;
- persist partial/final reports.

The scheduler is the only layer allowed to decide whether the batch continues after a conversation fails.

### Conversation Operation

A conversation operation is the central unit of work. It receives one normalized target and returns exactly one terminal outcome:

- `saved`;
- `failed`;
- `skipped`;
- `cancelled`.

It emits structured progress during execution and records timings, warnings, hashes, date receipts, and failure codes.

Required stages:

1. `opening`
2. `hydrating`
3. `extracting`
4. `resolving_dates`
5. `saving`
6. terminal outcome

### Navigation Adapter

The navigation adapter opens and validates the target conversation.

It must prove one of these:

- the target chat is already current and hydrated enough;
- the target chat was opened by URL or row click and then hydrated;
- navigation failed with a concrete code.

It must not save files, resolve dates, or decide batch policy.

### Hydration Adapter

The hydration adapter loads the conversation DOM to the required safe point and reports progress.

It must:

- accept an `AbortSignal`;
- emit progress when turn count, scroll state, or hydration phase changes;
- expose `lastProgressAt`;
- return a terminal hydration receipt;
- fail with a clear code when progress stalls.

### Extraction Adapter

The extraction adapter transforms a hydrated DOM into an export payload.

It must include identity and integrity evidence:

- `chatId`;
- URL;
- title;
- turn count;
- DOM/content signature;
- markdown hash or equivalent payload hash;
- warnings.

The operation must not save if `payload.chatId` does not match `targetChatId`.

### Date Resolver

Date resolution is a normal stage of export, not an optional post-process hidden behind CLI flags.

Rules:

- default is to attempt date resolution whenever possible;
- if Takeout is supplied, use Takeout first;
- My Activity is used only for Takeout gaps;
- `--no-my-activity` explicitly disables My Activity fallback;
- if date resolution fails, the conversation may still be saved, but the receipt must say why dates are absent.

Receipt statuses:

- `matched`;
- `unmatched`;
- `source_gap`;
- `source_mismatch`;
- `disabled_by_user`;
- `resolver_failed`.

### Save Writer

The writer only writes the payload, assets, and report fragments. It does not navigate, hydrate, resolve dates, or decide whether the batch continues.

Before writing markdown, the operation must have:

- target identity validated;
- hydration receipt terminal and safe;
- extraction receipt;
- date receipt or explicit date absence receipt.

### Progress Presenter

The presenter renders progress from canonical fields. It does not own job policy.

Canonical progress fields:

```ts
type ExportProgressSnapshot = {
  jobId: string;
  operationId?: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  phase: string;
  batchPosition?: number;
  batchTotal?: number;
  historyIndex?: number;
  title?: string;
  targetChatId?: string;
  currentChatId?: string;
  message?: string;
  lastProgressAt?: number;
  errorCount?: number;
};
```

UI rules:

- `batchPosition/batchTotal` is the only source for user-visible `N de M`;
- `historyIndex` is diagnostic/report-only;
- the browser dock shows the count once;
- the title/action line never repeats the count;
- terminal dock state disables shimmer and closes after a short visual hold;
- MCP can retain terminal progress for diagnostics, but the browser dock must not keep blinking because of terminal replay.

## Data Flow

The batch starts with normalized targets:

```ts
type ExportBatchTarget = {
  batchPosition: number;
  batchTotal: number;
  historyIndex?: number;
  targetChatId: string;
  title?: string;
  source: 'sidebar' | 'notebook' | 'direct';
  url?: string;
};
```

For each target, the scheduler creates:

```ts
type ConversationOperationContext = {
  jobId: string;
  operationId: string;
  target: ExportBatchTarget;
  abortSignal: AbortSignal;
  deadlines: {
    noProgressMs: number;
    hydrationMs: number;
    totalOperationMs: number;
  };
  progressSink: (snapshot: ExportProgressSnapshot) => void;
};
```

The operation returns:

```ts
type ConversationOperationResult =
  | { status: 'saved'; operationId: string; chatId: string; filePath: string; receipts: object }
  | { status: 'failed'; operationId: string; chatId?: string; code: string; error: string; receipts: object }
  | { status: 'skipped'; operationId: string; chatId: string; reason: string; receipts: object }
  | { status: 'cancelled'; operationId: string; chatId?: string; reason: string; receipts: object };
```

The report stores one terminal entry per target. Partial reports must be useful even after cancellation or process failure.

## Cancellation

Cancellation has two levels:

- job cancellation stops the scheduler from starting new operations;
- operation cancellation aborts the currently active browser operation.

The content script maintains one `AbortController` for the active operation. `cancel-active-operation` must call `controller.abort(reason)` for the matching `operationId` and publish an immediate lock/progress update.

Long-running stages must observe the abort signal:

- navigation waits;
- hydration loops;
- extraction work that can yield;
- asset fetching where practical.

If a stage cannot abort immediately because a browser primitive is not cancellable, it must still mark the operation as abort requested and let the scheduler apply the no-progress timeout.

## Watchdog

Each conversation operation tracks `lastProgressAt`.

Progress events that refresh it include:

- operation started;
- target URL opened;
- route/chat identity changed;
- hydration turn count increased;
- hydration terminalized;
- extraction started/finished;
- date resolution started/finished;
- save started/finished.

If `now - lastProgressAt > noProgressMs`, the scheduler records a failure with code `conversation_no_progress_timeout`, requests abort for the active operation, releases/cleans the tab lock, and continues to the next target unless job cancellation was requested.

The watchdog is per conversation, not only per job.

## Locks

`activeTabOperation` is tied to `operationId`:

```ts
type ActiveTabOperation = {
  operationId: string;
  jobId: string;
  targetChatId?: string;
  phase: string;
  startedAt: number;
  lastProgressAt: number;
  cancelRequestedAt?: number;
  abortReason?: string;
};
```

Lock rules:

- one active tab operation per tab;
- terminal outcome clears the lock immediately;
- cancellation updates and aborts the matching operation;
- orphaned locks past a TTL are reaped with receipt `operation_lock_reaped`;
- old commands must either be wrapped in a compatible operation or rejected while a new operation is active.

## Tab Lifecycle

The lifecycle model must distinguish current-chat readiness from recent-export readiness.

`claimable_for_current_chat` requires:

- active Gemini tab;
- expected extension version/protocol/build;
- command channel ready;
- no active operation;
- current `/app/<chatId>` route or equivalent proven current chat.

`claimable_for_recent_export` requires:

- active Gemini tab;
- expected extension version/protocol/build;
- command channel ready;
- no active operation;
- Gemini `/app` or `/app/<chatId>` route;
- sidebar/list conversation state already hydrated or openable by command.

This allows `export recent` to use `https://gemini.google.com/app` without a current chat ID, while `get-current-chat` still requires a specific chat.

## Local Unpacked-Extension Protocol

This is an operational protocol for agents testing local builds, not product auto-update.

Before running a browser-backed test against an unpacked extension:

1. Build the project.
2. Identify the unpacked extension path actually loaded by the browser diagnostics.
3. Synchronize the new `dist/extension/` files into that loaded path.
4. Reload the browser extension runtime.
5. Reload or reconnect Gemini tabs.
6. Confirm runtime version/build stamp matches the source before testing.

If diagnostics show source/build newer than runtime and the loaded path is known, the agent must not keep retrying self-reload against stale files. The next action is to sync the loaded folder first.

Phase 2 should automate this protocol with a CLI command and more actionable diagnostics.

## Testing Strategy

Unit tests:

- progress view model separates `batchPosition` from `historyIndex`;
- date import defaults to enabled unless explicitly disabled;
- Takeout-first/My Activity fallback precedence;
- conversation operation terminal result shapes;
- no-progress watchdog decision;
- lock cleanup and orphan lock reaping;
- lifecycle classifies `/app` as claimable for recent export but not current-chat export.

Content script tests:

- `cancel-active-operation` aborts the operation controller;
- hydration observes abort;
- terminal progress stops shimmer and dismisses the dock;
- duplicate count text is not rendered in the dock label.

MCP/job tests:

- a single timed-out conversation is recorded as failed and the batch continues;
- cancellation does not wait for a stuck operation forever;
- partial reports include terminal entries per target;
- CLI does not pass `useMyActivity: false` by default.

Smoke/manual validation:

- sync loaded unpacked extension path before browser tests;
- run `export recent --max-chats 30` from a Gemini `/app` tab;
- confirm 30 terminal entries in report;
- confirm no duplicated progress count;
- confirm no ghost dock after terminal state;
- confirm date receipts are present.

## Migration Plan Shape

Implementation should be staged:

1. Add contracts and pure view-model/runtime tests without switching behavior.
2. Introduce Conversation Operation for recent-chat export.
3. Move recent export scheduler to the operation pipeline.
4. Wire abort, watchdog, lock cleanup, and canonical progress.
5. Wire date resolver defaults and receipts.
6. Update diagnostics and minimal operational docs for unpacked-extension testing.
7. Keep notebook/direct export compatibility paths until they can be migrated safely.

Each step should leave tests passing and should avoid broad unrelated refactors.
