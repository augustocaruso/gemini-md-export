# Background-First Date-Strict Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser export avoid visible tab switching by default and make incomplete dates a non-successful export outcome that tells the user to run `fix-vault`.

**Architecture:** Add explicit TypeScript FSMs for tab activation policy and date-completeness outcome. Keep MCP/browser side effects in existing JS/content-script adapters, but make decisions in TS and propagate simple flags through the CLI and bridge.

**Tech Stack:** TypeScript FSM modules compiled into `build/ts`, Node test runner, MV3 content scripts, MCP bridge HTTP/SSE.

---

### Task 1: Date Completeness Gate

**Files:**
- Modify: `src/mcp/export-job-date-summary.ts`
- Modify: `src/mcp-server.js`
- Modify: `bin/gemini-md-export.mjs`
- Test: `tests/export-job-date-summary.test.mjs`
- Test: `tests/gemini-cli-tui.test.mjs`

- [ ] Add a failing FSM test proving a completed export with `partial` or `unresolved` dates becomes `completed_with_date_errors` and recommends `fix-vault`.
- [ ] Implement `evaluateDateCompletenessGateFsm(job)` returning `success`, `date_errors`, or `disabled`.
- [ ] Use the FSM in job result serialization so `nextAction.message` says not all dates were found and includes a `fix-vault` command.
- [ ] Update CLI final status rendering so `--plain --result-json` does not print a clean success when date errors remain.

### Task 2: Background-First Tab Access

**Files:**
- Create or modify: `src/mcp/tab-access-policy.ts`
- Modify: `src/mcp-server.js`
- Modify: `bin/gemini-md-export.mjs`
- Test: `tests/tab-access-policy.test.mjs`
- Test: `tests/gemini-cli-tui.test.mjs`

- [ ] Add a failing FSM test proving export defaults to `background_command` when a command-ready tab exists.
- [ ] Add a failing CLI/MCP source test proving export commands no longer force `activateTab=true` by default.
- [ ] Implement `evaluateTabAccessPolicyFsm` with states `background_command`, `activate_once`, `open_missing_tab`, and `blocked`.
- [ ] Wire export preparation to require activation only when explicit or when the FSM says activation is the recovery path.

### Task 3: Unified Progress for Gemini and My Activity

**Files:**
- Modify: `src/activity-content-script.ts`
- Modify: `src/userscript-shell.ts`
- Modify: `src/mcp-server.js`
- Test: existing source/behavior tests in `tests/mcp-command-channel.test.mjs` and focused progress tests.

- [ ] Add a failing source/behavior test proving both content scripts consume the same MCP `jobProgress` shape.
- [ ] Reuse the shared progress port in My Activity for MCP job progress, not only local activity scan progress.
- [ ] Ensure Gemini and My Activity show consistent labels, counts, status, and terminal state for the same job.

### Task 4: Verification

**Files:**
- No source files beyond Tasks 1-3.

- [ ] Run `npm run build`.
- [ ] Run focused tests for date summary, CLI, MCP command channel, activity progress, tab access, recent export runtime.
- [ ] Install the local bundle only after tests pass and no export job is active.
- [ ] Validate `browser status --wake --allow-reload`.
- [ ] Run a 30-chat My Activity export and confirm it either completes with all dates or clearly returns date errors plus the `fix-vault` instruction.
