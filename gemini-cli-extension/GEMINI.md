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
or explicit `intent`; ask for `detail: "full"` only while debugging.

## Router

- Browser/extension health: `gemini_ready` with `diagnostic: true`.
- Tabs/claim/reload diagnostics: `gemini_tabs` with
  `intent: "tab_management"`.
- Lightweight chat inventory: use `gemini-chat-inventory` for count, short
  paginated lists, and title search. For "quantos chats ao todo", run
  `gemini-md-export chats count --tui --result-json` once. If
  `totalKnown=false`, stop at "pelo menos N".
- Small read-only chat page/current/open: `gemini_chats` with
  `intent: "small_page"` or `diagnostic: true`. Download/export remains CLI-only.
- Recent export, full import, missing-chat import, sync, reexport, or notebook:
  run the bundled CLI directly. In interactive Gemini CLI sessions, run the
  bundled CLI with `--tui` by default for every human-facing command, not only
  long jobs. Add `--result-json` when you need a machine-readable final line
  while keeping the TUI. Use `--plain` only when output is captured or
  non-interactive. Do not preflight with repeated `gemini_ready`/`gemini_tabs`;
  the CLI owns readiness, tabs, progress, and final result. If `gemini_export`
  returns `code: "use_cli"`, run its command with the same TUI/plain rule.
- Follow-up "baixe/exporte essas" after a chat list means the exact listed
  `chatId`s. Use a Playwright-style loop: snapshot/list first, act by stable
  refs later. Run
  `gemini-md-export chats list --limit 10 --save-selection --tui --result-json`, then
  `gemini-md-export export selected --selection-file <file> --expected-count 10 --tui`
  with shell timeout > CLI timeout. If an old list has no selection file,
  repeated `--chat-id` is allowed only with every listed ID plus
  `--expected-count N`. If the shell died before final `RESULT_JSON`, run
  `gemini-md-export job list --active --tui --result-json`, then status/cancel
  before retry.
- Background progress/cancel: call `gemini_job`.
- Export directory and extension cache: call `gemini_config`.
- Diagnostics/process cleanup/support bundle: `gemini_support`.
- Telemetry status/preview/retry/opt-out: `/exporter:telemetry` or
  `gemini-md-export telemetry`.

## Skills

Use bundled Agent Skills for detailed workflows: `gemini-chat-inventory`,
`gemini-vault-sync`, `gemini-vault-repair`, `gemini-mcp-diagnostics`, and
`gemini-tabs-and-browser`.

## Commands

- `/sync`: sync the known vault with Gemini Web; an argument overrides the
  vault path from context.
- `/exporter:diagnose-page`: diagnose artifact iframes.
- `/exporter:capture-artifacts`: capture artifact HTML files plus manifest.
- `/exporter:repair-vault`: audit and repair contaminated raw exports/wiki
  cases.
- `/exporter:telemetry`: telemetry status, preview, retry and opt-out.

## CLI/TUI Export UI

The extension ships `bin/gemini-md-export.mjs`, a terminal wrapper over the
same bridge. It can start `bridge-only`, wake the browser, and exit idle
bridges unless `--no-exit-when-idle` is set.

- Every human-facing bundled CLI command should use `--tui` by default in
  interactive Gemini CLI sessions. Visible progress needs a real TTY/PTY.
  Captured shell output falls back to `--plain` with a warning:
  `node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" sync <vaultDir> --tui`
- Add `--result-json` to `--tui` when the agent needs to parse a final result.
  Use `--plain` only for captured/non-interactive execution. Use
  `gemini-md-export --help` for flags.
- CLI subcommands include `browser status`, `diagnose page`, `tabs`,
  `chats count`, `chats list`, `export ...`, `job ...`, `export-dir`, `cleanup`,
  `repair-vault`, and `telemetry enable/status/preview/send/disable`.
- Automation: `--json` for final JSON only, `--jsonl` for events. Avoid
  custom-command shell injection for long sync jobs.

## Guardrails

- Do not dump full history into chat. For "all history", "sync", or "missing
  chats", use the CLI. MCP `gemini_export` returns `code: "use_cli"` with the
  exact command instead of starting a hidden job.
- Do not call `gemini_ready`/`gemini_tabs` repeatedly before long exports. For
  multiple tabs, use `gemini-md-export tabs list --tui --result-json`, then
  `tabs claim --index <n> --tui --result-json`, and rerun with the
  claim/session.
- MCP browser tools intentionally refuse normal count/export paths unless the
  call has explicit diagnostic/control intent. Treat that refusal as final.
- If a CLI command reports multiple Gemini tabs, keep using CLI tab commands.
  Do not switch to `gemini_tabs`; the user explicitly wants to avoid MCP JSON
  cards.
- Do not run `kill`, reload, cleanup, or a new export after interruption before
  checking `gemini-md-export job list --active --tui --result-json` and using
  `job status ... --tui --result-json` or `job cancel --wait --tui --result-json`.
- Never report success when `RESULT_JSON.status` is `completed_with_errors`,
  `failed`, or `cancelled`, or when full-history was not verified. Mention
  `failures`, `reportFile`, and resume.
- Never answer "N chats ao todo" unless `totalKnown=true` or
  `countIsTotal=true`; otherwise answer "pelo menos N" and say the sidebar end
  was not confirmed.
- After partial counts or CLI failures, do not retry via MCP fallback tools.
  Report the concise CLI result. Diagnostics only happen if the user asks next.
- Never run `cleanup stale-processes` before normal count/export. Cleanup is
  diagnostic-only; do not recommend `kill <pid>` after CLI timeouts.
- Do not ask for manual extension reload before trying self-heal with
  `gemini_ready { "action": "status", "diagnostic": true, "selfHeal": true, "allowReload": true }`.
- If multiple Gemini tabs are connected, prefer CLI tab commands for count/export.
  For MCP diagnostics, use `gemini_tabs` with `intent: "tab_management"`.
- Dia is a first-class browser target. Use `--browser dia` when auto-detection
  picks another profile. `doctor --browser dia --tui --result-json` reports our
  extension, Playwright Extension when installed, native host, bridge, and
  connected tabs.
- Keep Markdown/assets inside the vault when `vaultDir` is known.
- Integrity beats speed: never save if DOM belongs to another chat ID.
- Report media warnings honestly.
- Use Brazilian Portuguese and concrete next actions.

For richer procedures, activate the matching bundled skill.
