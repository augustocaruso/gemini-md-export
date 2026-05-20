# Native Debugger Session Broker Design

Date: 2026-05-20
Status: Draft for user review

## Context

The current bridge model still treats extension heartbeats as an important source
of browser state. That is the wrong long-term contract. Heartbeats can show that
a content script was recently alive, but they cannot prove that the tab is still
the intended tab, that the page is hydrated, that the Google account flow is not
blocked, or that a claim is safe.

The desired workflow is closer to Playwright extension mode: operate on existing
browser tabs in the user's real logged-in profile, but make tab/session ownership
explicit and strongly validated. The difference is that this project should not
need a separate Playwright browser. The Chrome extension can use
`chrome.debugger` and `chrome.tabs` from its background service worker to inspect
and control existing tabs through Chrome DevTools Protocol.

## Goals

- Remove heartbeat as a source of truth for tab selection, lifecycle, and export
  readiness.
- Use `chrome.debugger`/CDP in the extension background as the authoritative
  browser control layer for existing Gemini tabs.
- Replace HTTP/SSE/long-poll as the primary command transport with Native
  Messaging.
- Keep the CLI/MCP as the user-facing orchestrator while moving browser facts to
  the extension background.
- Make export workflows accept only a validated, claimed, debuggable Gemini tab
  capability.
- Preserve a non-intrusive test mode: no browser focus, no tab activation, and
  no new tab unless there is no existing Gemini tab and the caller explicitly
  asks for wake/open behavior.
- Keep Chat Export, My Activity, and Takeout sharing the same core contracts,
  metadata evidence handling, progress model, and browser session primitives.

## Non-Goals

- Do not add a WebSocket application protocol.
- Do not make remote-debugging-port a user requirement.
- Do not remove the existing HTTP bridge in the first implementation slice.
- Do not move DOM extraction out of the content script in this design.
- Do not expose low-level CDP, native host, or heartbeat vocabulary to end users.
- Do not permit "last connected client wins" behavior for export jobs.

## Considered Approaches

### A. Native Messaging + chrome.debugger

The CLI/MCP talks to a native host by stdin/stdout framing. The extension talks
to that native host through `chrome.runtime.connectNative()`. The extension
background uses `chrome.tabs` and `chrome.debugger` to list, inspect, claim, and
control existing tabs.

This is the recommended approach. It avoids local port ownership problems,
reduces stale process confusion, keeps browser permissions in the extension, and
does not require a browser launched with remote debugging enabled.

### B. Keep HTTP bridge, move authority to chrome.debugger

This is a smaller migration. The current local bridge remains the transport, but
all tab readiness decisions move to the extension background through
`chrome.debugger`.

This is useful as an intermediate compatibility path, but it leaves the local
port, SSE, long-poll, and bridge process lifecycle as operational noise.

### C. CLI direct CDP

The CLI connects directly to a browser remote debugging endpoint and controls
tabs itself.

This is rejected for the default workflow. It usually requires launching or
configuring the browser with remote debugging, which is more intrusive for the
user's existing Dia/Chrome profile. It is still acceptable as a developer-only
diagnostic mode if needed later.

## Architecture

```text
CLI / MCP public tools
  -> Native host transport
    -> Extension background
      -> BrowserSessionBroker
        -> ChromeDebuggerController
          -> chrome.debugger / chrome.tabs
            -> Gemini tab content script / page DOM
```

The bridge/native host is transport. It is not the source of truth for tab
state. The broker is the state machine that decides whether a tab can be used.
The debugger controller is the browser-facing implementation that gathers fresh
facts.

The content script remains responsible for DOM extraction and page-local UI.
The background service worker is responsible for tab lifecycle, debugger attach,
target validation, blocker detection, navigation, and claim state.

## Core Types

The important compile-time rule is that raw transport records cannot enter
export code.

```ts
type NativeMessage = unknown;
type RawBrowserTab = unknown;
type InspectableBrowserTab = Brand<RawBrowserTab, "InspectableBrowserTab">;
type DebuggableGeminiTab = Brand<InspectableBrowserTab, "DebuggableGeminiTab">;
type ClaimedDebuggableGeminiTab =
  Brand<DebuggableGeminiTab, "ClaimedDebuggableGeminiTab">;
```

Only the browser session broker can construct `DebuggableGeminiTab`. Only the
claim manager can construct `ClaimedDebuggableGeminiTab`. Export workflows take
`ClaimedDebuggableGeminiTab`, never a heartbeat client, raw tab, tab id string,
or content-script client id.

## Data Flow

1. CLI/MCP sends a high-level command to the native host, for example
   `tabs.list`, `tabs.claim`, `export.recent`, or `export.cancel`.
2. The native host forwards the request to the extension via Native Messaging.
3. The extension background asks the broker for fresh tab state.
4. The broker lists tabs with `chrome.tabs`, attaches or reuses
   `chrome.debugger`, and validates URL, target lifetime, navigation state,
   Google blocker state, content-script availability, build version, and busy
   state.
5. If exactly one valid target is required but multiple exist, the broker
   returns `ambiguous_gemini_tabs` with a compact list.
6. Export begins only after an explicit claim produces
   `ClaimedDebuggableGeminiTab`.
7. DOM extraction still happens through the content script, but each heavy
   operation is revalidated through the broker before use.
8. Progress is emitted as typed job snapshots. The UI progress dock consumes the
   same `JobProgress` shape as CLI/MCP.

## Browser Workflow Rules

- Default commands do not focus windows.
- Default commands do not activate tabs.
- A new tab can be created only when there are no Gemini tabs and the caller
  opted into wake/open behavior.
- Multiple Gemini tabs require an explicit claim for export and real smoke
  tests.
- Claiming an inactive tab is allowed only if the caller explicitly requested
  activation and the broker revalidates after activation.
- If Google login, Google "sorry" verification, or another blocker page is
  detected, the workflow blocks with a specific code and a human next action.
- Heartbeat can remain as diagnostic telemetry during migration, but it cannot
  decide tab selection or readiness.

## Native Messaging Contract

Messages are newline-independent Native Messaging frames using Chrome's
length-prefixed JSON protocol. The payloads should be typed envelopes:

```ts
type NativeRequest = {
  id: string;
  protocolVersion: 1;
  command: string;
  payload: unknown;
};

type NativeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: NativeBrokerError };
```

The native host should be a thin transport and process supervisor. It should not
invent browser facts. If it caches anything, cached values must be labelled as
diagnostic snapshots and cannot be used as readiness proof.

## Migration Plan

1. Add typed Native Messaging envelopes and a native-host transport module while
   leaving the HTTP bridge in place.
2. Add a `ChromeDebuggerController` in the extension background with tests
   around attach/detach, target validation, blocker detection, and no-focus
   activation options.
3. Add `BrowserSessionBroker` types for inspectable, debuggable, claimable, and
   claimed tabs.
4. Route `gemini_tabs list/status/claim/release` through the new broker first,
   falling back to HTTP/client lifecycle only for compatibility.
5. Route export job creation through `ClaimedDebuggableGeminiTab`.
6. Move progress and cancellation through the typed native message channel.
7. Demote heartbeat/SSE/long-poll to fallback, then remove it after installed
   builds have migrated.

## Testing

- Pure TypeScript type tests prove raw tabs, content-script clients, and
  heartbeat snapshots cannot be passed to export workflows.
- Unit tests cover Native Messaging envelope framing and error mapping.
- Background-controller tests cover `chrome.debugger` attach/detach and blocker
  classification with mocked Chrome APIs.
- Broker tests cover zero tabs, one valid tab, multiple ambiguous tabs,
  inactive tabs, blocked Google pages, old builds, busy tabs, and explicit
  activation.
- CLI tests prove default commands pass `wake=false`, `activate=false`, and
  `focus=false`.
- Real smoke tests run in non-intrusive mode first. They may create a new tab
  only when no Gemini tab exists and wake/open was explicitly requested.

## Open Implementation Risks

- Native Messaging requires a stable extension id and correctly installed native
  host manifests per browser family.
- MV3 service workers can suspend, so the broker must reconnect cleanly and make
  stale responses impossible.
- `chrome.debugger` may show browser permission prompts or attach conflicts in
  some browser variants. Those states must be first-class blocker codes.
- Dia/Chrome/Edge/Brave may differ in extension id, native host manifest paths,
  and debugger support.

## Success Criteria

- Export cannot compile against raw heartbeat/client state.
- With multiple Gemini tabs, export blocks until a claim identifies the target.
- The default test/export workflow never opens, focuses, or activates browser UI
  unless the caller explicitly opted into that behavior.
- The CLI can report exactly why it cannot proceed without asking the user to
  restart the browser as a generic fallback.
- A 50-chat export either completes with valid receipts or fails with a precise
  typed blocker. It must not silently lose progress or switch tabs.
