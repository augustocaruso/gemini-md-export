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

## MCP Checks

Before browser work:

```json
{ "tool": "gemini_ready", "arguments": { "action": "status" } }
```

For known suspect IDs, reexport in a background job:

```json
{
  "tool": "gemini_export",
  "arguments": {
    "action": "reexport",
    "outputDir": "/path/to/staging",
    "items": [{ "chatId": "<chatId>", "sourcePath": "/path/to/note.md" }]
  }
}
```

Poll:

```json
{ "tool": "gemini_job", "arguments": { "action": "status", "jobId": "<jobId>" } }
```

For one-off checks only:

```json
{
  "tool": "gemini_chats",
  "arguments": { "action": "download", "chatId": "<chatId>", "outputDir": "/path/to/staging" }
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
