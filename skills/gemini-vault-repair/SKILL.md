---
name: gemini-vault-repair
description: Use when saved Gemini raw exports or wiki notes may contain wrong chat content, contaminated bodies, swapped chat IDs, or manual wiki edits that must be preserved.
---

# Gemini Vault Repair

Use this skill when the vault may contain corrupted raw exports or wiki notes
derived from the wrong Gemini chat.

## Non-Negotiables

- Preserve original YAML/frontmatter byte-for-byte unless the user explicitly
  asks to edit metadata.
- Compare content bodies, not enriched frontmatter.
- Back up before overwriting.
- Never overwrite a wiki/manual note automatically.
- If a raw export became a wiki note, create a `wiki-review/<chatId>.json`
  case file and ask the parent agent to route the rewrite deliberately.
- Every regenerated wiki must end with a Gemini source section containing the
  deduplicated union of all `https://gemini.google.com/app/<chatId>` links
  that informed the note.

## Preferred Runner

Prefer the bundled script:

```bash
node scripts/vault-repair.mjs /path/to/vault
```

The script audits notes, reexports exact chat IDs, validates staged Markdown,
creates backups, and writes a report.

## Browser Checks

Before browser work:

```json
{ "tool": "gemini_ready", "arguments": { "action": "status", "diagnostic": true } }
```

For known suspect IDs, prefer the runner above or the CLI:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" export reexport --chat-id "<chatId>" --output-dir "/path/to/staging" --plain
```

MCP `gemini_export` is CLI-first in v0.7.0 and should return `code: "use_cli"`
instead of starting hidden long jobs.

For one-off checks, stay CLI-first:

```bash
node "$HOME/.gemini/extensions/gemini-md-export/bin/gemini-md-export.mjs" export reexport --chat-id "<chatId>" --output-dir "/path/to/staging" --plain
```

`gemini_chats` download is intentionally blocked in the public MCP surface and
returns `use_cli_only`; do not bypass it with another MCP tool.

For a tiny read-only smoke check, `gemini_chats` requires explicit intent:

```json
{
  "tool": "gemini_chats",
  "arguments": { "action": "current", "intent": "one_off" }
}
```

## Reporting

Emit a preliminary report before changes and a final report after:

- files scanned
- suspects
- confirmed contaminated raws
- backups created
- wiki-review cases
- blocked/manual cases
- remaining browser/MCP issues
