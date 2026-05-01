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

- Browser/extension health for small diagnostics only: call `gemini_ready`.
- Multiple tabs, wrong tab, tab claim, reload Gemini tabs, or open-if-missing
  for small diagnostics: call `gemini_tabs`.
- Small chat listing, current chat, open chat, one-off download, or an
  explicitly partial page: call `gemini_chats`. For "quantos chats ao todo",
  run the CLI `gemini-md-export chats count --plain` once. If it returns
  `totalKnown=false`, stop and answer "pelo menos N"; do not call
  `gemini_chats` as a fallback.
- Recent export, full import, missing-chat import, incremental sync, reexport,
  or notebook export: run the bundled CLI directly first. Do not preflight with
  repeated `gemini_ready`/`gemini_tabs`; the CLI owns readiness, browser wake,
  tab selection flags, progress, and final `RESULT_JSON`. If `gemini_export` is
  called, treat `code: "use_cli"` as an instruction to run its returned command.
- Background progress/cancel: call `gemini_job`.
- Export directory and extension cache: call `gemini_config`.
- Diagnostics, process inspection, cleanup, support bundle, flight recorder, or
  debug snapshot: call `gemini_support`.

## Skills

Use bundled Agent Skills for detailed workflows:

- `gemini-vault-sync`: full import, incremental sync, missing chats, resumed
  exports, and no giant chat lists in the conversation.
- `gemini-vault-repair`: contaminated raw exports, wrong chat content, wiki
  repair, staged reexports, backups, and preservation rules.
- `gemini-mcp-diagnostics`: slow/unstable bridge, stale extension, Windows port
  conflicts, process cleanup, and support bundles.
- `gemini-tabs-and-browser`: multiple Gemini tabs, tab claims, visual tab
  indicator, reloads, and opening Gemini Web when no tab is connected.

## Commands

- `/sync`: sync the known vault with Gemini Web; an argument overrides the
  vault path from context.
- `/exporter:repair-vault`: audit and repair contaminated raw exports/wiki
  cases.

## CLI/TUI Export UI

The extension also ships `bin/gemini-md-export.mjs`, a terminal UI wrapper over
the same local bridge used by MCP.

- The CLI can start the local bridge in `bridge-only` mode; CLI-started bridges
  exit after idle unless `--no-exit-when-idle` is set.
- The CLI owns browser wake for long jobs: it checks `/agent/ready` with
  `wakeBrowser=false`, opens Gemini Web in the configured Chromium browser when
  no tab is connected, then waits for the extension before starting the job.
- For a visible human progress UI inside Gemini CLI, run it through shell mode
  or `run_shell_command` with an interactive shell/pty. Only promise a TUI when
  the executor exposes a real TTY/PTY; captured shell output cannot animate the
  progress bar and the CLI will fall back to `--plain` with a warning:
  `node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" sync <vaultDir> --tui`
- On Windows, use:
  `node "$env:USERPROFILE\.gemini\extensions\gemini-md-export\bin\gemini-md-export.mjs" sync <vaultDir> --tui`
- For agent-readable execution, prefer `--plain`; it emits stable progress
  lines and a final `RESULT_JSON` block.
- To discover the contract, run `gemini-md-export --help`.
- CLI subcommands include `browser status`, `tabs list/claim/release/reload`,
  `chats count`, `export recent`, `export missing`, `export resume`,
  `export reexport`, `export notebook`, `job status`, `job cancel`,
  `export-dir get/set`, `cleanup stale-processes`, and `repair-vault`.
- For automation, use `--json` for final JSON only or `--jsonl` for progress
  events.
- Do not use custom-command shell injection for long sync jobs; it injects the
  output into the prompt. Ask the agent to run the CLI as a shell command
  instead.

## Guardrails

- Do not dump full history into the chat. For "all history", "sync", or
  "missing chats", use the CLI wrapper for long jobs. MCP `gemini_export`
  should return `code: "use_cli"` with the exact command instead of starting a
  hidden long-running job.
- Do not call `gemini_ready`/`gemini_tabs` repeatedly before long exports. If
  multiple tabs block the CLI, use `gemini-md-export tabs list --plain` and
  `gemini-md-export tabs claim --index <n> --plain`, then rerun sync/export with
  `--claim-id <claimId>`.
- Never report success when CLI `RESULT_JSON.status` is
  `completed_with_errors`, `failed`, or `cancelled`, or when
  `fullHistoryRequested=true` and `fullHistoryVerified=false`. Mention
  `failures`, `reportFile`, and the resume command/next action instead.
- Never answer "N chats ao todo" unless `totalKnown=true` or
  `countIsTotal=true`; otherwise answer "pelo menos N" and say the sidebar end
  was not confirmed.
- After a partial CLI count, do not retry with `gemini_chats`,
  `gemini_ready`, or `gemini_tabs`. That creates noisy JSON tool cards and can
  lock the same Gemini tab. Report the partial count instead.
- Do not ask for manual Chrome extension reload before trying
  `gemini_ready { "action": "status", "selfHeal": true, "allowReload": true }`,
  unless the loaded extension is too old to support self-heal.
- If multiple Gemini tabs are connected, use `gemini_tabs` to claim the intended
  tab before browser-dependent work.
- If no Gemini tab is connected, the CLI opens one for long jobs. For small MCP
  tab/chat operations, use `gemini_tabs { "action": "list",
  "openIfMissing": true }` or the narrow browser-dependent hook.
- Keep Markdown/assets inside the vault when `vaultDir` is known; avoid browser
  Downloads as the intended destination.
- Integrity beats speed: never save a chat if the DOM still belongs to a
  previous URL/chat ID.
- If media fails, report the warning honestly. Do not claim images were
  imported when `mediaFailureCount > 0` or a media warning produced no files.
- Use Brazilian Portuguese, plain language, and concrete next actions for user-facing
  errors.

For richer procedures, activate the matching bundled skill and follow it.
