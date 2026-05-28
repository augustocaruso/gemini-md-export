# Gemini Private API Read Chat Spike

Status: approved for product adapter implementation; first private API adapters landed behind
explicit shell boundaries.
Date: 2026-05-28

## Goal

Prove whether Gemini Web has a private API path that can fetch a known
conversation by `chatId` without rendering or hydrating the conversation DOM.

The target proof is `getConversation(chatId)`: given a known
`https://gemini.google.com/app/<chatId>` URL, return a normalized turn list and
enough metadata to map into the existing export core.

## Local Evidence

The current repo checkout is `0.8.56`, but the primary bridge on
`127.0.0.1:47283` was an installed Gemini CLI extension process at `0.8.54`.
It was not an orphan: its parent Gemini CLI process was still running. That
process had `exitWhenIdle=false`, live browser clients, and held the bridge
port, so the local `0.8.56` MCP process fell back to `stdio-only`.

This means the lifecycle work solved part of the singleton story, but not the
case where an older full MCP launched by a still-running Gemini CLI session owns
the primary bridge. The product already reports this as
`primary_bridge_version_mismatch` and exposes a safe cleanup plan, but it is
still disruptive for local spike work.

Browser target note: Dia is the user's Chromium browser. The relevant
extensions/plugins are expected to be available in Dia; absence of Google
Chrome is not a blocker for this project.

## Open-Source Reference

Reference inspected:

- Repo: `HanaokaYuzu/Gemini-API`
- Commit: `fbe0790599ac8ee77692dabdce88a96110a33294`
- Commit date: `2026-04-13`

Important files:

- `/tmp/Gemini-API/src/gemini_webapi/constants.py`
- `/tmp/Gemini-API/src/gemini_webapi/components/chat_mixin.py`
- `/tmp/Gemini-API/src/gemini_webapi/client.py`

The library uses the Gemini Web private batch endpoint:

```text
POST https://gemini.google.com/_/BardChatUi/data/batchexecute
```

Relevant RPC IDs:

```text
LIST_CHATS = MaZiqc
READ_CHAT  = hNvQHb
```

`READ_CHAT` payload:

```json
["<chatId>", 10, null, 1, [1], [4], null, 1]
```

Batch request shape:

```text
query:
  rpcids=hNvQHb
  hl=<language>
  _reqid=<monotonic request id>
  rt=c
  source-path=/app
  bl=<build label, optional>
  f.sid=<session id, optional>

form:
  at=<SNlM0e token>
  f.req=[[[ "hNvQHb", "[\"<chatId>\",10,null,1,[1],[4],null,1]", null, "generic" ]]]
```

The same library discovers session fields from the initial Gemini app HTML:

```text
SNlM0e -> access token for form field at
cfb2h   -> build label bl
FdrFJe  -> session id f.sid
TuX5cc  -> language
```

Additional browser-control reference inspected:

- Repo: `pasky/chrome-cdp-skill`
- Pattern: raw Chrome DevTools Protocol connection to an already-open browser,
  with per-tab daemon sockets and no Puppeteer dependency.

The relevant idea for this project is not to adopt CDP as a product default.
It is useful as a developer probe because it can inspect Dia's live Gemini tab,
extract runtime/session evidence, and avoid DOM hydration. Product code should
prefer the extension/native broker path when possible.

NotebookLM private-protocol reference inspected:

- Repo: `teng-lin/notebooklm-py`
- File: `src/notebooklm/_chat_protocol.py`
- Pattern: keep streamed-chat wire request construction and response parsing in
  a protocol module, while conversation flow, caching, source resolution, and
  result construction stay in separate modules.

The useful lesson for this project is the boundary, not a direct endpoint
reuse: a Gemini private API adapter should have pure protocol builders/parsers
that are testable without browser state, and a separate shell that owns
authentication, browser/session tokens, retries, and lifecycle.

Lifecycle reference inspected:

- Gist: `anuj846k/2d641bf33606bcd13d8d5af311af1832`

The gist is useful as generic MCP lifecycle framing, but it does not solve this
project's concrete singleton problem: a still-running older Gemini CLI process
can own the bridge port with a stale exporter version.

## Probe Result Without Auth

A direct unauthenticated request to the `READ_CHAT` endpoint returned HTTP 200,
but no conversation data:

```text
)]}'

105
[["wrb.fr","hNvQHb",null,null,null,[7],"generic"],["di",24],["af.httprm",24,"-7626132358544272959",30]]
25
[["e",4,null,null,141]]
```

Interpretation: the endpoint and RPC ID are live enough to return a structured
batch response, but an authenticated browser session and `at` token are needed
to prove conversation retrieval.

## Authenticated Probe Result

Result: success.

Execution path:

```text
Dia live Gemini tab
  -> CDP developer probe
  -> SNlM0e/cfb2h/FdrFJe/TuX5cc extracted from loaded Gemini HTML
  -> Google cookies read from Dia through CDP with explicit user approval
  -> Node fetch to private batchexecute endpoint
  -> sanitized response summary only
```

Important discovery: `READ_CHAT` does not accept the bare hex ID from
`/app/<hex>`. `LIST_CHATS` returns IDs prefixed with `c_`, and `READ_CHAT`
expects that form:

```text
URL:       https://gemini.google.com/app/dbe5dd4b50b09c74
READ_CHAT: c_dbe5dd4b50b09c74
```

Single-chat proof:

```json
{
  "ok": true,
  "path": "dia-cdp-cookies-node-fetch",
  "cid": "c_dbe5dd4b50b09c74",
  "rpcStatus": 200,
  "bodyBytes": 9107,
  "turns": 1,
  "totalUserChars": 40,
  "totalModelChars": 3185
}
```

Recent-chat batch proof:

```json
{
  "okCount": 20,
  "total": 20,
  "maxTurns": 23,
  "maxBodyBytes": 811082,
  "maxChars": 149545,
  "withAssetsCount": 1
}
```

One recent chat had asset-like references in the private API payload:

```json
{
  "turns": 5,
  "candidateCount": 5,
  "bodyBytes": 811082,
  "assets": {
    "artifactRefs": 2,
    "webImageCount": 0,
    "generatedImageCount": 0,
    "generatedVideoCount": 0
  }
}
```

No conversation text, cookies, access tokens, or raw asset URLs were printed in
the probe output.

## Lifecycle Finding

The old primary bridge on `127.0.0.1:47283` was confirmed as PID `19610`,
exporter `0.8.54`, launched from
`~/.gemini/extensions/gemini-md-export/src/mcp-server.js`. The current checkout
was `0.8.56`.

Cleanup result:

```json
{
  "terminated": [
    {
      "pid": 19610,
      "signal": "SIGTERM",
      "ok": true,
      "exited": true
    }
  ]
}
```

A current bridge-only process was then launched from the repo checkout:

```json
{
  "version": "0.8.56",
  "pid": 29027,
  "bridgeRole": "primary",
  "bridgeOnly": true,
  "exitWhenIdle": true,
  "activeRequestCount": 7,
  "activeRequestBlockerCount": 0,
  "blockedBy": []
}
```

After its idle window elapsed, that bridge-only process exited and no listener
remained on `127.0.0.1:47283`. The final state is a clean port, not a hidden
replacement server left running.

Code fix made during the spike: idle shutdown now distinguishes raw active
HTTP sockets from active requests that should actually block lifecycle. Health
checks and event streams from clients without valid live runtime evidence do
not keep a bridge-only process alive forever.

## Real Candidate Chat IDs Found Locally

The existing Dia/Gemini bridge loaded recent sidebar entries. Candidate targets:

```text
dbe5dd4b50b09c74  Python Libraries in iOS Apps
88a98a108cdcfb61  Configuração de Ferramentas TypeScript/JavaScript
4a6f9af41e117e59  Dúvida sobre CPRE e Suas Aplicações
```

These IDs are suitable for the first `READ_CHAT` proof.

## Execution Options

### Option A: Browser-Authenticated Fetch Adapter

Preferred product direction.

Run the private API call inside the authenticated Dia/Gemini browser context,
using `fetch(..., { credentials: "include" })` and tokens read from the loaded
Gemini page. This avoids exporting Google cookies to Node and matches the
project's separation of shell and core:

```text
Dia/Gemini page or extension background
  -> browser-auth infra adapter
  -> raw private API response
  -> pure protocol decoder
  -> normalized ChatSnapshot
  -> export core
```

For the spike, this likely needs a debug-only bridge command or native broker
command that executes a narrow, typed `READ_CHAT` probe. It should not become a
general arbitrary eval endpoint.

### Option B: Library-Style Cookie Proof

Fastest proof and the path used for this spike after explicit approval, but not
preferred for product as-is.

Use the same approach as `Gemini-API`: load `__Secure-1PSID` /
`__Secure-1PSIDTS` from a cookie source, initialize the private API client, and
call `read_chat(chatId)`.

This reads browser authentication cookies and should only run with explicit user
approval. If used, the spike must avoid printing secrets, avoid persisting
cookies in the repo, and delete temporary artifacts.

### Option C: CDP Developer Probe

Useful for exploration, not product default.

Dia exposes a local DevTools endpoint after remote debugging is enabled. The
`chrome-cdp-skill` pattern works against this endpoint and can inspect existing
Gemini tabs. It is powerful enough to read cookies and browser state, so it
should remain an explicit developer diagnostic path.

## Architecture Contract For Product Implementation

If the proof succeeds, implementation should follow ports and adapters:

```text
core/
  gemini-private-protocol.ts
    Pure request builders, response decoders, zod/type guards or TS validators.

  gemini-chat-normalizer.ts
    Pure conversion from private API shapes to ChatSnapshot.

  markdown-renderer/
    Transport-independent HTML/block/text to Markdown renderer.

browser/
  private-api-browser-adapter.ts
    Browser-authenticated fetch implementation.

mcp/
  private-api-read-chat-fsm.ts
    Typed FSM: idle -> initializing -> token_ready -> requesting ->
    decoding -> succeeded | auth_blocked | protocol_changed | retrying.
```

No presentation/UI module should know private RPC details. No core module should
call `fetch`, read cookies, touch DOM, talk to the bridge, or know Dia/Chrome.

## Product Dependency Decision

`HanaokaYuzu/Gemini-API` / `gemini_webapi` is accepted as a Python dependency,
but only behind an infra adapter:

```text
MCP/shell
  -> JSON subprocess contract
  -> python/gemini_md_export/gemini_webapi_adapter.py
  -> gemini_webapi dependency
  -> normalized ChatSnapshot-compatible JSON
```

The TypeScript core remains dependency-free from Python and AGPL code. The
adapter is optional and replaceable; browser-authenticated fetch can remain a
separate `privateApi` transport.

## Markdown Renderer Note

Turndown is a reasonable first renderer adapter for HTML returned by either DOM
or private API paths. If the private API exposes richer block structures,
`unified`/`mdast` may be a better long-term renderer. The renderer should be
pluggable and tested with shared fixtures so DOM and private API outputs can be
compared.

## Next Gate

`READ_CHAT` returned real turns for multiple known chats. The next gate is a
product design, not another proof of existence:

1. Add pure TypeScript protocol builders/decoders for `LIST_CHATS` and
   `READ_CHAT`.
2. Add a browser-authenticated private API adapter behind a port. The first
   product candidate should run in the extension/background or native broker
   control path, not as arbitrary CDP eval.
3. Add a typed lifecycle FSM for stale-primary takeover:
   `observing -> compatible_primary | stale_primary_detected ->
   cleanup_plan_ready -> terminating_stale_primary -> starting_current_bridge ->
   verified | blocked`.
4. Add a renderer adapter layer. Start with Turndown for HTML fragments, but
   keep the port open for a richer block-to-Markdown renderer if private API
   structures are cleaner than HTML.
