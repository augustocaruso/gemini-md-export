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
- When the user asks to update/reinstall this exporter from Gemini CLI, prefer
  the `gemini_exporter_update` MCP tool. It starts a detached Windows updater
  from the latest GitHub release, so tell the user to close and reopen Gemini
  CLI after the updater finishes.
- Users can also run `/exporter:update` as a shortcut for the same update flow.
- If `/exporter:update` or `gemini_exporter_update` fails, tell the user to run
  the external PowerShell recovery command from the project README. Updating
  from inside Gemini CLI depends on the currently installed MCP, so an old or
  inconsistent updater may need that external bootstrap.
- When the user reports the MCP as disconnected on Windows, suggest running:
  `powershell -ExecutionPolicy Bypass -File .\diagnose-windows-mcp.ps1`
- If the MCP looks disconnected, suspect a stale `node.exe` or a bridge port
  conflict on `127.0.0.1:47283`.
- The local bridge health check is `http://127.0.0.1:47283/healthz`.

Available capabilities include:

- listing recent Gemini chats
- listing notebook chats
- exporting the current chat
- exporting the recent-chat history in a background batch job
- checking or cancelling a background export job
- downloading a specific recent or notebook chat
- updating this exporter from GitHub Releases on Windows
- manually reloading connected Gemini tabs when needed
- inspecting cache/debug state

Be concise and prefer the MCP tools over telling the user to manually scrape the
page when the local browser extension is connected.
