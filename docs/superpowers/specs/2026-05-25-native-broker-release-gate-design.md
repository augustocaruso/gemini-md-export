# Native Broker Release Gate Design

Date: 2026-05-25
Status: Approved design, awaiting written-spec review

## Context

The current export gate can still lose browser control when the MCP bridge is
restarted and no Gemini content script reconnects. In that state, commands such
as `tabs reload` only have the HTTP bridge and heartbeat inventory available.
If there are zero connected content-script clients, the CLI cannot ask any
existing tab to reload without using manual UI interaction or opening another
tab.

That behavior is not acceptable for release testing. The product needs a
browser-control channel that survives content-script loss and can operate on
already-open tabs without clicking the screen.

The existing native debugger broker design from 2026-05-20 is the right
direction. This spec narrows it into the release-gate contract: Native Messaging
and the extension background are the official authority when available.

## Decision

Native broker is mandatory when available for tab management and release/export
gates.

The MCP and CLI must stop treating heartbeat/content-script state as the source
of truth for:

- `tabs list`
- `tabs claim`
- `tabs reload`
- `browser status`
- `export recent`
- `sync`

Heartbeat, SSE, long-poll, and the HTTP bridge can remain as compatibility
fallbacks and diagnostics, but release/export workflows must not silently fall
back to them when the native broker is expected and unavailable.

## Architecture

```text
CLI / MCP
  -> native broker IPC
    -> native host
      -> extension background
        -> chrome.tabs / chrome.debugger
          -> existing Gemini tabs
        -> content script only for page-local DOM extraction
```

The native host is transport and supervision. It does not invent browser facts.

The extension background broker is the browser authority. It uses `chrome.tabs`
for tab inventory, reload, grouping, and claim visuals. It uses
`chrome.debugger` when fresh page inspection is required.

The content script remains the DOM executor. It lists conversations, hydrates
chats, extracts Markdown, saves progress snapshots, and renders page-local UI.
It is not the authority for selecting an export tab.

## Core Contracts

The broker owns these capability transitions:

- `RawBrowserTab`: raw `chrome.tabs` record.
- `DebuggableGeminiTab`: browser tab validated as Gemini and inspectable.
- `ClaimedDebuggableGeminiTab`: debuggable Gemini tab with an active claim.

Export job creation must require a native lease equivalent to
`ClaimedDebuggableGeminiTab`. Raw content-script clients, heartbeat snapshots,
`clientId`, or unvalidated `tabId` values must not be accepted as export
authority.

My Activity can be claim-adjacent for date import and visual grouping, but it
must never become the export target.

## Command Behavior

### `tabs reload`

The CLI calls the native broker first. The extension background lists existing
Gemini tabs with `chrome.tabs` and reloads the target tabs directly.

This must work even when no content script is connected. If there are no
existing Gemini tabs, the command returns `no_existing_gemini_tabs`. It does not
open a new tab unless the caller explicitly passed wake/open intent.

### `tabs list`

The broker lists and classifies relevant tabs:

- ready Gemini tab
- blocked Google verification tab
- Google login tab
- My Activity helper tab
- uninspectable tab
- non-Gemini tab

The public CLI output should translate those states into plain next actions.
The detailed JSON can include broker codes and raw diagnostics.

### `tabs claim`

Claims are created and tracked by the background broker against `tabId` and
`windowId`. The visual marker uses tab groups or the existing badge/title
fallback.

If My Activity is used as a helper for dates, it can join the same visual group
as the Gemini claim. That grouping is visual affinity only; export authority
stays with the Gemini tab.

### `export recent --claim-id ...`

Before creating the job, MCP validates the claim through the native broker.
The broker confirms that the tab still points to Gemini, is controllable, is not
blocked by Google login/verification, and has an active claim.

The content script then executes page-local commands in the claimed tab.
Before each heavy per-conversation operation, the job either renews a short
native lease or revalidates the existing one.

### Bridge Restart

After the MCP/HTTP bridge restarts, the CLI can still talk to the native broker
through IPC. The broker can list, reload, and claim existing tabs because it
lives in the extension background, not in the content script.

This is the release-gate recovery path. It replaces manual clicking or opening
another tab.

## Error Model

Public errors must identify the failing layer and the next action.

- `native_broker_unavailable`: the MCP cannot talk to the native broker IPC.
- `native_broker_extension_disconnected`: native host is alive, but the
  extension background is not connected.
- `no_existing_gemini_tabs`: there is no open Gemini tab to list/reload/claim.
- `ambiguous_gemini_tabs`: more than one Gemini tab exists and no claim or
  explicit target was supplied.
- `claimed_tab_not_gemini`: the claim no longer points to a Gemini tab.
- `debugger_attach_denied`: the browser refused debugger inspection.
- `google_login_required`: the tab is in a Google login flow.
- `google_verification_required`: the tab is blocked by Google verification.

Generic messages such as "Verifique a extensao Chrome" are not enough for
release-gate failures.

## Native-First Policy

The default user-facing commands can remain tolerant while migration is
underway, but release/export gates are strict:

- If native broker is healthy, use it first.
- If native broker is configured but unhealthy, fail with a native broker error.
- Do not silently select a content-script client when native validation failed.
- Do not open, focus, or activate browser UI unless the caller explicitly opts
  in.
- HTTP heartbeat inventory is diagnostic unless a command explicitly runs in
  compatibility mode.

## Migration Plan

1. Make native broker status first-class in `doctor`, `browser status`, and
   `/healthz`.
2. Make `tabs list`, `tabs claim`, and `tabs reload` use native broker as the
   primary path.
3. Add native broker reload support independent of content-script clients.
4. Add explicit native lease validation before `export recent`, `export
   missing`, and `sync` job creation.
5. Revalidate the lease before heavy per-conversation browser operations.
6. Keep HTTP/content-script fallback only under an explicit compatibility flag.
7. Run the 30-chat and then 50-chat release gates with no UI clicks and no new
   tabs unless `--wake` was requested.

## Testing

Unit tests:

- Native broker lists tabs without content-script clients.
- Native broker reloads existing Gemini tabs through `chrome.tabs.reload`.
- My Activity is rejected as an export target.
- My Activity can join the Gemini claim visual group for date import.
- Multiple Gemini tabs return `ambiguous_gemini_tabs`.
- A claim whose URL changed away from Gemini is rejected.
- Native broker unavailable returns a typed blocker, not a generic extension
  error.

MCP/CLI contract tests:

- `tabs reload` does not depend on `getLiveClients()`.
- `browser status --allow-reload` uses native broker before HTTP fallback.
- `export recent` requires a native lease in release mode.
- `export recent --claim-id` cannot fall through to an active My Activity tab.
- Commands keep `wake=false`, `activate=false`, and `focus=false` by default.

Real smoke:

1. Open Gemini tabs normally in the user's real browser profile.
2. Kill/restart the MCP bridge.
3. Run `tabs reload --allow-reload` without clicking the screen.
4. Run `tabs list`.
5. Run `tabs claim`.
6. Export 30 chats with Takeout/date import enabled.
7. Verify exported files against the latest Takeout evidence.

## Success Criteria

- The CLI can reload existing Gemini tabs after bridge restart without a
  content-script heartbeat.
- Release export cannot start without a validated native Gemini tab lease.
- The active My Activity tab cannot become the export target.
- Error messages identify native host, extension background, tab inventory,
  debugger, login, or verification blockers precisely.
- A 30-chat export gate completes or fails with a typed blocker and preserved
  receipts.
- The implementation does not require AppleScript, manual clicks, or opening
  extra tabs for the normal recovery path.

