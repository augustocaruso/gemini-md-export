# Gemini Markdown Export

Use the `gemini-md-export` extension MCP when the user wants to inspect or export
Gemini web chats from the local browser session.

Operational guidance:

- Prefer listing recent chats before attempting a download.
- Prefer the recent-chats fast path first; only force a refresh when the user
  explicitly needs the sidebar refreshed.
- When the user asks to update/reinstall this exporter from Gemini CLI, prefer
  the `gemini_exporter_update` MCP tool. It starts a detached Windows updater
  from the latest GitHub release, so tell the user to close and reopen Gemini
  CLI after the updater finishes.
- Users can also run `/exporter:update` as a shortcut for the same update flow.
- When the user reports the MCP as disconnected on Windows, suggest running:
  `powershell -ExecutionPolicy Bypass -File .\diagnose-windows-mcp.ps1`
- If the MCP looks disconnected, suspect a stale `node.exe` or a bridge port
  conflict on `127.0.0.1:47283`.
- The local bridge health check is `http://127.0.0.1:47283/healthz`.

Available capabilities include:

- listing recent Gemini chats
- listing notebook chats
- exporting the current chat
- downloading a specific recent or notebook chat
- updating this exporter from GitHub Releases on Windows
- inspecting cache/debug state

Be concise and prefer the MCP tools over telling the user to manually scrape the
page when the local browser extension is connected.
