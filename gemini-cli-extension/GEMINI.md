# Gemini Markdown Export

Exports Gemini Web conversations to Markdown through the visible DOM, local MCP
bridge, and Chrome/Edge extension. No private APIs, cookies, tokens,
`chrome.debugger`, screenshots, or capture fallbacks.

## Public MCP Tools

Only these MCP tools are public:

- `gemini_ready`
- `gemini_tabs`
- `gemini_chats`
- `gemini_export`
- `gemini_job`
- `gemini_config`
- `gemini_support`

Old `gemini_*` names return `code: "tool_renamed"` with the replacement.

Default output is compact. Browser tools are opt-in: pass `diagnostic: true`
or explicit `intent` for deliberate diagnostics/control. Ask for
`detail: "full"` only while debugging.

## Router

- Browser/extension health: `gemini_ready` with `diagnostic: true`.
- Tabs/claim/reload diagnostics: `gemini_tabs` with
  `intent: "tab_management"`.
- Lightweight chat inventory: use `gemini-chat-inventory` for count, short
  paginated lists, and title search. For "quantos chats ao todo", run
  `gemini-md-export chats count --plain` once. If `totalKnown=false`, stop at
  "pelo menos N".
- Small read-only chat page/current/open: `gemini_chats` with
  `intent: "small_page"` or `diagnostic: true`. Download/export remains CLI-only.
- Recent export, full import, missing-chat import, sync, reexport, or notebook:
  run the bundled CLI directly first. Do not preflight with repeated
  `gemini_ready`/`gemini_tabs`; the CLI owns readiness, browser wake, tab flags,
  progress, and final `RESULT_JSON`. If `gemini_export` is called, treat
  `code: "use_cli"` as an instruction to run its returned command.
- Background progress/cancel: call `gemini_job`.
- Export directory and extension cache: call `gemini_config`.
- Diagnostics/process cleanup/support bundle/flight recorder: `gemini_support`.
- Telemetry may be auto-enabled in private builds via
  `telemetry.defaults.json`; status/preview/retry/opt-out: `/exporter:telemetry`
  or `gemini-md-export telemetry`.

## Skills

Use bundled Agent Skills for detailed workflows: `gemini-chat-inventory`,
`gemini-vault-sync`, `gemini-vault-repair`, `gemini-mcp-diagnostics`, and
`gemini-tabs-and-browser`.

## Commands

- `/sync`: sync the known vault with Gemini Web; an argument overrides the
  vault path from context.
- `/exporter:diagnose-page`: diagnose artifact iframes without export/bypass.
- `/exporter:capture-artifacts`: capture artifact HTML files plus an Obsidian
  manifest; never paste captured HTML.
- `/exporter:repair-vault`: audit and repair contaminated raw exports/wiki
  cases.
- `/exporter:telemetry`: telemetry status, preview, retry and opt-out.

## CLI/TUI Export UI

The extension ships `bin/gemini-md-export.mjs`, a terminal UI wrapper over the
same bridge. The CLI can start `bridge-only`, owns browser wake for long jobs,
and exits idle bridges unless `--no-exit-when-idle` is set.

- For a visible human progress UI inside Gemini CLI, run it through shell mode
  or `run_shell_command` with a real TTY/PTY. Captured shell output cannot
  animate; the CLI falls back to `--plain` with a warning:
  `node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" sync <vaultDir> --tui`
- For agents, prefer `--plain`; it emits progress lines and final
  `RESULT_JSON`. Use `gemini-md-export --help` for flags.
- CLI subcommands include `browser status`, `diagnose page`, `tabs`,
  `chats count`, `export ...`, `job ...`, `export-dir`, `cleanup`,
  `repair-vault`, and `telemetry enable/status/preview/send/disable`.
- Automation: `--json` for final JSON only, `--jsonl` for events. Do not use
  custom-command shell injection for long sync jobs.

## Guardrails

- Do not dump full history into chat. For "all history", "sync", or "missing
  chats", use the CLI. MCP `gemini_export` returns `code: "use_cli"` with the
  exact command instead of starting a hidden job.
- Do not call `gemini_ready`/`gemini_tabs` repeatedly before long exports. If
  multiple tabs block the CLI, use `gemini-md-export tabs list --plain`, then
  `tabs claim --index <n> --plain`, and rerun with `--claim-id <claimId>`.
- MCP `gemini_ready`, `gemini_tabs`, and `gemini_chats` intentionally refuse
  normal user-facing count/export paths unless the call carries explicit
  diagnostic/control intent. Treat that refusal as final; do not work around it
  with another MCP tool.
- If a CLI command reports multiple Gemini tabs, keep using CLI tab commands.
  Do not switch to `gemini_tabs`; the user explicitly wants to avoid MCP JSON
  cards.
- Never report success when CLI `RESULT_JSON.status` is `completed_with_errors`,
  `failed`, or `cancelled`, or when `fullHistoryRequested=true` and
  `fullHistoryVerified=false`. Mention `failures`, `reportFile`, and resume.
- Never answer "N chats ao todo" unless `totalKnown=true` or
  `countIsTotal=true`; otherwise answer "pelo menos N" and say the sidebar end
  was not confirmed.
- After a partial CLI count, do not retry with `gemini_chats`,
  `gemini_ready`, or `gemini_tabs`. That creates noisy JSON tool cards and can
  lock the same Gemini tab. Report the partial count instead.
- After a failed CLI count/export caused by timeout, connection, readiness, or
  `extension_version_mismatch`, stop and report the short CLI failure. Do not
  activate diagnostics, call `gemini_ready`/`gemini_tabs`/`gemini_support`, or
  kill processes unless the user explicitly asks for diagnostics after that
  failure.
- Never run `cleanup stale-processes` before a normal count/export attempt.
  Cleanup is diagnostic-only and is not a recovery step for "quantos chats" or
  "baixe conversas". Do not recommend `kill <pid>` as a next step after a CLI
  timeout.
- After a CLI timeout, do not ask "quer que eu rode diagnostico agora?". Stop
  with the concise failure; diagnostics only happen if the user's next message
  explicitly asks for them.
- Do not ask for manual Chrome extension reload before trying
  `gemini_ready { "action": "status", "diagnostic": true, "selfHeal": true, "allowReload": true }`,
  unless the loaded extension is too old to support self-heal.
- If multiple Gemini tabs are connected, prefer CLI tab commands for
  count/export. For explicit MCP diagnostics, use `gemini_tabs` with
  `intent: "tab_management"` to claim the intended tab.
- If no Gemini tab is connected, the CLI opens one for long jobs. For small MCP
  diagnostics, use `gemini_tabs { "action": "list", "intent": "tab_management", "openIfMissing": true }`.
- Keep Markdown/assets inside the vault when `vaultDir` is known; avoid browser
  Downloads as the intended destination.
- Integrity beats speed: never save if the DOM belongs to another URL/chat ID.
- If media fails, report the warning honestly. Do not claim images were
  imported when `mediaFailureCount > 0` or a media warning produced no files.
- Use Brazilian Portuguese, plain language, and concrete next actions for user-facing
  errors.

For richer procedures, activate the matching bundled skill.
