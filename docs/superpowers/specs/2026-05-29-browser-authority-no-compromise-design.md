# Browser Authority No-Compromise Design

Date: 2026-05-29
Status: Approved and implemented in the working tree; browser-real release smokes pending

## Goal

Make browser side effects impossible unless a single authority grants them.

The product UX target is no compromise:

- export and repair flows should prefer the Gemini private API and avoid browser tab work when possible;
- when browser work is necessary, it must be scoped to one explicit operation lease;
- no code path may open, reload, activate, navigate, claim, or mutate a browser tab directly;
- Google verification, login, stale runtime, build mismatch, and tab ambiguity must become typed blockers, not retry loops;
- the user should see a simple export/repair/progress experience, not implementation terms like leases, heartbeats, or retries.

The immediate failure this design fixes is operational: the repo already has good pieces, but authority is fragmented across `browser-side-effects`, `tab-orchestrator`, `blocker-aware-tab-lifecycle`, `browser-launch`, `existing-tabs-reload`, the content script, and MCP command handlers. Each layer can still make partial lifecycle decisions. That makes duplicate tab creation and broad reloads possible.

## Approaches Considered

### 1. Harden Existing Guards

Keep the current modules and add more checks where failures appeared.

Pros:

- smallest code diff;
- low migration cost;
- can patch the last observed bug quickly.

Cons:

- preserves the root problem: multiple modules still decide browser lifecycle;
- each new workflow needs to remember all guardrails;
- easy to regress through a legacy command or content-script fallback;
- does not make the architecture easier to reason about.

Decision: rejected. This is the loop we must stop.

### 2. Policy Wrapper Around Side Effects

Keep current modules but require every side-effect call to pass through a shared policy function.

Pros:

- better than scattered checks;
- can produce useful tests for "no implicit browser side effect";
- lower risk than a full orchestration rewrite.

Cons:

- policy would still be separate from allocation, claims, blockers, runtime epoch, and recovery;
- commands could be "allowed" without carrying enough ownership context;
- does not naturally express budgets, managed tabs, or operation cleanup.

Decision: useful as a migration step, not sufficient as the final design.

### 3. Single Browser Authority With Operation Leases

Create one TypeScript authority that owns browser effects. All shells ask it for a lease and execute only typed effects returned by it.

Pros:

- browser side effects become fail-closed by construction;
- CLI, MCP, extension UI, and content script share one contract;
- operation ownership, budget, blocker handling, cleanup, and diagnostics live together;
- private API can be the default path, with browser work only as bootstrap or recovery;
- testable as pure FSMs before touching real Dia/Chrome.

Cons:

- larger migration;
- legacy MCP/content-script commands need explicit deprecation or adaptation;
- needs strong contract tests to prevent bypasses.

Decision: recommended and approved direction.

## Product Model

The user does not interact with leases.

From the user's perspective:

1. They choose an export or repair action.
2. The product checks whether the private API path can do the work without browser tab control.
3. If browser control is needed, the product creates an internal operation lease.
4. Progress appears in the same UI/viewmodel regardless of whether the backend is private API, extension background, or sidecar.
5. If Google blocks the browser profile, the operation stops with a clear message and no further tab retries.
6. On completion or cancellation, the lease is released and any managed browser state is cleaned up.

The lease is an internal safety capability, not a user-facing workflow step.

## Architecture

Introduce a browser authority layer in TypeScript.

```text
CLI / MCP / Extension UI / Content Script
  -> Export or Repair Workflow
    -> Private API Adapter first
    -> Browser Authority only if browser side effect is required
      -> pure FSMs
      -> typed effects
      -> shell executors
```

The authority composes existing concepts instead of duplicating them:

- side-effect policy from `src/mcp/browser-side-effects.ts`;
- runtime epoch readiness from `src/mcp/tab-orchestrator/runtime-epoch-fsm.ts`;
- tab pool and allocation from `src/mcp/tab-orchestrator/tab-lifecycle-fsm.ts`;
- blocker handling from `src/mcp/blocker-aware-tab-lifecycle.ts`;
- reload and recovery decisions from `src/mcp/tab-orchestrator/recovery-fsm.ts` and `src/mcp/existing-tabs-reload.ts`;
- tab claims and visual cleanup from the existing tab claim modules.

The difference is ownership: those modules become implementation details of one authority. Public workflows do not call them independently.

## Core Contracts

### BrowserLease

`BrowserLease` is a typed capability created only by the browser authority.

It includes:

- `leaseId`;
- `operationId`;
- `operationKind`;
- `owner`, such as `cli`, `mcp`, `extension-ui`, or `repair`;
- `policy`, such as `none`, `private_first`, `job_safe`, or `interactive_explicit`;
- `budget`, including max new tabs, max reloads, max activations, and deadline;
- `managedTabs`, limited to tabs created or claimed by this lease;
- `epoch`, the expected extension runtime;
- `blocker`, if the operation reached a terminal browser blocker;
- `releasePlan`, including visual claim cleanup.

Only code receiving a valid `BrowserLease` can execute browser effects.

### BrowserEffect

All browser mutations are represented as typed effects:

- `browser.launch`;
- `tab.activate`;
- `tab.reload`;
- `tab.navigate`;
- `extension.reload`;
- `contentScript.command`;
- `tab.claimVisual`;
- `tab.releaseVisual`;
- `managedTab.cleanup`.

Effects include the `leaseId` and are rejected by the shell if the lease is missing, expired, mismatched, or over budget.

### BrowserBlocker

Terminal blockers are explicit:

- `google_verification_required`;
- `google_login_required`;
- `extension_build_mismatch_unrecoverable`;
- `runtime_epoch_timeout`;
- `ambiguous_gemini_tabs`;
- `native_broker_unavailable_for_required_effect`;
- `browser_side_effects_disabled`;
- `operation_budget_exhausted`.

Google verification is profile-scoped by default. If one Gemini launch hits `google.com/sorry`, the authority assumes the profile is blocked and suppresses new launches until a valid Gemini page is observed after user resolution.

## Private-First Data Flow

Export and repair workflows must choose the least browser-dependent adapter that can satisfy the request:

1. Known chat IDs: private API read/export first.
2. Vault repair with missing assets or raw/suspect exports: private API repair first.
3. Metadata/date repair: use MarkdownDB and private metadata where available; browser/My Activity is a fallback only when explicitly needed.
4. Inventory/listing: use private inventory when available; extension/sidebar inventory becomes fallback behind a browser lease.
5. DOM export: legacy fallback only, never the default for a known chat ID.

The workflow result is a shared viewmodel. CLI, MCP, and extension UI render the same job state, progress, item outcomes, assets, warnings, and auth/browser blockers.

## Shell Boundaries

The browser authority is pure decision logic plus adapter interfaces.

Pure TypeScript modules own:

- operation state machines;
- lease allocation;
- effect budgeting;
- blocker transitions;
- adapter selection;
- progress state;
- release policy.

Shells own:

- filesystem writes;
- HTTP bridge calls;
- Chrome/Dia extension APIs;
- native broker calls;
- Python sidecar process calls;
- user-visible rendering.

The content script cannot decide lifecycle policy. It may expose commands and execute effects only when the command carries a valid browser authority token or lease marker.

## Migration Plan

### Slice 1: Authority Contract

Add pure TypeScript contracts and FSM tests:

- `BrowserLease`;
- `BrowserEffect`;
- `BrowserBlocker`;
- `BrowserAuthorityState`;
- `transitionBrowserAuthority(state, event) -> { state, effects }`.

No runtime behavior changes in this slice.

### Slice 2: Side-Effect Gate Becomes Lease Gate

Replace generic explicit-intent checks with lease validation:

- MCP browser launch;
- extension reload;
- tab reload;
- tab activation;
- tab navigation;
- content-script heavy commands.

Existing `explicit=true` stays temporarily as a compatibility input, but it must be converted into a lease before any effect is emitted.

### Slice 3: Private-First Export/Repair Adapter Selection

Move selected export, recent export, sync, missing, reexport, and fix-vault to one adapter-selection flow:

```text
private API -> extension background private API -> Python sidecar -> browser lease fallback -> DOM legacy fallback
```

Each step returns the same normalized job item result.

### Slice 4: Extension UI Parity

The extension modal becomes a thin launcher for the same job contract as CLI/MCP.

It must display:

- progress;
- current item;
- completed/failed counts;
- asset download progress when known;
- auth/session blockers;
- Google verification blockers;
- final report.

It must not run a separate export brain inside the content script.

### Slice 5: Remove Bypasses

Add static and runtime tests that fail if code calls browser side-effect executors without the authority:

- no direct `launchChromeForGemini` from workflow code;
- no direct `reloadGeminiTabs` without authority lease;
- no content-script command that mutates tabs without lease marker;
- no `openIfMissing` path that bypasses authority;
- no browser wake from release or smoke commands unless explicitly leased.

### Slice 6: Release Smokes

Required release smokes:

- private selected export of a real chat with assets;
- extension modal selected export using the shared job viewmodel;
- fix-vault repair of missing assets in a temporary vault;
- recent export small batch without opening a new tab when private inventory is enough;
- Google verification fixture proves launch suppression and no retry loop;
- stale build fixture proves epoch wait/reload does not accept old heartbeat evidence;
- side-effect audit proves no operation opened more than its lease budget.

## Error Handling

User-facing messages stay simple:

- "Sua sessão do Google expirou. Abra o Gemini no navegador e entre de novo."
- "O Google pediu uma verificação no navegador. Resolva essa tela e rode de novo."
- "A extensão do Dia ainda está antiga. Recarregue a extensão uma vez e tente novamente."
- "Encontrei mais de uma aba possível. Escolha uma aba ou feche as duplicadas."

Internal reports can include lease IDs, budgets, epoch IDs, and adapter attempts, but the primary UX does not show those terms.

## Testing

Add tests in four layers:

1. Pure FSM tests for lease creation, blocker transitions, budgets, cleanup, and private-first adapter selection.
2. Type contract tests proving browser effect executors require `BrowserLease`.
3. Source-level bypass tests scanning known entrypoints for forbidden direct calls.
4. Integration tests for CLI/MCP/extension viewmodel parity.

Browser-real smokes are release gates, not the first line of correctness.

## Success Criteria

The change is done when all of the following are true:

- A normal selected export of known chat IDs uses private API without opening a new tab.
- A repair of missing assets uses private API before any browser fallback.
- Every browser mutation has a recorded lease owner, budget, and release result.
- Google verification stops retries globally for that profile until resolved.
- CLI, MCP, and extension UI receive the same job viewmodel.
- Tests fail if a new workflow opens, reloads, activates, navigates, or mutates a tab outside the authority.
- Release notes can honestly say browser control is controlled, scoped, and private-first.
