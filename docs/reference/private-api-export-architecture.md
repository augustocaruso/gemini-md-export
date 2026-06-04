# Private API Export Architecture

Status: release-prep reference.

## Mental model

The product has one export contract and multiple transports.

- Core contract: `ChatSnapshot` plus assets, evidence and canonical Markdown rendering.
- Browser-background transport: extension service worker fetches Gemini private endpoints with the logged-in browser session. This is the preferred adapter when a Gemini tab is connected.
- Private API sidecar transport: Python subprocess around `gemini_webapi`, used when there is no usable browser tab/session or when the CLI is running headless.
- DOM transport: explicit fallback only. Public workflows must not silently downgrade to DOM scraping.
- Vault query transport: MarkdownDB (`mddb`) indexes the vault for metadata and local asset checks.

The core must not import `gemini_webapi`, `mddb`, cookies or browser APIs directly. Those stay behind adapters.

## Metadata and dates

For private exports, canonical dates come from the private API path:

- `python/gemini_md_export/gemini_webapi_adapter.py` reads the chat through `gemini_webapi`.
- The sidecar also calls the raw `READ_CHAT` RPC to recover per-turn timestamps.
- `src/mcp/gemini-webapi-python-adapter.ts` maps those dates into `ChatSnapshot.metadata.dateCreated` and `dateLastMessage`.
- `src/core/chat-snapshot-markdown.ts` renders those fields into frontmatter.

`fix-vault` still runs metadata validation/backfill after repair. That is deliberate: repaired files should already have private API dates, and the metadata step verifies/canonicalizes the vault after the write.

## Vault query

Vault metadata and missing local assets should be queried through MarkdownDB, not through handwritten directory scanners.

- Dependency: `mddb@^0.9.5`.
- Security override: `sqlite3@6.0.1`, matching the Medical Notes Workbench packaging pattern.
- Adapter: `src/mcp/markdown-db-vault-adapter.ts`.
- Current use: `fix-vault` asks this adapter for indexed Gemini export records and missing `assets/<chatId>/...` links before selecting private API repair targets.

MarkdownDB is a derived cache. The Markdown files remain the source of truth.

## CLI, MCP and extension

CLI, MCP and the extension modal now share the same selected-export job contract. The extension button/modal is a thin launcher for `/agent/reexport-chats`; the MCP job owns writing, progress, reports and asset handling.

Current behavior:

- `export selected` and direct `reexport` use private read by default for explicit chat IDs.
- Adapter order is browser-background first, then Python sidecar.
- MCP export workflows try private read first when a conversation has a proven chat ID.
- DOM fallback requires explicit opt-in (`allowDomFallback: true` or an intentional browser export path).
- The visible extension modal calls the MCP job and consumes the same job progress viewmodel broadcast used by CLI/MCP.

Release implication: feature parity now depends on validating the shared job path in real Dia/Gemini sessions, not on maintaining separate extension logic.

## Auth

There are two auth transports:

- Python sidecar: accepts `cookiesJson` when provided; otherwise `gemini_webapi[browser]` attempts local browser cookie/profile import.
- Extension background: uses the active browser session implicitly through authenticated fetches.

Missing product polish:

- a polished final-user label for "verificar sessão" in installers/docs;
- a supported cookie capture/check flow for direct CLI use when local browser import fails.

Implemented session checks:

- Extension/background: `private-api-session-status`, using the browser session.
- Python sidecar: `session_status`, using explicit cookies or local browser import.
- MCP support: `gemini_support { action: "session_status" }`.

## Inventory

Known chat IDs can be exported privately without browsing a conversation.

Inventory is private-first:

- `selected` and direct `reexport`: private-first because chat IDs are explicit.
- `fix-vault`: uses MarkdownDB for vault inventory and private API for repair.
- `recent`, `missing`, `sync`: call private `LIST_CHATS` through browser-background first, then Python sidecar.

DOM/sidebar discovery is now fallback-only and must be explicit. Private `LIST_CHATS` currently treats a full page smaller than the requested limit as total-known; when the private endpoint returns exactly the requested limit, the count remains partial until private pagination is implemented.
