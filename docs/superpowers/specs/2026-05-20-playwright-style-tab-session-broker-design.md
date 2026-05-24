# Playwright-Style Tab Session Broker Design

Date: 2026-05-20
Status: Draft for user review

## Context

The exporter currently has the right pieces, but they are not strict enough as a contract. The browser extension sends heartbeats, snapshots, command results, tab identity, active-tab state, build information, and claim state. The MCP server uses those facts to choose a tab and run exports. In practice, the same word, "stale", has been covering several different states: the extension may be connected but not hydrated, the page may be ready but the command channel may be stuck, or an old build may still be alive.

The user-visible failure is that an export can appear to target a usable tab while the underlying client is not actually safe to use. The specific unacceptable case is claiming or exporting from a non-active, non-hydrated, old-build, or command-unready tab. This should be impossible by TypeScript contract, not merely checked by scattered runtime conditionals.

The design is inspired by Playwright MCP extension mode: keep a simple public interface, but put a strong local driver underneath it. Playwright's extension mode connects to existing browser tabs with the user's real session and forces explicit tab selection before automation. We should copy that model conceptually: the MCP driver owns tab/session readiness; tools receive only validated capabilities.

## Goals

- Make it impossible at compile time for browser-dependent export flows to accept a raw or inactive tab client.
- Split "stale" into precise lifecycle states with actionable messages.
- Keep public tools simple: `gemini_ready`, `gemini_tabs`, `gemini_chats`, `gemini_export`, `gemini_job`, `gemini_config`, `gemini_support`.
- Preserve the MV3 extension + local MCP architecture. This design does not replace the exporter with Playwright/CDP.
- Keep WebSocket or persistent ports possible as a later transport improvement, but do not depend on them for the correctness contract.
- Share the same lifecycle contract across Chat Export, My Activity, and future Takeout-related browser clients where relevant.

## Non-Goals

- Do not add Playwright as the production exporter runtime.
- Do not expand the public tool surface.
- Do not remove existing SSE/heartbeat/long-poll fallback in this phase.
- Do not redesign the modal UI, progress dock visuals, or top-bar button.
- Do not make inactive-tab export possible through an escape hatch.

## Architecture

Introduce a pure TypeScript lifecycle module at `src/mcp/client-lifecycle.ts` that converts raw bridge clients into a discriminated union. Raw clients stay as diagnostics only. Runtime operations receive narrowed capability types.

The core lifecycle states are:

- `disconnected`: no browser client is known.
- `transport_connected`: the extension/client exists but has not sent enough page state.
- `extension_mismatch`: version, protocol, or build stamp does not match the expected runtime.
- `warming_up`: the client is freshly connected and within the page-hydration grace window.
- `page_unready`: the client is alive, but the Gemini page is missing, not Gemini, or not hydrated enough.
- `command_unready`: page state is present, but command delivery is not currently usable.
- `busy`: a heavy operation is already running in that tab.
- `claimable`: active Gemini tab with fresh page heartbeat, matching extension build, command channel ready, and no conflicting operation.
- `claimed_ready`: same as `claimable`, plus a valid claim for the current MCP session.
- `dead`: the client exceeded the liveness TTL.

The important output types are branded:

```ts
type ClaimableGeminiTab = GeminiClientSnapshot & Brand<'ClaimableGeminiTab'>;
type ClaimedReadyGeminiTab = ClaimableGeminiTab & Brand<'ClaimedReadyGeminiTab'>;
```

Only lifecycle functions may create these branded values. Export/list/open-chat operations that require a browser tab must accept one of these branded types instead of `GeminiClientSnapshot`.

## Data Flow

1. The content script continues sending heartbeat, snapshot, build/protocol, tab identity, active-tab state, command readiness, claim state, and busy state.
2. The MCP server stores raw client records exactly as it does today.
3. Before any browser-dependent tool chooses a tab, it calls the lifecycle evaluator.
4. Selection functions return either a branded tab capability or a structured rejection.
5. Public tools translate rejection codes into Portuguese messages and next actions.
6. Export jobs store the branded tab/session identity at job creation and revalidate before each heavy operation.

No export function should search the global client map directly. If a function needs a tab, it receives a lease/capability from the broker.

## Session And Claim Model

The MCP session owns a claim. A claim is valid only when the tab remains active, fresh, same build, command-ready, and associated with the same session or explicit claim ID.

Claiming an inactive tab returns a structured error. It does not activate a random tab silently. If activation is requested by the caller, the activation step must produce a new lifecycle evaluation before claim is allowed.

The visual tab-group/badge behavior remains the browser-level signal for the selected tab. There should be no in-page overlay for claim state.

## Error Handling

The current generic "stale" bucket becomes specific codes:

- `no_connected_client`
- `warming_up`
- `extension_version_mismatch`
- `extension_protocol_mismatch`
- `extension_build_mismatch`
- `inactive_tab`
- `page_not_gemini`
- `page_not_hydrated`
- `command_channel_unready`
- `tab_operation_in_progress`
- `claim_missing`
- `claim_conflict`
- `client_dead`

Each code maps to:

- a short internal reason,
- a Portuguese user/operator message,
- a next action,
- whether automatic retry is allowed,
- whether manual browser reload is appropriate.

## Testing

Add tests at three levels:

- Pure lifecycle table tests: raw client inputs produce the expected lifecycle state or branded capability.
- Type contract tests: browser-dependent functions reject raw client snapshots at compile time.
- MCP integration tests: `tabs list`, `tabs claim`, `gemini_ready status`, and export job creation use the broker and do not bypass readiness.

Existing command-channel and tab-selection tests should be updated to import the lifecycle module instead of duplicating readiness logic.

The real-browser smoke for a 50-chat export should be allowed to fail only with a structured readiness or validation error. It must not silently select one partial client, lose progress, or call the run successful when fewer chats were exportable.

## Migration Plan

1. Add the lifecycle module and tests without changing behavior.
2. Replace tab-selection helpers with lifecycle-derived branded types.
3. Replace export job creation and browser-dependent commands to require `ClaimedReadyGeminiTab`.
4. Update diagnostics so `/agent/clients`, `gemini_ready`, and `gemini_tabs` show lifecycle state instead of a single stale flag.
5. Run targeted unit tests, TypeScript checks, build, bridge smoke, and then the real 50-chat export test.

## Later Transport Upgrade

After the lifecycle contract is enforced, a WebSocket or Chrome runtime persistent-port transport can replace or supplement heartbeat/SSE/long-poll.

That upgrade should improve speed and disconnect detection, but it should not be responsible for correctness. Correctness belongs to the lifecycle broker and branded capabilities.
