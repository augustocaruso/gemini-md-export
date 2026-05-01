---
name: gemini-tabs-and-browser
description: Use when there are multiple Gemini tabs, the wrong tab may be active, a tab claim/indicator is needed, or Gemini Web must be opened reliably before export.
---

# Gemini Tabs And Browser

Use this skill whenever tab identity matters.

## Concepts

- The visual indicator is on the browser tab through Chrome tab grouping/badge
  mechanisms, not a DOM overlay inside Gemini.
- A tab claim is a lease for the current Gemini CLI session.
- If no Gemini tab is connected, `gemini_tabs` can open one when
  `openIfMissing` is not false.

## Flows

List tabs:

```json
{ "tool": "gemini_tabs", "arguments": { "action": "list", "openIfMissing": true } }
```

Claim one tab:

```json
{
  "tool": "gemini_tabs",
  "arguments": {
    "action": "claim",
    "index": 1,
    "label": "GME",
    "force": true
  }
}
```

Release when done:

```json
{ "tool": "gemini_tabs", "arguments": { "action": "release" } }
```

Reload Gemini tabs after extension self-reload or stale content script:

```json
{ "tool": "gemini_tabs", "arguments": { "action": "reload" } }
```

## Guardrails

- If multiple tabs are present, claim before listing/exporting.
- If a requested chat belongs to a specific tab, use `chatId`, `tabId`,
  `windowId`, `clientId`, or `claimId`.
- Do not simulate the tab indicator with in-page borders or overlays.
- Do not ask the user to open a tab manually until the tool path has failed or
  the configured browser is unavailable.
