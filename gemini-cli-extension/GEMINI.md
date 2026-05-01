# Gemini Markdown Export

Use the `gemini-md-export` extension MCP when the user wants to inspect or export
Gemini web chats from the local browser session.

Operational guidance:

- Prefer listing recent chats before attempting a download.
- Prefer the recent-chats fast path first; only force a refresh when the user
  explicitly needs the sidebar refreshed.
- For large recent-chat lists, never request or print hundreds of chats in one
  tool call. Page `gemini_list_recent_chats` with `limit` 25-50 and increasing
  `offset` values, then continue from `pagination.nextOffset` until
  `pagination.reachedEnd` is true, `pagination.canLoadMore` is false, or a page
  returns no conversations.
- When the user asks to import/sync the whole Gemini chat history into an
  Obsidian vault, the required workflow is a reconciliation, not a blind export:
  call `gemini_export_missing_chats` with `vaultDir` pointing at the vault/folder
  to scan. That job loads the entire reachable Gemini web sidebar, scans the
  vault recursively for raw Gemini Markdown exports (`chat_id`, `source:
  gemini-web`, raw turn headings, or `<chatId>.md` filenames), computes
  `webConversationCount - existingVaultCount = missingCount`, and downloads only
  the missing chats. Tell the user the job ID and poll
  `gemini_export_job_status` until it finishes. If the user wants the missing
  files in a specific raw-export folder, pass `outputDir`; otherwise the MCP
  saves them under `vaultDir`, so the Markdown and `assets/<chatId>/...` stay
  inside the vault instead of falling back to Downloads. Do not emulate this by
  listing pages in chat or looping over `gemini_download_chat`.
- When the user asks for a blind full export outside a vault reconciliation, do
  not list the chats first. Start `gemini_export_recent_chats`, tell the user the
  job ID, and poll `gemini_export_job_status` until the job finishes. The job
  writes Markdown files and an incremental JSON report locally. If the user asks
  to stop the import/export, call `gemini_export_job_cancel`; already written
  Markdown files and the report are preserved. Do not pass `maxChats` unless the
  user explicitly asks for a partial export; with no `maxChats`, the MCP loads
  until the sidebar reaches its real end. Blind whole-history export is still
  incremental: by default it skips non-empty `<chatId>.md` files that already
  exist in the output directory and records them as
  `skippedExisting`/`skippedCount` in the report. Only pass `skipExisting=false`
  when the user explicitly asks to overwrite/re-export already saved chats. If
  individual chats fail because the extension could not prove it reached the
  beginning of the conversation, report those failures from the job status
  instead of treating them as completed exports.
- When summarizing an export job, distinguish "100% of the requested partial
  batch" from "100% of the user's full Gemini history". Only call the full
  history complete when `fullHistoryRequested=true`, `fullHistoryVerified=true`,
  `reachedEnd=true`, and `truncated=false`. If `scope=partial` or `maxChats` /
  `limit` was provided, say it was a partial export.
- When the user asks to repair an Obsidian vault after wrong Gemini chat
  content was saved under the wrong `chat_id`, use the bundled subagent
  `gemini-vault-repair` or the command `/exporter:repair-vault <vault path>`.
  Prefer `scripts/vault-repair.mjs`, which audits Markdown exports, follows each
  raw export's `chat_id`/Gemini link by reexporting that exact chat to a staging
  directory, compares bodies, creates backups, and writes preliminary/final
  reports. YAML/frontmatter-only differences are not content divergence; raw
  repairs must preserve the original frontmatter byte-for-byte and replace only
  the Markdown body. For more than a couple of raw exports, the runner starts
  `gemini_reexport_chats` with the explicit chatId list and polls
  `gemini_export_job_status`; do not loop over `gemini_download_chat` for dozens
  of items, especially on Windows. The local audit only builds the queue and
  highlights suspects; direct reexport is the authoritative check. If a bad chat
  has already become a wiki/Obsidian note, the
  wiki note is also repair scope: preserve it, back it up, create a
  `wiki-review` case file, and require a deliberate regenerate/merge strategy
  from the corrected raw export instead of overwriting it automatically. The
  repair subagent is intentionally a Flash operational checker: it emits
  preliminary and final reports, and when a wiki needs rewriting it asks the
  parent agent to call the appropriate note-writing/knowledge-architect subagent
  with the case file and staged corrected raw export. Any rewritten or
  consolidated wiki note must preserve provenance at the end of the note: append
  or update a dedicated Gemini source section containing the deduplicated union
  of every `https://gemini.google.com/app/<chatId>` link that inspired the final
  note, not only the latest chat.
- When the user asks to update this exporter inside Gemini CLI, use Gemini CLI's
  built-in extension update flow instead of an MCP tool: tell the user to run
  `gemini extensions update gemini-md-export` or `gemini extensions update --all`
  from a fresh terminal, then restart Gemini CLI. The update also downloads the
  companion unpacked Chrome/Edge extension files into `browser-extension/`.
  After this self-healing version, browser-dependent MCP tools verify the
  browser extension version/protocol and ask it to reload itself when it is
  stale; manual reload in `chrome://extensions` is only the fallback for first
  migration, manifest/permission changes, or the wrong browser profile.
- If no Gemini tab is connected when a browser-dependent MCP tool runs, the MCP
  should try to open `https://gemini.google.com/app` automatically in the
  configured Chromium browser. Prefer fixing `GEMINI_MCP_BROWSER`
  (`chrome`/`edge`/`brave`/`dia`) or `GEMINI_MCP_CHROME_PROFILE_DIRECTORY`
  over telling the user to repeat the same failed tool call.
- On Windows, browser launch must not use synchronous `where`/`spawnSync` in
  the runtime path. In the Gemini CLI extension, the BeforeTool hook is
  responsible for opening the configured browser; the MCP server runs with
  `GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED=false` so it does not compensate by
  opening another tab if the hook fails.
- `gemini_browser_status` is also allowed to wake the browser and self-heal the
  browser extension. Do not treat status as a passive-only tool; Gemini CLI
  often asks for status first, and that first status call should be enough to
  open the configured browser and, when an old Chrome/Edge extension build is
  connected, request the extension's own `RELOAD_SELF` flow. Inspect
  `selfHeal.reloadAttempts`, `selfHeal.code`, `bridgeHealth`, and
  `connectedClients` before asking the user to do anything manually.
- Treat `gemini_browser_status.ready=false`, a non-null `blockingIssue`, or
  zero `connectedClients` as a blocker for browser-dependent work. Do not keep
  calling `gemini_download_chat`, vault repair, or export tools in a loop while
  the browser bridge is disconnected. First call `gemini_browser_status` with
  default `selfHeal=true`; if tabs are connected but only need page reload,
  call `gemini_reload_gemini_tabs`. Only ask for manual reload of the
  `chrome://extensions`/`edge://extensions` card after the automatic self-heal
  fails or when the status says the loaded unpacked extension still points at an
  old/wrong `browser-extension` folder.
- Bridge protocol v2 separates liveness from heavy inventory. The content
  script sends lightweight `/bridge/heartbeat`, posts full conversation lists
  through `/bridge/snapshot` only when needed, and prefers `/bridge/events`
  (SSE) for MCP commands/progress. If SSE is unavailable, the old long-poll
  `/bridge/command` path remains the fallback. Treat
  `bridgeHealth.status="command_channel_stuck"` as a page/extension channel
  problem: prefer `gemini_reload_gemini_tabs` or `gemini_browser_status`
  self-heal before asking for manual Chrome extension reload.
- On slow Windows machines, prefer background jobs over long synchronous tool
  loops. `gemini_reexport_chats` is the stable path for a known list of chatIds:
  it navigates and saves one chat at a time, writes an incremental JSON report,
  broadcasts progress to the Gemini tab, and can be checked/cancelled with the
  export job tools.
- The extension does not use a `SessionStart` hook for static context; the
  extension `GEMINI.md` file is the context source. This avoids hook execution
  just because the Gemini CLI started.
- On Windows, the extension BeforeTool hook is narrowly matched to
  gemini-md-export MCP tools only. It prelaunches the configured Chromium
  browser before browser-dependent exporter tools, including
  `gemini_browser_status`, but it must not run for unrelated tools. It first checks
  `http://127.0.0.1:47283/agent/clients` with a very short timeout. If a Gemini
  tab is already connected, it opens nothing. If no client is connected, it
  opens `https://gemini.google.com/app` through a generated short PowerShell
  launcher that captures the current foreground window, starts the browser
  minimized, waits briefly, and tries to restore focus to the original terminal.
  If that immediate launch fails, direct browser spawn is allowed only when
  `GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK=true`; do not reintroduce
  `cmd.exe /c start`, WSH, synchronous `where`, or a fallback that focuses the
  browser by default. Emit concise user-facing status through the hook JSON
  `systemMessage` when the hook launches, waits on an existing launch, skips
  because the bridge is unreachable, times out, or fails. Stay silent when a
  Gemini tab is already connected.
  After launching, the hook waits for `/agent/clients` to report a connected
  Gemini tab before it returns, up to `GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS`
  (default 12000ms). The hook and MCP share `hook-browser-launch.json`, so a
  tool call should not open a second tab while a recent hook launch is still
  within cooldown. If the bridge is unreachable, the hook must not launch the
  browser blindly; record diagnostics and let the MCP return the actionable
  error. The hook itself must not use synchronous stdin reads.
  `SessionStart`
  must not read stdin. BeforeTool/AfterTool read stdin asynchronously, parse as
  soon as a complete JSON payload arrives, and fail open after
  `GEMINI_MCP_HOOK_STDIN_TIMEOUT_MS` (default 120ms) if the client keeps stdin
  open. For debugging, run
  `node scripts/hooks/gemini-md-export-hook.mjs diagnose`; it prints
  `/healthz`, `/agent/clients`, effective timeouts, launch plan, and the paths
  to `hook-last-run.json` and `hook-browser-launch.json`. The final hook envs
  are `GEMINI_MCP_HOOK_LAUNCH_BROWSER`,
  `GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS`,
  `GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS`,
  `GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK`, and `GEMINI_MCP_BROWSER`. If this
  is undesirable, set `GEMINI_MCP_HOOK_LAUNCH_BROWSER=false`.
- When the user reports the MCP as disconnected on Windows, suggest running:
  `powershell -ExecutionPolicy Bypass -File .\diagnose-windows-mcp.ps1`
- Multiple Gemini CLI terminals may start multiple MCP processes. Only the
  first process owns `127.0.0.1:47283`; later processes should stay quiet and
  proxy MCP tool calls to the primary bridge. If a second terminal still shows
  bridge/extension startup errors, suspect an old extension version or stale
  `node.exe`.
- The local bridge health check is `http://127.0.0.1:47283/healthz`.

Available capabilities include:

- listing recent Gemini chats
- listing notebook chats
- exporting the current chat
- exporting the recent-chat history in a background batch job
- reexporting an explicit list of chatIds in a background batch job
- checking or cancelling a background export job
- downloading a specific recent or notebook chat
- manually reloading connected Gemini tabs when needed
- inspecting cache/debug state

Be concise and prefer the MCP tools over telling the user to manually scrape the
page when the local browser extension is connected.
