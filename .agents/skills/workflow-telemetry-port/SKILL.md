---
name: workflow-telemetry-port
description: Port Augusto's workflow telemetry pattern to another local CLI or Gemini extension, reusing the existing Cloudflare Worker/Resend receiver and preserving fail-open behavior, redaction, outbox retry, opt-out, and actionable feedback emails.
---

# Workflow Telemetry Port

Use this when adding Augusto's workflow telemetry loop to another personal CLI,
Gemini CLI extension, MCP server, or workflow tool.

## Required Shape

- For private builds where users already agreed, support auto-enable through a
  packaged `telemetry.defaults.json`; keep a visible `telemetry status` and a
  working `telemetry disable` opt-out.
- Store mutable config under `~/.gemini/<app-name>/`, not inside an
  auto-updated extension bundle.
- Client knows only `endpoint_url` and `auth_token`; email/API secrets stay in
  the Cloudflare Worker.
- Remote send is always fail-open: it must never change stdout, stderr, or exit
  code of the primary workflow.
- Keep an outbox for retry when offline.
- Redact tokens, API keys, emails, Authorization headers, URL query strings,
  long Markdown/HTML/content fields, and home-directory paths.

## Contract

Use an app-specific envelope schema:

```text
<app-name>.workflow-telemetry-envelope.v1
```

Envelope fields:

- `schema`, `envelope_id`, `generated_at`, `install_id`, `payload_level`
- `client.app`, runtime version, platform
- `records[]` with `workflow`, `status`, `phase`, `exit_code`,
  `duration_ms`, `blocked_reason`, `next_action`,
  `human_decision_required`, `payload_summary`, `diagnostic_snippets`
- `limits.max_envelope_bytes`
- `truncated`

Recommended payload levels:

- `diagnostic_redacted`: default; metadata, blockers, errors/warnings redacted,
  counts, signals, compact path labels/hashes.
- `full_logs`: only for trusted installs; include raw command/result payload
  after redaction and size limiting.

## Implementation Checklist

1. Add a small local telemetry module in the project's native language.
2. Add CLI commands: `telemetry enable`, `disable`, `status`, `preview`, `send`.
   `enable` is a manual override; distribution defaults should remove the need
   for every user to paste endpoint/token.
3. Instrument top-level public workflows at their final success/error boundary.
4. If tests import the CLI entrypoint, disable auto-send under the test runner
   unless a test-specific env var explicitly allows it.
5. Add tests for no-default disabled, distribution-default auto-enable,
   opt-out blocking defaults, enable/status/disable, preview without network,
   outbox/retry, redaction, local HTTP send, and fail-open behavior.
6. Add/update Gemini CLI slash command, docs, and build packaging.
7. If reusing Augusto's Worker, make sure the Worker accepts the new envelope
   schema and uses `client.app` in the email subject/body.
