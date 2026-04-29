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
- When the user asks to import/export the whole Gemini chat history, do not list
  the chats first. Start `gemini_export_recent_chats`, tell the user the job ID,
  and poll `gemini_export_job_status` until the job finishes. The job writes the
  Markdown files and an incremental JSON report locally. If the user asks to
  stop the import/export, call `gemini_export_job_cancel`; already written
  Markdown files and the report are preserved. Do not pass `maxChats` unless the
  user explicitly asks for a partial export; with no `maxChats`, the MCP loads
  until the sidebar reaches its real end. If individual chats fail because the
  extension could not prove it reached the beginning of the conversation, report
  those failures from the job status instead of treating them as completed
  exports.
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
- `gemini_browser_status` is also allowed to wake the browser when no Gemini
  tab is connected. Do not treat status as a passive-only tool; Gemini CLI often
  asks for status first, and that first status call should be enough to open the
  configured browser.
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
- checking or cancelling a background export job
- downloading a specific recent or notebook chat
- manually reloading connected Gemini tabs when needed
- inspecting cache/debug state

Be concise and prefer the MCP tools over telling the user to manually scrape the
page when the local browser extension is connected.
