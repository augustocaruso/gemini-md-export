# Playwright-Style Tab Session Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a Playwright-style tab/session broker so Gemini browser operations cannot compile against raw, inactive, stale, old-build, busy, or command-unready clients.

**Architecture:** Add a pure TypeScript lifecycle evaluator under `src/mcp/client-lifecycle.ts` and make `src/mcp/tab-selection.ts` a compatibility layer over it. The MCP server continues storing raw bridge clients, but selection, claim, diagnostics, and export job creation consume lifecycle-derived capabilities and structured rejection codes.

**Tech Stack:** TypeScript `NodeNext`, branded types, Node test runner, existing `build/ts` runtime imports from `src/mcp-server.js`, existing `npm run build:ts`, `npm run typecheck`, and focused MCP/browser tests.

---

## File Structure

- Create: `src/mcp/client-lifecycle.ts`
  - Owns raw client lifecycle classification, branded `ClaimableGeminiTab` and `ClaimedReadyGeminiTab`, rejection codes, Portuguese messages, and capability constructors.
- Modify: `src/mcp/tab-selection.ts`
  - Keeps existing exports used by `src/mcp-server.js`, but delegates active-claimable checks to `client-lifecycle.ts`.
- Modify: `src/mcp-server.js`
  - Imports lifecycle helpers from `build/ts/mcp/client-lifecycle.js`, exposes lifecycle diagnostics in tab/status output, and revalidates claim/job clients with lifecycle helpers.
- Modify: `tests/mcp-tab-selection.test.mjs`
  - Keeps compatibility coverage and adds lifecycle state expectations.
- Create: `tests/mcp-client-lifecycle.test.mjs`
  - Pure table tests for every lifecycle state and every important rejection code.
- Modify: `tests/mcp-tab-selection-types.ts`
  - Switches compile-time examples to branded lifecycle types and proves raw snapshots cannot enter claim/export APIs.
- Modify: `tests/mcp-command-channel.test.mjs`
  - Updates static guard expectations to include lifecycle use in `claimGeminiTabForClient` and diagnostics.

## Task 1: Add Pure Client Lifecycle Module

**Files:**
- Create: `src/mcp/client-lifecycle.ts`
- Create: `tests/mcp-client-lifecycle.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/mcp-client-lifecycle.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertClaimableGeminiTab,
  classifyGeminiClientLifecycle,
  getGeminiClientLifecycle,
  getClaimableGeminiTabs,
  toClaimableGeminiTab,
  toClaimedReadyGeminiTab,
} from '../build/ts/mcp/client-lifecycle.js';

const baseClient = {
  clientId: 'chat-active',
  kind: 'chat',
  tabId: 123,
  isActiveTab: true,
  lastHeartbeatAt: 1_000,
  lastSeenAt: 1_100,
  extensionVersion: '0.8.53',
  protocolVersion: 2,
  buildStamp: '20260520-0238',
  commandReady: true,
  recentCommandFailure: false,
  page: {
    url: 'https://gemini.google.com/app/88a98a108cdcfb61',
    pathname: '/app/88a98a108cdcfb61',
    chatId: '88a98a108cdcfb61',
    buildStamp: '20260520-0238',
  },
};

const options = {
  now: 1_500,
  staleAfterMs: 45_000,
  hydrationGraceMs: 4_000,
  expectedExtensionVersion: '0.8.53',
  expectedProtocolVersion: 2,
  expectedBuildStamp: '20260520-0238',
  requireCommandReady: true,
  sessionId: 'session-a',
  claims: [],
};

test('classifies an active ready Gemini tab as claimable', () => {
  const state = getGeminiClientLifecycle(baseClient, options);

  assert.equal(state.state, 'claimable');
  assert.equal(state.ok, true);
  assert.equal(state.client.clientId, 'chat-active');
});

test('splits missing page from dead clients', () => {
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, page: null }, options).state,
    'transport_connected',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, lastHeartbeatAt: 1_000 }, {
      ...options,
      now: 60_000,
    }).state,
    'dead',
  );
});

test('classifies fresh missing page as warming up when connected recently', () => {
  assert.equal(
    getGeminiClientLifecycle(
      {
        ...baseClient,
        page: null,
        lastSeenAt: 1_300,
      },
      options,
    ).state,
    'warming_up',
  );
});

test('rejects version, protocol and build mismatches with specific codes', () => {
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, extensionVersion: '0.0.1' }, options).code,
    'extension_version_mismatch',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, protocolVersion: 1 }, options).code,
    'extension_protocol_mismatch',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, buildStamp: 'old' }, options).code,
    'extension_build_mismatch',
  );
});

test('rejects inactive, non-Gemini, unhydrated, command-unready and busy clients', () => {
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, isActiveTab: false }, options).code,
    'inactive_tab',
  );
  assert.equal(
    getGeminiClientLifecycle({
      ...baseClient,
      page: { url: 'https://example.com/' },
    }, options).code,
    'page_not_gemini',
  );
  assert.equal(
    getGeminiClientLifecycle({
      ...baseClient,
      page: { url: 'https://gemini.google.com/app' },
    }, options).code,
    'page_not_hydrated',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, commandReady: false }, options).code,
    'command_channel_unready',
  );
  assert.equal(
    getGeminiClientLifecycle({ ...baseClient, tabOperationInProgress: true }, options).code,
    'tab_operation_in_progress',
  );
});

test('creates branded claimable and claimed-ready capabilities only after validation', () => {
  const claimable = toClaimableGeminiTab(baseClient, options);
  assert.equal(claimable.clientId, 'chat-active');

  const claimed = toClaimedReadyGeminiTab(baseClient, {
    ...options,
    claims: [
      {
        claimId: 'claim-a',
        clientId: 'chat-active',
        sessionId: 'session-a',
        tabId: 123,
        expiresAtMs: 10_000,
      },
    ],
  });
  assert.equal(claimed.claim.claimId, 'claim-a');
});

test('claimed-ready rejects missing and conflicting claims', () => {
  assert.equal(
    getGeminiClientLifecycle(baseClient, {
      ...options,
      requireClaimed: true,
      claims: [],
    }).code,
    'claim_missing',
  );
  assert.equal(
    getGeminiClientLifecycle(baseClient, {
      ...options,
      requireClaimed: true,
      claims: [
        {
          claimId: 'claim-b',
          clientId: 'chat-active',
          sessionId: 'other-session',
          tabId: 123,
          expiresAtMs: 10_000,
        },
      ],
    }).code,
    'claim_conflict',
  );
});

test('list helper returns only claimable Gemini tabs', () => {
  const result = getClaimableGeminiTabs(
    [
      baseClient,
      { ...baseClient, clientId: 'inactive', isActiveTab: false },
      { ...baseClient, clientId: 'activity', kind: 'activity', page: { url: 'https://myactivity.google.com/product/gemini' } },
    ],
    options,
  );

  assert.deepEqual(result.map((client) => client.clientId), ['chat-active']);
});

test('assert helper throws structured lifecycle data', () => {
  assert.throws(
    () => assertClaimableGeminiTab({ ...baseClient, isActiveTab: false }, options),
    (error) => error.code === 'inactive_tab' && error.data?.lifecycle?.state === 'page_unready',
  );
});

test('classify helper exposes compact diagnostics for raw clients', () => {
  const classified = classifyGeminiClientLifecycle(
    [
      baseClient,
      { ...baseClient, clientId: 'old-build', buildStamp: 'old' },
    ],
    options,
  );

  assert.deepEqual(
    classified.map((item) => [item.client.clientId, item.lifecycle.state, item.lifecycle.code]),
    [
      ['chat-active', 'claimable', null],
      ['old-build', 'extension_mismatch', 'extension_build_mismatch'],
    ],
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run build:ts && node --test tests/mcp-client-lifecycle.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `build/ts/mcp/client-lifecycle.js`.

- [ ] **Step 3: Implement `src/mcp/client-lifecycle.ts`**

Add the module with these exported names:

```ts
const CLAIMABLE_GEMINI_TAB: unique symbol = Symbol('ClaimableGeminiTab');
const CLAIMED_READY_GEMINI_TAB: unique symbol = Symbol('ClaimedReadyGeminiTab');

export type GeminiClientLifecycleState =
  | 'disconnected'
  | 'transport_connected'
  | 'extension_mismatch'
  | 'warming_up'
  | 'page_unready'
  | 'command_unready'
  | 'busy'
  | 'claimable'
  | 'claimed_ready'
  | 'dead';

export type GeminiClientLifecycleCode =
  | 'no_connected_client'
  | 'warming_up'
  | 'extension_version_mismatch'
  | 'extension_protocol_mismatch'
  | 'extension_build_mismatch'
  | 'activity_client_not_claimable'
  | 'missing_tab_id'
  | 'inactive_tab'
  | 'page_not_gemini'
  | 'page_not_hydrated'
  | 'command_channel_unready'
  | 'tab_operation_in_progress'
  | 'claim_missing'
  | 'claim_conflict'
  | 'client_dead';

export type GeminiPageSnapshot = Readonly<{
  url?: string | null;
  pathname?: string | null;
  chatId?: string | null;
  kind?: string | null;
  buildStamp?: string | null;
}>;

export type GeminiClientSnapshot = Readonly<{
  clientId: string;
  kind?: string | null;
  tabId?: number | string | null;
  windowId?: number | string | null;
  isActiveTab?: boolean | null;
  lastHeartbeatAt?: number | null;
  lastSeenAt?: number | null;
  extensionVersion?: string | null;
  protocolVersion?: number | string | null;
  buildStamp?: string | null;
  commandReady?: boolean | null;
  recentCommandFailure?: boolean | null;
  tabOperationInProgress?: boolean | null;
  page?: GeminiPageSnapshot | null;
}>;

export type GeminiTabClaimSnapshot = Readonly<{
  claimId: string;
  clientId?: string | null;
  tabId?: number | string | null;
  sessionId?: string | null;
  expiresAtMs?: number | null;
}>;

export type GeminiClientLifecycleOptions = Readonly<{
  now?: number;
  staleAfterMs: number;
  hydrationGraceMs?: number;
  expectedExtensionVersion?: string | null;
  expectedProtocolVersion?: number | string | null;
  expectedBuildStamp?: string | null;
  requireCommandReady?: boolean;
  requireClaimed?: boolean;
  sessionId?: string | null;
  claimId?: string | null;
  claims?: readonly GeminiTabClaimSnapshot[];
}>;

export type ClaimableGeminiTab = GeminiClientSnapshot &
  Readonly<{
    readonly [CLAIMABLE_GEMINI_TAB]: true;
    readonly tabId: number;
    readonly isActiveTab: true;
    readonly lastHeartbeatAt: number;
    readonly page: GeminiPageSnapshot & Readonly<{ url: string }>;
  }>;

export type ClaimedReadyGeminiTab = ClaimableGeminiTab &
  Readonly<{
    readonly [CLAIMED_READY_GEMINI_TAB]: true;
    readonly claim: GeminiTabClaimSnapshot;
  }>;
```

Implement helpers that normalize `tabId`, parse page origin with `URL`, compare extension version/protocol/build, find a non-expired matching claim, and return lifecycle objects with:

```ts
{
  ok: boolean;
  state: GeminiClientLifecycleState;
  code: GeminiClientLifecycleCode | null;
  message: string;
  nextAction: string;
  retryable: boolean;
  manualReloadRecommended: boolean;
  client?: GeminiClientSnapshot;
}
```

Use these messages:

```ts
const LIFECYCLE_MESSAGES = {
  no_connected_client: 'Nenhuma aba do Gemini conectada a extensao.',
  warming_up: 'A aba Gemini ainda esta inicializando.',
  extension_version_mismatch: 'A extensao conectada nao esta na versao esperada.',
  extension_protocol_mismatch: 'A extensao conectada nao fala o protocolo esperado.',
  extension_build_mismatch: 'A extensao conectada nao esta no build esperado.',
  activity_client_not_claimable: 'Cliente My Activity nao pode ser usado para exportar chats do Gemini.',
  missing_tab_id: 'A aba conectada nao informou o ID real da aba do navegador.',
  inactive_tab: 'Aba Gemini inativa nao pode ser reivindicada para exportacao.',
  page_not_gemini: 'A aba ativa nao aponta para o Gemini Web.',
  page_not_hydrated: 'A pagina do Gemini ainda nao hidratou uma conversa exportavel.',
  command_channel_unready: 'A aba ativa ainda nao abriu o canal de comandos.',
  tab_operation_in_progress: 'A aba ja esta executando uma operacao pesada.',
  claim_missing: 'Esta sessao ainda nao reivindicou uma aba Gemini valida.',
  claim_conflict: 'A aba Gemini esta reivindicada por outra sessao.',
  client_dead: 'O cliente da aba parou de enviar sinais recentes.',
} as const;
```

- [ ] **Step 4: Run lifecycle tests**

Run:

```bash
npm run build:ts && node --test tests/mcp-client-lifecycle.test.mjs
```

Expected: all tests in `tests/mcp-client-lifecycle.test.mjs` pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/client-lifecycle.ts tests/mcp-client-lifecycle.test.mjs
git commit -m "feat: add Gemini client lifecycle broker"
```

## Task 2: Make Tab Selection Delegate To Lifecycle

**Files:**
- Modify: `src/mcp/tab-selection.ts`
- Modify: `tests/mcp-tab-selection.test.mjs`
- Modify: `tests/mcp-tab-selection-types.ts`

- [ ] **Step 1: Update tests to expect lifecycle rejection codes**

In `tests/mcp-tab-selection.test.mjs`, import `getGeminiClientLifecycle` from `../build/ts/mcp/client-lifecycle.js` and add:

```js
test('compat active-claimable guard uses lifecycle diagnostics', () => {
  const lifecycle = getGeminiClientLifecycle(
    {
      ...baseClient,
      isActiveTab: false,
    },
    options,
  );

  assert.equal(lifecycle.state, 'page_unready');
  assert.equal(lifecycle.code, 'inactive_tab');
});
```

In `tests/mcp-tab-selection-types.ts`, replace `ActiveClaimableGeminiClient` with `ClaimableGeminiTab` and prove raw snapshots still fail:

```ts
import {
  assertClaimableGeminiTab,
  type ClaimableGeminiTab,
  type GeminiClientSnapshot,
} from '../src/mcp/client-lifecycle.js';

declare const rawClient: GeminiClientSnapshot;
declare const claimGeminiTab: (client: ClaimableGeminiTab) => void;

claimGeminiTab(
  assertClaimableGeminiTab(rawClient, {
    now: 1_000,
    staleAfterMs: 45_000,
  }),
);

// @ts-expect-error Raw bridge snapshots must pass through the lifecycle broker.
claimGeminiTab(rawClient);
```

- [ ] **Step 2: Run tests to verify the compatibility layer still points at old behavior**

Run:

```bash
npm run build:ts && node --test tests/mcp-tab-selection.test.mjs
npm run typecheck
```

Expected: typecheck fails until `src/mcp/tab-selection.ts` exports compatible lifecycle-backed types.

- [ ] **Step 3: Refactor `src/mcp/tab-selection.ts`**

Make this file import from `./client-lifecycle.js`:

```ts
import {
  assertClaimableGeminiTab,
  explainGeminiClientLifecycleRejection,
  getClaimableGeminiTabs,
  toClaimableGeminiTab,
  type ClaimableGeminiTab,
  type GeminiClientLifecycleOptions,
  type GeminiClientSnapshot,
  type GeminiPageSnapshot,
} from './client-lifecycle.js';
```

Keep these compatibility aliases and functions:

```ts
export type ActiveClaimableGeminiClient = ClaimableGeminiTab;
export type ActiveClaimableGeminiClientOptions = GeminiClientLifecycleOptions;
export type { GeminiClientSnapshot, GeminiPageSnapshot };

export const explainActiveClaimableGeminiClientRejection =
  explainGeminiClientLifecycleRejection;

export const toActiveClaimableGeminiClient = toClaimableGeminiTab;
export const assertActiveClaimableGeminiClient = assertClaimableGeminiTab;
export const getActiveClaimableGeminiClients = getClaimableGeminiTabs;
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/mcp-client-lifecycle.test.mjs tests/mcp-tab-selection.test.mjs
npm run typecheck
```

Expected: lifecycle tests, tab selection tests, and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tab-selection.ts tests/mcp-tab-selection.test.mjs tests/mcp-tab-selection-types.ts
git commit -m "refactor: route tab selection through lifecycle broker"
```

## Task 3: Surface Lifecycle Diagnostics In MCP

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Add static tests for lifecycle imports and diagnostics**

In `tests/mcp-command-channel.test.mjs`, add assertions over `src/mcp-server.js`:

```js
test('mcp server exposes lifecycle diagnostics for tab readiness', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');

  assert.match(source, /classifyGeminiClientLifecycle/);
  assert.match(source, /getGeminiClientLifecycle/);
  assert.match(source, /lifecycle:\s*lifecycleSummaryForClient/);
});
```

- [ ] **Step 2: Run the static test**

Run:

```bash
node --test tests/mcp-command-channel.test.mjs
```

Expected: FAIL because `src/mcp-server.js` does not import or expose lifecycle diagnostics yet.

- [ ] **Step 3: Import lifecycle helpers in `src/mcp-server.js`**

After the existing `tab-selection.js` import, add:

```js
const {
  classifyGeminiClientLifecycle,
  getGeminiClientLifecycle,
} = await import(compiledTsModuleUrl('mcp', 'client-lifecycle.js'));
```

Add:

```js
const clientLifecycleOptions = (overrides = {}) => ({
  ...activeClaimableGeminiClientOptions(),
  hydrationGraceMs: 4000,
  sessionId: PROCESS_SESSION_ID,
  claims: summarizeRawTabClaims(),
  ...overrides,
});

const summarizeRawTabClaims = () =>
  [...tabClaims.values()].map((claim) => ({
    claimId: claim.claimId,
    clientId: claim.clientId,
    tabId: claim.tabId,
    sessionId: claim.sessionId,
    expiresAtMs: claim.expiresAtMs,
  }));

const lifecycleSummaryForClient = (client, overrides = {}) => {
  const lifecycle = getGeminiClientLifecycle(client, clientLifecycleOptions(overrides));
  return {
    state: lifecycle.state,
    code: lifecycle.code,
    message: lifecycle.message,
    nextAction: lifecycle.nextAction,
    retryable: lifecycle.retryable,
    manualReloadRecommended: lifecycle.manualReloadRecommended,
  };
};
```

Place `summarizeRawTabClaims` after tab-claim helpers are declared, so it can read `tabClaims`.

- [ ] **Step 4: Add lifecycle summaries to tab outputs**

In tab listing and diagnostics objects, add:

```js
lifecycle: lifecycleSummaryForClient(client),
```

For demoted clients, replace ad hoc demotion reason with:

```js
const lifecycle = getGeminiClientLifecycle(client, clientLifecycleOptions());
return {
  ...summarizeClient(client),
  lifecycle: lifecycleSummaryForClient(client),
  demotedFromTabSelection: true,
  demotionReason: lifecycle.code || lifecycle.state || 'not-selected',
};
```

- [ ] **Step 5: Run focused static tests**

Run:

```bash
npm run build:ts && node --test tests/mcp-command-channel.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.js tests/mcp-command-channel.test.mjs
git commit -m "feat: expose tab lifecycle diagnostics"
```

## Task 4: Require Claimed-Ready Capability For Export Job Creation

**Files:**
- Modify: `src/mcp/client-lifecycle.ts`
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-tab-selection-types.ts`
- Modify: `tests/recent-chats-load-more.test.mjs`

- [ ] **Step 1: Add type contract for claimed-ready export**

Append to `tests/mcp-tab-selection-types.ts`:

```ts
import {
  assertClaimedReadyGeminiTab,
  type ClaimedReadyGeminiTab,
} from '../src/mcp/client-lifecycle.js';

declare const exportFromClaimedTab: (client: ClaimedReadyGeminiTab) => void;

exportFromClaimedTab(
  assertClaimedReadyGeminiTab(rawClient, {
    now: 1_000,
    staleAfterMs: 45_000,
    requireClaimed: true,
    sessionId: 'session-a',
    claims: [
      {
        claimId: 'claim-a',
        clientId: rawClient.clientId,
        sessionId: 'session-a',
        tabId: rawClient.tabId,
        expiresAtMs: 60_000,
      },
    ],
  }),
);

// @ts-expect-error Export jobs require a claimed-ready tab, not merely a raw client.
exportFromClaimedTab(rawClient);
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: FAIL until `assertClaimedReadyGeminiTab` is exported.

- [ ] **Step 3: Export claimed-ready assertion**

In `src/mcp/client-lifecycle.ts`, export:

```ts
export const assertClaimedReadyGeminiTab = (
  client: GeminiClientSnapshot | null | undefined,
  options: GeminiClientLifecycleOptions,
): ClaimedReadyGeminiTab => {
  const result = toClaimedReadyGeminiTab(client, { ...options, requireClaimed: true });
  if (result) return result;
  const lifecycle = getGeminiClientLifecycle(client, { ...options, requireClaimed: true });
  const error = new Error(`${lifecycle.code}: ${lifecycle.message}`);
  Object.assign(error, { code: lifecycle.code, data: { lifecycle } });
  throw error;
};
```

- [ ] **Step 4: Revalidate job claim before browser export**

In `src/mcp-server.js`, add:

```js
const assertClientClaimedReadyForSession = (client, args = {}) =>
  assertClaimedReadyGeminiTab(client, {
    ...clientLifecycleOptions({
      sessionId: normalizeSessionId(args.sessionId || args._proxySessionId),
      requireClaimed: true,
    }),
  });
```

After `ensureTabClaimForJob` returns a claim, call:

```js
assertClientClaimedReadyForSession(client, {
  ...args,
  claimId: claim.claimId,
});
```

This makes the job creation path fail before DOM/export commands if the claim is missing, expired, conflicting, inactive, old-build, or command-unready.

- [ ] **Step 5: Update static recent export test**

In `tests/recent-chats-load-more.test.mjs`, update the existing claim/export block assertion to include `assertClientClaimedReadyForSession`.

```js
assert.match(
  block,
  /ensureTabClaimForJob[\s\S]*?assertClientClaimedReadyForSession/,
);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts
npm run typecheck
node --test tests/mcp-client-lifecycle.test.mjs tests/mcp-tab-selection.test.mjs tests/recent-chats-load-more.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/client-lifecycle.ts src/mcp-server.js tests/mcp-tab-selection-types.ts tests/recent-chats-load-more.test.mjs
git commit -m "feat: require claimed ready tabs for export jobs"
```

## Task 5: Verification And Runtime Smoke

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-playwright-style-tab-session-broker.md`

- [ ] **Step 1: Run targeted build and tests**

Run:

```bash
npm run build:ts
npm run typecheck
node --test tests/mcp-client-lifecycle.test.mjs tests/mcp-tab-selection.test.mjs tests/mcp-command-channel.test.mjs tests/recent-chats-load-more.test.mjs
```

Expected: all pass.

- [ ] **Step 2: Run full build**

Run:

```bash
npm run build
```

Expected: `dist/extension`, `dist/gemini-cli-extension`, and `build/ts/mcp/client-lifecycle.js` are produced without errors.

- [ ] **Step 3: Run bridge smoke**

Run:

```bash
node scripts/bridge-smoke.mjs --spawn --json
```

Expected: bridge endpoints and MCP support checks pass in isolated mode.

- [ ] **Step 4: Install local build for the real browser profile**

Run the same local sync used by the current refactor slice:

```bash
rsync -a --delete dist/gemini-cli-extension/ "$HOME/.gemini/extensions/gemini-md-export/"
rsync -a --delete dist/gemini-cli-extension/ "$HOME/Library/Application Support/GeminiMdExport/gemini-cli-extension/"
```

Expected: installed bundle contains `build/ts/mcp/client-lifecycle.js` and current `bridge-version.json`.

- [ ] **Step 5: Run real readiness check**

Run:

```bash
node scripts/bridge-smoke.mjs --bridge-url http://127.0.0.1:47283 --json
```

Expected: pass if the current browser/MCP instance is healthy, or fail with a structured readiness error. Failure must include lifecycle state such as `warming_up`, `extension_build_mismatch`, `command_channel_unready`, `inactive_tab`, or `client_dead`.

- [ ] **Step 6: Run the 50-chat export smoke when readiness is claimable**

Use the public MCP/CLI path already used in this repo for recent exports. Expected success criteria:

- claim is visible in the browser tab group or badge,
- the progress dock remains visible through the job,
- every exported file passes filename/frontmatter/URL integrity validation,
- partial export is reported as partial, not success,
- readiness failure is structured and actionable, not a silent stale-client fallback.

- [ ] **Step 7: Commit verification notes**

Update this plan's status section with the exact commands and outcomes, then commit:

```bash
git add docs/superpowers/plans/2026-05-20-playwright-style-tab-session-broker.md
git commit -m "docs: record tab session broker verification"
```

## Self-Review

- Spec coverage: lifecycle states, branded capability types, public-tool simplicity, active-tab claim enforcement, claim/session model, diagnostics, and deferred transport upgrade are covered.
- Placeholder scan: no placeholder markers or unspecified edge-handling steps remain.
- Type consistency: `ClaimableGeminiTab`, `ClaimedReadyGeminiTab`, `GeminiClientSnapshot`, and `GeminiClientLifecycleOptions` are introduced in Task 1 and reused consistently in later tasks.
