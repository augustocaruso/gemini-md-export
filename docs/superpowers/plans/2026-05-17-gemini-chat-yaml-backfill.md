# Gemini Chat YAML Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize raw Gemini chat Markdown files to a canonical YAML schema and backfill `date_created` / `date_last_message` from Google Gemini Activity.

**Architecture:** Keep metadata normalization separate from contaminated-content repair. New exports emit the canonical YAML directly. A dedicated backfill runner scans existing raw chat files, normalizes their YAML, first matches them against the authenticated My Activity web UI through the MV3 extension/bridge, and later accepts Takeout records when the export email arrives.

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

## My Activity Bridge Client

Closed implementation direction:

- The runtime scraper is the MV3 extension, not Playwright.
- `src/activity-content-script.js` runs on `https://myactivity.google.com/product/gemini*`.
- The My Activity page connects to the local bridge as `kind: "activity"` and exposes `activity-scan-batch`.
- The bridge accepts My Activity origin only for heartbeat/events/command result style client communication.
- Sensitive endpoints such as `pick-directory`, `save-files`, and `fetch-asset` remain restricted to Gemini/chrome-extension origins.
- Scan results are sanitized: dates, score, hashes, sample lengths, card indexes, and checkpoints only.

## Scanner And Checkpoint

The default live path is resumable and exhaustive:

```bash
gemini-md-export metadata backfill <vaultDir> --use-my-activity --report <report.json>
```

The runner builds in-memory candidates with `{ chatId, firstPrompt, lastPrompt, assistantSamples }`, sends them to the Activity client, and records checkpoint fields such as `lastSeenActivityToken`, `loadedCardCount`, and `resolvedChatIds`. Files without confident matches are still normalized and reported as `unresolved`; date fields are omitted.

`date_last_message` means the timestamp of the latest Gemini Activity item that confirms the last known Gemini response. It is not a promise that the timestamp is the exact end of model generation.

## Takeout Later

When the Google export arrives, the same runner accepts:

```bash
gemini-md-export metadata backfill <vaultDir> --takeout <MyActivity.json> --report <report.json>
```

Takeout is normalized into the same match shape as the live My Activity scraper and does not require browser/bridge readiness.

## Manifest Permission And Reload

`https://myactivity.google.com/*` is a new MV3 host permission. A browser runtime that loaded an older manifest will not inject the Activity content script. Readiness/bridge errors should return a concrete action: open `https://myactivity.google.com/product/gemini` and, if the new permission has not reached the loaded runtime, reload the extension card manually in `chrome://extensions` / `edge://extensions`.

## Activity UX

The live My Activity scan reuses the extension's existing visual language:

- the MCP applies the same tab-claim visual path used by Gemini tabs, so the My Activity tab is marked with Tab Group/badge while the scan runs;
- `src/activity-content-script.js` renders the same `gm-md-export-progress-dock` pattern used by long exports, with a moving bar, shimmer, resolved-chat count, loaded/scanned item text, and terminal "Concluído"/"Falhou" states;
- the visual claim is best-effort and auto-released after the scan, so a claim failure does not block YAML normalization.

## Privacy Gate

Prompts and responses may exist only in memory during scoring. Reports, telemetry, flight recorder events, and operational logs must contain only hashes, sizes, scores, counts, timestamps, file paths, and status. Tests must fail if sensitive prompt/response text appears in report output.

## File Structure

- Modify `src/extract.mjs`: emit canonical frontmatter for new exports.
- Modify `src/userscript-shell.js`: pass `dateExported` and assistant-response `turnCount` into `buildDocument`.
- Create `src/activity-content-script.js`: authenticated My Activity scraper for `myactivity.google.com/product/gemini`.
- Create `gemini-cli-extension/scripts/chat-metadata-backfill.mjs`: CLI runner for dry-run/apply metadata normalization.
- Create `tests/chat-metadata-backfill.test.mjs`: fixtures and assertions for the new runner.
- Modify `src/extension-background.js` and `src/mcp-server.js`: route backfill queries to the My Activity tab and return sanitized matches.
- Modify `bin/gemini-md-export.mjs`: expose `metadata backfill`.
- Modify `scripts/build.mjs`: package the new runner and the My Activity content script.
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

## Task 2: Live My Activity Scraper First

**Files:**
- Create: `src/activity-content-script.js`
- Modify: `scripts/build.mjs`
- Modify: `src/extension-background.js`
- Modify: `src/mcp-server.js`
- Test: `tests/content-script.test.mjs`
- Test: `tests/bridge-smoke.test.mjs`
- Test: `tests/gemini-cli-extension.test.mjs`

- [ ] **Step 1: Add extension manifest/build tests**

Add tests proving the MV3 bundle includes:

- content script match `https://myactivity.google.com/product/gemini*`;
- host permission `https://myactivity.google.com/*`;
- packaged `activity-content-script.js`.

Run:

```bash
node --test tests/gemini-cli-extension.test.mjs
```

Expected: fail until the build includes the new script and permission.

- [ ] **Step 2: Implement the activity content script**

Create `src/activity-content-script.js` with a tiny message API:

- listens for `chrome.runtime.onMessage` type `gemini-md-export/activity-scan`;
- scans currently loaded Gemini Activity cards;
- for likely candidates, opens `Item details`;
- extracts date/time from the card/details view;
- scores candidate prompt/response text inside the page;
- returns only sanitized evidence: `date`, `score`, `textHash`, `promptCoverage`, `assistantCoverage`, `candidateCount`, and `source: "my-activity-web"`.

Do not log prompt or response bodies to the browser console.

- [ ] **Step 3: Package and permission the script**

In `scripts/build.mjs`:

- read `src/activity-content-script.js`;
- write it to `dist/extension/activity-content-script.js`;
- add it to `manifest.content_scripts`;
- add `https://myactivity.google.com/*` to `host_permissions`;
- copy it into the Gemini CLI browser-extension bundle.

- [ ] **Step 4: Add bridge/MCP route**

Expose a local agent endpoint that can:

- find an existing `https://myactivity.google.com/product/gemini` tab or open one;
- ask the content script to scan for one raw chat candidate at a time;
- return sanitized match results to the backfill runner.

The endpoint must be opt-in and must not expose prompt or response bodies in HTTP logs, flight logs, telemetry, or JSON reports.

- [ ] **Step 5: Verify**

Run:

```bash
npm run build
node --test tests/content-script.test.mjs tests/bridge-smoke.test.mjs tests/gemini-cli-extension.test.mjs
```

Expected: pass.

## Task 3: Backfill Runner Using My Activity Web

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
- My Activity web match fills `date_created` and `date_last_message`;
- ambiguous duplicate prompt leaves dates unchanged and reports `ambiguous`;
- wiki/derived note is skipped.

Use temp directories and write Markdown fixtures directly inside the test. Stub the My Activity bridge endpoint so tests do not need a real browser.

Run:

```bash
node --test tests/chat-metadata-backfill.test.mjs
```

Expected: fail because the runner does not exist yet.

- [ ] **Step 2: Implement argument parsing**

Support live scraping first:

```text
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs <vault-or-folder>
  --use-my-activity
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
- `--use-my-activity` is the default while Takeout is unavailable; keep the flag for clarity in reports and commands.

- [ ] **Step 3: Implement raw-chat detection**

A file is eligible only when all are true:

- Markdown file with parseable frontmatter or clear raw Gemini headings;
- has a `chat_id`, Gemini `/app/<chatId>` URL, or filename chat id;
- body contains raw chat headings;
- does not show wiki/derived-note signals such as Obsidian wikilinks, medical/wiki headings, extra operational metadata, or final multi-source Gemini footer.

Skipped files must appear in the report with `status: "skipped"` and `reason`.

- [ ] **Step 4: Query My Activity matches**

For each eligible raw chat:

- build a sanitized in-memory candidate from first user message, last user message, assistant response samples, and `chat_id`;
- call the local My Activity endpoint;
- store only sanitized match evidence in the report;
- continue scanning other files if one candidate is unresolved or ambiguous.

- [ ] **Step 5: Score matches**

For each raw chat:

- extract first user message, all user messages, and assistant response samples from the Markdown body;
- compare against My Activity card/details text using normalized whitespace and longest-common-substring coverage;
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

## Task 4: Takeout Import After Email Arrives

**Files:**
- Modify: `gemini-cli-extension/scripts/chat-metadata-backfill.mjs`
- Test: `tests/chat-metadata-backfill.test.mjs`

- [ ] **Step 1: Add Takeout fixture tests**

Add tests proving `--takeout <MyActivity.json>`:

- parses Google Activity JSON;
- fills the same match model used by My Activity web scraping;
- does not require browser/bridge readiness;
- takes precedence over live scraping when both are supplied and scores tie.

- [ ] **Step 2: Parse Takeout activity**

Accept Google My Activity JSON forms commonly exported by Takeout/Data Portability:

- top-level array of activity objects;
- object with an array property containing activity objects.

For each activity item, extract:

- `time` as UTC ISO;
- visible text fields such as `title`, `description`, `details`, `subtitles`, and nested string values;
- whether the item belongs to Gemini/Bard by checking product/title fields for `Gemini`, `Gemini Apps`, or `bard`.

Keep full text only in memory. The report should store hashes, score, timestamps, and lengths, not prompt/response bodies.

- [ ] **Step 3: Merge sources**

When both `--takeout` and `--use-my-activity` are supplied:

- normalize both sources into the same candidate shape;
- prefer Takeout for equal scores because it is exportable and easier to audit;
- include `source: "takeout"` or `source: "my-activity-web"` in report evidence.

- [ ] **Step 4: Verify**

Run:

```bash
node --test tests/chat-metadata-backfill.test.mjs
```

Expected: pass.

## Task 5: CLI Command

**Files:**
- Modify: `bin/gemini-md-export.mjs`
- Test: `tests/gemini-cli-tui.test.mjs`

- [ ] **Step 1: Add CLI tests**

Add tests that:

- `gemini-md-export help metadata` lists `metadata backfill`;
- `metadata backfill <vault> --use-my-activity` spawns `chat-metadata-backfill.mjs`;
- `metadata backfill <vault> --takeout <file>` remains supported once Takeout arrives;
- unknown metadata subcommands return a usage error.

- [ ] **Step 2: Wire the command**

Add command shape:

```bash
gemini-md-export metadata backfill <vault-or-folder> --use-my-activity [--apply]
gemini-md-export metadata backfill <vault-or-folder> --takeout <MyActivity.json> [--apply]
```

Forward unrecognized backfill-specific flags to `chat-metadata-backfill.mjs` the same way `repair-vault` delegates to its runner.

- [ ] **Step 3: Verify**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs
```

Expected: pass.

## Task 6: Docs And Gemini CLI Command

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
- My Activity web scraping command as the first implementation path;
- Takeout command as the later stable/offline path once the email arrives;
- dry-run/apply behavior and backup location.

- [ ] **Step 2: Add Gemini CLI command**

Create `/exporter:backfill-metadata` command that tells the agent to call:

```bash
node "${extensionPath}/bin/gemini-md-export.mjs" metadata backfill "<vaultDir>" --use-my-activity
```

or:

```bash
node "${extensionPath}/bin/gemini-md-export.mjs" metadata backfill "<vaultDir>" --takeout "<MyActivity.json>"
```

The command must say explicitly that `--apply` is required to mutate files.

- [ ] **Step 3: Verify bundle tests**

Run:

```bash
node --test tests/gemini-cli-extension.test.mjs
```

Expected: pass.

## Task 7: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: build succeeds and all `node --test tests/*.test.mjs` tests pass.

- [ ] **Step 2: Manual My Activity dry-run smoke**

Create a temporary vault fixture and run:

```bash
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs /tmp/gme-vault-fixture --use-my-activity --report /tmp/gme-report-live.json
```

Expected:

- My Activity tab is opened or reused;
- no Markdown files changed;
- report uses `source: "my-activity-web"`;
- report contains proposed canonical YAML changes;
- unresolved/ambiguous cases are reported without dates.

After the Takeout email/file arrives, also run:

```bash
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs /tmp/gme-vault-fixture --takeout /tmp/gme-takeout-fixture.json --report /tmp/gme-report-takeout.json
```

Expected:

- no browser/bridge is required;
- report uses `source: "takeout"`;
- no Markdown files changed without `--apply`.

- [ ] **Step 3: Manual My Activity apply smoke**

Run:

```bash
node gemini-cli-extension/scripts/chat-metadata-backfill.mjs /tmp/gme-vault-fixture --use-my-activity --apply --report /tmp/gme-report-apply.json
```

Expected:

- eligible raw chat files are rewritten;
- backups are created;
- Markdown bodies are byte-for-byte unchanged;
- YAML matches the canonical contract.
