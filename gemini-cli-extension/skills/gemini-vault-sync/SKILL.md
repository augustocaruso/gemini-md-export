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

1. Check readiness:

```json
{ "tool": "gemini_ready", "arguments": { "action": "check" } }
```

2. For a vault that was already synced before, run incremental sync:

```json
{
  "tool": "gemini_export",
  "arguments": {
    "action": "sync",
    "vaultDir": "/path/to/vault",
    "outputDir": "/path/to/vault"
  }
}
```

3. For first import or suspected gaps, scan the vault and export missing chats:

```json
{
  "tool": "gemini_export",
  "arguments": {
    "action": "missing",
    "vaultDir": "/path/to/vault",
    "outputDir": "/path/to/vault"
  }
}
```

4. For a bounded recent export:

```json
{
  "tool": "gemini_export",
  "arguments": {
    "action": "recent",
    "maxChats": 25
  }
}
```

5. Poll compact status:

```json
{ "tool": "gemini_job", "arguments": { "action": "status", "jobId": "<jobId>" } }
```

Use `detail: "full"` only when debugging a failed job or report mismatch.

## Resume

If the previous response contains `reportFile`, pass it as `resumeReportFile`
or `reportFile` on the next `gemini_export` call. The exporter skips chats
already completed in that report.

## Human Output

Report only:

- `jobId`
- progress/status
- counts
- `reportFile`
- next action

Do not paste full conversation inventories unless the user explicitly asks for
a small page of results.
