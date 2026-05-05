---
name: gemini-vault-sync
description: Use when the user asks to import, sync, resume, or find missing Gemini Web chats in an Obsidian vault without dumping huge chat lists into the conversation.
---

# Gemini Vault Sync

Use this skill for full-history import, incremental vault sync, missing-chat
repair, and resumed export jobs.

## Rules

- Do not list hundreds of chats in the chat transcript.
- Use background jobs and report files for long work.
- Prefer vault-local output: assets and Markdown should stay under the vault
  when `vaultDir` is known.
- If a job already exists, inspect it before starting another one.

## Main Flows

### Preferred CLI Flow

Use the bundled CLI for long sync/import jobs when shell access is available.
It talks directly to the local bridge, shows progress in the terminal, and
finishes with a machine-readable result.
In interactive Gemini CLI sessions, run every human-facing bundled CLI command
with `--tui` by default so the user sees the terminal UI in the agent window.
Add `--result-json` when you need to parse the final result while keeping TUI.
Use `--plain` only when shell output is captured/non-interactive or another
program explicitly needs stable non-TUI output. Do not use `--plain` just
because a command is short.
If the bridge is down, the CLI can start it in `bridge-only` mode before
calling `/agent/*`.
Do not run repeated `gemini_ready` or `gemini_tabs` calls before the CLI. They
pollute the user-visible transcript with JSON and duplicate readiness work the
CLI already performs.
Use `export missing <vaultDir>` for explicit missing-only imports, `sync
<vaultDir>` for incremental vault sync, and `export resume <reportFile>` when a
previous report should be resumed.

When the user just listed a small page of chats and then says "baixe essas" or
"exporte essas", do not use a fresh recent-history export. Reexport the exact
IDs that were shown. Prefer the saved manifest from the inventory snapshot:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" export selected --selection-file "$HOME/.gemini-md-export/selections/latest.json" --expected-count 10 --tui --timeout-ms 1800000
```

If the list was produced before `chats list --save-selection`, copy every
listed `chatId` explicitly with repeated `--chat-id` and still pass
`--expected-count N`; the CLI must fail before touching the bridge if the count
does not match.

Give the surrounding shell/tool a longer timeout than the CLI. If the shell
ended before a final `RESULT_JSON`, recover explicitly with
`job list --active --tui --result-json`, then
`job status <jobId> --tui --result-json` or
`job cancel <jobId> --wait --tui --result-json`. Do not start another export
until the previous job is terminal or cancelled.

Inside interactive Gemini CLI, use `--tui` by default. Only promise the visible
progress UI when the shell executor exposes a real TTY/PTY:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" sync "/path/to/vault" --tui
```

On Windows PowerShell:

```powershell
node "$env:USERPROFILE\.gemini\extensions\gemini-md-export\bin\gemini-md-export.mjs" sync "C:\path\to\vault" --tui
```

For agent-readable execution in an interactive terminal, prefer
`--tui --result-json` and parse only the final `RESULT_JSON` line. Use
`--plain` instead of `--tui` only for captured/non-interactive shells. Use
`--json` for final JSON only or `--jsonl` when another program needs progress
events.
If `--tui` is requested in a captured/non-interactive shell, the CLI falls back
to `--plain` and prints a warning; do not describe that as a visible progress
bar.
Use `--help` on the CLI or subcommand when you need the exact flags, output
formats, examples, or exit codes.

If the CLI reports multiple Gemini tabs, stay in CLI mode:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" tabs list --tui --result-json
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" tabs claim --index 1 --session gemini-downloads --tui --result-json
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" sync "/path/to/vault" --session gemini-downloads --tui
```

Do not inject a long-running CLI command with custom-command `!{...}` because
that copies all output into the prompt. Ask the agent to run the CLI through
the shell tool instead.

### MCP Role

Use MCP for control-plane checks, not for starting long sync/export jobs.

Check readiness:

```json
{ "tool": "gemini_ready", "arguments": { "action": "check", "diagnostic": true } }
```

If you accidentally call `gemini_export` for `sync`, `missing`, `recent`,
`reexport`, or `notebook`, it should return `code: "use_cli"` with an exact
`command`, `args`, and `cwd`. Run that CLI command directly through the shell.
Do not poll `gemini_job` unless a CLI/bridge response has already returned a
real `jobId`.

Use CLI `tabs list/claim` before the CLI sync/export when tab identity is
ambiguous. Use `gemini_tabs` only when shell access is unavailable, and pass
`intent: "tab_management"` when you do. Use
`gemini_support` when the bridge/extension is slow, stale, or disconnected.
Use `detail: "full"` only for root-cause debugging.

## Resume

If the previous response contains `reportFile`, run:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" export resume "/path/to/report.json" --tui
```

The exporter skips chats already completed in that report.

## Human Output

Report only:

- `jobId`
- progress/status
- counts
- `reportFile`
- next action

Do not paste full conversation inventories unless the user explicitly asks for
a small page of results.

For "quantos chats ao todo?", prefer:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" chats count --tui --result-json
```

Only report an exact total when `RESULT_JSON.totalKnown=true` or
`RESULT_JSON.countIsTotal=true`. Otherwise say "pelo menos N" and explain that
the end of the Gemini sidebar was not confirmed.

If the CLI returns a partial count, stop there. Do not call `gemini_chats`,
`gemini_ready`, or `gemini_tabs` as a fallback for the same count request; that
adds noisy JSON tool cards and can contend with the same browser tab.

If the CLI count/export fails with timeout, connection/readiness failure,
`extension_version_mismatch`, or `no_connected_clients`, stop there too. Report
the concise CLI failure. Do not activate diagnostics, call MCP fallback tools,
or kill processes unless the user explicitly asks for diagnostics after the
failure.

Do not run `cleanup stale-processes` before count/export. It creates noisy
process JSON and is diagnostic-only. After a count/export timeout, do not
suggest `kill <pid>`; report the timeout plainly and wait for the user's next
instruction.
Do not ask whether to run diagnostics immediately after that timeout. The next
step must come from the user explicitly.

For Dia, add `--browser dia` when the CLI does not auto-detect the profile.
Use `gemini-md-export doctor --browser dia --tui --result-json` only when the
user asks for diagnostics; it reports our extension, the Playwright Extension
when present, native host, bridge, and connected Gemini tabs.

MCP now enforces this: `gemini_chats` count/download returns a short
`use_cli_only` refusal, and `gemini_ready`/`gemini_tabs`/`gemini_chats` require
explicit diagnostic/control intent for browser-facing calls. Do not bypass that
guard.

If the CLI reports multiple Gemini tabs, stay in the CLI path:
`gemini-md-export tabs list --tui --result-json`, then
`gemini-md-export tabs claim --index <n> --tui --result-json`, then retry with
`--claim-id`. Do not switch to `gemini_tabs`.

Never summarize a `RESULT_JSON` as success when `status` is
`completed_with_errors`, `failed`, or `cancelled`, or when
`fullHistoryRequested` is true and `fullHistoryVerified` is false. Name failed
chats from `failures`, include the report path, and give the resume/next action.
