---
name: gemini-mcp-diagnostics
description: Use when gemini-md-export is slow, unstable, disconnected, stale after update, blocked by Windows processes, or the browser extension does not respond.
---

# Gemini MCP Diagnostics

Use this skill for bridge/extension/browser instability, port conflicts,
timeouts, stale Chrome extension builds, and Windows process cleanup.

Do not activate this skill as an automatic fallback after a normal
`gemini-md-export chats count` or export/sync CLI failure. For those user-facing
count/export requests, report the short CLI failure and stop unless the user
explicitly asks for diagnostics.

## Order Of Operations

1. Check the compact ready state:

```json
{ "tool": "gemini_ready", "arguments": { "action": "check", "diagnostic": true } }
```

2. If not ready or stale, run full status with self-heal:

```json
{
  "tool": "gemini_ready",
  "arguments": {
    "action": "status",
    "diagnostic": true,
    "selfHeal": true,
    "allowReload": true,
    "detail": "full"
  }
}
```

3. Diagnose environment:

```json
{ "tool": "gemini_support", "arguments": { "action": "diagnose", "detail": "full" } }
```

4. For port/process conflicts:

```json
{ "tool": "gemini_support", "arguments": { "action": "processes", "detail": "full" } }
```

Only clean up after inspecting the plan:

```json
{
  "tool": "gemini_support",
  "arguments": { "action": "cleanup_processes", "confirm": true }
}
```

5. For handoff to a human or another machine:

```json
{ "tool": "gemini_support", "arguments": { "action": "bundle" } }
```

## Guidance

- Do not ask for manual Chrome extension reload until `gemini_ready` self-heal
  has been tried or the loaded extension is too old to self-reload.
- In proxy mode, prefer diagnostics over killing processes. The primary bridge
  may be valid.
- Never run raw `kill <pid>`, `pkill`, `killall`, or `taskkill` as a shortcut.
  Process cleanup must go through the exporter diagnostics/dry-run path and
  requires explicit user confirmation.
- `cleanup stale-processes` is not a preflight for normal count/export. Use it
  only after the user asks for diagnostics or cleanup explicitly.
- Keep normal output compact. Use `detail: "full"` only for root-cause work.
- Browser-facing MCP tools require explicit diagnostic/control intent. Use
  `diagnostic: true` for `gemini_ready` and `intent: "tab_management"` for
  deliberate tab operations.
- Explain dates/build stamps concretely when comparing versions.
