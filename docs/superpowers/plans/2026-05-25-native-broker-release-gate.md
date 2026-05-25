# Native Broker Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native browser broker the authoritative path for tab list, claim, reload, and release/export readiness so release gates can recover existing Gemini tabs after MCP bridge restart without clicks, AppleScript, or opening extra tabs.

**Architecture:** CLI/MCP talks to the native broker IPC. The native host forwards tab commands to the extension background through Native Messaging. The extension background uses `chrome.tabs` and `chrome.debugger` to classify, reload, claim, and validate existing tabs; content scripts remain page-local DOM executors only.

**Tech Stack:** TypeScript `NodeNext`, MV3 extension background, Chrome Native Messaging, `chrome.tabs`, `chrome.debugger`, Node IPC sockets, Node test runner, existing `npm run build:ts` / `scripts/build.mjs` pipeline.

---

## File Structure

- Modify: `src/native/protocol.ts`
  - Add `tabs.reload` to the typed native command union.
- Modify: `src/mcp/native-browser-broker.ts`
  - Add `reload()` to the MCP-side native broker client.
  - Keep fallback decisions centralized in this module.
- Create: `tests/native-broker-client.test.mjs`
  - Unit tests for extension-background broker commands with mocked Chrome APIs.
- Modify: `src/browser/background/native-broker-client.ts`
  - Handle `tabs.reload`.
  - Query existing browser tabs and reload Gemini tabs through `chrome.tabs.reload`.
- Modify: `src/browser/background/browser-session-broker.ts`
  - Add typed claim-visual companion helpers so My Activity can join the visual Tab Group without becoming an export target.
- Modify: `src/mcp-server.js`
  - Route `reloadGeminiTabs()` through native broker before `getLiveClients()`.
  - Expose native broker status in `/healthz`, `/agent/ready`, and `/agent/tabs`.
  - Require native export lease before release/export job creation.
  - Revalidate native lease before heavy per-conversation browser operations.
- Modify: `bin/gemini-md-export.mjs`
  - Surface native broker blockers in plain output and result JSON.
  - Add an explicit diagnostic compatibility flag for HTTP/content-script fallback.
- Modify: `tests/native-browser-broker.test.mjs`
  - MCP native broker client contract tests.
- Modify: `tests/native-host.test.mjs`
  - Native host / service-worker source contract tests.
- Modify: `tests/mcp-command-channel.test.mjs`
  - MCP native-first source contracts for reload and status.
- Modify: `tests/mcp-export-workflows.test.mjs`
  - Export lease strictness tests.
- Modify: `tests/recent-chats-load-more.test.mjs`
  - Per-conversation lease revalidation source contract.
- Modify: `tests/gemini-cli-tui.test.mjs`
  - CLI behavior and public error tests.
- Create: `scripts/native-broker-release-gate-smoke.mjs`
  - Local smoke script for bridge restart, native reload, claim, and 30-chat export gate.

---

### Task 1: Add `tabs.reload` to the Native Broker MCP Client

**Files:**
- Modify: `src/native/protocol.ts`
- Modify: `src/mcp/native-browser-broker.ts`
- Modify: `tests/native-browser-broker.test.mjs`

- [ ] **Step 1: Write the failing client test**

Append this test to `tests/native-browser-broker.test.mjs`:

```js
test('native broker client sends tabs.reload with target payload', async () => {
  const calls = [];
  const client = createNativeBrowserBrokerClient({
    request: async (request) => {
      calls.push(request);
      return { id: request.id, ok: true, result: { ok: true, reloaded: 1 } };
    },
  });

  const response = await client.reload(
    { tabId: 42, claimId: 'claim-42' },
    { allowFallback: false },
  );

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'tabs.reload');
  assert.deepEqual(calls[0].payload, { tabId: 42, claimId: 'claim-42' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build:ts && node --test tests/native-browser-broker.test.mjs --test-name-pattern 'tabs.reload'
```

Expected: FAIL with `client.reload is not a function` or a TypeScript build error because `tabs.reload` is not in `NativeBrokerCommand`.

- [ ] **Step 3: Implement the native command and client method**

In `src/native/protocol.ts`, update `NativeBrokerCommand`:

```ts
export type NativeBrokerCommand =
  | 'ping'
  | 'healthz'
  | 'tabs.list'
  | 'tabs.status'
  | 'tabs.claim'
  | 'tabs.release'
  | 'tabs.reload'
  | 'export.start'
  | 'export.cancel'
  | 'job.progress'
  | 'extension.hello'
  | 'proxyHttp';
```

In `src/mcp/native-browser-broker.ts`, update the command extract and return object:

```ts
type NativeBrowserBrokerCommand = Extract<
  NativeBrokerCommand,
  'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release' | 'tabs.reload'
>;
```

```ts
return {
  listTabs: (options: NativeBrowserBrokerOptions = {}) => call('tabs.list', {}, options),
  status: (options: NativeBrowserBrokerOptions = {}) => call('tabs.status', {}, options),
  claim: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
    call('tabs.claim', payload, options),
  release: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
    call('tabs.release', payload, options),
  reload: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
    call('tabs.reload', payload, options),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build:ts && node --test tests/native-browser-broker.test.mjs --test-name-pattern 'tabs.reload'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/protocol.ts src/mcp/native-browser-broker.ts tests/native-browser-broker.test.mjs
git commit -m "feat: add native broker reload command"
```

---

### Task 2: Implement Background `tabs.reload` Without Content Scripts

**Files:**
- Create: `tests/native-broker-client.test.mjs`
- Modify: `src/browser/background/native-broker-client.ts`

- [ ] **Step 1: Write the failing background broker tests**

Create `tests/native-broker-client.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleNativeBrowserBrokerCommand,
} from '../build/ts/browser/background/native-broker-client.js';

const chromeApiForTabs = ({ tabs, hrefByTabId, reloadError = null }) => {
  const reloaded = [];
  const api = {
    runtime: { lastError: null },
    tabs: {
      query(_queryInfo, callback) {
        callback(tabs);
      },
      reload(tabId, _reloadProperties, callback) {
        reloaded.push(tabId);
        api.runtime.lastError = reloadError ? { message: reloadError } : null;
        callback();
        api.runtime.lastError = null;
      },
    },
    debugger: {
      attach(_target, _version, callback) {
        callback();
      },
      sendCommand(target, _method, _params, callback) {
        callback({
          result: {
            value: {
              href: hrefByTabId[target.tabId] || 'https://example.com/',
              readyState: 'complete',
            },
          },
        });
      },
      detach(_target, callback) {
        callback();
      },
    },
  };
  return { api, reloaded };
};

test('native broker reloads existing Gemini tabs without content-script clients', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: false, url: 'https://gemini.google.com/app' },
      { id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reloaded, 1);
  assert.deepEqual(result.reloadedTabIds, [42]);
  assert.deepEqual(reloaded, [42]);
});

test('native broker reports no_existing_gemini_tabs without opening a tab', async () => {
  const { api, reloaded } = chromeApiForTabs({
    tabs: [{ id: 99, windowId: 7, active: true, url: 'https://myactivity.google.com/product/gemini' }],
    hrefByTabId: { 99: 'https://myactivity.google.com/product/gemini' },
  });

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.reload', payload: {} },
    api,
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_existing_gemini_tabs');
  assert.equal(result.reloaded, 0);
  assert.deepEqual(reloaded, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run build:ts && node --test tests/native-broker-client.test.mjs
```

Expected: FAIL because `tabs.reload` is unsupported by `handleNativeBrowserBrokerCommand`.

- [ ] **Step 3: Implement background reload**

In `src/browser/background/native-broker-client.ts`, extend the command type:

```ts
export type NativeBrowserBrokerCommand = Readonly<{
  id?: string;
  command: 'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release' | 'tabs.reload';
  payload?: { tabId?: number | null; claimId?: string | null };
}>;
```

Extend `ChromeNativeBrokerApi.tabs`:

```ts
tabs?: {
  query(queryInfo: { url: string[] }, callback: (tabs?: RawBrowserTab[]) => void): void;
  reload?(
    tabId: number,
    reloadProperties: { bypassCache?: boolean },
    callback?: () => void,
  ): void;
};
```

Add this helper near `queryManagedTabs`:

```ts
const chromeReloadTab = (
  chromeApi: ChromeNativeBrokerApi,
  tabId: number,
): Promise<{ ok: true } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    if (!chromeApi.tabs?.reload) {
      resolve({ ok: false, error: 'chrome_tabs_reload_unavailable' });
      return;
    }
    chromeApi.tabs.reload(tabId, { bypassCache: false }, () => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) {
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
    });
  });
```

Add this branch inside `handleNativeBrowserBrokerCommand` after `tabs.status`:

```ts
if (request.command === 'tabs.reload') {
  const listed = await getDebuggableGeminiTabs(tabs, { inspectTab });
  const requestedTabId = Number(request.payload?.tabId || 0);
  const targets = requestedTabId
    ? listed.tabs.filter((tab) => tab.tabId === requestedTabId)
    : listed.tabs;

  if (targets.length === 0) {
    return {
      ok: false as const,
      code: 'no_existing_gemini_tabs',
      reloaded: 0,
      tabs: listed.tabs,
      classified: listed.classified,
    };
  }

  const results = await Promise.all(
    targets.map(async (tab) => ({
      tab,
      reload: await chromeReloadTab(chromeApi, tab.tabId),
    })),
  );
  const successes = results.filter((item) => item.reload.ok);
  const failures = results.filter((item) => !item.reload.ok);

  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : 'native_tab_reload_failed',
    requested: targets.length,
    reloaded: successes.length,
    reloadedTabIds: successes.map((item) => item.tab.tabId),
    failures: failures.map((item) => ({
      tabId: item.tab.tabId,
      error: item.reload.ok ? null : item.reload.error,
    })),
    tabs: listed.tabs,
    classified: listed.classified,
  };
}
```

Update `isBrowserBrokerCommand`:

```ts
const isBrowserBrokerCommand = (
  command: unknown,
): command is NativeBrowserBrokerCommand['command'] =>
  command === 'tabs.list' ||
  command === 'tabs.status' ||
  command === 'tabs.claim' ||
  command === 'tabs.release' ||
  command === 'tabs.reload';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run build:ts && node --test tests/native-broker-client.test.mjs tests/browser-session-broker.test.mjs tests/chrome-debugger-controller.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/background/native-broker-client.ts tests/native-broker-client.test.mjs
git commit -m "feat: reload Gemini tabs through native broker"
```

---

### Task 2.5: Guarantee My Activity Joins the Native Claim Visual

**Files:**
- Modify: `src/browser/background/browser-session-broker.ts`
- Modify: `src/browser/background/native-broker-client.ts`
- Modify: `tests/browser-session-broker.test.mjs`
- Modify: `tests/native-broker-client.test.mjs`
- Modify: `tests/native-host.test.mjs`
- Modify: `tests/tab-claim-visual.test.mjs`
- Modify: `tests/tab-claim-visual-types.ts`

- [ ] **Step 1: Write the failing pure broker test**

Append this test to `tests/browser-session-broker.test.mjs`:

```js
test('My Activity entra no alvo visual da claim sem virar aba exportavel', async () => {
  const activityTab = {
    id: 99,
    windowId: 7,
    active: false,
    url: 'https://myactivity.google.com/product/gemini',
    title: 'My Activity',
  };
  const result = await claimDebuggableGeminiTab([tab, activityTab], {
    inspectTab: async (tabId) =>
      tabId === 42
        ? {
            ok: true,
            tabId,
            url: tab.url,
            pageKind: 'gemini',
            blockerCode: null,
          }
        : {
            ok: true,
            tabId,
            url: activityTab.url,
            pageKind: 'my_activity',
            blockerCode: null,
          },
  });
  const listed = await getDebuggableGeminiTabs([tab, activityTab], {
    inspectTab: async (tabId) =>
      tabId === 42
        ? {
            ok: true,
            tabId,
            url: tab.url,
            pageKind: 'gemini',
            blockerCode: null,
          }
        : {
            ok: true,
            tabId,
            url: activityTab.url,
            pageKind: 'my_activity',
            blockerCode: null,
          },
  });

  assert.equal(result.ok, true);
  assert.equal(result.tab.tabId, 42);
  assert.deepEqual(result.visualCompanionTabIds, [99]);
  assert.deepEqual(listed.tabs.map((item) => item.tabId), [42]);
});
```

- [ ] **Step 2: Write the failing native broker visual test**

Add this test to `tests/native-broker-client.test.mjs`:

```js
test('native broker claim groups Gemini and My Activity in the same visual rectangle', async () => {
  const grouped = [];
  const updatedGroups = [];
  const { api } = chromeApiForTabs({
    tabs: [
      { id: 42, windowId: 7, active: true, url: 'https://gemini.google.com/app/abc123456789' },
      { id: 99, windowId: 7, active: false, url: 'https://myactivity.google.com/product/gemini' },
    ],
    hrefByTabId: {
      42: 'https://gemini.google.com/app/abc123456789',
      99: 'https://myactivity.google.com/product/gemini',
    },
  });
  api.tabs.group = (createProperties, callback) => {
    grouped.push(createProperties.tabIds);
    callback(777);
  };
  api.tabGroups = {
    update(groupId, updateProperties, callback) {
      updatedGroups.push({ groupId, updateProperties });
      callback({ id: groupId, ...updateProperties });
    },
  };

  const result = await handleNativeBrowserBrokerCommand(
    { command: 'tabs.claim', payload: { claimId: 'claim-42', label: 'Gemini Export' } },
    api,
  );

  assert.equal(result.ok, true);
  assert.equal(result.tab.tabId, 42);
  assert.equal(result.visual.mode, 'tab-group');
  assert.deepEqual(result.visual.tabIds, [42, 99]);
  assert.deepEqual(grouped, [[42, 99]]);
  assert.equal(updatedGroups[0].groupId, 777);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
npm run build:ts && node --test tests/browser-session-broker.test.mjs tests/native-broker-client.test.mjs --test-name-pattern 'My Activity|same visual rectangle'
```

Expected: FAIL because the native broker does not yet return a typed visual target or apply a Tab Group from the background path.

- [ ] **Step 4: Add typed visual companion contract**

In `src/browser/background/browser-session-broker.ts`:

- Extend the `BrowserTabClassification` contract so My Activity remains `state: 'not_gemini'` with `inspection.pageKind === 'my_activity'`.
- Add a typed helper:

```ts
export const visualCompanionTabIdsForClaim = (
  claimedTab: DebuggableGeminiTab,
  classified: readonly BrowserTabClassification[],
): readonly number[] =>
  classified
    .filter((item) => item.inspection?.pageKind === 'my_activity')
    .map((item) => Number(item.tab.id))
    .filter((tabId) => Number.isInteger(tabId) && tabId !== claimedTab.tabId);
```

- Make `claimDebuggableGeminiTab(...)` return `visualCompanionTabIds` together with the claimed Gemini tab.
- Do not include My Activity in `getDebuggableGeminiTabs(...)`; it stays non-exportable.

- [ ] **Step 5: Apply native claim visual from the background broker**

In `src/browser/background/native-broker-client.ts`:

- Extend `NativeBrowserBrokerCommand['payload']` with `label?: string | null` and `color?: string | null`.
- Extend `ChromeNativeBrokerApi` with `tabs.group(...)` and `tabGroups.update(...)`.
- Add `applyNativeClaimVisual(...)`:

```ts
const applyNativeClaimVisual = async (
  chromeApi: ChromeNativeBrokerApi,
  tabId: number,
  relatedTabIds: readonly number[],
  payload: { label?: string | null; color?: string | null } = {},
) => {
  const tabIds = Array.from(new Set([tabId, ...relatedTabIds])).filter(Number.isInteger);
  if (!chromeApi.tabs?.group || !chromeApi.tabGroups?.update) {
    return { mode: 'action-badge' as const, tabId, reason: 'tab-groups-api-unavailable' };
  }
  const groupId = await chromeGroupTabs(chromeApi, tabIds);
  if (!Number.isInteger(groupId)) {
    return { mode: 'action-badge' as const, tabId, reason: 'tab-group-create-failed' };
  }
  await chromeUpdateTabGroup(chromeApi, groupId, {
    title: payload.label || 'Gemini Export',
    color: payload.color || 'blue',
  });
  return {
    mode: 'tab-group' as const,
    tabId,
    tabIds: tabIds as [number, ...number[]],
    groupId,
    label: payload.label || 'Gemini Export',
    color: payload.color || 'blue',
  };
};
```

In the `tabs.claim` branch, after `claimDebuggableGeminiTab(...)` succeeds, return:

```ts
return {
  ...claim,
  visual: await applyNativeClaimVisual(
    chromeApi,
    claim.tab.tabId,
    claim.visualCompanionTabIds,
    request.payload,
  ),
};
```

- [ ] **Step 6: Strengthen public visual type tests**

In `tests/tab-claim-visual.test.mjs`, add a runtime assertion that a `tab-group` visual with `tabIds: [42, 99]` is accepted and still requires `tabId: 42` to be included.

In `tests/tab-claim-visual-types.ts`, add a `satisfies TabGroupClaimVisual` fixture with `tabIds: [42, 99] as const`; keep the existing `@ts-expect-error` fixture proving a group visual without the claimed tab is rejected.

In `tests/native-host.test.mjs`, extend `service worker opens persistent native broker port and exposes tab commands` to assert `tabs.group`, `tabGroups.update`, `visualCompanionTabIds`, and `applyNativeClaimVisual`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run build:ts && node --test \
  tests/browser-session-broker.test.mjs \
  tests/native-broker-client.test.mjs \
  tests/native-host.test.mjs \
  tests/tab-claim-visual.test.mjs
```

Expected: PASS.

Run the type check that includes `tests/tab-claim-visual-types.ts` through the repo's existing TypeScript build command:

```bash
npm run build:ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/browser/background/browser-session-broker.ts src/browser/background/native-broker-client.ts tests/browser-session-broker.test.mjs tests/native-broker-client.test.mjs tests/native-host.test.mjs tests/tab-claim-visual.test.mjs tests/tab-claim-visual-types.ts
git commit -m "feat: group My Activity with native tab claim"
```

---

### Task 3: Make MCP `reloadGeminiTabs()` Native-First

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Write the failing source contract**

Append this test to `tests/mcp-command-channel.test.mjs`:

```js
test('reload de abas usa native broker antes de depender de clientes vivos', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const reloadBlock = source.match(
    /const reloadGeminiTabs = async \(args = \{\}\) => \{[\s\S]*?\n\};\n\nconst legacyRawTools/,
  )?.[0];

  assert.ok(reloadBlock, 'reloadGeminiTabs deve existir');
  assert.match(reloadBlock, /tryNativeBrowserBrokerTabsAction\('reload', args\)/);
  assert.ok(
    reloadBlock.indexOf("tryNativeBrowserBrokerTabsAction('reload', args)") <
      reloadBlock.indexOf('const liveClients = getLiveClients()'),
    'native broker precisa rodar antes de getLiveClients',
  );
  assert.match(source, /nativeBrowserBroker\.reload/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tests/mcp-command-channel.test.mjs --test-name-pattern 'native broker antes'
```

Expected: FAIL because `tryNativeBrowserBrokerTabsAction('reload', args)` is absent.

- [ ] **Step 3: Add native reload to `tryNativeBrowserBrokerTabsAction`**

In `src/mcp-server.js`, add this branch inside `tryNativeBrowserBrokerTabsAction`:

```js
if (action === 'reload') {
  return nativeBrowserBrokerToolResult(
    await nativeBrowserBroker.reload(
      {
        tabId: args.tabId ?? null,
        claimId: args.claimId || null,
      },
      { allowFallback: args.allowHttpBrowserFallback === true },
    ),
    action,
  );
}
```

- [ ] **Step 4: Call native reload before live-client reload**

At the top of `reloadGeminiTabs`, after `assertBrowserSideEffect(...)` and delay normalization, insert:

```js
const nativeReload = await tryNativeBrowserBrokerTabsAction('reload', args);
if (nativeReload && (nativeReload.ok !== false || args.allowHttpBrowserFallback !== true)) {
  return nativeReload;
}
```

Keep the existing `reloadExtensionForExistingTabs(...)` and content-script reload as compatibility behavior when `allowHttpBrowserFallback === true` or when native broker is disabled by environment.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
npm run build:ts && node --test tests/mcp-command-channel.test.mjs --test-name-pattern 'reload de abas|native broker antes'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.js tests/mcp-command-channel.test.mjs
git commit -m "feat: make tab reload native-first"
```

---

### Task 4: Expose Native Broker Status in Readiness and CLI Status

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `bin/gemini-md-export.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Write the failing CLI readiness test**

Append this test to `tests/gemini-cli-tui.test.mjs`:

```js
test('CLI browser status surfaces native broker blocker from readiness', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: false,
        blockingIssue: 'native_broker_extension_disconnected',
        connectedClientCount: 0,
        selectableTabCount: 0,
        commandReadyClientCount: 0,
        nativeBroker: {
          configured: true,
          available: false,
          code: 'native_broker_extension_disconnected',
          message: 'A extensão ainda não abriu a porta nativa do broker.',
        },
      });
      return;
    }
    if (url.pathname === '/agent/clients') {
      sendJson(res, 200, { mcp: { bridgeRole: 'primary' }, connectedClients: [] });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['browser', 'status', '--bridge-url', bridgeUrl, '--plain', '--no-wake', '--result-json'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    assert.match(stdout.text(), /A extensão ainda não abriu a porta nativa do broker/);
    assert.equal(run.result.nativeBroker.code, 'native_broker_extension_disconnected');
    assert.equal(stderr.text(), '');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'native broker blocker'
```

Expected: FAIL because `run.result.nativeBroker` is missing or the plain label ignores the broker message.

- [ ] **Step 3: Add structured native broker status in MCP**

Replace `probeNativeBrowserBrokerAvailability` in `src/mcp-server.js` with a status-returning helper:

```js
const probeNativeBrowserBrokerStatus = async () => {
  if (!shouldUseNativeBrowserBroker()) {
    return {
      configured: false,
      available: false,
      code: 'native_broker_disabled',
      message: 'Native broker desativado por configuracao.',
    };
  }
  const response = await withSoftTimeout(
    nativeBrowserBroker.status({ allowFallback: true }),
    750,
    { ok: false, code: 'native_broker_probe_timeout' },
  );
  if (response?.ok === true) {
    return {
      configured: true,
      available: true,
      code: null,
      message: 'Native broker conectado.',
      response,
    };
  }
  const code =
    response?.error?.code ||
    response?.code ||
    'native_broker_unavailable';
  const message =
    response?.error?.message ||
    response?.error ||
    'Não consegui falar com o broker nativo.';
  return {
    configured: true,
    available: false,
    code,
    message,
    response,
  };
};

const probeNativeBrowserBrokerAvailability = async () => {
  const status = await probeNativeBrowserBrokerStatus();
  if (status.available === true) return true;
  if (status.configured === false || status.code === 'native_broker_unavailable') return false;
  return null;
};
```

In `buildLightweightBrowserReady`, compute and return status:

```js
const nativeBrokerStatus = await probeNativeBrowserBrokerStatus();
```

Add to the returned object:

```js
nativeBroker: nativeBrokerStatus,
```

If `nativeBrokerStatus.configured === true`, `nativeBrokerStatus.available !== true`, and there are no claimable tabs, set `blockingIssue` to `nativeBrokerStatus.code || blockingIssue`.

- [ ] **Step 4: Surface broker status in CLI browser status**

In `bin/gemini-md-export.mjs`, add `nativeBroker` to the `runBrowser` result object:

```js
nativeBroker: ready.nativeBroker || null,
```

Update `nextAction` priority inside `runBrowser`:

```js
nextAction:
  ready.ready === true
    ? 'Bridge, extensao e aba Gemini parecem prontos.'
    : ready.nativeBroker?.message ||
      ready.browserDiagnostic?.message ||
      ready.extensionReadiness?.nextAction?.message ||
      ready.cliBrowserWake?.reason ||
      ready.cliBrowserWake?.error ||
      'Verifique a extensao Chrome.',
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'native broker blocker'
```

Expected: PASS.

- [ ] **Step 6: Run readiness contracts**

Run:

```bash
node --test tests/mcp-command-channel.test.mjs --test-name-pattern 'browser_status|native broker'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.js bin/gemini-md-export.mjs tests/gemini-cli-tui.test.mjs tests/mcp-command-channel.test.mjs
git commit -m "feat: expose native broker readiness"
```

---

### Task 5: Require Native Lease for Release Export and Sync

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-export-workflows.test.mjs`
- Modify: `tests/recent-chats-load-more.test.mjs`

- [ ] **Step 1: Write the failing source contract for job creation**

Append this test to `tests/mcp-export-workflows.test.mjs`:

```js
test('recent export job validates native lease before creating job', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const endpointBlock = source.match(
    /url\.pathname === '\/agent\/export-recent-chats'[\s\S]*?\n  if \(req\.method === 'GET' && url\.pathname === '\/agent\/export-missing-chats'\)/,
  )?.[0];

  assert.ok(endpointBlock, 'export recent endpoint deve existir');
  assert.match(endpointBlock, /validateNativeExportTabLeaseForJob/);
  assert.ok(
    endpointBlock.indexOf('validateNativeExportTabLeaseForJob') <
      endpointBlock.indexOf('startRecentChatsExportJob'),
    'lease nativa precisa ser validada antes de criar job',
  );
});
```

- [ ] **Step 2: Write the failing source contract for per-conversation revalidation**

Append this test to `tests/recent-chats-load-more.test.mjs`:

```js
test('export recente revalida lease nativa antes de comando pesado por conversa', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'mcp-server.js'), 'utf-8');
  const collectBlock = source.match(
    /const collectConversationItemPayloadForClient = async[\s\S]*?\nconst saveCollectedConversationPayload/,
  )?.[0];

  assert.ok(collectBlock, 'collectConversationItemPayloadForClient deve existir');
  assert.match(collectBlock, /validateNativeExportTabLeaseForJob/);
  assert.ok(
    collectBlock.indexOf('validateNativeExportTabLeaseForJob') <
      collectBlock.indexOf("'get-chat-by-id'"),
    'lease nativa precisa ser revalidada antes do get-chat-by-id',
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/mcp-export-workflows.test.mjs tests/recent-chats-load-more.test.mjs --test-name-pattern 'lease nativa'
```

Expected: FAIL because export creation and per-conversation collection do not both show explicit native lease validation in those blocks.

- [ ] **Step 4: Validate native lease before job creation**

In the `/agent/export-recent-chats` endpoint in `src/mcp-server.js`, after `ensureTabClaimForJob` and before `startRecentChatsExportJob`, use:

```js
const claim = await ensureTabClaimForJob(client, selector, TAB_CLAIM_LABELS.export);
const nativeLease = await validateNativeExportTabLeaseForJob(
  { ...selector, claimId: claim?.claimId || selector.claimId, tabId: claim?.tabId ?? selector.tabId },
  claim,
  client,
);
```

Pass the lease into the job args:

```js
_nativeExportLease: nativeLease,
```

Repeat the same structure in `/agent/export-missing-chats`, `/agent/sync-vault`, and selected/reexport endpoints that use browser export.

- [ ] **Step 5: Revalidate lease before each heavy conversation command**

At the start of `collectConversationItemPayloadForClient`, after `const prepared = await ensureClientActiveForExport(client, args);` and before `enqueueCommandWithClientRecovery`, insert:

```js
if (args._nativeExportLease || args.claimId || args.requireNativeExportLease === true) {
  await validateNativeExportTabLeaseForJob(
    {
      ...args,
      claimId: args._nativeExportLease?.claimId || args.claimId,
      tabId: args._nativeExportLease?.tabId ?? prepared.client?.tabId ?? args.tabId,
    },
    args._nativeExportLease || null,
    prepared.client,
  );
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/mcp-export-workflows.test.mjs tests/recent-chats-load-more.test.mjs --test-name-pattern 'lease nativa|native broker tabs'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.js tests/mcp-export-workflows.test.mjs tests/recent-chats-load-more.test.mjs
git commit -m "feat: require native lease for browser exports"
```

---

### Task 6: Add Explicit HTTP Compatibility Flag and Public Error Mapping

**Files:**
- Modify: `bin/gemini-md-export.mjs`
- Modify: `src/mcp-server.js`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Write the failing CLI compatibility tests**

Append these tests to `tests/gemini-cli-tui.test.mjs`:

```js
test('CLI passes explicit HTTP browser fallback flag only when requested', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'reload') {
      sendJson(res, 200, {
        ok: true,
        allowHttpBrowserFallback: url.searchParams.get('allowHttpBrowserFallback'),
        reloaded: 0,
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'tabs',
        'reload',
        '--bridge-url',
        bridgeUrl,
        '--plain',
        '--allow-http-browser-fallback',
        '--result-json',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(run.result.allowHttpBrowserFallback, 'true');
    assert.equal(stderr.text(), '');
  });
});

test('CLI prints native broker next action for strict release blocker', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-recent-chats') {
      sendJson(res, 503, {
        ok: false,
        code: 'native_broker_extension_disconnected',
        error: 'A extensão ainda não abriu a porta nativa do broker.',
        nextAction: 'Recarregue a extensão ou rode doctor para ver o native broker.',
      });
      return;
    }
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, { ready: true, connectedClientCount: 1, selectableTabCount: 1 });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () =>
        main(
          ['export', 'recent', '--bridge-url', bridgeUrl, '--plain', '--max-chats', '1'],
          { stdout, stderr },
        ),
      /A extensão ainda não abriu a porta nativa do broker/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'HTTP browser fallback|native broker next action'
```

Expected: FAIL because the parser does not know `--allow-http-browser-fallback` and strict native errors do not include the next action in the thrown message.

- [ ] **Step 3: Add the CLI flag**

In `bin/gemini-md-export.mjs`, add to help text under common options:

```js
'  --allow-http-browser-fallback  Diagnostico: permite fallback legado por content script quando native broker falha.',
```

In argument parsing, add:

```js
else if (arg === '--allow-http-browser-fallback') out.flags.allowHttpBrowserFallback = true;
```

In `browserControlParamsFromFlags` call sites, add this param where request params are built:

```js
allowHttpBrowserFallback: flags.allowHttpBrowserFallback,
```

For `runTabs`, pass:

```js
allowHttpBrowserFallback: parsed.flags.allowHttpBrowserFallback,
```

- [ ] **Step 4: Preserve next action in request errors**

In `requestJson` error construction in `bin/gemini-md-export.mjs`, include `nextAction` from response JSON when present:

```js
const nextAction = data?.nextAction || data?.nativeBroker?.nextAction || null;
const message = [data?.error || data?.message || response.statusText, nextAction]
  .filter(Boolean)
  .join('\n');
const err = new Error(message);
err.code = data?.code || null;
err.data = data;
```

- [ ] **Step 5: Thread the flag into MCP selector args**

In `src/mcp-server.js`, add to `clientSelectorFromSearchParams`:

```js
allowHttpBrowserFallback: parseOptionalBoolean(searchParams.get('allowHttpBrowserFallback')),
```

Use `args.allowHttpBrowserFallback === true` as the only strict fallback escape hatch for native broker failures in tab management and export lease validation.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'HTTP browser fallback|native broker next action'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bin/gemini-md-export.mjs src/mcp-server.js tests/gemini-cli-tui.test.mjs
git commit -m "feat: gate HTTP browser fallback behind explicit flag"
```

---

### Task 7: Add a Native Broker Release Gate Smoke Script

**Files:**
- Create: `scripts/native-broker-release-gate-smoke.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Write the failing bundle/source test**

Append this test to `tests/gemini-cli-tui.test.mjs`:

```js
test('release gate smoke script documents native broker command sequence', () => {
  const scriptPath = resolve(ROOT, 'scripts', 'native-broker-release-gate-smoke.mjs');
  const source = readFileSync(scriptPath, 'utf-8');

  assert.match(source, /tabs reload/);
  assert.match(source, /tabs claim/);
  assert.match(source, /export recent/);
  assert.match(source, /--allow-reload/);
  assert.match(source, /--no-wake/);
  assert.match(source, /--no-focus-window/);
  assert.match(source, /--takeout/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'release gate smoke script'
```

Expected: FAIL with `ENOENT` because the script does not exist.

- [ ] **Step 3: Create the smoke script**

Create `scripts/native-broker-release-gate-smoke.mjs`:

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const takeout = valueOf('--takeout');
const outputDir =
  valueOf('--output-dir') ||
  resolve(process.env.HOME || '.', 'Downloads', `gemini-md-export-native-gate-${Date.now()}`);
const maxChats = valueOf('--max-chats') || '30';

if (!takeout) {
  console.error('Uso: node scripts/native-broker-release-gate-smoke.mjs --takeout <takeout.zip> [--output-dir <dir>] [--max-chats 30]');
  process.exit(64);
}

mkdirSync(outputDir, { recursive: true });

const run = (label, commandArgs) => {
  console.log(`\\n## ${label}`);
  console.log(`node bin/gemini-md-export.mjs ${commandArgs.join(' ')}`);
  const result = spawnSync(process.execPath, ['bin/gemini-md-export.mjs', ...commandArgs], {
    cwd: resolve(new URL('..', import.meta.url).pathname),
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
};

// tabs reload
run('Native reload existing tabs', [
  'tabs',
  'reload',
  '--allow-reload',
  '--no-wake',
  '--no-activate-tab',
  '--no-focus-window',
  '--plain',
  '--result-json',
]);

// tabs list
run('Native list tabs', [
  'tabs',
  'list',
  '--no-wake',
  '--no-activate-tab',
  '--no-focus-window',
  '--plain',
  '--result-json',
]);

// tabs claim
run('Native claim existing Gemini tab', [
  'tabs',
  'claim',
  '--allow-reload',
  '--no-wake',
  '--no-activate-tab',
  '--no-focus-window',
  '--plain',
  '--result-json',
]);

// export recent
run('Export recent release gate', [
  'export',
  'recent',
  '--max-chats',
  maxChats,
  '--output-dir',
  outputDir,
  '--takeout',
  takeout,
  '--no-wake',
  '--activate-tab',
  '--no-focus-window',
  '--ready-wait-ms',
  '60000',
  '--timeout-ms',
  '900000',
  '--poll-ms',
  '1500',
  '--plain',
  '--result-json',
]);
```

- [ ] **Step 4: Make the script executable**

Run:

```bash
chmod +x scripts/native-broker-release-gate-smoke.mjs
```

- [ ] **Step 5: Run focused test**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs --test-name-pattern 'release gate smoke script'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/native-broker-release-gate-smoke.mjs tests/gemini-cli-tui.test.mjs
git commit -m "test: add native broker release gate smoke script"
```

---

### Task 8: Full Verification and Installed Extension Sync

**Files:**
- No source edits unless verification exposes a failure.

- [ ] **Step 1: Run the focused native broker suite**

Run:

```bash
npm run build:ts && node --test \
  tests/native-browser-broker.test.mjs \
  tests/native-broker-client.test.mjs \
  tests/native-host.test.mjs \
  tests/browser-session-broker.test.mjs \
  tests/chrome-debugger-controller.test.mjs \
  tests/mcp-command-channel.test.mjs \
  tests/mcp-export-workflows.test.mjs \
  tests/recent-chats-load-more.test.mjs \
  tests/gemini-cli-tui.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Build the distributable bundle**

Run:

```bash
npm run build
```

Expected: build writes `dist/gemini-cli-extension`, `dist/extension`, and `dist/gemini-export.user.js` without errors.

- [ ] **Step 3: Sync the installed Gemini CLI extension**

Run:

```bash
rsync -a --delete dist/gemini-cli-extension/ /Users/augustocaruso/.gemini/extensions/gemini-md-export/
node -e 'const fs=require("fs"); const p="/Users/augustocaruso/.gemini/extensions/gemini-md-export/bridge-version.json"; console.log(fs.readFileSync(p,"utf8"));'
```

Expected: printed JSON has `extensionVersion`, `protocolVersion`, and the new `buildStamp`.

- [ ] **Step 4: Run non-click native status**

Run:

```bash
node bin/gemini-md-export.mjs browser status --allow-reload --no-wake --no-activate-tab --no-focus-window --ready-wait-ms 60000 --plain --result-json
```

Expected: either ready with `nativeBroker.available=true`, or a typed native broker blocker such as `native_broker_extension_disconnected`. It must not open a new tab.

- [ ] **Step 5: Run release gate smoke when a Gemini tab is already open**

Run:

```bash
node scripts/native-broker-release-gate-smoke.mjs \
  --takeout /Users/augustocaruso/Downloads/takeout-20260521T143843Z-3-001.zip \
  --output-dir /Users/augustocaruso/Downloads/gemini-md-export-native-gate-30 \
  --max-chats 30
```

Expected: either a completed 30-chat export with receipts, or a typed blocker from native broker, Google login, Google verification, claim ambiguity, or export integrity. It must not require AppleScript or manual clicks.

- [ ] **Step 6: Commit verification-only metadata if build scripts changed generated tracked files**

Run:

```bash
git status --short
```

If tracked source or test files changed during fixes, commit them with the task-specific commit message from the previous task. Do not commit `dist/` unless this repo already tracks the affected generated files.
