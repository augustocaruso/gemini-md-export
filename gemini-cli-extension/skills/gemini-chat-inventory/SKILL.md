---
name: gemini-chat-inventory
description: Use when the user asks to count, list, page through, or search Gemini Web chat history by title without exporting chats or syncing an Obsidian vault.
---

# Gemini Chat Inventory

Use this skill for lightweight history inventory: total count, short paginated
lists, title search, and "what chats do I have?" questions.

Do not use this skill for full-history export, vault sync, missing-chat import,
repair, notebook export, artifact capture, or bridge/root-cause diagnostics.

## Mental Model

- Count is a scalar answer: one number, exact only when the sidebar end is
  confirmed.
- List is a page of inventory: keep it small, because chat titles may be
  sensitive and hundreds of rows waste context.
- Export/sync is a different workflow: route to `gemini-vault-sync`.
- Diagnostics are opt-in after the user explicitly asks for them.

## Count

For "quantos chats/conversas ao todo?", run the CLI directly:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" chats count --plain
```

Report an exact total only when the CLI result confirms `totalKnown=true` or
`countIsTotal=true`. Otherwise answer "pelo menos N" and say the end of the
Gemini sidebar was not confirmed.

If count returns partial, timeout, readiness, connection, `no_connected_clients`,
or `extension_version_mismatch`, stop with the concise CLI result. Do not call
`gemini_ready`, `gemini_tabs`, `gemini_chats`, `gemini_support`, or cleanup tools
as fallback unless the user's next message explicitly asks for diagnostics.

## Short Lists

For "liste meus chats", show a small page. Prefer 25 items by default and never
show more than 50 unless the user explicitly asks for a larger page.

Prefer the CLI snapshot flow when shell access exists, especially if the user
may follow with "baixe essas":

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" chats list --limit 25 --save-selection --plain
```

This is the Playwright-style loop: list/snapshot first, act later by stable
chat refs from the saved `selectionFile`.

Use `gemini_chats` only for a deliberate small read when shell access is not
available:

```json
{
  "tool": "gemini_chats",
  "arguments": {
    "action": "list",
    "source": "recent",
    "limit": 25,
    "offset": 0,
    "refresh": false,
    "intent": "small_page",
    "detail": "compact"
  }
}
```

In the answer, show titles with enough metadata to orient the user, but do not
paste large JSON. Include the next page hint when available, for example:
"posso continuar a partir do offset 25".

If the list cache is empty or stale and the user asked for current data, repeat
with `refresh: true`. If the tool reports multiple Gemini tabs, stay in CLI tab
selection flow (`tabs list --plain`, `tabs claim --index <n> --plain`) before
retrying the small list with the selected tab/claim.

## Follow-up Downloads From A Listed Page

When the user says "baixe essas", "exporte essas conversas", or similar after
you have just listed chats, treat "essas" as the exact `chatId`s from that list.
Do not switch to a positional recent-history export; the sidebar may have
changed and the wrong chats can be downloaded.

Use the saved selection manifest from `chats list --save-selection`:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" export reexport --selection-file "$HOME/.gemini-md-export/selections/latest.json" --expected-count 10 --plain --timeout-ms 1800000
```

If no selection file exists because the list came from an older tool result,
use `export reexport --chat-id ...` only with every listed `chatId` copied
explicitly and add `--expected-count N`.

Set the shell/tool timeout higher than the CLI timeout so the CLI has time to
cancel the job and release the tab itself. If an external shell timeout or
interruption happened and you did not see a terminal `RESULT_JSON`, do not start
another export immediately. First run:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" job list --active --plain
```

Then use the printed `job status ...` or `job cancel ...` command for the active
job before retrying. Prefer `job cancel <jobId> --wait --plain` when you need
to clear a stuck job; do not run `kill`, reload, cleanup, or a new export as a
shortcut.

When the target browser is Dia, keep the same CLI flow and add `--browser dia`
if the profile is not auto-detected.

## Search By Title

For "procure conversas sobre X", page through recent chats in small batches and
filter titles/summaries locally. Show only matches, not every scanned row.

Use a conservative scan:

- start with `limit: 50`, `offset: 0`, `refresh: false`;
- continue while the user asked for more results and pagination says there may
  be more;
- stop early after useful matches unless the user explicitly asks to keep
  searching;
- if no matches are found in loaded/cache data, say that clearly and offer the
  next page/refresh path as a concrete next action.

Do not turn a search request into full export. If the user wants content inside
matching chats, open/export specific chats by ID/title through the appropriate
workflow.

## Full Inventory Requests

If the user asks to list everything, do not paste hundreds of titles into the
conversation. Offer one of these safer outputs:

- a paginated preview in chat;
- a local report/export flow via `gemini-vault-sync`;
- a count-only answer if they only need size.

## Human Output

Use Portuguese, short explanations, and concrete counts:

- "Encontrei 25 conversas nesta página."
- "Total confirmado: 287 conversas."
- "Contagem parcial: pelo menos 153; o fim da barra lateral não foi confirmado."
- "Mostrei 25 de pelo menos 153; próximo offset: 25."

Avoid implementation jargon in the final answer unless the user asks for it.
