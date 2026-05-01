# Gemini Markdown Export

This extension exports Gemini Web conversations to Markdown through the visible
Gemini DOM, a local MCP bridge, and the companion Chrome/Edge extension. It does
not use private Gemini APIs, cookies, account tokens, `chrome.debugger`,
screenshots, or capture fallbacks.

## Public MCP Tools

Only these MCP tools are public:

- `gemini_ready`
- `gemini_tabs`
- `gemini_chats`
- `gemini_export`
- `gemini_job`
- `gemini_config`
- `gemini_support`

Old `gemini_*` tool names were removed from `tools/list` in v0.5.0. If one is
called directly, use the returned `code: "tool_renamed"` replacement command.

Default tool output is compact. Ask for `detail: "full"` only while debugging.

## Router

- Browser/extension health: call `gemini_ready`.
- Multiple tabs, wrong tab, tab claim, reload Gemini tabs, or open-if-missing:
  call `gemini_tabs`.
- Small chat listing, current chat, open chat, or one-off download:
  call `gemini_chats`.
- Recent export, full import, missing-chat import, incremental sync, reexport,
  or notebook export: call `gemini_export`.
- Background progress/cancel: call `gemini_job`.
- Export directory and extension cache: call `gemini_config`.
- Diagnostics, process inspection, cleanup, support bundle, flight recorder, or
  debug snapshot: call `gemini_support`.

## Skills

Use bundled Gemini CLI Agent Skills for detailed workflows instead of loading
long playbooks into this context:

- `gemini-vault-sync`: full import, incremental sync, missing chats, resumed
  exports, and no giant chat lists in the conversation.
- `gemini-vault-repair`: contaminated raw exports, wrong chat content, wiki
  repair, staged reexports, backups, and preservation rules.
- `gemini-mcp-diagnostics`: slow/unstable bridge, stale extension, Windows port
  conflicts, process cleanup, and support bundles.
- `gemini-tabs-and-browser`: multiple Gemini tabs, tab claims, visual tab
  indicator, reloads, and opening Gemini Web when no tab is connected.

## Commands

- `/sync`: sync the known vault with Gemini Web. With no argument, use the
  vault path already present in the active/main GEMINI.md context. With an
  argument, treat it as the vault path override.
- `/exporter:repair-vault`: audit and repair contaminated raw exports/wiki
  cases.

## Guardrails

- Do not dump full history into the chat. For "all history", "sync", or
  "missing chats", start a `gemini_export` background job and poll
  `gemini_job`.
- Do not ask for manual Chrome extension reload before trying
  `gemini_ready { "action": "status", "selfHeal": true, "allowReload": true }`,
  unless the loaded extension is too old to support self-heal.
- If multiple Gemini tabs are connected, use `gemini_tabs` to claim the intended
  tab before browser-dependent work.
- If no Gemini tab is connected, `gemini_tabs { "action": "list",
  "openIfMissing": true }` or browser-dependent hooks can open one.
- Keep Markdown/assets inside the vault when `vaultDir` is known; avoid browser
  Downloads as the intended destination.
- Integrity beats speed: never save a chat if the DOM still belongs to a
  previous URL/chat ID.
- If media fails, report the warning honestly. Do not claim images were
  imported when `mediaFailureCount > 0` or a media warning produced no files.
- Use Brazilian Portuguese, plain language, and concrete next actions for user-facing
  errors.

## Common Calls

Check readiness:

```json
{ "action": "check" }
```

Full status/self-heal:

```json
{ "action": "status", "selfHeal": true, "allowReload": true }
```

List or claim tabs:

```json
{ "action": "list", "openIfMissing": true }
```

```json
{ "action": "claim", "index": 1, "label": "GME", "force": true }
```

Sync a vault:

```json
{ "action": "sync", "vaultDir": "/path/to/vault", "outputDir": "/path/to/vault" }
```

Poll a job:

```json
{ "action": "status", "jobId": "<jobId>" }
```

For richer procedures, activate the matching bundled skill and follow it.
