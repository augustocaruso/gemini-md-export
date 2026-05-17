# Gemini Chat YAML Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize raw Gemini chat Markdown files to a canonical YAML schema and backfill `date_created` / `date_last_message` from Google Gemini Activity.

**Architecture:** Keep metadata normalization separate from contaminated-content repair. New exports should emit the canonical YAML directly, while a dedicated backfill runner scans existing raw chat files, matches them against Takeout/My Activity records, reports the proposed changes, and only rewrites files with `--apply` after creating backups.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing MV3 Chrome extension build, local MCP bridge, Markdown frontmatter parsing with the repo's lightweight parser style.

---

## Canonical YAML Contract

Raw Gemini chat files must use this frontmatter shape:

```yaml
---
type: gemini_chat
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
date_created: 2026-05-10T09:46:09Z
date_last_message: 2026-05-10T10:12:31Z
date_exported: 2026-05-17T18:55:08Z
turn_count: 6
model: "2.5 Pro"
tags: [gemini-export]
---
```

Rules:

- `type` stays because it cheaply distinguishes a raw Gemini chat from a derived wiki/note.
- `source` is removed; `type`, `url`, and `tags` carry enough identity.
- `exported_at` is replaced by `date_exported`.
- All date fields are UTC ISO-8601 with second precision and `Z`; no milliseconds and no local offset.
- `turn_count` means number of Gemini/assistant responses, not total Markdown headings.
- `date_created` is the first matched Gemini Activity item for the chat.
- `date_last_message` is the last matched Gemini Activity item that confirms a Gemini response for the chat. If the available Activity timestamp is the prompt event time, use that timestamp and record the limitation in the JSON report, not in the YAML.
- If a date cannot be matched confidently, omit that date field and report the file as `unresolved` or `ambiguous`.
- Scope is raw chats only. Wiki notes, consolidated notes, or manually edited derived notes must be skipped.

## File Structure

- Modify `src/extract.mjs`: emit canonical frontmatter for new exports.
- Modify `src/userscript-shell.js`: pass `dateExported` and assistant-response `turnCount` into `buildDocument`.
- Create `gemini-cli-extension/scripts/chat-metadata-backfill.mjs`: CLI runner for dry-run/apply metadata normalization.
- Create `tests/chat-metadata-backfill.test.mjs`: fixtures and assertions for the new runner.
- Modify `bin/gemini-md-export.mjs`: expose `metadata backfill`.
- Modify `scripts/build.mjs`: package the new runner and, if live My Activity mode is implemented in the same pass, package the activity content script.
- Optionally create `src/activity-content-script.js`: live My Activity fallback that scans authenticated `myactivity.google.com/product/gemini` pages.
- Modify `README.md` and `gemini-cli-extension/GEMINI.md`: document the canonical YAML and command.

## Task 1: New Export YAML

**Files:**
- Modify: `src/extract.mjs`
- Modify: `src/userscript-shell.js`
- Test: `tests/extract.test.mjs`

- [ ] **Step 1: Add a UTC formatter test**

Add tests asserting that frontmatter uses `date_exported`, removes `source`, and keeps second-precision UTC:

```js
test('buildFrontmatter: canonical Gemini chat YAML v2', () => {
  const fm = buildFrontmatter({
    chatId: 'b8e7c075effe9457',
    title: 'Exemplo',
    url: 'https://gemini.google.com/app/b8e7c075effe9457',
    dateCreated: '2026-05-10T09:46:09.543Z',
    dateLastMessage: '2026-05-10T10:12:31.999Z',
    dateExported: '2026-05-17T18:55:08.123Z',
    turnCount: 6,
    model: '2.5 Pro',
  });

  assert.match(fm, /^---\ntype: gemini_chat\n/);
  assert.match(fm, /\nchat_id: b8e7c075effe9457\n/);
  assert.match(fm, /\ndate_created: 2026-05-10T09:46:09Z\n/);
  assert.match(fm, /\ndate_last_message: 2026-05-10T10:12:31Z\n/);
  assert.match(fm, /\ndate_exported: 2026-05-17T18:55:08Z\n/);
  assert.match(fm, /\nturn_count: 6\n/);
  assert.doesNotMatch(fm, /\nsource:/);
  assert.doesNotMatch(fm, /\nexported_at:/);
});
```

Run:

```bash
node --test tests/extract.test.mjs
```

Expected: fail because the canonical fields are not implemented yet.

- [ ] **Step 2: Update `buildFrontmatter`**

Implement these behaviors in `src/extract.mjs`:

- Add helper `formatUtcIsoSeconds(value)` that returns `YYYY-MM-DDTHH:mm:ssZ` for valid date-like values and `''` otherwise.
- Accept `dateCreated`, `dateLastMessage`, `dateExported`, and `turnCount`.
- Preserve field order exactly as shown in the contract.
- Keep `title`, `model`, and `tags` quoting behavior consistent with the current YAML writer.
- Do not emit empty optional fields.

- [ ] **Step 3: Pass canonical metadata from the browser shell**

In `buildExportPayload` inside `src/userscript-shell.js`:

- Replace `exportedAt: new Date().toISOString()` with `dateExported: new Date().toISOString()`.
- Add `turnCount: turns.filter((turn) => turn.role === 'assistant').length`.
- Leave `dateCreated` and `dateLastMessage` unset for normal Gemini DOM export until Activity/Takeout enrichment is available.

- [ ] **Step 4: Verify**

Run:

```bash
node --test tests/extract.test.mjs
```

Expected: pass.

## Task 2: Backfill Runner With Takeout

**Files:**
- Create: `gemini-cli-extension/scripts/chat-metadata-backfill.mjs`
- Test: `tests/chat-metadata-backfill.test.mjs`

- [ ] **Step 1: Add fixture tests**

Create tests for:

- dry-run does not rewrite files;
- `--apply` rewrites only raw chats and creates backups;
- `exported_at` migrates to `date_exported`;
- `source` is removed;
- `turn_count` equals assistant heading count;
- Takeout match fills `date_created` and `date_last_message`;
- ambiguous duplicate prompt leaves dates unchanged and reports `ambiguous`;
- wiki/derived note is skipped.

Use temp directories and write Markdown fixtures directly inside the test.

Run:

```bash
node --test tests/chat-metadata-backfill.test.mjs
```

Expected: fail because the runner does not exist yet.

- [ ] **Step 2: Implement argument parsing**

Support:

```text
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs <vault-or-folder>
  --takeout <MyActivity.json>
  --apply
  --report <report.json>
  --backup-dir <dir>
  --path <file.md>
```

Defaults:

- dry-run unless `--apply` is present;
- report path `<vault>/.gemini-md-export-metadata/backfill-report.json`;
- backup dir `<vault>/.gemini-md-export-metadata/backups/<YYYYMMDD-HHMMSS>`;
- repeated `--path` limits work to explicit files.

- [ ] **Step 3: Implement raw-chat detection**

A file is eligible only when all are true:

- Markdown file with parseable frontmatter or clear raw Gemini headings;
- has a `chat_id`, Gemini `/app/<chatId>` URL, or filename chat id;
- body contains raw chat headings;
- does not show wiki/derived-note signals such as Obsidian wikilinks, medical/wiki headings, extra operational metadata, or final multi-source Gemini footer.

Skipped files must appear in the report with `status: "skipped"` and `reason`.

- [ ] **Step 4: Parse Takeout activity**

Accept Google My Activity JSON forms commonly exported by Takeout/Data Portability:

- top-level array of activity objects;
- object with an array property containing activity objects.

For each activity item, extract:

- `time` as UTC ISO;
- visible text fields such as `title`, `description`, `details`, `subtitles`, and nested string values;
- whether the item belongs to Gemini/Bard by checking product/title fields for `Gemini`, `Gemini Apps`, or `bard`.

Keep full text only in memory. The report should store hashes, score, timestamps, and lengths, not prompt/response bodies.

- [ ] **Step 5: Score matches**

For each raw chat:

- extract first user message, all user messages, and assistant response samples from the Markdown body;
- compare against Activity text using normalized whitespace and longest-common-substring coverage;
- require strong first-prompt coverage for `date_created`;
- require strong coverage of the last user prompt plus assistant-response confirmation when available for `date_last_message`;
- if multiple items tie above threshold, mark `ambiguous`;
- if no item clears threshold, mark `unresolved`.

Threshold defaults:

- first prompt coverage at least `0.85`;
- assistant confirmation coverage at least `0.20` against the Activity details text when the assistant sample has at least 80 characters;
- duplicate candidates within two score points are ambiguous.

- [ ] **Step 6: Rewrite canonical frontmatter**

For each eligible file:

- preserve the Markdown body byte-for-byte;
- replace only the frontmatter block;
- write fields in canonical order;
- omit unresolved date fields;
- compute `turn_count` from assistant headings in the body;
- normalize `date_exported` from existing `date_exported`, existing `exported_at`, or current export metadata when present.

On `--apply`, copy the original file to the backup directory before overwriting.

- [ ] **Step 7: Verify**

Run:

```bash
node --test tests/chat-metadata-backfill.test.mjs
```

Expected: pass.

## Task 3: CLI Command

**Files:**
- Modify: `bin/gemini-md-export.mjs`
- Test: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add CLI tests**

Add tests that:

- `gemini-md-export help metadata` lists `metadata backfill`;
- `metadata backfill <vault> --takeout <file>` spawns `chat-metadata-backfill.mjs`;
- unknown metadata subcommands return a usage error.

- [ ] **Step 2: Wire the command**

Add command shape:

```bash
gemini-md-export metadata backfill <vault-or-folder> --takeout <MyActivity.json> [--apply]
```

Forward unrecognized backfill-specific flags to `chat-metadata-backfill.mjs` the same way `repair-vault` delegates to its runner.

- [ ] **Step 3: Verify**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs
```

Expected: pass.

## Task 4: Live My Activity Fallback

**Files:**
- Create: `src/activity-content-script.js`
- Modify: `scripts/build.mjs`
- Modify: `src/extension-background.js`
- Modify: `src/mcp-server.js`
- Test: `tests/content-script.test.mjs`
- Test: `tests/bridge-smoke.test.mjs`

- [ ] **Step 1: Add extension manifest support**

In `scripts/build.mjs` add:

- content script match: `https://myactivity.google.com/product/gemini*`;
- host permission: `https://myactivity.google.com/*`;
- packaged file: `activity-content-script.js`.

- [ ] **Step 2: Implement the activity content script**

The script must:

- listen for `chrome.runtime.onMessage` type `gemini-md-export/activity-scan`;
- scan visible Gemini Activity cards;
- open `Item details` for candidate cards;
- score matches inside the page using query text sent by the local runner/MCP;
- return only sanitized evidence: `chatId`, `date`, `score`, `textHash`, `promptCoverage`, `assistantCoverage`, and `candidateCount`.

Do not log prompt or response bodies to the browser console.

- [ ] **Step 3: Add bridge/MCP route**

Expose a local agent endpoint that can:

- find or open a My Activity tab;
- send candidate queries to the activity content script;
- return sanitized match results to the backfill runner.

The endpoint must be opt-in from the runner, used only when no Takeout file is provided or when `--use-my-activity` is passed.

- [ ] **Step 4: Add runner integration**

Extend the backfill runner with:

```bash
gemini-md-export metadata backfill <vault> --use-my-activity
```

Behavior:

- require local bridge/extension readiness;
- send only candidate text needed for scoring;
- merge live Activity matches with Takeout matches when both are present;
- prefer Takeout if scores tie.

- [ ] **Step 5: Verify**

Run:

```bash
npm run build
node --test tests/content-script.test.mjs tests/bridge-smoke.test.mjs
```

Expected: pass.

## Task 5: Docs And Gemini CLI Command

**Files:**
- Modify: `README.md`
- Modify: `gemini-cli-extension/GEMINI.md`
- Create: `gemini-cli-extension/commands/exporter/backfill-metadata.toml`
- Test: `tests/gemini-cli-extension.test.mjs`

- [ ] **Step 1: Update README**

Document:

- canonical YAML schema;
- `turn_count` semantics as number of Gemini responses;
- UTC `Z` date format;
- Takeout command;
- live My Activity fallback command;
- dry-run/apply behavior and backup location.

- [ ] **Step 2: Add Gemini CLI command**

Create `/exporter:backfill-metadata` command that tells the agent to call:

```bash
node "${extensionPath}/bin/gemini-md-export.mjs" metadata backfill "<vaultDir>" --takeout "<MyActivity.json>"
```

or:

```bash
node "${extensionPath}/bin/gemini-md-export.mjs" metadata backfill "<vaultDir>" --use-my-activity
```

The command must say explicitly that `--apply` is required to mutate files.

- [ ] **Step 3: Verify bundle tests**

Run:

```bash
node --test tests/gemini-cli-extension.test.mjs
```

Expected: pass.

## Task 6: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: build succeeds and all `node --test tests/*.test.mjs` tests pass.

- [ ] **Step 2: Manual dry-run smoke**

Create a temporary vault fixture and run:

```bash
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs /tmp/gme-vault-fixture --takeout /tmp/gme-takeout-fixture.json --report /tmp/gme-report.json
```

Expected:

- no Markdown files changed;
- report contains proposed canonical YAML changes;
- unresolved/ambiguous cases are reported without dates.

- [ ] **Step 3: Manual apply smoke**

Run:

```bash
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs /tmp/gme-vault-fixture --takeout /tmp/gme-takeout-fixture.json --apply --report /tmp/gme-report-apply.json
```

Expected:

- eligible raw chat files are rewritten;
- backups are created;
- Markdown bodies are byte-for-byte unchanged;
- YAML matches the canonical contract.

