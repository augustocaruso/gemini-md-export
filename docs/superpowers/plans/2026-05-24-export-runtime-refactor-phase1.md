# Export Runtime Refactor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor recent-chat export into auditable per-conversation operations with canonical progress, default date resolution, abortable cancellation, deterministic tab locks, and `/app` recent-export readiness.

**Architecture:** Add small TypeScript modules for operation contracts, lock/watchdog policy, and conversation-operation orchestration, then adapt `src/mcp-server.js` and `src/userscript-shell.ts` to consume those contracts. The scheduler remains MCP-owned, the browser content script remains DOM-owned, and progress rendering becomes a pure view-model concern.

**Tech Stack:** Node.js ESM, TypeScript compiled into `build/ts`, MV3 content script TypeScript, Node test runner, existing MCP bridge over HTTP/SSE/WebSocket.

---

## Execution Notes

- The current workspace may contain unrelated WebSocket changes. During implementation, do not commit unrelated dirty files. Prefer a new worktree through `superpowers:using-git-worktrees` if the current branch is still dirty.
- Run `npm run build:ts` before tests that import `build/ts/*`.
- Source of truth for browser runtime changes is `src/userscript-shell.ts`, not generated `build/ts/userscript-shell.js` or `dist/`.
- `src/mcp-server.js` may import new TypeScript modules through `../build/ts/...` only after `npm run build:ts`.
- Keep each task commit scoped to files listed in that task.

## File Structure

Create these focused modules:

- `src/mcp/export-operation-contracts.ts`
  - Pure types and helpers for batch targets, operation IDs, progress snapshots, date receipt status, terminal operation results.
- `src/mcp/export-operation-lock.ts`
  - Pure helpers for active tab operation state, cancel requests, progress updates, terminal cleanup, and stale lock reaping.
- `src/mcp/export-operation-watchdog.ts`
  - Pure no-progress watchdog decisions for one conversation operation.
- `src/mcp/conversation-operation-runner.ts`
  - Dependency-injected orchestration for one conversation: opening, hydrating/extracting through browser command, resolving dates, saving, terminal result.
- `docs/reference/local-unpacked-extension-testing.md`
  - Operational protocol for agents testing local unpacked extension builds.

Modify these existing files:

- `bin/gemini-md-export.mjs`
  - Stop defaulting `useMyActivity` to false. Leave absent value absent so MCP runtime default applies.
- `src/core/progress-view-model.ts`
  - Prefer canonical `batchPosition/batchTotal`; keep `historyIndex` diagnostic; strip duplicated count fragments from labels.
- `src/mcp/client-lifecycle.ts`
  - Add capability-aware lifecycle: current-chat claimability versus recent-export claimability.
- `src/userscript-shell.ts`
  - Add operation IDs and `AbortController` to active tab operations; make cancel call abort; publish lock changes immediately; pass abort/progress into hydration.
- `src/mcp-server.js`
  - Normalize recent export targets with batch position and history index; run each target through the operation runner; add per-operation watchdog; record terminal entries.
- `AGENTS.md`
  - Add a concise pointer to the local unpacked-extension testing protocol.

Add or extend these tests:

- `tests/export-operation-contracts.test.mjs`
- `tests/export-operation-lock.test.mjs`
- `tests/export-operation-watchdog.test.mjs`
- `tests/conversation-operation-runner.test.mjs`
- `tests/progress-view-model.test.mjs`
- `tests/mcp-client-lifecycle.test.mjs`
- `tests/mcp-command-channel.test.mjs`
- `tests/gemini-cli-tui.test.mjs`
- `tests/content-script.test.mjs`

---

### Task 1: Add Operation Contracts

**Files:**
- Create: `src/mcp/export-operation-contracts.ts`
- Create: `tests/export-operation-contracts.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/export-operation-contracts.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExportBatchTargets,
  buildOperationId,
  isTerminalOperationStatus,
  makeOperationProgressSnapshot,
  operationResultFromError,
} from '../build/ts/mcp/export-operation-contracts.js';

test('buildExportBatchTargets separates batch position from history index', () => {
  const targets = buildExportBatchTargets(
    [
      { conversation: { chatId: 'aaa111aaa111', title: 'Primeira' }, index: 6 },
      { conversation: { id: 'bbb222bbb222', title: 'Segunda' }, index: 7 },
    ],
    { batchTotal: 2, source: 'sidebar' },
  );

  assert.deepEqual(targets, [
    {
      batchPosition: 1,
      batchTotal: 2,
      historyIndex: 6,
      targetChatId: 'aaa111aaa111',
      title: 'Primeira',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/aaa111aaa111',
    },
    {
      batchPosition: 2,
      batchTotal: 2,
      historyIndex: 7,
      targetChatId: 'bbb222bbb222',
      title: 'Segunda',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/bbb222bbb222',
    },
  ]);
});

test('operation ids are deterministic and safe for traces', () => {
  assert.equal(
    buildOperationId({
      jobId: 'job-12345678',
      batchPosition: 25,
      targetChatId: 'abcdef0123456789',
    }),
    'job-12345678:025:abcdef0123456789',
  );
});

test('makeOperationProgressSnapshot emits canonical count fields only', () => {
  const snapshot = makeOperationProgressSnapshot({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    phase: 'hydrating',
    status: 'running',
    target: {
      batchPosition: 1,
      batchTotal: 30,
      historyIndex: 6,
      targetChatId: 'aaa111aaa111',
      title: 'Caso CPRE',
      source: 'sidebar',
      url: 'https://gemini.google.com/app/aaa111aaa111',
    },
    message: 'Carregando início da conversa',
    now: 1000,
  });

  assert.equal(snapshot.batchPosition, 1);
  assert.equal(snapshot.batchTotal, 30);
  assert.equal(snapshot.historyIndex, 6);
  assert.equal(snapshot.message, 'Carregando início da conversa');
  assert.equal(snapshot.targetChatId, 'aaa111aaa111');
  assert.equal(snapshot.lastProgressAt, 1000);
});

test('terminal status and error result helpers are stable', () => {
  assert.equal(isTerminalOperationStatus('saved'), true);
  assert.equal(isTerminalOperationStatus('failed'), true);
  assert.equal(isTerminalOperationStatus('running'), false);

  const err = Object.assign(new Error('travou'), { code: 'conversation_no_progress_timeout' });
  assert.deepEqual(
    operationResultFromError({
      operationId: 'op-1',
      targetChatId: 'aaa111aaa111',
      error: err,
      receipts: { navigation: { ok: false } },
    }),
    {
      status: 'failed',
      operationId: 'op-1',
      chatId: 'aaa111aaa111',
      code: 'conversation_no_progress_timeout',
      error: 'travou',
      receipts: { navigation: { ok: false } },
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build:ts && node --test tests/export-operation-contracts.test.mjs
```

Expected: FAIL with `Cannot find module '../build/ts/mcp/export-operation-contracts.js'`.

- [ ] **Step 3: Implement the contracts**

Create `src/mcp/export-operation-contracts.ts`:

```ts
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';

export type ExportBatchTargetSource = 'sidebar' | 'notebook' | 'direct';

export type ExportBatchTarget = {
  batchPosition: number;
  batchTotal: number;
  historyIndex?: number | null;
  targetChatId: string;
  title?: string | null;
  source: ExportBatchTargetSource;
  url?: string | null;
};

export type OperationProgressStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ConversationOperationStatus = 'saved' | 'failed' | 'skipped' | 'cancelled';

export type ExportProgressSnapshot = {
  jobId: string;
  operationId?: string | null;
  status: OperationProgressStatus;
  phase: string;
  batchPosition?: number | null;
  batchTotal?: number | null;
  historyIndex?: number | null;
  title?: string | null;
  targetChatId?: string | null;
  currentChatId?: string | null;
  message?: string | null;
  lastProgressAt?: number | null;
  errorCount?: number | null;
};

export type ConversationOperationTerminalResult =
  | {
      status: 'saved';
      operationId: string;
      chatId: string;
      filePath: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'failed';
      operationId: string;
      chatId?: string | null;
      code: string;
      error: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'skipped';
      operationId: string;
      chatId: string;
      reason: string;
      receipts: Record<string, unknown>;
    }
  | {
      status: 'cancelled';
      operationId: string;
      chatId?: string | null;
      reason: string;
      receipts: Record<string, unknown>;
    };

type RawConversationItem = {
  conversation?: Record<string, unknown>;
  index?: number | string | null;
};

type BuildTargetsOptions = {
  batchTotal?: number | null;
  source?: ExportBatchTargetSource;
};

const normalizeChatId = (value: unknown): string | null => parseChatId(String(value || ''));

const chatIdForConversation = (conversation: Record<string, unknown>): string | null =>
  normalizeChatId(conversation.chatId) ||
  normalizeChatId(conversation.id) ||
  normalizeChatId(conversation.url);

const titleForConversation = (conversation: Record<string, unknown>): string | null => {
  const title = String(conversation.title || conversation.label || '').trim();
  return title || null;
};

export const buildExportBatchTargets = (
  items: RawConversationItem[] = [],
  { batchTotal = null, source = 'sidebar' }: BuildTargetsOptions = {},
): ExportBatchTarget[] => {
  const resolvedTotal = Math.max(0, Number(batchTotal || items.length || 0));
  return items
    .map((item, offset) => {
      const conversation = item.conversation || {};
      const targetChatId = chatIdForConversation(conversation);
      if (!targetChatId) return null;
      const historyIndex =
        item.index === null || item.index === undefined || item.index === ''
          ? null
          : Number(item.index);
      const url =
        typeof conversation.url === 'string' && parseChatId(conversation.url)
          ? conversation.url
          : canonicalGeminiChatUrl(targetChatId);
      return {
        batchPosition: offset + 1,
        batchTotal: resolvedTotal || items.length,
        historyIndex: Number.isFinite(historyIndex) ? historyIndex : null,
        targetChatId,
        title: titleForConversation(conversation),
        source,
        url,
      } satisfies ExportBatchTarget;
    })
    .filter((target): target is ExportBatchTarget => Boolean(target));
};

export const buildOperationId = ({
  jobId,
  batchPosition,
  targetChatId,
}: {
  jobId: string;
  batchPosition: number;
  targetChatId: string;
}): string =>
  `${String(jobId || 'job').slice(0, 12)}:${String(Math.max(0, batchPosition)).padStart(3, '0')}:${targetChatId}`;

export const makeOperationProgressSnapshot = ({
  jobId,
  operationId = null,
  status = 'running',
  phase,
  target,
  message = null,
  currentChatId = null,
  errorCount = null,
  now = Date.now(),
}: {
  jobId: string;
  operationId?: string | null;
  status?: OperationProgressStatus;
  phase: string;
  target: ExportBatchTarget;
  message?: string | null;
  currentChatId?: string | null;
  errorCount?: number | null;
  now?: number;
}): ExportProgressSnapshot => ({
  jobId,
  operationId,
  status,
  phase,
  batchPosition: target.batchPosition,
  batchTotal: target.batchTotal,
  historyIndex: target.historyIndex ?? null,
  title: target.title ?? null,
  targetChatId: target.targetChatId,
  currentChatId,
  message,
  lastProgressAt: now,
  errorCount,
});

export const isTerminalOperationStatus = (status: unknown): status is ConversationOperationStatus =>
  status === 'saved' || status === 'failed' || status === 'skipped' || status === 'cancelled';

export const operationResultFromError = ({
  operationId,
  targetChatId,
  error,
  receipts = {},
}: {
  operationId: string;
  targetChatId?: string | null;
  error: unknown;
  receipts?: Record<string, unknown>;
}): ConversationOperationTerminalResult => {
  const err = error as { message?: string; code?: string };
  return {
    status: 'failed',
    operationId,
    chatId: targetChatId || null,
    code: err?.code || 'conversation_operation_failed',
    error: err?.message || String(error),
    receipts,
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build:ts && node --test tests/export-operation-contracts.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/export-operation-contracts.ts tests/export-operation-contracts.test.mjs
git commit -m "feat: add export operation contracts"
```

---

### Task 2: Add Lock And Watchdog Policies

**Files:**
- Create: `src/mcp/export-operation-lock.ts`
- Create: `src/mcp/export-operation-watchdog.ts`
- Create: `tests/export-operation-lock.test.mjs`
- Create: `tests/export-operation-watchdog.test.mjs`

- [ ] **Step 1: Write failing lock tests**

Create `tests/export-operation-lock.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  finishActiveTabOperation,
  reapStaleActiveTabOperation,
  requestActiveTabOperationCancel,
  startActiveTabOperation,
  updateActiveTabOperationProgress,
} from '../build/ts/mcp/export-operation-lock.js';

test('active tab operation is tied to operationId and progresses deterministically', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'opening',
    now: 1000,
  });

  assert.equal(active.operationId, 'op-1');
  assert.equal(active.phase, 'opening');
  assert.equal(active.lastProgressAt, 1000);

  const next = updateActiveTabOperationProgress(active, { phase: 'hydrating', now: 1500 });
  assert.equal(next.phase, 'hydrating');
  assert.equal(next.lastProgressAt, 1500);
});

test('cancel only affects matching operation when operationId is supplied', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    targetChatId: 'aaa111aaa111',
    phase: 'hydrating',
    now: 1000,
  });

  assert.deepEqual(requestActiveTabOperationCancel(active, { operationId: 'other', now: 1200 }), {
    active,
    cancelled: false,
    reason: 'operation-id-mismatch',
  });

  const result = requestActiveTabOperationCancel(active, {
    operationId: 'op-1',
    reason: 'tool-cancel',
    now: 1300,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.active.cancelRequestedAt, 1300);
  assert.equal(result.active.abortReason, 'tool-cancel');
});

test('terminal operation clears lock and stale operation is reaped with receipt', () => {
  const active = startActiveTabOperation({
    operationId: 'op-1',
    jobId: 'job-1',
    phase: 'hydrating',
    now: 1000,
  });

  assert.equal(finishActiveTabOperation(active, { operationId: 'op-1' }), null);
  assert.equal(finishActiveTabOperation(active, { operationId: 'other' }), active);

  const reaped = reapStaleActiveTabOperation(active, {
    now: 10_500,
    staleAfterMs: 9000,
  });
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.active, null);
  assert.equal(reaped.receipt.code, 'operation_lock_reaped');
});
```

- [ ] **Step 2: Write failing watchdog tests**

Create `tests/export-operation-watchdog.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateConversationOperationWatchdog } from '../build/ts/mcp/export-operation-watchdog.js';

test('watchdog allows fresh progress', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 10_000,
      lastProgressAt: 8_000,
      noProgressMs: 5_000,
      cancelRequested: false,
    }),
    { action: 'continue', elapsedMs: 2000 },
  );
});

test('watchdog fails a silent operation and preserves code', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 20_000,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: false,
    }),
    {
      action: 'fail',
      elapsedMs: 10000,
      code: 'conversation_no_progress_timeout',
      message: 'Conversa sem progresso por 10s.',
    },
  );
});

test('watchdog cancels silently stuck operation after job cancel', () => {
  assert.deepEqual(
    evaluateConversationOperationWatchdog({
      operationId: 'op-1',
      now: 20_000,
      lastProgressAt: 10_000,
      noProgressMs: 5_000,
      cancelRequested: true,
    }),
    {
      action: 'cancel',
      elapsedMs: 10000,
      code: 'conversation_cancelled_after_no_progress',
      message: 'Cancelamento solicitado; operação sem progresso por 10s.',
    },
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm run build:ts && node --test tests/export-operation-lock.test.mjs tests/export-operation-watchdog.test.mjs
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement lock policy**

Create `src/mcp/export-operation-lock.ts`:

```ts
export type ActiveTabOperationState = {
  operationId: string;
  jobId?: string | null;
  targetChatId?: string | null;
  phase: string;
  startedAt: number;
  lastProgressAt: number;
  cancelRequestedAt?: number | null;
  abortReason?: string | null;
};

export const startActiveTabOperation = ({
  operationId,
  jobId = null,
  targetChatId = null,
  phase,
  now = Date.now(),
}: {
  operationId: string;
  jobId?: string | null;
  targetChatId?: string | null;
  phase: string;
  now?: number;
}): ActiveTabOperationState => ({
  operationId,
  jobId,
  targetChatId,
  phase,
  startedAt: now,
  lastProgressAt: now,
});

export const updateActiveTabOperationProgress = (
  active: ActiveTabOperationState,
  { phase = active.phase, now = Date.now() }: { phase?: string; now?: number } = {},
): ActiveTabOperationState => ({
  ...active,
  phase,
  lastProgressAt: now,
});

export const requestActiveTabOperationCancel = (
  active: ActiveTabOperationState | null,
  {
    operationId = null,
    reason = 'bridge-command',
    now = Date.now(),
  }: { operationId?: string | null; reason?: string; now?: number } = {},
) => {
  if (!active) return { active: null, cancelled: false, reason: 'no-active-operation' };
  if (operationId && active.operationId !== operationId) {
    return { active, cancelled: false, reason: 'operation-id-mismatch' };
  }
  return {
    active: {
      ...active,
      cancelRequestedAt: now,
      abortReason: reason,
    },
    cancelled: true,
    reason,
  };
};

export const finishActiveTabOperation = (
  active: ActiveTabOperationState | null,
  { operationId = null }: { operationId?: string | null } = {},
): ActiveTabOperationState | null => {
  if (!active) return null;
  if (operationId && active.operationId !== operationId) return active;
  return null;
};

export const reapStaleActiveTabOperation = (
  active: ActiveTabOperationState | null,
  { now = Date.now(), staleAfterMs }: { now?: number; staleAfterMs: number },
) => {
  if (!active) return { active: null, reaped: false, receipt: null };
  const elapsedMs = now - Math.max(active.lastProgressAt || 0, active.startedAt || 0);
  if (elapsedMs <= staleAfterMs) return { active, reaped: false, receipt: null };
  return {
    active: null,
    reaped: true,
    receipt: {
      code: 'operation_lock_reaped',
      operationId: active.operationId,
      jobId: active.jobId || null,
      targetChatId: active.targetChatId || null,
      elapsedMs,
      staleAfterMs,
    },
  };
};
```

- [ ] **Step 5: Implement watchdog policy**

Create `src/mcp/export-operation-watchdog.ts`:

```ts
const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

export type ConversationOperationWatchdogInput = {
  operationId: string;
  now: number;
  lastProgressAt: number;
  noProgressMs: number;
  cancelRequested?: boolean;
};

export type ConversationOperationWatchdogDecision =
  | { action: 'continue'; elapsedMs: number }
  | { action: 'fail'; elapsedMs: number; code: string; message: string }
  | { action: 'cancel'; elapsedMs: number; code: string; message: string };

export const evaluateConversationOperationWatchdog = ({
  now,
  lastProgressAt,
  noProgressMs,
  cancelRequested = false,
}: ConversationOperationWatchdogInput): ConversationOperationWatchdogDecision => {
  const elapsedMs = Math.max(0, now - lastProgressAt);
  if (elapsedMs <= noProgressMs) return { action: 'continue', elapsedMs };
  if (cancelRequested) {
    return {
      action: 'cancel',
      elapsedMs,
      code: 'conversation_cancelled_after_no_progress',
      message: `Cancelamento solicitado; operação sem progresso por ${seconds(elapsedMs)}s.`,
    };
  }
  return {
    action: 'fail',
    elapsedMs,
    code: 'conversation_no_progress_timeout',
    message: `Conversa sem progresso por ${seconds(elapsedMs)}s.`,
  };
};
```

- [ ] **Step 6: Run tests**

```bash
npm run build:ts && node --test tests/export-operation-lock.test.mjs tests/export-operation-watchdog.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/export-operation-lock.ts src/mcp/export-operation-watchdog.ts tests/export-operation-lock.test.mjs tests/export-operation-watchdog.test.mjs
git commit -m "feat: add export operation lock and watchdog policies"
```

---

### Task 3: Fix Date Import Defaults At The CLI Boundary

**Files:**
- Modify: `bin/gemini-md-export.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add failing CLI default tests**

Append this test near the other CLI help/argument tests in `tests/gemini-cli-tui.test.mjs`:

```js
test('CLI deixa My Activity no default do runtime para export e sync', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  const parseDefaults = source.match(/flags:\s*\{[\s\S]*?version: firstArgIsVersion,[\s\S]*?\}/)?.[0] || '';
  const startSyncStart = source.indexOf('const startSyncJob = async');
  const startExportStart = source.indexOf('const startExportJob = async');
  const fetchJobStatusStart = source.indexOf('const fetchJobStatus');
  const startSyncBlock =
    startSyncStart >= 0 && startExportStart > startSyncStart
      ? source.slice(startSyncStart, startExportStart)
      : '';
  const startExportBlock =
    startExportStart >= 0 && fetchJobStatusStart > startExportStart
      ? source.slice(startExportStart, fetchJobStatusStart)
      : '';

  assert.doesNotMatch(parseDefaults, /useMyActivity:\s*false/);
  assert.match(startSyncBlock, /useMyActivity:\s*flags\.noMyActivity \? false : flags\.useMyActivity/);
  assert.match(startExportBlock, /useMyActivity:\s*flags\.noMyActivity \? false : flags\.useMyActivity/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern "CLI deixa My Activity"
```

Expected: FAIL because `parseArgs` currently sets `useMyActivity: false`.

- [ ] **Step 3: Remove the false default**

In `bin/gemini-md-export.mjs`, inside `parseArgs` default flags, remove this line:

```js
      useMyActivity: false,
```

Do not replace it with `true`. The absence of the key is meaningful: `appendParams()` omits undefined values and MCP runtime applies `shouldUseMyActivityForDateImport()` default `true`.

- [ ] **Step 4: Run focused tests**

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern "CLI deixa My Activity|CLI expõe ajuda contextual"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/gemini-md-export.mjs tests/gemini-cli-tui.test.mjs
git commit -m "fix: keep date import enabled by default in cli exports"
```

---

### Task 4: Make Progress Canonical

**Files:**
- Modify: `src/core/progress-view-model.ts`
- Modify: `src/mcp-server.js`
- Modify: `tests/progress-view-model.test.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add failing progress view-model tests**

Append to `tests/progress-view-model.test.mjs`:

```js
test('export progress separates batch position from history index', () => {
  const view = buildExportJobProgressViewModel({
    status: 'running',
    phase: 'exporting',
    requested: 30,
    completed: 24,
    batchPosition: 25,
    batchTotal: 30,
    historyIndex: 30,
    current: {
      index: 30,
      title: 'DAS vs. DARF',
      chatId: 'abc123abc123',
      batchPosition: 25,
      batchTotal: 30,
      historyIndex: 30,
    },
    progressMessage: 'Baixando conversas do Gemini: DAS vs. DARF',
  });

  assert.equal(view.countLabel, '25 de 30');
  assert.equal(view.displayCurrent, 25);
  assert.equal(view.total, 30);
  assert.equal(view.label, 'Baixando conversas do Gemini: DAS vs. DARF');
  assert.equal(view.currentItem.title, 'DAS vs. DARF');
});

test('export progress strips legacy duplicated count from label', () => {
  const view = buildExportJobProgressViewModel({
    status: 'running',
    phase: 'exporting',
    requested: 30,
    completed: 24,
    batchPosition: 25,
    batchTotal: 30,
    current: { title: 'DAS vs. DARF', chatId: 'abc123abc123' },
    progressMessage: 'Baixando conversas do Gemini (25/30): DAS vs. DARF',
  });

  assert.equal(view.countLabel, '25 de 30');
  assert.equal(view.label, 'Baixando conversas do Gemini: DAS vs. DARF');
});
```

- [ ] **Step 2: Add failing CLI rendering test**

Append to `tests/gemini-cli-tui.test.mjs`:

```js
test('CLI plain progress não duplica contador no texto', async () => {
  const stdout = captureStream();
  const job = {
    jobId: 'job-progress',
    status: 'running',
    phase: 'exporting',
    requested: 30,
    completed: 24,
    batchPosition: 25,
    batchTotal: 30,
    progressMessage: 'Baixando conversas do Gemini (25/30): DAS vs. DARF',
    current: { title: 'DAS vs. DARF', chatId: 'abc123abc123' },
  };

  await withServer((req, res, url) => {
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, version: PACKAGE_VERSION, protocolVersion: 2 });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, { ready: true, ok: true });
      return;
    }
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 200, job);
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      sendJson(res, 200, { ...job, status: 'completed', phase: 'done', completed: 30 });
      return;
    }
    sendJson(res, 404, { error: 'unexpected ' + url.pathname });
  }, async (bridgeUrl) => {
    await main(
      [
        'export',
        'recent',
        '--bridge-url',
        bridgeUrl,
        '--no-start-bridge',
        '--plain',
        '--poll-ms',
        '10',
      ],
      { stdout },
    );
  });

  assert.match(stdout.text(), /25 de 30|30 de 30/);
  assert.doesNotMatch(stdout.text(), /25\/30.*25\/30/);
});
```

- [ ] **Step 3: Run tests to verify failures**

```bash
npm run build:ts && node --test tests/progress-view-model.test.mjs --test-name-pattern "export progress"
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern "CLI plain progress"
```

Expected: first command FAILS because canonical fields are not supported; second may fail or expose duplicated legacy labels.

- [ ] **Step 4: Update progress view model**

In `src/core/progress-view-model.ts`, add helpers near the existing number/count helpers:

```ts
const stripLegacyProgressCount = (value: unknown): string => {
  const text = String(value || '').trim();
  return text
    .replace(/\s+\(\d+\s*\/\s*\d+\)(?=:)/, '')
    .replace(/\s+\(\d+\s+de\s+\d+\)(?=:)/i, '')
    .trim();
};

const operationBatchPosition = (job: Record<string, any>): number | null => {
  const value = job.batchPosition ?? job.current?.batchPosition ?? job.operation?.batchPosition;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const operationBatchTotal = (job: Record<string, any>, fallback = 0): number => {
  const value = job.batchTotal ?? job.current?.batchTotal ?? job.operation?.batchTotal ?? fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};
```

Then in `buildExportJobProgressViewModel`, replace the current `total`, `displayCurrent`, `barCurrent`, `label`, and `countLabel` calculations with this shape:

```ts
  const counts = jobTotals(job);
  const fallbackTotal = finiteNumber(job.requested ?? job.missingCount ?? job.webConversationCount, 0);
  const batchPosition = operationBatchPosition(job);
  const total = operationBatchTotal(job, fallbackTotal);
  const status = normalizeStatus(job.status);
  const phase = typeof job.phase === 'string' ? job.phase : null;
  const terminal = isTerminal(status);
  const completed = Math.max(0, finiteNumber(job.completed, 0));
  const currentIndex = Math.max(0, finiteNumber(job.current?.index ?? job.position, 0));
  const mode =
    total > 0 &&
    !['queued', 'loading-history', 'scanning-vault', 'loading-metadata', 'resolving-metadata'].includes(
      String(phase || ''),
    )
      ? 'determinate'
      : 'indeterminate';
  const current = total > 0 ? Math.min(completed, total) : completed;
  const displayCurrent =
    batchPosition !== null
      ? Math.min(total || batchPosition, batchPosition)
      : total > 0 && !terminal && phase === 'exporting'
        ? Math.min(total, Math.max(completed + 1, currentIndex, 1))
        : current;
  const barCurrent =
    batchPosition !== null && total > 0 && !terminal
      ? Math.min(total - 0.02, Math.max(0, batchPosition - 0.38))
      : total > 0 && !terminal && phase === 'exporting'
        ? Math.min(total - 0.02, completed + 0.62)
        : current;
  const currentItem =
    job.current?.title || job.current?.chatId
      ? { title: job.current.title || null, chatId: job.current.chatId || null }
      : null;
  const label = stripLegacyProgressCount(
    job.operationMessage || job.progressMessage || job.decisionSummary?.headline || 'Sincronizando...',
  );
```

And pass:

```ts
    label,
    countLabel:
      total > 0
        ? batchPosition !== null
          ? `${Math.min(displayCurrent, total)} de ${total}`
          : `${Math.min(displayCurrent, total)}/${total}`
        : indeterminateCountLabel(job, counts),
```

- [ ] **Step 5: Stop emitting counts inside MCP progress messages when canonical fields exist**

In `src/mcp-server.js`, update `exportJobProgressMessage(job)` in the `job.phase === 'exporting'` branch.

Replace:

```js
    const count =
      job.requested > 0
        ? ` (${Math.min(job.completed + 1, job.requested)}/${job.requested})`
        : '';
    return `${prefix}${count}${title ? `: ${title}` : '...'}`;
```

With:

```js
    return `${prefix}${title ? `: ${title}` : '...'}`;
```

When Task 8 wires `batchPosition/batchTotal`, the count will come only from the view model.

- [ ] **Step 6: Run focused tests**

```bash
npm run build:ts && node --test tests/progress-view-model.test.mjs --test-name-pattern "export progress|only CLI progress"
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern "CLI plain progress"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/progress-view-model.ts src/mcp-server.js tests/progress-view-model.test.mjs tests/gemini-cli-tui.test.mjs
git commit -m "fix: canonicalize export progress counts"
```

---

### Task 5: Add Capability-Aware Tab Lifecycle

**Files:**
- Modify: `src/mcp/client-lifecycle.ts`
- Modify: `src/mcp/tab-selection.ts`
- Modify: `tests/mcp-client-lifecycle.test.mjs`
- Modify: `tests/mcp-tab-selection.test.mjs`

- [ ] **Step 1: Add failing lifecycle tests**

Append to `tests/mcp-client-lifecycle.test.mjs`:

```js
test('/app home is claimable for recent export but not current chat', () => {
  const homeClient = {
    ...baseClient,
    page: {
      url: 'https://gemini.google.com/app',
      pathname: '/app',
      chatId: null,
      listedConversationCount: 12,
      sidebarConversationCount: 12,
      buildStamp: '20260520-0238',
    },
  };

  assert.equal(
    getGeminiClientLifecycle(homeClient, {
      ...options,
      capability: 'current-chat',
    }).code,
    'current_chat_required',
  );

  const recent = getGeminiClientLifecycle(homeClient, {
    ...options,
    capability: 'recent-export',
  });
  assert.equal(recent.state, 'claimable');
  assert.equal(recent.code, null);
});

test('/app home without sidebar evidence can warm for recent export when command is ready', () => {
  const homeClient = {
    ...baseClient,
    page: {
      url: 'https://gemini.google.com/app',
      pathname: '/app',
      chatId: null,
      buildStamp: '20260520-0238',
    },
  };

  const recent = getGeminiClientLifecycle(homeClient, {
    ...options,
    capability: 'recent-export',
  });
  assert.equal(recent.state, 'claimable');
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npm run build:ts && node --test tests/mcp-client-lifecycle.test.mjs --test-name-pattern "/app home"
```

Expected: FAIL because `capability` is not supported and `/app` is currently `page_not_hydrated`.

- [ ] **Step 3: Update lifecycle types and page checks**

In `src/mcp/client-lifecycle.ts`, add to `GeminiClientLifecycleOptions`:

```ts
  capability?: 'current-chat' | 'recent-export';
```

Add helpers near `pageHasHydratedGeminiContext`:

```ts
const pageIsGeminiAppHome = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  return pathname === '/app' || pathname === '/app/';
};

const pageHasRecentExportContext = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  if (!pathname.startsWith('/app')) return false;
  if (pageHasHydratedGeminiContext(page)) return true;
  if (pageIsGeminiAppHome(page)) return true;
  return false;
};

const pageHasCurrentChatContext = (page: GeminiPageSnapshot): boolean => {
  const pathname = pagePathname(page);
  if (normalizeString(page.chatId)) return true;
  if (/^\/app\/[a-f0-9]{12,}/i.test(pathname)) return true;
  return false;
};
```

Then replace the existing hydration block:

```ts
  if (!pageHasHydratedGeminiContext(client.page)) {
    return result('page_unready', 'page_not_hydrated', client);
  }
```

With:

```ts
  const capability = options.capability || 'current-chat';
  if (capability === 'current-chat') {
    if (!pageHasCurrentChatContext(client.page)) {
      return result('page_unready', 'current_chat_required', client);
    }
  } else if (!pageHasRecentExportContext(client.page)) {
    return result('page_unready', 'page_not_hydrated', client);
  }
```

Add `current_chat_required` to the lifecycle code/message maps with:

```ts
current_chat_required: 'Abra uma conversa específica para exportar o chat atual.',
```

- [ ] **Step 4: Update tab selection defaults**

In `src/mcp/tab-selection.ts`, keep the existing exported functions, and add:

```ts
export const toRecentExportClaimableGeminiClient = (
  client: Parameters<typeof toClaimableGeminiTab>[0],
  options: Parameters<typeof toClaimableGeminiTab>[1],
) => toClaimableGeminiTab(client, { ...options, capability: 'recent-export' });
```

Use this new helper later in `src/mcp-server.js` for `export recent` and `gemini_tabs claim` when the requested intent is export/recent.

- [ ] **Step 5: Run focused tests**

```bash
npm run build:ts && node --test tests/mcp-client-lifecycle.test.mjs tests/mcp-tab-selection.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client-lifecycle.ts src/mcp/tab-selection.ts tests/mcp-client-lifecycle.test.mjs tests/mcp-tab-selection.test.mjs
git commit -m "feat: distinguish recent export tab readiness"
```

---

### Task 6: Make Content-Script Operations Abortable

**Files:**
- Modify: `src/userscript-shell.ts`
- Modify: `tests/content-script.test.mjs`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Add source-level failing tests**

Append to `tests/content-script.test.mjs`:

```js
test('content script active tab operation owns an AbortController', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const operationBlock = source.match(
    /const runWithTabOperationBackpressure = async[\s\S]*?\n  \};\n\n  const findConversationForBridgeCommand/,
  )?.[0] || '';
  const cancelBlock = source.match(
    /if \(command\.type === 'cancel-active-operation'\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(operationBlock, /new AbortController\(\)/);
  assert.match(operationBlock, /abortController/);
  assert.match(operationBlock, /abortSignal/);
  assert.match(cancelBlock, /abortController\.abort/);
  assert.match(cancelBlock, /operationId/);
});
```

Update the existing `MCP propaga cancelamento...` test in `tests/mcp-command-channel.test.mjs` by adding:

```js
  assert.match(contentSource, /abortController\.abort/);
  assert.match(contentSource, /operationId/);
```

- [ ] **Step 2: Run tests to verify failure**

```bash
node --test tests/content-script.test.mjs --test-name-pattern "AbortController"
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "propaga cancelamento"
```

Expected: FAIL because `activeTabOperation` currently records cancel but does not call an operation abort controller.

- [ ] **Step 3: Update active operation summary**

In `src/userscript-shell.ts`, update `activeTabOperationSummary()` to include `operationId`, `jobId`, `targetChatId`, and `phase`:

```ts
      operationId: active.operationId || null,
      jobId: active.jobId || null,
      targetChatId: active.targetChatId || null,
      phase: active.phase || null,
```

Keep `abortController` out of the summary because it is not serializable.

- [ ] **Step 4: Create abort controller in runWithTabOperationBackpressure**

Inside `runWithTabOperationBackpressure`, before assigning `state.activeTabOperation`, add:

```ts
    const abortController = new AbortController();
    const operationId =
      command.args?.operationId ||
      `${command.type}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
```

Then replace the current `state.activeTabOperation = { ... }` assignment with:

```ts
    state.activeTabOperation = {
      type: command.type,
      label: tabOperationLabel(command),
      commandId: command.id || null,
      operationId,
      jobId: command.args?.jobId || null,
      targetChatId: command.args?.targetChatId || command.args?.chatId || command.args?.item?.chatId || null,
      phase: command.args?.phase || 'queued',
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      abortController,
    };
```

Change the call from:

```ts
      const result = await fn();
```

To:

```ts
      const result = await fn({
        operationId,
        abortSignal: abortController.signal,
        setOperationPhase: (phase) => {
          if (state.activeTabOperation?.operationId === operationId) {
            state.activeTabOperation.phase = phase;
            state.activeTabOperation.lastProgressAt = Date.now();
            reportTabBrokerStateSoon('operation-progress', { force: true });
          }
        },
      });
```

Existing callbacks that ignore the parameter continue to work.

- [ ] **Step 5: Abort on cancel-active-operation**

In the `cancel-active-operation` branch, read `operationId`:

```ts
      const requestedOperationId = command.args?.operationId || null;
      if (
        requestedOperationId &&
        state.activeTabOperation.operationId &&
        requestedOperationId !== state.activeTabOperation.operationId
      ) {
        return {
          ok: true,
          cancelled: false,
          reason: 'operation-id-mismatch',
          activeOperation: activeTabOperationSummary(),
        };
      }
```

After setting `cancelRequestedAt`, add:

```ts
      state.activeTabOperation.abortController?.abort(
        state.activeTabOperation.cancelReason || 'bridge-command',
      );
```

Update `activeTabOperationCancelRequested()` to:

```ts
  const activeTabOperationCancelRequested = () =>
    Boolean(
      state.activeTabOperation?.cancelRequestedAt ||
        state.activeTabOperation?.abortController?.signal?.aborted,
    );
```

- [ ] **Step 6: Run focused tests**

```bash
npm run build:ts
node --test tests/content-script.test.mjs --test-name-pattern "AbortController"
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "propaga cancelamento"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/userscript-shell.ts tests/content-script.test.mjs tests/mcp-command-channel.test.mjs
git commit -m "feat: abort active browser export operations"
```

---

### Task 7: Pass Abort And Progress Into Navigation/Hydration

**Files:**
- Modify: `src/userscript-shell.ts`
- Modify: `tests/content-script.test.mjs`

- [ ] **Step 1: Add failing source tests**

Append to `tests/content-script.test.mjs`:

```js
test('content script passes operation abort signal into hydration and export collection', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const hydrateBlock = source.match(
    /const hydrateConversationToTop = async[\s\S]*?\n  \};\n\n  const downloadBlob/,
  )?.[0] || '';
  const collectBlock = source.match(
    /const collectExportForCurrentConversation = async[\s\S]*?\n  \};\n\n  const collectExportForConversation/,
  )?.[0] || '';

  assert.match(hydrateBlock, /options\.abortSignal\?\.aborted/);
  assert.match(hydrateBlock, /options\.onProgress/);
  assert.match(collectBlock, /abortSignal:\s*options\.abortSignal/);
  assert.match(collectBlock, /setOperationPhase/);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node --test tests/content-script.test.mjs --test-name-pattern "operation abort signal"
```

Expected: FAIL because hydration only checks `isCancelled` and does not receive `abortSignal` or progress phase updates.

- [ ] **Step 3: Add abort helper in content script**

Near `activeTabOperationCancelRequested`, add:

```ts
  const throwIfOperationAborted = (signal, message) => {
    if (!signal?.aborted) return;
    const error = new Error(message || 'Operação cancelada.');
    error.code = 'operation_cancelled';
    throw error;
  };
```

- [ ] **Step 4: Update hydrateConversationToTop**

Inside `hydrateConversationToTop`, after local state initialization, call:

```ts
    throwIfOperationAborted(
      options.abortSignal,
      'Exportação cancelada antes de terminar a hidratação da conversa.',
    );
```

Replace checks like:

```ts
        if (options.isCancelled?.()) {
```

With:

```ts
        if (options.isCancelled?.() || options.abortSignal?.aborted) {
```

When progress is detected, after updating `lastProgressAt`, call:

```ts
          options.onProgress?.({ state, elapsedMs: Date.now() - startedAt });
```

Ensure at least these places emit progress:

- after `conversationHydrationChanged(...)` returns true;
- before returning `not-scrollable`;
- after final `turns` are scraped.

- [ ] **Step 5: Pass operation context through export collection**

Change `collectExportForCurrentConversation` to call phase setter:

```ts
    options.setOperationPhase?.('hydrating');
```

In the hydration options passed to `hydrateConversationToTop`, add:

```ts
      abortSignal: options.abortSignal,
```

Before `buildExportPayload`, add:

```ts
    options.setOperationPhase?.('extracting');
    throwIfOperationAborted(options.abortSignal, 'Exportação cancelada antes de extrair Markdown.');
```

In `collectExportForConversation`, pass through:

```ts
      abortSignal: options.abortSignal,
      setOperationPhase: options.setOperationPhase,
```

Where bridge commands call `collectExportForConversation`, update the call sites inside `runWithTabOperationBackpressure` callbacks to accept the context parameter and pass it forward:

```ts
    return runWithTabOperationBackpressure(command, async ({ abortSignal, setOperationPhase, operationId }) => {
      return collectExportForConversation(item, {
        ...options,
        abortSignal,
        setOperationPhase,
        operationId,
      });
    });
```

- [ ] **Step 6: Run focused tests**

```bash
npm run build:ts && node --test tests/content-script.test.mjs --test-name-pattern "operation abort signal|isCancelled"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/userscript-shell.ts tests/content-script.test.mjs
git commit -m "feat: propagate abort and progress through browser export"
```

---

### Task 8: Add Conversation Operation Runner

**Files:**
- Create: `src/mcp/conversation-operation-runner.ts`
- Create: `tests/conversation-operation-runner.test.mjs`

- [ ] **Step 1: Write failing operation runner tests**

Create `tests/conversation-operation-runner.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { runConversationOperation } from '../build/ts/mcp/conversation-operation-runner.js';

const target = {
  batchPosition: 1,
  batchTotal: 2,
  historyIndex: 6,
  targetChatId: 'aaa111aaa111',
  title: 'Caso CPRE',
  source: 'sidebar',
  url: 'https://gemini.google.com/app/aaa111aaa111',
};

test('conversation operation saves after download, date resolution and writer', async () => {
  const progress = [];
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'job-1:001:aaa111aaa111',
    target,
    progressSink: (snapshot) => progress.push(snapshot),
    abortSignal: new AbortController().signal,
    deps: {
      now: () => 1000 + progress.length,
      download: async () => ({
        payload: { chatId: 'aaa111aaa111', content: '# ok' },
        client: { clientId: 'client-1' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => ({
        payload: { ...payload, dateCreated: '2026-05-01T00:00:00Z' },
        receipt: { status: 'matched', source: 'takeout' },
      }),
      save: async ({ payload }) => ({
        filePath: `/tmp/${payload.chatId}.md`,
        bytes: 12,
        receipt: { status: 'saved' },
      }),
    },
  });

  assert.equal(result.status, 'saved');
  assert.equal(result.chatId, 'aaa111aaa111');
  assert.equal(result.filePath, '/tmp/aaa111aaa111.md');
  assert.deepEqual(
    progress.map((item) => item.phase),
    ['opening', 'resolving_dates', 'saving'],
  );
});

test('conversation operation fails before save when payload chat id does not match target', async () => {
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'op-1',
    target,
    progressSink: () => {},
    abortSignal: new AbortController().signal,
    deps: {
      download: async () => ({
        payload: { chatId: 'bbb222bbb222', content: '# wrong' },
        receipts: { navigation: { ok: true } },
      }),
      resolveDates: async ({ payload }) => ({ payload, receipt: { status: 'unmatched' } }),
      save: async () => {
        throw new Error('save should not run');
      },
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'payload_chat_id_mismatch');
});

test('conversation operation returns cancelled when abort signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort('test-cancel');
  const result = await runConversationOperation({
    jobId: 'job-1',
    operationId: 'op-1',
    target,
    progressSink: () => {},
    abortSignal: controller.signal,
    deps: {
      download: async () => {
        throw new Error('download should not run');
      },
      resolveDates: async ({ payload }) => ({ payload, receipt: { status: 'unmatched' } }),
      save: async () => ({ filePath: '/tmp/nope.md', receipt: {} }),
    },
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'test-cancel');
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm run build:ts && node --test tests/conversation-operation-runner.test.mjs
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement runner**

Create `src/mcp/conversation-operation-runner.ts`:

```ts
import {
  type ConversationOperationTerminalResult,
  type ExportBatchTarget,
  makeOperationProgressSnapshot,
  operationResultFromError,
} from './export-operation-contracts.js';

type RuntimePayload = Record<string, any> & { chatId?: string | null };

type DownloadResult = {
  payload: RuntimePayload;
  client?: Record<string, unknown> | null;
  activeClient?: Record<string, unknown> | null;
  receipts?: Record<string, unknown>;
};

type DateResult = {
  payload: RuntimePayload;
  receipt: Record<string, unknown>;
};

type SaveResult = {
  filePath: string;
  bytes?: number | null;
  receipt?: Record<string, unknown>;
};

type OperationDeps = {
  now?: () => number;
  download: (args: { target: ExportBatchTarget; operationId: string; abortSignal: AbortSignal }) => Promise<DownloadResult>;
  resolveDates: (args: { target: ExportBatchTarget; payload: RuntimePayload; operationId: string; abortSignal: AbortSignal }) => Promise<DateResult>;
  save: (args: { target: ExportBatchTarget; payload: RuntimePayload; operationId: string; abortSignal: AbortSignal }) => Promise<SaveResult>;
};

export type RunConversationOperationArgs = {
  jobId: string;
  operationId: string;
  target: ExportBatchTarget;
  abortSignal: AbortSignal;
  progressSink: (snapshot: ReturnType<typeof makeOperationProgressSnapshot>) => void;
  deps: OperationDeps;
};

const abortReason = (signal: AbortSignal): string =>
  typeof signal.reason === 'string'
    ? signal.reason
    : signal.reason?.message || 'operation_cancelled';

const cancelled = (
  operationId: string,
  target: ExportBatchTarget,
  signal: AbortSignal,
  receipts: Record<string, unknown> = {},
): ConversationOperationTerminalResult => ({
  status: 'cancelled',
  operationId,
  chatId: target.targetChatId,
  reason: abortReason(signal),
  receipts,
});

const throwIfAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;
  const error = new Error(abortReason(signal));
  (error as Error & { code?: string }).code = 'operation_cancelled';
  throw error;
};

export const runConversationOperation = async ({
  jobId,
  operationId,
  target,
  abortSignal,
  progressSink,
  deps,
}: RunConversationOperationArgs): Promise<ConversationOperationTerminalResult> => {
  const now = deps.now || Date.now;
  const receipts: Record<string, unknown> = {};
  const progress = (phase: string, message: string) =>
    progressSink(
      makeOperationProgressSnapshot({
        jobId,
        operationId,
        phase,
        status: 'running',
        target,
        message,
        now: now(),
      }),
    );

  try {
    if (abortSignal.aborted) return cancelled(operationId, target, abortSignal, receipts);

    progress('opening', 'Abrindo conversa');
    const downloaded = await deps.download({ target, operationId, abortSignal });
    receipts.download = downloaded.receipts || {};
    throwIfAborted(abortSignal);

    const payload = downloaded.payload || {};
    if (String(payload.chatId || '').toLowerCase() !== target.targetChatId.toLowerCase()) {
      const error = new Error(
        `Payload do navegador veio de ${payload.chatId || 'chat desconhecido'}, mas o alvo era ${target.targetChatId}.`,
      );
      (error as Error & { code?: string }).code = 'payload_chat_id_mismatch';
      throw error;
    }

    progress('resolving_dates', 'Conferindo datas da conversa');
    const dated = await deps.resolveDates({ target, payload, operationId, abortSignal });
    receipts.dateImport = dated.receipt;
    throwIfAborted(abortSignal);

    progress('saving', 'Salvando Markdown');
    const saved = await deps.save({ target, payload: dated.payload, operationId, abortSignal });
    receipts.save = saved.receipt || {};
    throwIfAborted(abortSignal);

    return {
      status: 'saved',
      operationId,
      chatId: target.targetChatId,
      filePath: saved.filePath,
      receipts,
    };
  } catch (error) {
    if ((error as { code?: string })?.code === 'operation_cancelled' || abortSignal.aborted) {
      return cancelled(operationId, target, abortSignal, receipts);
    }
    return operationResultFromError({
      operationId,
      targetChatId: target.targetChatId,
      error,
      receipts,
    });
  }
};
```

- [ ] **Step 4: Run tests**

```bash
npm run build:ts && node --test tests/conversation-operation-runner.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/conversation-operation-runner.ts tests/conversation-operation-runner.test.mjs
git commit -m "feat: add conversation operation runner"
```

---

### Task 9: Wire Recent Export To Operation Targets And Progress

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/recent-chats-load-more.test.mjs`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Add failing source tests for target wiring**

Append to `tests/recent-chats-load-more.test.mjs`:

```js
test('recent export builds operation targets with batch and history positions', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0] || '';

  assert.match(source, /export-operation-contracts\.js/);
  assert.match(source, /buildExportBatchTargets/);
  assert.match(source, /buildOperationId/);
  assert.match(block, /const operationTargets = buildExportBatchTargets/);
  assert.match(block, /job\.current = \{[\s\S]*batchPosition/);
  assert.match(block, /batchTotal/);
  assert.match(block, /historyIndex/);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node --test tests/recent-chats-load-more.test.mjs --test-name-pattern "operation targets"
```

Expected: FAIL because `runRecentChatsExportJob` still loops raw `selected` items.

- [ ] **Step 3: Import operation helpers in MCP**

Near other `build/ts/mcp/*` imports in `src/mcp-server.js`, add:

```js
import {
  buildExportBatchTargets,
  buildOperationId,
} from '../build/ts/mcp/export-operation-contracts.js';
```

- [ ] **Step 4: Convert selected items into operation targets**

In `runRecentChatsExportJob`, after resume filtering and before `job.requested`, add:

```js
    const operationTargets = buildExportBatchTargets(selected, {
      batchTotal: selected.length,
      source: 'sidebar',
    });
```

Set requested from targets:

```js
    job.requested = resumedCompletedCount + operationTargets.length;
```

Change the export loop from:

```js
    for (let i = 0; i < selected.length; i += 1) {
```

To:

```js
    for (let i = 0; i < operationTargets.length; i += 1) {
```

Inside the loop, replace:

```js
      const { conversation, index } = selected[i];
```

With:

```js
      const target = operationTargets[i];
      const selectedItem = selected[i];
      const { conversation, index } = selectedItem;
      const operationId = buildOperationId({
        jobId: job.jobId,
        batchPosition: target.batchPosition,
        targetChatId: target.targetChatId,
      });
```

Replace `job.current` with:

```js
      job.current = {
        index,
        batchPosition: target.batchPosition,
        batchTotal: target.batchTotal,
        historyIndex: target.historyIndex,
        operationId,
        title: target.title || conversation.title || null,
        chatId: target.targetChatId,
      };
      job.batchPosition = target.batchPosition;
      job.batchTotal = target.batchTotal;
      job.historyIndex = target.historyIndex;
      job.operationId = operationId;
```

When calling `downloadConversationItemWithRetry`, pass operation fields to the content script:

```js
          operationId,
          jobId: job.jobId,
          targetChatId: target.targetChatId,
```

- [ ] **Step 5: Preserve existing selected item behavior**

Do not remove existing skip-existing, deferred date save, metric, success, or failure code in this task. The goal is only to make the loop operation-aware and progress-canonical before replacing the internals with the full runner.

When the loop finishes, clear canonical current fields in the `finally` block near `job.current = null`:

```js
    job.batchPosition = null;
    job.batchTotal = null;
    job.historyIndex = null;
    job.operationId = null;
```

- [ ] **Step 6: Run focused tests**

```bash
npm run build:ts && node --test tests/recent-chats-load-more.test.mjs --test-name-pattern "operation targets|lazy-load parcial"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.js tests/recent-chats-load-more.test.mjs
git commit -m "feat: add operation targets to recent export"
```

---

### Task 10: Add Per-Conversation No-Progress Watchdog To Recent Export

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-command-channel.test.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add failing source tests**

Append to `tests/mcp-command-channel.test.mjs`:

```js
test('recent export has per-conversation no-progress watchdog', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0] || '';

  assert.match(source, /export-operation-watchdog\.js/);
  assert.match(source, /evaluateConversationOperationWatchdog/);
  assert.match(block, /conversationNoProgressMs/);
  assert.match(block, /conversation_no_progress_timeout/);
  assert.match(block, /requestActiveBrowserOperationCancelForJob/);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node --test tests/mcp-command-channel.test.mjs --test-name-pattern "per-conversation no-progress"
```

Expected: FAIL because no operation watchdog is wired yet.

- [ ] **Step 3: Import watchdog**

In `src/mcp-server.js`, add:

```js
import { evaluateConversationOperationWatchdog } from '../build/ts/mcp/export-operation-watchdog.js';
```

- [ ] **Step 4: Add timeout normalizer**

Near other export timeout constants/helpers, add:

```js
const DEFAULT_CONVERSATION_NO_PROGRESS_MS = Math.max(
  5000,
  Math.min(
    5 * 60_000,
    Number(process.env.GEMINI_MCP_CONVERSATION_NO_PROGRESS_MS || 45_000),
  ),
);

const conversationNoProgressMs = (args = {}) =>
  Math.max(
    5000,
    Math.min(
      10 * 60_000,
      Number(args.conversationNoProgressMs || args.noProgressMs || DEFAULT_CONVERSATION_NO_PROGRESS_MS),
    ),
  );
```

- [ ] **Step 5: Race each download against watchdog**

Inside the recent export loop, before `downloadConversationItemWithRetry`, set:

```js
        let operationLastProgressAt = Date.now();
        const markOperationProgress = () => {
          operationLastProgressAt = Date.now();
        };
```

Pass a progress callback into args:

```js
          onOperationProgress: markOperationProgress,
```

Wrap the download promise with a watchdog race:

```js
        const noProgressMs = conversationNoProgressMs(args);
        const downloadPromise = downloadConversationItemWithRetry(job, client, conversation, {
          ...args,
          outputDir: job.outputDir,
          collectOnly: deferDateImportSave,
          returnToOriginal: false,
          operationId,
          jobId: job.jobId,
          targetChatId: target.targetChatId,
          onOperationProgress: markOperationProgress,
        });
        const watchdogPromise = new Promise((_, reject) => {
          const timer = setInterval(() => {
            const decision = evaluateConversationOperationWatchdog({
              operationId,
              now: Date.now(),
              lastProgressAt: operationLastProgressAt,
              noProgressMs,
              cancelRequested: job.cancelRequested === true,
            });
            if (decision.action === 'continue') return;
            clearInterval(timer);
            const error = new Error(decision.message);
            error.code = decision.code;
            error.operationId = operationId;
            error.targetChatId = target.targetChatId;
            void requestActiveBrowserOperationCancelForJob(job, decision.code);
            reject(error);
          }, Math.min(1000, Math.max(250, Math.floor(noProgressMs / 5))));
          downloadPromise.finally(() => clearInterval(timer));
        });
        const result = await Promise.race([downloadPromise, watchdogPromise]);
```

Remove the old direct `await downloadConversationItemWithRetry(...)` in this loop. Keep the success/deferred-save handling after `result`.

- [ ] **Step 6: Ensure progress callback is invoked by command responses**

In `downloadConversationItemWithRetry` and lower helper calls, when a browser command starts and when it returns, call:

```js
args.onOperationProgress?.({ phase: 'browser-command-started' });
```

and:

```js
args.onOperationProgress?.({ phase: 'browser-command-finished' });
```

The content script progress propagation from Task 7 will later allow more granular updates; this task guarantees the watchdog is not silent while command boundaries move.

- [ ] **Step 7: Run focused tests**

```bash
npm run build:ts && node --test tests/mcp-command-channel.test.mjs --test-name-pattern "per-conversation no-progress|propaga cancelamento"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server.js tests/mcp-command-channel.test.mjs
git commit -m "feat: add per-conversation export watchdog"
```

---

### Task 11: Integrate Operation Runner For Recent Export Save Path

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/recent-chats-load-more.test.mjs`
- Modify: `tests/conversation-operation-runner.test.mjs`

- [ ] **Step 1: Add failing source integration test**

Append to `tests/recent-chats-load-more.test.mjs`:

```js
test('recent export loop delegates one item to conversation operation runner', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const block = source.match(
    /const runRecentChatsExportJob = async[\s\S]*?\nconst startRecentChatsExportJob/,
  )?.[0] || '';

  assert.match(source, /conversation-operation-runner\.js/);
  assert.match(source, /runConversationOperation/);
  assert.match(block, /runConversationOperation\(\{/);
  assert.match(block, /resolveDates:/);
  assert.match(block, /save:/);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node --test tests/recent-chats-load-more.test.mjs --test-name-pattern "conversation operation runner"
```

Expected: FAIL.

- [ ] **Step 3: Import runner**

In `src/mcp-server.js`, add:

```js
import { runConversationOperation } from '../build/ts/mcp/conversation-operation-runner.js';
```

- [ ] **Step 4: Add adapter helper inside `runRecentChatsExportJob` loop**

Replace the direct download/save handling inside the `try` block with a runner call that keeps the watchdog from Task 10 active:

```js
        const operationAbortController = new AbortController();
        const operationTimeoutMs = Math.max(
          1000,
          Number(args.exportBrowserTimeoutMs || EXPORT_COMMAND_TIMEOUT_MS),
        );
        const operationTimeoutTimer = setTimeout(() => {
          operationAbortController.abort('operation_timeout');
          void requestActiveBrowserOperationCancelForJob(job, 'operation_timeout');
        }, operationTimeoutMs);

        const noProgressMs = conversationNoProgressMs(args);
        const operationPromise = runConversationOperation({
          jobId: job.jobId,
          operationId,
          target,
          abortSignal: operationAbortController.signal,
          progressSink: (snapshot) => {
            job.current = {
              ...(job.current || {}),
              batchPosition: snapshot.batchPosition,
              batchTotal: snapshot.batchTotal,
              historyIndex: snapshot.historyIndex,
              operationId,
              title: snapshot.title || job.current?.title || null,
              chatId: snapshot.targetChatId || job.current?.chatId || null,
              phase: snapshot.phase,
            };
            job.batchPosition = snapshot.batchPosition;
            job.batchTotal = snapshot.batchTotal;
            job.historyIndex = snapshot.historyIndex;
            job.operationId = operationId;
            markOperationProgress();
            touchExportJob(job);
            broadcastRecentChatsJobProgress(job, client);
          },
          deps: {
            download: async ({ abortSignal }) => {
              const collected = await downloadConversationItemWithRetry(job, client, conversation, {
                ...args,
                outputDir: job.outputDir,
                collectOnly: true,
                returnToOriginal: false,
                operationId,
                jobId: job.jobId,
                targetChatId: target.targetChatId,
                abortSignal,
                onOperationProgress: markOperationProgress,
              });
              return {
                payload: collected.result?.payload || collected.payload || collected,
                activeClient: collected.activeClient || null,
                client: collected.client || null,
                receipts: {
                  browser: collected.metrics || collected.result?.payload?.metrics || null,
                },
              };
            },
            resolveDates: async ({ payload }) => {
              const context = await createExportDateImportContextForArgs(args);
              const integrity = await validateMcpExportPayload(payload, {
                expectedChatId: target.targetChatId,
                requestedChatId: target.targetChatId,
              });
              if (!integrity.ok) {
                return {
                  payload,
                  receipt: {
                    status: 'validation_failed',
                    code: integrity.code,
                    message: integrity.message,
                  },
                };
              }
              const enriched = await enrichExportPayloadWithDates({
                payload,
                integrity,
                args: { ...args, _exportDateImportContext: context },
              });
              if (!enriched.ok) {
                return {
                  payload,
                  receipt: enriched.receipt || {
                    status: 'resolver_failed',
                    message: enriched.message || 'Falha ao resolver datas.',
                  },
                };
              }
              return {
                payload: enriched.payload,
                receipt: enriched.receipt,
              };
            },
            save: async ({ payload }) => {
              const integrity = await validateMcpExportPayload(payload, {
                expectedChatId: target.targetChatId,
                requestedChatId: target.targetChatId,
              });
              if (!integrity.ok) {
                const error = new Error(integrity.message);
                error.code = integrity.code;
                error.data = integrity;
                throw error;
              }
              const saved = writeExportPayloadBundle(payload, { outputDir: job.outputDir });
              return {
                filePath: saved.filePath,
                bytes: saved.bytes,
                receipt: {
                  status: 'saved',
                  markdownHash: integrity.markdownHash,
                  assistantTurnCount: integrity.assistantTurnCount,
                },
              };
            },
          },
        });
        const watchdogPromise = new Promise((resolve) => {
          const watchdogTimer = setInterval(() => {
            const decision = evaluateConversationOperationWatchdog({
              operationId,
              now: Date.now(),
              lastProgressAt: operationLastProgressAt,
              noProgressMs,
              cancelRequested: job.cancelRequested === true,
            });
            if (decision.action === 'continue') return;
            clearInterval(watchdogTimer);
            operationAbortController.abort(decision.code);
            void requestActiveBrowserOperationCancelForJob(job, decision.code);
            resolve({
              status: decision.action === 'cancel' ? 'cancelled' : 'failed',
              operationId,
              chatId: target.targetChatId,
              code: decision.code,
              error: decision.message,
              reason: decision.message,
              receipts: { watchdog: decision },
            });
          }, Math.min(1000, Math.max(250, Math.floor(noProgressMs / 5))));
          operationPromise.finally(() => clearInterval(watchdogTimer));
        });
        const operationResult = await Promise.race([operationPromise, watchdogPromise]);
        clearTimeout(operationTimeoutTimer);
```

Then map the operation result:

```js
        if (operationResult.status === 'saved') {
          const result = {
            filePath: operationResult.filePath,
            payload: { chatId: operationResult.chatId },
            dateImport: operationResult.receipts?.dateImport || null,
            client,
          };
          const success = buildConversationExportSuccess({ index, conversation, result });
          success.operationId = operationId;
          success.batchPosition = target.batchPosition;
          success.historyIndex = target.historyIndex;
          success.receipts = operationResult.receipts;
          recordConversationExportSuccess(
            { job, successes, itemMetric, success, result },
            exportJobRecordingDeps,
          );
        } else if (operationResult.status === 'cancelled') {
          const error = new Error(operationResult.reason || 'Operação cancelada.');
          error.code = 'operation_cancelled';
          throw error;
        } else if (operationResult.status === 'failed') {
          const error = new Error(operationResult.error);
          error.code = operationResult.code;
          error.receipts = operationResult.receipts;
          throw error;
        }
```

This adapter is intentionally verbose. Later cleanup can move MCP-specific success/failure mapping into a smaller helper, but this task should first make recent export use the operation terminal contract.

- [ ] **Step 5: Remove old deferred save branch for recent export**

For recent export only, remove `deferDateImportSave` and `deferredSaves` usage in `runRecentChatsExportJob`. Keep direct export unchanged.

Ensure these lines are gone from the recent export block:

```js
    const deferDateImportSave = hasDateImportSource(args);
    const deferredSaves = [];
```

And remove the later `saveDeferredDateImportExports(...)` call from `runRecentChatsExportJob`.

Direct export can still use the old deferred path until it is migrated.

- [ ] **Step 6: Run focused tests**

```bash
npm run build:ts && node --test tests/conversation-operation-runner.test.mjs tests/recent-chats-load-more.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.js tests/recent-chats-load-more.test.mjs tests/conversation-operation-runner.test.mjs
git commit -m "feat: run recent exports through conversation operations"
```

---

### Task 12: Stop Ghost Progress Dock After Terminal MCP Progress

**Files:**
- Modify: `src/userscript-shell.ts`
- Modify: `tests/content-script.test.mjs`

- [ ] **Step 1: Add failing source test**

Append to `tests/content-script.test.mjs`:

```js
test('MCP terminal progress clears snapshot before finishing dock', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const terminalBlock = source.match(
    /if \(jobProgress\.status && TERMINAL_MCP_STATUSES\.has\(jobProgress\.status\)\) \{[\s\S]*?\n    \}/,
  )?.[0] || '';

  assert.match(terminalBlock, /state\.mcpTerminalProgressSeenAt/);
  assert.match(terminalBlock, /clearMcpProgressSnapshot\(\)/);
  assert.match(terminalBlock, /stopProgressCreep\(\)/);
  assert.match(terminalBlock, /finishExportProgress/);
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node --test tests/content-script.test.mjs --test-name-pattern "terminal progress"
```

Expected: FAIL until terminal handling records terminal seen time and stops creep before replay can keep the dock alive.

- [ ] **Step 3: Add terminal replay guard state**

In the initial `state` object in `src/userscript-shell.ts`, add:

```ts
    mcpTerminalProgressSeenAt: 0,
    mcpTerminalProgressJobId: null,
```

- [ ] **Step 4: Ignore repeated terminal replay after finish starts**

At the top of `handleMcpJobProgressBroadcast(jobProgress)`, after source filtering and before `beginMcpProgress`, add:

```ts
    if (
      jobProgress.status &&
      TERMINAL_MCP_STATUSES.has(jobProgress.status) &&
      state.mcpTerminalProgressJobId === jobProgress.jobId &&
      Date.now() - (state.mcpTerminalProgressSeenAt || 0) < PROGRESS_MIN_VISIBLE_MS + 1500
    ) {
      return;
    }
```

In the terminal block, before `finishExportProgress()`:

```ts
      state.mcpTerminalProgressSeenAt = Date.now();
      state.mcpTerminalProgressJobId = jobProgress.jobId || state.mcpProgressJobId || null;
      stopProgressCreep();
```

Keep `clearMcpProgressSnapshot()` before finishing. The MCP can still retain terminal snapshots for diagnostics; this only prevents visual replay from resurrecting the dock.

- [ ] **Step 5: Run focused tests**

```bash
npm run build:ts && node --test tests/content-script.test.mjs --test-name-pattern "terminal progress"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/userscript-shell.ts tests/content-script.test.mjs
git commit -m "fix: stop terminal progress dock replay"
```

---

### Task 13: Document Local Unpacked-Extension Testing Protocol

**Files:**
- Create: `docs/reference/local-unpacked-extension-testing.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the protocol document**

Create `docs/reference/local-unpacked-extension-testing.md`:

```md
# Local Unpacked Extension Testing Protocol

This protocol is for agents testing local builds of `gemini-md-export` against a Chromium unpacked extension.

It is not product auto-update. It is an operator responsibility during local testing.

## Required Steps

1. Build the project:

   ```bash
   npm run build
   ```

2. Ask the CLI/MCP diagnostics which unpacked extension path the browser is actually using.

   Useful commands:

   ```bash
   node bin/gemini-md-export.mjs browser status --plain --result-json
   node bin/gemini-md-export.mjs ready status --plain --result-json
   ```

3. Compare source/build version with loaded runtime version.

   If diagnostics show a newer source/build than the loaded runtime and the loaded path is known, do not keep retrying self-reload. The browser is loading stale files.

4. Synchronize the built extension into the loaded unpacked path.

   Example:

   ```bash
   rsync -a --delete dist/extension/ /path/reported/by/diagnostics/browser-extension/
   ```

   Use the path reported by diagnostics. Do not assume a default path when diagnostics already named the loaded path.

5. Reload the browser extension runtime.

   Prefer project commands when available:

   ```bash
   node bin/gemini-md-export.mjs browser status --allow-reload --plain --result-json
   ```

   If the runtime was loaded from a custom browser UI that cannot self-reload, reload the unpacked extension card manually.

6. Reload or reconnect Gemini tabs.

7. Confirm the loaded runtime version/build stamp matches the source before running export tests.

## Failure Pattern

If source says `0.8.54` but runtime says `0.8.53`, self-reload alone cannot fix the mismatch when the loaded folder still contains `0.8.53` files. Sync the loaded folder first.

## Agent Rule

Before claiming a browser-backed local test result, the agent must confirm the loaded runtime build matches the source build. If not, the test result is invalid.
```

- [ ] **Step 2: Add AGENTS pointer**

In `AGENTS.md`, near the existing baseline/testing or architecture section, add:

```md
- **Protocolo obrigatório para teste local com extensão unpacked:** antes de testar export no navegador, rode build, descubra pelo diagnóstico qual pasta unpacked o browser está usando, sincronize `dist/extension/` para essa pasta, recarregue a extensão/abas e confirme versão/build stamp. Self-reload não atualiza arquivos se a pasta carregada está velha. Detalhes em `docs/reference/local-unpacked-extension-testing.md`.
```

- [ ] **Step 3: Run docs sanity check**

```bash
test -f docs/reference/local-unpacked-extension-testing.md
rg -n "Self-reload não atualiza arquivos|local-unpacked-extension-testing" AGENTS.md docs/reference/local-unpacked-extension-testing.md
```

Expected: both commands exit 0 and show the new references.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/local-unpacked-extension-testing.md AGENTS.md
git commit -m "docs: document unpacked extension test protocol"
```

---

### Task 14: Final Verification

**Files:**
- No source files unless verification exposes a failure.

- [ ] **Step 1: Run TypeScript typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run focused test set**

```bash
npm run build:ts
node --test \
  tests/export-operation-contracts.test.mjs \
  tests/export-operation-lock.test.mjs \
  tests/export-operation-watchdog.test.mjs \
  tests/conversation-operation-runner.test.mjs \
  tests/progress-view-model.test.mjs \
  tests/mcp-client-lifecycle.test.mjs \
  tests/mcp-tab-selection.test.mjs \
  tests/content-script.test.mjs \
  tests/mcp-command-channel.test.mjs \
  tests/recent-chats-load-more.test.mjs \
  tests/gemini-cli-tui.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: PASS, preserving existing skipped tests.

- [ ] **Step 4: Check formatting drift**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Run browserless bridge smoke**

```bash
node scripts/bridge-smoke.mjs --spawn --json
```

Expected: JSON result with bridge health OK, events/heartbeat/snapshot tested, and no login-dependent failure.

- [ ] **Step 6: Manual browser export smoke with protocol**

Only run after syncing the loaded unpacked extension path per `docs/reference/local-unpacked-extension-testing.md`.

```bash
rm -rf /tmp/gme-phase1-export-smoke
mkdir -p /tmp/gme-phase1-export-smoke
node bin/gemini-md-export.mjs export recent \
  --max-chats 30 \
  --output-dir /tmp/gme-phase1-export-smoke \
  --activate-tab \
  --plain \
  --result-json \
  --timeout-ms 900000
```

Expected:

- report has 30 terminal entries;
- no item stalls silently past the configured no-progress timeout;
- browser dock shows one `N de 30` count;
- dock disappears after terminal status;
- report date receipts are present;
- output files have `date_created` or `date_last_message` when Takeout/My Activity evidence exists, or an explicit absence receipt when not.

- [ ] **Step 7: Commit verification-only adjustments if any**

If verification required code changes, inspect the changed paths first:

```bash
git status --short
```

Then stage only the files that were edited during Task 14. For example, if only runtime and focused tests changed:

```bash
git add src/mcp-server.js src/userscript-shell.ts tests/mcp-command-channel.test.mjs tests/content-script.test.mjs
git commit -m "fix: stabilize export runtime refactor verification"
```

If no files changed, do not create an empty commit.
