# Browser Authority No-Compromise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini browser side effects lease-only, private-first, and shared across CLI, MCP, and extension UI.

**Current status, 2026-05-29:** Implemented in the working tree, with automated verification passing. Commit steps are intentionally not marked complete because this workspace already contains broader release-prep changes. Browser-real release smokes remain a separate gate: real selected export with assets, extension modal export, `fix-vault` against a temporary vault, private inventory recent export, and blocker/runtime fixtures.

**Architecture:** Add a pure TypeScript Browser Authority that emits typed effects only under a valid operation lease. Existing browser lifecycle modules become implementation details behind that authority. Export and repair workflows choose private API adapters before any browser lease fallback.

**Tech Stack:** TypeScript strict mode, Node test runner, Biome, existing MV3 extension/background, MCP bridge, Python sidecar through existing adapter boundaries.

---

## Execution Topology

Sequential gates:

1. Land pure Browser Authority contracts and FSM tests.
2. Add lease validation around browser side-effect commands.
3. Route MCP/CLI/browser readiness through the authority.
4. Route export/repair adapter selection through private-first policy.
5. Promote extension UI to the shared job/viewmodel path.
6. Add bypass scans and release smokes.

Parallel-safe tracks after Gate 2:

- Private-first adapter selection can progress in `src/core/` and `src/mcp/private-*`.
- Extension UI parity can progress in `src/userscript-shell.ts` and `src/extension-background.ts`.
- Static bypass tests can progress in `tests/browser-authority-bypass.test.mjs`.

Join points:

- Gate 3 must pass before browser-real smokes.
- Gate 4 and Gate 5 must pass before claiming CLI/MCP/extension parity.
- Gate 6 is the release gate.

## File Structure

Create:

- `src/mcp/browser-authority/types.ts`: public types for leases, budgets, effects, blockers, and state.
- `src/mcp/browser-authority/fsm.ts`: pure transition function.
- `src/mcp/browser-authority/lease-gate.ts`: shell-side validation for effects carrying a lease.
- `src/mcp/browser-authority/mcp-runtime.ts`: adapters between MCP arguments, existing client evidence, and authority events.
- `src/mcp/browser-authority/index.ts`: barrel exports.
- `src/core/export-adapter-policy.ts`: private-first adapter selection FSM shared by export and repair workflows.
- `tests/browser-authority-fsm.test.mjs`: pure authority behavior.
- `tests/browser-authority-lease-gate.test.mjs`: shell validation.
- `tests/browser-authority-bypass.test.mjs`: source-level no-bypass assertions.
- `tests/export-adapter-policy.test.mjs`: private-first adapter selection.
- `tests/browser-authority-types.ts`: compile-time contract tests.

Modify:

- `src/mcp-server.js`: replace direct side-effect permission and scattered launch/reload decisions with authority runtime calls.
- `src/mcp/browser-side-effects.ts`: keep kill switch and explicit runtime state, but make mutation permission lease-aware.
- `src/browser/shared/tab-commands.ts`: carry authority lease markers for mutating commands.
- `src/userscript-shell.ts`: reject mutating browser commands without the authority marker.
- `src/extension-background.ts`: pass lease marker through private/export job launch and reload commands.
- `src/mcp/export-workflows.ts`: use private-first adapter policy for selected/recent/sync/missing/reexport.
- `src/core/fix-vault-flow.ts`: use private-first adapter policy before browser fallback.
- `tests/browser-side-effects.test.mjs`: update expectations from explicit intent to lease intent.
- `tests/mcp-command-channel.test.mjs`: verify MCP routes through authority.
- `tests/gemini-cli-tui.test.mjs`: verify CLI does not wake/reload browser outside leased paths.

## Task 1: Browser Authority Types

**Files:**

- Create: `src/mcp/browser-authority/types.ts`
- Create: `src/mcp/browser-authority/index.ts`
- Test: `tests/browser-authority-types.ts`

- [ ] **Step 1: Write the compile-time contract test**

Create `tests/browser-authority-types.ts`:

```ts
import type {
  BrowserAuthorityEffect,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from '../src/mcp/browser-authority/index.js';

declare const lease: BrowserLease;
declare const unleasedLaunch: BrowserAuthorityEffect & { type: 'browser.launch' };
declare const leasedLaunch: LeasedBrowserAuthorityEffect & { type: 'browser.launch' };

declare function executeBrowserEffect(effect: LeasedBrowserAuthorityEffect): void;
declare function acceptLease(value: BrowserLease): void;

acceptLease(lease);
executeBrowserEffect(leasedLaunch);

// @ts-expect-error Browser mutations require a leased effect.
executeBrowserEffect(unleasedLaunch);
```

- [ ] **Step 2: Run the type test and verify it fails**

Run:

```bash
npm run build:ts
```

Expected: fail because `src/mcp/browser-authority/index.ts` does not exist.

- [ ] **Step 3: Add the types**

Create `src/mcp/browser-authority/types.ts`:

```ts
export type BrowserAuthorityOwner = 'cli' | 'mcp' | 'extension-ui' | 'repair' | 'test';

export type BrowserAuthorityPolicy = 'none' | 'private_first' | 'job_safe' | 'interactive_explicit';

export type BrowserAuthorityOperationKind =
  | 'selected_export'
  | 'recent_export'
  | 'sync_export'
  | 'missing_export'
  | 'reexport'
  | 'fix_vault'
  | 'ready_check'
  | 'tab_management'
  | 'diagnostic';

export type BrowserAuthorityBudget = Readonly<{
  maxNewTabs: number;
  maxReloads: number;
  maxActivations: number;
  maxNavigations: number;
  deadlineAtMs: number;
}>;

export type BrowserAuthorityBlockerCode =
  | 'google_verification_required'
  | 'google_login_required'
  | 'extension_build_mismatch_unrecoverable'
  | 'runtime_epoch_timeout'
  | 'ambiguous_gemini_tabs'
  | 'native_broker_unavailable_for_required_effect'
  | 'browser_side_effects_disabled'
  | 'operation_budget_exhausted'
  | 'lease_missing'
  | 'lease_expired'
  | 'lease_mismatch';

export type BrowserAuthorityBlocker = Readonly<{
  code: BrowserAuthorityBlockerCode;
  scope: 'operation' | 'tab' | 'profile';
  terminal: true;
  message: string;
  nextAction: string;
  observedAtMs: number;
}>;

export type BrowserLease = Readonly<{
  leaseId: string;
  operationId: string;
  operationKind: BrowserAuthorityOperationKind;
  owner: BrowserAuthorityOwner;
  policy: BrowserAuthorityPolicy;
  budget: BrowserAuthorityBudget;
  managedTabIds: readonly number[];
  expectedEpochId?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  blocker?: BrowserAuthorityBlocker | null;
  releasedAtMs?: number | null;
}>;

export type BrowserAuthorityEffectType =
  | 'browser.launch'
  | 'tab.activate'
  | 'tab.reload'
  | 'tab.navigate'
  | 'extension.reload'
  | 'contentScript.command'
  | 'tab.claimVisual'
  | 'tab.releaseVisual'
  | 'managedTab.cleanup'
  | 'diagnostic.record';

export type BrowserAuthorityEffect = Readonly<{
  type: BrowserAuthorityEffectType;
  reason: string;
  leaseId?: string;
  tabId?: number | null;
  url?: string | null;
  commandType?: string | null;
  blocker?: BrowserAuthorityBlocker | null;
}>;

export type LeasedBrowserAuthorityEffect = BrowserAuthorityEffect & Readonly<{ leaseId: string }>;

export type BrowserAuthorityState = Readonly<{
  leases: readonly BrowserLease[];
  profileBlocker?: BrowserAuthorityBlocker | null;
  updatedAtMs: number;
}>;
```

Create `src/mcp/browser-authority/index.ts`:

```ts
export type {
  BrowserAuthorityBlocker,
  BrowserAuthorityBlockerCode,
  BrowserAuthorityBudget,
  BrowserAuthorityEffect,
  BrowserAuthorityEffectType,
  BrowserAuthorityOperationKind,
  BrowserAuthorityOwner,
  BrowserAuthorityPolicy,
  BrowserAuthorityState,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from './types.js';
```

- [ ] **Step 4: Run the type test**

Run:

```bash
npm run build:ts
```

Expected: pass the new type declarations and honor the `@ts-expect-error`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/browser-authority/types.ts src/mcp/browser-authority/index.ts tests/browser-authority-types.ts
git commit -m "feat: add browser authority contracts"
```

## Task 2: Browser Authority FSM

**Files:**

- Create: `src/mcp/browser-authority/fsm.ts`
- Modify: `src/mcp/browser-authority/index.ts`
- Test: `tests/browser-authority-fsm.test.mjs`

- [ ] **Step 1: Write failing FSM tests**

Create `tests/browser-authority-fsm.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialBrowserAuthorityState,
  transitionBrowserAuthority,
} from '../build/ts/mcp/browser-authority/index.js';

const budget = {
  maxNewTabs: 1,
  maxReloads: 1,
  maxActivations: 1,
  maxNavigations: 1,
  deadlineAtMs: 10_000,
};

test('browser authority grants a lease and emits leased launch effect', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = transitionBrowserAuthority(start, {
    type: 'leaseRequested',
    nowMs: 1_000,
    leaseId: 'lease-1',
    operationId: 'op-1',
    operationKind: 'selected_export',
    owner: 'cli',
    policy: 'private_first',
    budget,
  });

  assert.equal(result.state.leases.length, 1);
  assert.equal(result.state.leases[0].leaseId, 'lease-1');

  const launch = transitionBrowserAuthority(result.state, {
    type: 'effectRequested',
    nowMs: 1_100,
    leaseId: 'lease-1',
    effect: {
      type: 'browser.launch',
      reason: 'no_ready_private_session',
      url: 'https://gemini.google.com/app',
    },
  });

  assert.equal(launch.effects[0].type, 'browser.launch');
  assert.equal(launch.effects[0].leaseId, 'lease-1');
});

test('browser authority blocks effects without a valid lease', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const result = transitionBrowserAuthority(start, {
    type: 'effectRequested',
    nowMs: 1_000,
    leaseId: 'missing',
    effect: { type: 'tab.reload', reason: 'test', tabId: 1 },
  });

  assert.equal(result.effects.length, 0);
  assert.equal(result.blocker?.code, 'lease_missing');
});

test('browser authority suppresses profile-wide Google verification retries', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const blocked = transitionBrowserAuthority(start, {
    type: 'profileBlockerObserved',
    nowMs: 1_000,
    blocker: {
      code: 'google_verification_required',
      scope: 'profile',
      terminal: true,
      message: 'O Google pediu uma verificacao.',
      nextAction: 'Resolva a verificacao no navegador.',
      observedAtMs: 1_000,
    },
  });

  const lease = transitionBrowserAuthority(blocked.state, {
    type: 'leaseRequested',
    nowMs: 1_100,
    leaseId: 'lease-2',
    operationId: 'op-2',
    operationKind: 'recent_export',
    owner: 'mcp',
    policy: 'job_safe',
    budget,
  });

  assert.equal(lease.state.leases.length, 0);
  assert.equal(lease.blocker?.code, 'google_verification_required');
});

test('browser authority releases a lease and stops future effects', () => {
  const start = initialBrowserAuthorityState({ nowMs: 1_000 });
  const leased = transitionBrowserAuthority(start, {
    type: 'leaseRequested',
    nowMs: 1_000,
    leaseId: 'lease-3',
    operationId: 'op-3',
    operationKind: 'fix_vault',
    owner: 'repair',
    policy: 'private_first',
    budget,
  });
  const released = transitionBrowserAuthority(leased.state, {
    type: 'leaseReleased',
    nowMs: 1_500,
    leaseId: 'lease-3',
    reason: 'operation_completed',
  });
  const effect = transitionBrowserAuthority(released.state, {
    type: 'effectRequested',
    nowMs: 1_600,
    leaseId: 'lease-3',
    effect: { type: 'tab.reload', reason: 'after_release', tabId: 5 },
  });

  assert.equal(effect.effects.length, 0);
  assert.equal(effect.blocker?.code, 'lease_expired');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run build:ts && node --test tests/browser-authority-fsm.test.mjs
```

Expected: fail because `initialBrowserAuthorityState` and `transitionBrowserAuthority` are not exported.

- [ ] **Step 3: Implement the FSM**

Create `src/mcp/browser-authority/fsm.ts`:

```ts
import type {
  BrowserAuthorityBlocker,
  BrowserAuthorityBudget,
  BrowserAuthorityEffect,
  BrowserAuthorityOperationKind,
  BrowserAuthorityOwner,
  BrowserAuthorityPolicy,
  BrowserAuthorityState,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from './types.js';

export type BrowserAuthorityEvent =
  | Readonly<{
      type: 'leaseRequested';
      nowMs: number;
      leaseId: string;
      operationId: string;
      operationKind: BrowserAuthorityOperationKind;
      owner: BrowserAuthorityOwner;
      policy: BrowserAuthorityPolicy;
      budget: BrowserAuthorityBudget;
      expectedEpochId?: string | null;
    }>
  | Readonly<{
      type: 'effectRequested';
      nowMs: number;
      leaseId: string;
      effect: BrowserAuthorityEffect;
    }>
  | Readonly<{
      type: 'profileBlockerObserved';
      nowMs: number;
      blocker: BrowserAuthorityBlocker;
    }>
  | Readonly<{
      type: 'leaseReleased';
      nowMs: number;
      leaseId: string;
      reason: string;
    }>;

export type BrowserAuthorityTransition = Readonly<{
  state: BrowserAuthorityState;
  effects: readonly LeasedBrowserAuthorityEffect[];
  blocker?: BrowserAuthorityBlocker | null;
}>;

export const initialBrowserAuthorityState = ({
  nowMs = Date.now(),
}: Readonly<{ nowMs?: number }> = {}): BrowserAuthorityState => ({
  leases: [],
  profileBlocker: null,
  updatedAtMs: nowMs,
});

const blocker = (
  code: BrowserAuthorityBlocker['code'],
  nowMs: number,
  message: string,
  nextAction: string,
): BrowserAuthorityBlocker => ({
  code,
  scope: 'operation',
  terminal: true,
  message,
  nextAction,
  observedAtMs: nowMs,
});

const activeLease = (state: BrowserAuthorityState, leaseId: string): BrowserLease | null =>
  state.leases.find((lease) => lease.leaseId === leaseId) || null;

const leaseIsExpired = (lease: BrowserLease, nowMs: number): boolean =>
  !!lease.releasedAtMs || lease.budget.deadlineAtMs <= nowMs;

const effectCost = (effect: BrowserAuthorityEffect): keyof BrowserAuthorityBudget | null => {
  if (effect.type === 'browser.launch') return 'maxNewTabs';
  if (effect.type === 'tab.reload' || effect.type === 'extension.reload') return 'maxReloads';
  if (effect.type === 'tab.activate') return 'maxActivations';
  if (effect.type === 'tab.navigate') return 'maxNavigations';
  return null;
};

const budgetAllowsEffect = (lease: BrowserLease, effect: BrowserAuthorityEffect): boolean => {
  const key = effectCost(effect);
  if (!key) return true;
  return Number(lease.budget[key]) > 0;
};

const spendBudget = (lease: BrowserLease, effect: BrowserAuthorityEffect, nowMs: number): BrowserLease => {
  const key = effectCost(effect);
  if (!key) return { ...lease, updatedAtMs: nowMs };
  return {
    ...lease,
    budget: {
      ...lease.budget,
      [key]: Math.max(0, Number(lease.budget[key]) - 1),
    },
    updatedAtMs: nowMs,
  };
};

const upsertLease = (leases: readonly BrowserLease[], next: BrowserLease): readonly BrowserLease[] => [
  ...leases.filter((lease) => lease.leaseId !== next.leaseId),
  next,
];

export const transitionBrowserAuthority = (
  state: BrowserAuthorityState,
  event: BrowserAuthorityEvent,
): BrowserAuthorityTransition => {
  if (event.type === 'profileBlockerObserved') {
    return {
      state: {
        ...state,
        profileBlocker: event.blocker,
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: event.blocker,
    };
  }

  if (event.type === 'leaseRequested') {
    if (state.profileBlocker?.terminal) {
      return {
        state: { ...state, updatedAtMs: event.nowMs },
        effects: [],
        blocker: state.profileBlocker,
      };
    }

    const lease: BrowserLease = {
      leaseId: event.leaseId,
      operationId: event.operationId,
      operationKind: event.operationKind,
      owner: event.owner,
      policy: event.policy,
      budget: event.budget,
      managedTabIds: [],
      expectedEpochId: event.expectedEpochId || null,
      createdAtMs: event.nowMs,
      updatedAtMs: event.nowMs,
      blocker: null,
      releasedAtMs: null,
    };

    return {
      state: {
        ...state,
        leases: upsertLease(state.leases, lease),
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: null,
    };
  }

  if (event.type === 'leaseReleased') {
    return {
      state: {
        ...state,
        leases: state.leases.map((lease) =>
          lease.leaseId === event.leaseId
            ? { ...lease, releasedAtMs: event.nowMs, updatedAtMs: event.nowMs }
            : lease,
        ),
        updatedAtMs: event.nowMs,
      },
      effects: [],
      blocker: null,
    };
  }

  const lease = activeLease(state, event.leaseId);
  if (!lease) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: blocker(
        'lease_missing',
        event.nowMs,
        'A operacao nao tem uma autorizacao de navegador valida.',
        'Reinicie a operacao pelo fluxo principal.',
      ),
    };
  }

  if (leaseIsExpired(lease, event.nowMs)) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: blocker(
        'lease_expired',
        event.nowMs,
        'A autorizacao de navegador desta operacao expirou.',
        'Reinicie a operacao se ainda precisar controlar o navegador.',
      ),
    };
  }

  if (!budgetAllowsEffect(lease, event.effect)) {
    return {
      state: { ...state, updatedAtMs: event.nowMs },
      effects: [],
      blocker: blocker(
        'operation_budget_exhausted',
        event.nowMs,
        'A operacao atingiu o limite seguro de controle do navegador.',
        'Pare e revise o diagnostico antes de tentar de novo.',
      ),
    };
  }

  const spentLease = spendBudget(lease, event.effect, event.nowMs);
  const leasedEffect: LeasedBrowserAuthorityEffect = {
    ...event.effect,
    leaseId: event.leaseId,
  };

  return {
    state: {
      ...state,
      leases: upsertLease(state.leases, spentLease),
      updatedAtMs: event.nowMs,
    },
    effects: [leasedEffect],
    blocker: null,
  };
};
```

Update `src/mcp/browser-authority/index.ts`:

```ts
export {
  initialBrowserAuthorityState,
  transitionBrowserAuthority,
  type BrowserAuthorityEvent,
  type BrowserAuthorityTransition,
} from './fsm.js';
export type {
  BrowserAuthorityBlocker,
  BrowserAuthorityBlockerCode,
  BrowserAuthorityBudget,
  BrowserAuthorityEffect,
  BrowserAuthorityEffectType,
  BrowserAuthorityOperationKind,
  BrowserAuthorityOwner,
  BrowserAuthorityPolicy,
  BrowserAuthorityState,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from './types.js';
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run build:ts && node --test tests/browser-authority-fsm.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/browser-authority/fsm.ts src/mcp/browser-authority/index.ts tests/browser-authority-fsm.test.mjs
git commit -m "feat: add browser authority FSM"
```

## Task 3: Lease Gate For Shell Effects

**Files:**

- Create: `src/mcp/browser-authority/lease-gate.ts`
- Modify: `src/mcp/browser-authority/index.ts`
- Test: `tests/browser-authority-lease-gate.test.mjs`

- [ ] **Step 1: Write failing gate tests**

Create `tests/browser-authority-lease-gate.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLeasedBrowserEffect,
  browserAuthorityLeaseToken,
} from '../build/ts/mcp/browser-authority/index.js';

test('lease gate accepts matching leased browser effect', () => {
  const lease = {
    leaseId: 'lease-1',
    operationId: 'op-1',
    operationKind: 'selected_export',
    owner: 'cli',
    policy: 'private_first',
    budget: {
      maxNewTabs: 1,
      maxReloads: 1,
      maxActivations: 1,
      maxNavigations: 1,
      deadlineAtMs: 9_999,
    },
    managedTabIds: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  const token = browserAuthorityLeaseToken(lease);
  const effect = assertLeasedBrowserEffect({
    effect: { type: 'tab.reload', reason: 'test', leaseId: 'lease-1', tabId: 10 },
    token,
    nowMs: 2,
  });

  assert.equal(effect.leaseId, 'lease-1');
});

test('lease gate rejects missing token', () => {
  assert.throws(
    () =>
      assertLeasedBrowserEffect({
        effect: { type: 'tab.reload', reason: 'test', leaseId: 'lease-1', tabId: 10 },
        token: null,
        nowMs: 2,
      }),
    /autorizacao de navegador/i,
  );
});

test('lease gate rejects mismatched token', () => {
  const token = {
    leaseId: 'lease-real',
    operationId: 'op-1',
    deadlineAtMs: 9_999,
  };

  assert.throws(
    () =>
      assertLeasedBrowserEffect({
        effect: { type: 'browser.launch', reason: 'test', leaseId: 'lease-other' },
        token,
        nowMs: 2,
      }),
    /nao pertence/i,
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run build:ts && node --test tests/browser-authority-lease-gate.test.mjs
```

Expected: fail because `lease-gate.ts` is missing.

- [ ] **Step 3: Implement lease gate**

Create `src/mcp/browser-authority/lease-gate.ts`:

```ts
import type { BrowserAuthorityEffect, BrowserLease, LeasedBrowserAuthorityEffect } from './types.js';

export type BrowserAuthorityLeaseToken = Readonly<{
  leaseId: string;
  operationId: string;
  deadlineAtMs: number;
}>;

export const browserAuthorityLeaseToken = (lease: BrowserLease): BrowserAuthorityLeaseToken => ({
  leaseId: lease.leaseId,
  operationId: lease.operationId,
  deadlineAtMs: lease.budget.deadlineAtMs,
});

export const assertLeasedBrowserEffect = ({
  effect,
  token,
  nowMs = Date.now(),
}: Readonly<{
  effect: BrowserAuthorityEffect;
  token?: BrowserAuthorityLeaseToken | null;
  nowMs?: number;
}>): LeasedBrowserAuthorityEffect => {
  if (!token) {
    throw Object.assign(new Error('Controle do navegador exige autorizacao de navegador valida.'), {
      code: 'browser_authority_lease_missing',
    });
  }

  if (!effect.leaseId || effect.leaseId !== token.leaseId) {
    throw Object.assign(
      new Error('Este comando de navegador nao pertence a autorizacao desta operacao.'),
      { code: 'browser_authority_lease_mismatch' },
    );
  }

  if (token.deadlineAtMs <= nowMs) {
    throw Object.assign(new Error('A autorizacao de navegador desta operacao expirou.'), {
      code: 'browser_authority_lease_expired',
    });
  }

  return { ...effect, leaseId: token.leaseId };
};
```

Update `src/mcp/browser-authority/index.ts`:

```ts
export {
  assertLeasedBrowserEffect,
  browserAuthorityLeaseToken,
  type BrowserAuthorityLeaseToken,
} from './lease-gate.js';
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run build:ts && node --test tests/browser-authority-lease-gate.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/browser-authority/lease-gate.ts src/mcp/browser-authority/index.ts tests/browser-authority-lease-gate.test.mjs
git commit -m "feat: require browser authority lease tokens"
```

## Task 4: Private-First Adapter Policy

**Files:**

- Create: `src/core/export-adapter-policy.ts`
- Test: `tests/export-adapter-policy.test.mjs`

- [ ] **Step 1: Write failing policy tests**

Create `tests/export-adapter-policy.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { planExportAdapters } from '../build/ts/core/export-adapter-policy.js';

test('known chat ids prefer private API and avoid browser lease', () => {
  const plan = planExportAdapters({
    operationKind: 'selected_export',
    knownChatIds: ['abc123abc123'],
    privateApiAvailable: true,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: true,
    browserFallbackAllowed: true,
  });

  assert.deepEqual(plan.adapters.map((item) => item.kind), ['private_api']);
  assert.equal(plan.requiresBrowserLease, false);
});

test('private API falls back to extension private API before browser DOM', () => {
  const plan = planExportAdapters({
    operationKind: 'selected_export',
    knownChatIds: ['abc123abc123'],
    privateApiAvailable: false,
    extensionPrivateApiAvailable: true,
    pythonSidecarAvailable: true,
    browserFallbackAllowed: true,
  });

  assert.deepEqual(plan.adapters.map((item) => item.kind), ['extension_private_api', 'python_sidecar']);
  assert.equal(plan.requiresBrowserLease, false);
});

test('inventory fallback requires a browser lease when private inventory is unavailable', () => {
  const plan = planExportAdapters({
    operationKind: 'recent_export',
    knownChatIds: [],
    privateApiAvailable: false,
    privateInventoryAvailable: false,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: false,
    browserFallbackAllowed: true,
  });

  assert.equal(plan.requiresBrowserLease, true);
  assert.deepEqual(plan.adapters.map((item) => item.kind), ['browser_inventory', 'dom_legacy']);
});

test('browser fallback disabled returns a blocker instead of DOM fallback', () => {
  const plan = planExportAdapters({
    operationKind: 'recent_export',
    knownChatIds: [],
    privateApiAvailable: false,
    privateInventoryAvailable: false,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: false,
    browserFallbackAllowed: false,
  });

  assert.equal(plan.requiresBrowserLease, false);
  assert.equal(plan.blocker?.code, 'private_inventory_unavailable');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run build:ts && node --test tests/export-adapter-policy.test.mjs
```

Expected: fail because `export-adapter-policy.ts` does not exist.

- [ ] **Step 3: Implement adapter policy**

Create `src/core/export-adapter-policy.ts`:

```ts
export type ExportAdapterKind =
  | 'private_api'
  | 'extension_private_api'
  | 'python_sidecar'
  | 'private_inventory'
  | 'browser_inventory'
  | 'dom_legacy';

export type ExportAdapterPolicyInput = Readonly<{
  operationKind: string;
  knownChatIds?: readonly string[];
  privateApiAvailable?: boolean;
  privateInventoryAvailable?: boolean;
  extensionPrivateApiAvailable?: boolean;
  pythonSidecarAvailable?: boolean;
  browserFallbackAllowed?: boolean;
}>;

export type ExportAdapterPlan = Readonly<{
  adapters: readonly Readonly<{ kind: ExportAdapterKind; browserLeaseRequired: boolean }>[];
  requiresBrowserLease: boolean;
  blocker?: Readonly<{ code: string; message: string }> | null;
}>;

const adapter = (kind: ExportAdapterKind, browserLeaseRequired = false) => ({
  kind,
  browserLeaseRequired,
});

export const planExportAdapters = (input: ExportAdapterPolicyInput): ExportAdapterPlan => {
  const knownChatIds = input.knownChatIds || [];
  const adapters: ReturnType<typeof adapter>[] = [];

  if (knownChatIds.length > 0 && input.privateApiAvailable === true) {
    adapters.push(adapter('private_api'));
    return { adapters, requiresBrowserLease: false, blocker: null };
  }

  if (knownChatIds.length > 0 && input.extensionPrivateApiAvailable === true) {
    adapters.push(adapter('extension_private_api'));
  }

  if (knownChatIds.length > 0 && input.pythonSidecarAvailable === true) {
    adapters.push(adapter('python_sidecar'));
  }

  if (adapters.length > 0) {
    return { adapters, requiresBrowserLease: false, blocker: null };
  }

  if (input.privateInventoryAvailable === true) {
    adapters.push(adapter('private_inventory'));
    return { adapters, requiresBrowserLease: false, blocker: null };
  }

  if (input.browserFallbackAllowed !== true) {
    return {
      adapters: [],
      requiresBrowserLease: false,
      blocker: {
        code: 'private_inventory_unavailable',
        message: 'Inventario privado indisponivel e fallback de navegador desativado.',
      },
    };
  }

  adapters.push(adapter('browser_inventory', true), adapter('dom_legacy', true));
  return { adapters, requiresBrowserLease: true, blocker: null };
};
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run build:ts && node --test tests/export-adapter-policy.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/export-adapter-policy.ts tests/export-adapter-policy.test.mjs
git commit -m "feat: add private-first export adapter policy"
```

## Task 5: MCP Runtime Adapter

**Files:**

- Create: `src/mcp/browser-authority/mcp-runtime.ts`
- Modify: `src/mcp/browser-authority/index.ts`
- Modify: `src/mcp-server.js`
- Test: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Add source-level test for MCP authority import and usage**

Append to `tests/mcp-command-channel.test.mjs`:

```js
test('MCP routes browser side effects through browser authority runtime', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /browser-authority/);
  assert.match(source, /createBrowserAuthorityLeaseForMcp/);
  assert.match(source, /assertBrowserAuthorityCommandAllowed/);
  assert.doesNotMatch(source, /launchChromeForGemini\(\{\s*browser:/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
node --test tests/mcp-command-channel.test.mjs
```

Expected: fail because MCP is not using the authority runtime.

- [ ] **Step 3: Add MCP runtime helpers**

Create `src/mcp/browser-authority/mcp-runtime.ts`:

```ts
import {
  browserAuthorityLeaseToken,
  initialBrowserAuthorityState,
  transitionBrowserAuthority,
  type BrowserAuthorityBudget,
  type BrowserAuthorityOperationKind,
  type BrowserAuthorityPolicy,
  type BrowserAuthorityState,
  type BrowserLease,
} from './index.js';

const DEFAULT_BROWSER_AUTHORITY_BUDGET_MS = 120_000;

export const defaultBrowserAuthorityBudget = (
  nowMs = Date.now(),
  overrides: Partial<BrowserAuthorityBudget> = {},
): BrowserAuthorityBudget => ({
  maxNewTabs: overrides.maxNewTabs ?? 0,
  maxReloads: overrides.maxReloads ?? 0,
  maxActivations: overrides.maxActivations ?? 0,
  maxNavigations: overrides.maxNavigations ?? 0,
  deadlineAtMs: overrides.deadlineAtMs ?? nowMs + DEFAULT_BROWSER_AUTHORITY_BUDGET_MS,
});

export const createBrowserAuthorityLeaseForMcp = ({
  state = initialBrowserAuthorityState(),
  nowMs = Date.now(),
  leaseId,
  operationId,
  operationKind,
  policy,
  budget,
}: Readonly<{
  state?: BrowserAuthorityState;
  nowMs?: number;
  leaseId: string;
  operationId: string;
  operationKind: BrowserAuthorityOperationKind;
  policy: BrowserAuthorityPolicy;
  budget: BrowserAuthorityBudget;
}>): Readonly<{ state: BrowserAuthorityState; lease: BrowserLease; token: ReturnType<typeof browserAuthorityLeaseToken> }> => {
  const result = transitionBrowserAuthority(state, {
    type: 'leaseRequested',
    nowMs,
    leaseId,
    operationId,
    operationKind,
    owner: 'mcp',
    policy,
    budget,
  });
  const lease = result.state.leases.find((item) => item.leaseId === leaseId);
  if (!lease) {
    throw Object.assign(new Error(result.blocker?.message || 'Controle do navegador bloqueado.'), {
      code: result.blocker?.code || 'browser_authority_lease_blocked',
      data: { blocker: result.blocker || null },
    });
  }
  return { state: result.state, lease, token: browserAuthorityLeaseToken(lease) };
};

export const assertBrowserAuthorityCommandAllowed = ({
  commandType,
  args,
}: Readonly<{ commandType: string; args: Record<string, unknown> }>): void => {
  const mutating = new Set([
    'activate-browser-tab',
    'activate-tab',
    'claim-tab',
    'get-chat-by-id',
    'open-chat',
    'reload-extension-self',
    'reload-gemini-tabs',
    'reload-page',
  ]);
  if (!mutating.has(commandType)) return;
  if (typeof args.browserAuthorityLeaseId === 'string' && args.browserAuthorityLeaseId.trim()) {
    return;
  }
  throw Object.assign(
    new Error('Comando de navegador bloqueado: faltou autorizacao da operacao.'),
    { code: 'browser_authority_lease_missing' },
  );
};
```

Update `src/mcp/browser-authority/index.ts`:

```ts
export {
  assertBrowserAuthorityCommandAllowed,
  createBrowserAuthorityLeaseForMcp,
  defaultBrowserAuthorityBudget,
} from './mcp-runtime.js';
```

- [ ] **Step 4: Wire MCP command dispatch**

In `src/mcp-server.js`, import the compiled module next to the existing `browser-side-effects` import:

```js
const {
  assertBrowserAuthorityCommandAllowed,
  createBrowserAuthorityLeaseForMcp,
  defaultBrowserAuthorityBudget,
} = await import(compiledTsModuleUrl('mcp', 'browser-authority', 'index.js'));
```

Before dispatching any content-script command, call:

```js
assertBrowserAuthorityCommandAllowed({
  commandType,
  args: commandArgs,
});
```

When an existing explicit browser command is accepted, create a compatibility lease:

```js
const authority = createBrowserAuthorityLeaseForMcp({
  leaseId: `mcp-${PROCESS_SESSION_ID}-${Date.now()}`,
  operationId: args.jobId || args.claimId || PROCESS_SESSION_ID,
  operationKind: 'tab_management',
  policy: 'interactive_explicit',
  budget: defaultBrowserAuthorityBudget(Date.now(), {
    maxNewTabs: commandType === 'browser.launch' ? 1 : 0,
    maxReloads: commandType.includes('reload') ? 1 : 0,
    maxActivations: commandType.includes('activate') ? 1 : 0,
    maxNavigations: commandType === 'open-chat' || commandType === 'get-chat-by-id' ? 1 : 0,
  }),
});
commandArgs.browserAuthorityLeaseId = authority.lease.leaseId;
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run build:ts && node --check src/mcp-server.js && node --test tests/mcp-command-channel.test.mjs tests/browser-authority-fsm.test.mjs tests/browser-authority-lease-gate.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/browser-authority/mcp-runtime.ts src/mcp/browser-authority/index.ts src/mcp-server.js tests/mcp-command-channel.test.mjs
git commit -m "feat: route MCP browser commands through authority"
```

## Task 6: Content Script Lease Marker Enforcement

**Files:**

- Modify: `src/browser/shared/tab-commands.ts`
- Modify: `src/userscript-shell.ts`
- Test: `tests/browser-side-effects.test.mjs`

- [ ] **Step 1: Add content-script source test**

Append to `tests/browser-side-effects.test.mjs`:

```js
test('content script rejects mutating browser commands without browser authority lease marker', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'userscript-shell.ts'), 'utf-8');

  assert.match(source, /browserAuthorityLeaseId/);
  assert.match(source, /browser_authority_lease_missing/);
  assert.match(source, /explicitBrowserCommandIntentRequired/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
node --test tests/browser-side-effects.test.mjs
```

Expected: fail until the content script checks `browserAuthorityLeaseId`.

- [ ] **Step 3: Add marker type**

In `src/browser/shared/tab-commands.ts`, add to command argument types:

```ts
export type BrowserAuthorityCommandArgs = Readonly<{
  browserAuthorityLeaseId?: string;
  explicitBrowserSideEffect?: true;
}>;
```

- [ ] **Step 4: Enforce marker in content script**

In `src/userscript-shell.ts`, update the mutating command guard:

```ts
const hasBrowserAuthorityLease = (args: unknown): boolean => {
  if (!args || typeof args !== 'object') return false;
  const value = (args as { browserAuthorityLeaseId?: unknown }).browserAuthorityLeaseId;
  return typeof value === 'string' && value.trim().length > 0;
};

const rejectMissingBrowserAuthorityLease = (commandType: string) => ({
  ok: false,
  status: 'browser_authority_lease_missing',
  code: 'browser_authority_lease_missing',
  skipped: true,
  commandType,
  error: 'Comando de navegador bloqueado: faltou autorizacao da operacao.',
});
```

For each mutating command in `explicitBrowserCommandIntentRequired`, require both legacy explicit intent and the new marker during migration:

```ts
if (explicitBrowserCommandIntentRequired(command.type)) {
  if (!hasBrowserAuthorityLease(command.args)) {
    return rejectMissingBrowserAuthorityLease(command.type);
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run build:ts && node --test tests/browser-side-effects.test.mjs tests/mcp-command-channel.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/browser/shared/tab-commands.ts src/userscript-shell.ts tests/browser-side-effects.test.mjs
git commit -m "feat: enforce browser authority marker in content script"
```

## Task 7: Wire Private-First Policy Into Export And Repair

**Files:**

- Modify: `src/mcp/export-workflows.ts`
- Modify: `src/core/fix-vault-flow.ts`
- Modify: `tests/mcp-export-workflows.test.mjs`
- Modify: `tests/fix-vault-flow.test.mjs`

- [ ] **Step 1: Add workflow tests**

In `tests/mcp-export-workflows.test.mjs`, add:

```js
test('selected export policy uses private API before browser fallback', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'mcp', 'export-workflows.ts'), 'utf-8');

  assert.match(source, /planExportAdapters/);
  assert.match(source, /private_api/);
  assert.match(source, /browserAuthorityLeaseId/);
});
```

In `tests/fix-vault-flow.test.mjs`, add:

```js
test('fix-vault policy plans private repair before browser fallback', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'core', 'fix-vault-flow.ts'), 'utf-8');

  assert.match(source, /planExportAdapters/);
  assert.match(source, /fix_vault/);
  assert.doesNotMatch(source, /openIfMissing:\s*true\s*,\s*allowReload:\s*true/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test tests/mcp-export-workflows.test.mjs tests/fix-vault-flow.test.mjs
```

Expected: fail until workflows import the policy.

- [ ] **Step 3: Import and use policy in export workflows**

In `src/mcp/export-workflows.ts`, import:

```ts
import { planExportAdapters } from '../core/export-adapter-policy.js';
```

At selected export planning, compute:

```ts
const adapterPlan = planExportAdapters({
  operationKind: 'selected_export',
  knownChatIds: chatIds,
  privateApiAvailable: args.privateApi !== false,
  extensionPrivateApiAvailable: true,
  pythonSidecarAvailable: true,
  browserFallbackAllowed: args.browserFallbackAllowed === true,
});
```

Pass `adapterPlan.requiresBrowserLease` into the MCP runtime before any browser fallback command. If the first adapter succeeds, skip browser readiness entirely.

- [ ] **Step 4: Import and use policy in fix-vault**

In `src/core/fix-vault-flow.ts`, import:

```ts
import { planExportAdapters } from './export-adapter-policy.js';
```

Before building repair commands, compute:

```ts
const repairPlan = planExportAdapters({
  operationKind: 'fix_vault',
  knownChatIds: candidateChatIds,
  privateApiAvailable: true,
  extensionPrivateApiAvailable: true,
  pythonSidecarAvailable: true,
  browserFallbackAllowed: flags.openIfMissing === true,
});
```

If `repairPlan.requiresBrowserLease` is false, do not emit `--open-if-missing` or reload-oriented browser flags.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run build:ts && node --test tests/export-adapter-policy.test.mjs tests/mcp-export-workflows.test.mjs tests/fix-vault-flow.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/export-workflows.ts src/core/fix-vault-flow.ts tests/mcp-export-workflows.test.mjs tests/fix-vault-flow.test.mjs
git commit -m "feat: make export and repair private-first"
```

## Task 8: Extension UI Shared Viewmodel

**Files:**

- Modify: `src/userscript-shell.ts`
- Modify: `src/extension-background.ts`
- Modify: `tests/gemini-private-api-extension-wiring.test.mjs`
- Modify: `tests/private-api-selected-export.test.mjs`

- [ ] **Step 1: Add tests for shared job launcher**

In `tests/gemini-private-api-extension-wiring.test.mjs`, add:

```js
test('extension selected export launches shared private job instead of local DOM export brain', () => {
  const userscript = readFileSync(resolve(import.meta.dirname, '..', 'src', 'userscript-shell.ts'), 'utf-8');
  const background = readFileSync(resolve(import.meta.dirname, '..', 'src', 'extension-background.ts'), 'utf-8');

  assert.match(userscript, /reexport-chats/);
  assert.match(userscript, /privateApiSelectedExport/);
  assert.match(background, /PRIVATE_API_SELECTED_EXPORT/);
  assert.doesNotMatch(userscript, /runLocalDomSelectedExportBrain/);
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
node --test tests/gemini-private-api-extension-wiring.test.mjs
```

Expected: fail until UI launcher is wired.

- [ ] **Step 3: Add extension message contract**

In `src/extension-background.ts`, add a message handler:

```ts
if (message?.type === 'PRIVATE_API_SELECTED_EXPORT') {
  return handlePrivateApiSelectedExportMessage(message);
}
```

The handler should call the existing shared selected-export runtime and return the same viewmodel shape used by CLI/MCP:

```ts
const handlePrivateApiSelectedExportMessage = async (message: PrivateApiSelectedExportMessage) => {
  const result = await runPrivateApiSelectedExport({
    chatIds: message.chatIds,
    outputDir: message.outputDir,
    source: 'extension-ui',
    progress: message.progress === true,
  });
  return { ok: result.ok, viewModel: result.viewModel, report: result.report };
};
```

- [ ] **Step 4: Update userscript modal launcher**

In `src/userscript-shell.ts`, route selected export submit through:

```ts
const privateApiSelectedExport = async (chatIds: string[], outputDir: string | null) =>
  chrome.runtime.sendMessage({
    type: 'PRIVATE_API_SELECTED_EXPORT',
    chatIds,
    outputDir,
    progress: true,
  });
```

Map returned `viewModel.progress` into the existing progress dock instead of starting a separate DOM export path.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run build:ts && node --test tests/gemini-private-api-extension-wiring.test.mjs tests/private-api-selected-export.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/userscript-shell.ts src/extension-background.ts tests/gemini-private-api-extension-wiring.test.mjs tests/private-api-selected-export.test.mjs
git commit -m "feat: route extension exports through shared private job"
```

## Task 9: Static Bypass Tests

**Files:**

- Create: `tests/browser-authority-bypass.test.mjs`

- [ ] **Step 1: Add bypass scan tests**

Create `tests/browser-authority-bypass.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf-8');

test('browser launch is not called directly from workflows', () => {
  for (const file of ['src/mcp/export-workflows.ts', 'src/core/fix-vault-flow.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /launchChromeForGemini\s*\(/, file);
    assert.doesNotMatch(source, /openIfMissing:\s*true\s*,\s*wakeBrowser:\s*true/, file);
  }
});

test('MCP mutating browser commands require browser authority lease marker', () => {
  const source = read('src/mcp-server.js');

  assert.match(source, /assertBrowserAuthorityCommandAllowed/);
  assert.match(source, /browserAuthorityLeaseId/);
  assert.doesNotMatch(source, /explicitBrowserSideEffect:\s*true\s*\}\s*\)/);
});

test('content script mutating commands reject missing browser authority lease', () => {
  const source = read('src/userscript-shell.ts');

  assert.match(source, /browser_authority_lease_missing/);
  assert.match(source, /hasBrowserAuthorityLease/);
});
```

- [ ] **Step 2: Run bypass tests**

Run:

```bash
node --test tests/browser-authority-bypass.test.mjs
```

Expected: pass only after Tasks 5-8.

- [ ] **Step 3: Commit**

```bash
git add tests/browser-authority-bypass.test.mjs
git commit -m "test: block browser authority bypasses"
```

## Task 10: Verification Suite

**Files:**

- Modify: `package.json`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add no-compromise test script**

In `package.json`, add:

```json
"test:browser-authority": "npm run build:ts && node --test tests/browser-authority-fsm.test.mjs tests/browser-authority-lease-gate.test.mjs tests/browser-authority-bypass.test.mjs tests/export-adapter-policy.test.mjs"
```

- [ ] **Step 2: Add CLI no-wake regression test**

In `tests/gemini-cli-tui.test.mjs`, add a source or mocked-command test asserting selected export does not call ready with browser wake when private adapter succeeds:

```js
test('CLI selected export does not wake browser when private adapter succeeds', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'cli', 'private-api-selected-export.ts'), 'utf-8');

  assert.match(source, /planExportAdapters/);
  assert.doesNotMatch(source, /wakeBrowser:\s*true/);
});
```

- [ ] **Step 3: Run focused verification**

Run:

```bash
npm run test:browser-authority
```

Expected: pass.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run check
uv run ruff check python
uv run pyrefly check python
git diff --check
```

Expected: all pass. Existing skipped tests remain skipped.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/gemini-cli-tui.test.mjs
git commit -m "test: add browser authority release gate"
```

## Release Smoke Checklist

Run only after the unit suite passes and do not use GUI clicking.

- [ ] Private selected export of a real known chat with at least one asset.
- [ ] Extension modal selected export through shared job/viewmodel.
- [ ] `fix-vault` on a temporary vault with one missing asset.
- [ ] Recent export small batch where private inventory is enough and no new browser tab opens.
- [ ] Google verification fixture or simulated diagnosis proves profile blocker suppresses launches.
- [ ] Stale build fixture proves old heartbeat cannot satisfy runtime epoch readiness.
- [ ] Side-effect report shows every browser mutation has a lease ID, owner, budget, and release result.

Commands:

```bash
npm run test:browser-authority
npm test
npm run check
uv run ruff check python
uv run pyrefly check python
git diff --check
```

The release is not ready until the extension UI and CLI/MCP return the same job viewmodel for selected export and repair workflows.
