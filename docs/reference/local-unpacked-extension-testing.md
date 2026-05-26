# Local Unpacked Extension Testing Protocol

This protocol is for agents testing local builds of `gemini-md-export` against a Chromium unpacked extension.

It is not product auto-update. It is an operator responsibility during local testing.

## Required Steps

1. Build the project:

   ```bash
   npm run build
   ```

2. Confirm no browser-backed export job is active.

   Useful commands:

   ```bash
   node bin/gemini-md-export.mjs job list --active --plain --result-json
   curl -s http://127.0.0.1:47283/healthz
   ```

   Do not run `rsync`, installer copy steps, or browser reload while an export job is running. Wait for the job to finish or cancel it first. Changing installed files mid-job can make the bridge expect a newer build while the content script is still executing the previous build, which invalidates watchdog recovery and can produce repeated failures on the same chats.

3. Ask the CLI/MCP diagnostics which unpacked extension path the browser is actually using.

   Useful commands:

   ```bash
   node bin/gemini-md-export.mjs browser status --plain --result-json
   node bin/gemini-md-export.mjs ready status --plain --result-json
   ```

4. Compare source/build version with loaded runtime version.

   If diagnostics show a newer source/build than the loaded runtime and the loaded path is known, do not keep retrying self-reload. The browser is loading stale files.

5. Synchronize the built extension into the loaded unpacked path.

   Example:

   ```bash
   rsync -a --delete dist/extension/ /path/reported/by/diagnostics/browser-extension/
   ```

   Use the path reported by diagnostics. Do not assume a default path when diagnostics already named the loaded path.

6. Reload the browser extension runtime.

   Prefer project commands when available:

   ```bash
   node bin/gemini-md-export.mjs browser status --allow-reload --plain --result-json
   ```

   If the runtime was loaded from a custom browser UI that cannot self-reload, reload the unpacked extension card manually.

7. Reload or reconnect Gemini tabs.

8. Confirm the loaded runtime version/build stamp matches the source before running export tests.

## Failure Pattern

If source says `0.8.54` but runtime says `0.8.53`, self-reload alone cannot fix the mismatch when the loaded folder still contains `0.8.53` files. Sync the loaded folder first.

Self-reload não atualiza arquivos se a pasta carregada está velha.

## Agent Rule

Before claiming a browser-backed local test result, the agent must confirm there was no active export job during local install sync and that the loaded runtime build matches the source build. If not, the test result is invalid.
