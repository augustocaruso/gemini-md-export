# Native Debugger Session Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heartbeat-led browser readiness with a Native Messaging + `chrome.debugger` session broker so export/test workflows cannot target stale, inactive, ambiguous, blocked, or unclaimed Gemini tabs.

**Architecture:** Keep CLI/MCP as the public orchestrator, but move browser truth into the extension background. The native host becomes a broker transport with two legs: Native Messaging for the extension and local IPC for MCP/CLI; `chrome.debugger`/`chrome.tabs` supplies fresh tab facts; TypeScript branded capabilities gate export workflows.

**Tech Stack:** TypeScript `NodeNext`, MV3 service worker, Chrome Native Messaging, `chrome.debugger`, `chrome.tabs`, Node streams/local sockets, Node test runner, `tsc --noEmit`, Biome, existing build pipeline.

---

## Scope And Ordering

This plan intentionally ships in compatibility slices. HTTP/SSE/heartbeat stays available until the native debugger path is proven, but no new export path may treat heartbeat as readiness proof.

The current branch already has a dirty TypeScript migration WIP. Do not broaden the refactor beyond the files listed here. Do not run intrusive browser tests unless the command explicitly uses wake/open behavior and no Gemini tab exists.

## File Structure

- Create: `src/native/protocol.ts`
  - Typed Native Messaging and local broker IPC envelopes.
- Create: `src/native/frame.ts`
  - Length-prefixed JSON frame encoder/decoder shared by native host tests.
- Create: `src/native/native-host-runtime.ts`
  - Native host command dispatcher; keeps `src/native-host.mjs` as a thin entrypoint.
- Create: `src/native/local-ipc.ts`
  - Unix socket / Windows named pipe address generation and request client/server helpers.
- Create: `src/browser/background/chrome-debugger-controller.ts`
  - Browser-facing CDP wrapper for attach/detach, URL/runtime inspection, blocker classification, optional activation.
- Create: `src/browser/background/browser-session-broker.ts`
  - Branded `InspectableBrowserTab`, `DebuggableGeminiTab`, `ClaimedDebuggableGeminiTab`, tab listing, claim, revalidation.
- Create: `src/browser/background/native-broker-client.ts`
  - Extension-side Native Messaging port manager and request router.
- Create: `src/mcp/native-browser-broker.ts`
  - MCP-side adapter that calls the native broker through local IPC and falls back to current HTTP bridge only when allowed.
- Create: `src/extension-background.ts`
  - Renamed from the current `src/extension-background.js` with transitional `@ts-nocheck`; new logic imports typed modules.
- Delete: `src/extension-background.js`
  - Replaced by the TypeScript source. The built MV3 file remains `dist/extension/background.js`.
- Modify: `scripts/build.mjs`
  - Bundle/copy background TS modules and native runtime modules into `dist/extension` and `dist/gemini-cli-extension`.
- Modify: `src/native-host.mjs`
  - Thin wrapper around `build/ts/native/native-host-runtime.js`.
- Modify: `src/mcp-server.js`
  - Route tab list/claim/status and export job creation through `src/mcp/native-browser-broker.ts` when available.
- Modify: `bin/gemini-md-export.mjs`
  - Preserve non-intrusive defaults and add native broker diagnostics/status output.
- Modify tests:
  - `tests/native-protocol.test.mjs`
  - `tests/native-host.test.mjs`
  - `tests/native-local-ipc.test.mjs`
  - `tests/chrome-debugger-controller.test.mjs`
  - `tests/browser-session-broker.test.mjs`
  - `tests/native-browser-broker.test.mjs`
  - `tests/mcp-command-channel.test.mjs`
  - `tests/mcp-export-workflows.test.mjs`
  - `tests/gemini-cli-tui.test.mjs`
  - `tests/gemini-cli-extension.test.mjs`
  - `tests/browser-smoke.test.mjs`
  - `tests/typescript-shell-source.test.mjs`

## Task 1: Lock The TypeScript Boundary For New Runtime Logic

**Files:**
- Modify: `src/extension-background.js`
- Create: `src/extension-background.ts`
- Modify: `scripts/build.mjs`
- Modify: `tests/typescript-shell-source.test.mjs`
- Modify: `tests/gemini-cli-extension.test.mjs`

- [ ] **Step 1: Write the failing source-boundary test**

Add this assertion to `tests/typescript-shell-source.test.mjs`:

```js
test('new browser runtime logic lives in TypeScript sources', () => {
  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]extension-background\.js/);
  assert.equal(existsSync(resolve(ROOT, 'src', 'extension-background.ts')), true);
  assert.equal(existsSync(resolve(ROOT, 'src', 'extension-background.js')), false);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run build:ts && node --test tests/typescript-shell-source.test.mjs
```

Expected: FAIL because `src/extension-background.ts` does not exist or build still reads `src/extension-background.js`.

- [ ] **Step 3: Rename the background source mechanically**

Move `src/extension-background.js` to `src/extension-background.ts`. Put this at the top of the new TS file:

```ts
// @ts-nocheck
// Transitional MV3 service worker source. New browser broker logic must live in
// typed modules imported from this file; do not add new large JS-only blocks.
```

Update `scripts/build.mjs`:

```js
const extensionBackgroundSrc = readFileSync(
  resolve(ROOT, 'build', 'ts', 'extension-background.js'),
  'utf-8',
);
```

- [ ] **Step 4: Keep bundled extension expectations intact**

Update any tests that read `src/extension-background.js` to read `src/extension-background.ts` unless the test inspects built output. Keep `dist/extension/background.js` as the generated MV3 file.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/typescript-shell-source.test.mjs tests/gemini-cli-extension.test.mjs tests/native-host.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/extension-background.ts scripts/build.mjs tests/typescript-shell-source.test.mjs tests/gemini-cli-extension.test.mjs tests/native-host.test.mjs
git add -u src/extension-background.js
git commit -m "refactor: move extension background source to typescript"
```

## Task 2: Add Typed Native Broker Protocol And Framing

**Files:**
- Create: `src/native/protocol.ts`
- Create: `src/native/frame.ts`
- Create: `tests/native-protocol.test.mjs`

- [ ] **Step 1: Write the failing protocol tests**

Create `tests/native-protocol.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeNativeFrameBuffer,
  encodeNativeFrame,
} from '../build/ts/native/frame.js';
import {
  makeNativeRequest,
  nativeBrokerError,
  nativeBrokerOk,
  normalizeNativeCommand,
} from '../build/ts/native/protocol.js';

test('native frames encode and decode Chrome length-prefixed JSON', () => {
  const frame = encodeNativeFrame({ id: 'r1', command: 'tabs.list', payload: { limit: 2 } });
  const decoded = decodeNativeFrameBuffer(frame);

  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].id, 'r1');
  assert.equal(decoded.messages[0].command, 'tabs.list');
  assert.equal(decoded.remaining.length, 0);
});

test('partial native frame keeps remaining bytes until payload arrives', () => {
  const frame = encodeNativeFrame({ id: 'r2', command: 'ping' });
  const first = decodeNativeFrameBuffer(frame.subarray(0, 3));
  const second = decodeNativeFrameBuffer(Buffer.concat([first.remaining, frame.subarray(3)]));

  assert.equal(first.messages.length, 0);
  assert.equal(second.messages[0].id, 'r2');
});

test('protocol helpers preserve request ids and typed errors', () => {
  const request = makeNativeRequest('tabs.claim', { tabId: 42 }, { id: 'claim-1' });
  const ok = nativeBrokerOk(request, { claimId: 'c1' });
  const error = nativeBrokerError(request, 'ambiguous_gemini_tabs', 'Escolha uma aba Gemini.');

  assert.equal(normalizeNativeCommand(request.command), 'tabs.claim');
  assert.deepEqual(ok, { id: 'claim-1', ok: true, result: { claimId: 'c1' } });
  assert.equal(error.id, 'claim-1');
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'ambiguous_gemini_tabs');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run build:ts && node --test tests/native-protocol.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `build/ts/native/frame.js`.

- [ ] **Step 3: Implement `src/native/protocol.ts`**

Create:

```ts
export const NATIVE_BROKER_PROTOCOL_VERSION = 1;

export type NativeBrokerCommand =
  | 'ping'
  | 'healthz'
  | 'tabs.list'
  | 'tabs.status'
  | 'tabs.claim'
  | 'tabs.release'
  | 'export.start'
  | 'export.cancel'
  | 'job.progress'
  | 'proxyHttp';

export type NativeBrokerRequest<TPayload = unknown> = Readonly<{
  id: string;
  protocolVersion: number;
  command: NativeBrokerCommand;
  payload: TPayload;
}>;

export type NativeBrokerError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  nextAction: string;
  data?: unknown;
}>;

export type NativeBrokerResponse<TResult = unknown> =
  | Readonly<{ id: string; ok: true; result: TResult }>
  | Readonly<{ id: string; ok: false; error: NativeBrokerError }>;

export const normalizeNativeCommand = (value: unknown): NativeBrokerCommand => {
  const command = String(value || '').trim() as NativeBrokerCommand;
  if (!command) return 'ping';
  return command;
};

export const makeNativeRequest = <TPayload>(
  command: NativeBrokerCommand,
  payload: TPayload,
  options: { id?: string; protocolVersion?: number } = {},
): NativeBrokerRequest<TPayload> => ({
  id: options.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  protocolVersion: options.protocolVersion || NATIVE_BROKER_PROTOCOL_VERSION,
  command,
  payload,
});

export const nativeBrokerOk = <TResult>(
  request: Pick<NativeBrokerRequest, 'id'>,
  result: TResult,
): NativeBrokerResponse<TResult> => ({
  id: request.id,
  ok: true,
  result,
});

export const nativeBrokerError = (
  request: Pick<NativeBrokerRequest, 'id'> | null,
  code: string,
  message: string,
  options: { retryable?: boolean; nextAction?: string; data?: unknown } = {},
): NativeBrokerResponse<never> => ({
  id: request?.id || '',
  ok: false,
  error: {
    code,
    message,
    retryable: options.retryable === true,
    nextAction: options.nextAction || message,
    ...(options.data === undefined ? {} : { data: options.data }),
  },
});
```

- [ ] **Step 4: Implement `src/native/frame.ts`**

Create:

```ts
const MAX_NATIVE_FRAME_BYTES = 16 * 1024 * 1024;

export const encodeNativeFrame = (message: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

export const decodeNativeFrameBuffer = (
  buffer: Buffer,
): { messages: unknown[]; remaining: Buffer } => {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_NATIVE_FRAME_BYTES) {
      throw new Error(`Native Messaging frame too large: ${length} bytes`);
    }
    if (buffer.length - offset < 4 + length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    messages.push(JSON.parse(payload.toString('utf-8')));
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
};
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/native-protocol.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/native/protocol.ts src/native/frame.ts tests/native-protocol.test.mjs
git commit -m "feat: add native broker protocol"
```

## Task 3: Move Native Host Runtime Into TypeScript

**Files:**
- Create: `src/native/native-host-runtime.ts`
- Modify: `src/native-host.mjs`
- Modify: `tests/native-host.test.mjs`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: Write failing runtime tests**

Add to `tests/native-host.test.mjs`:

```js
test('native host runtime is implemented in TypeScript', () => {
  assert.equal(existsSync(resolve(ROOT, 'src', 'native', 'native-host-runtime.ts')), true);
  const wrapper = readFileSync(resolve(ROOT, 'src', 'native-host.mjs'), 'utf-8');
  assert.match(wrapper, /import\\(['"]\\.\\.\\/build\\/ts\\/native\\/native-host-runtime\\.js['"]\\)/);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/native-host.test.mjs
```

Expected: FAIL because the runtime module does not exist yet.

- [ ] **Step 3: Implement the TS runtime**

Create `src/native/native-host-runtime.ts` by moving the current logic from `src/native-host.mjs` into an exported function:

```ts
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeNativeFrameBuffer, encodeNativeFrame } from './frame.js';
import { nativeBrokerError, nativeBrokerOk, type NativeBrokerRequest } from './protocol.js';

export type NativeHostRuntimeOptions = Readonly<{
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  root?: string;
  bridgeUrl?: string;
}>;

export const startNativeHostRuntime = (options: NativeHostRuntimeOptions = {}): void => {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const root =
    options.root || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bridgeUrl = options.bridgeUrl || process.env.GEMINI_MD_EXPORT_BRIDGE_URL || 'http://127.0.0.1:47283';
  let buffer = Buffer.alloc(0);

  const write = (message: unknown) => stdout.write(encodeNativeFrame(message));

  const handle = async (request: NativeBrokerRequest): Promise<unknown> => {
    if (request.command === 'ping') {
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
      return nativeBrokerOk(request, {
        transport: 'nativeMessaging',
        nativeProtocolVersion: 1,
        version: pkg.version,
        pid: process.pid,
        node: process.version,
      });
    }
    if (request.command === 'proxyHttp') {
      const payload = request.payload as { path?: string; method?: string; payload?: unknown };
      const url = new URL(payload.path || '/healthz', bridgeUrl);
      const response = await fetch(url, {
        method: payload.method || 'GET',
        body: payload.payload === undefined ? undefined : JSON.stringify(payload.payload),
      });
      return nativeBrokerOk(request, {
        ok: response.ok,
        status: response.status,
        data: await response.json().catch(() => null),
      });
    }
    return nativeBrokerError(request, 'unknown_command', `Comando native desconhecido: ${request.command}`);
  };

  stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    const decoded = decodeNativeFrameBuffer(buffer);
    buffer = decoded.remaining;
    for (const message of decoded.messages) {
      handle(message as NativeBrokerRequest)
        .then(write)
        .catch((err) =>
          write(nativeBrokerError(message as NativeBrokerRequest, 'native_host_error', err instanceof Error ? err.message : String(err))),
        );
    }
  });

  stdin.on('end', () => process.exit(0));
};
```

- [ ] **Step 4: Replace `src/native-host.mjs` with a thin wrapper**

Use:

```js
#!/usr/bin/env node

const { startNativeHostRuntime } = await import('../build/ts/native/native-host-runtime.js');

startNativeHostRuntime();
```

- [ ] **Step 5: Ensure build bundles native modules**

In `scripts/build.mjs`, keep copying `build/ts` into the Gemini CLI extension. Add a test expectation in `tests/gemini-cli-extension.test.mjs` that `build/ts/native/native-host-runtime.js` exists in `dist/gemini-cli-extension`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/native-protocol.test.mjs tests/native-host.test.mjs tests/gemini-cli-extension.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/native/native-host-runtime.ts src/native-host.mjs scripts/build.mjs tests/native-host.test.mjs tests/gemini-cli-extension.test.mjs
git commit -m "refactor: move native host runtime to typescript"
```

## Task 4: Add Local IPC For MCP/CLI To Reach The Native Broker

**Files:**
- Create: `src/native/local-ipc.ts`
- Create: `tests/native-local-ipc.test.mjs`
- Modify: `src/native/native-host-runtime.ts`

- [ ] **Step 1: Write local IPC tests**

Create `tests/native-local-ipc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBrokerIpcServer,
  defaultBrokerIpcPath,
  requestBrokerIpc,
} from '../build/ts/native/local-ipc.js';

test('broker ipc uses a non-http local endpoint', () => {
  const path = defaultBrokerIpcPath({ platform: 'darwin', runtimeDir: '/tmp/gme-test' });
  assert.match(path, /gemini-md-export/);
  assert.doesNotMatch(path, /^http/);
});

test('broker ipc request/response preserves ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gme-ipc-'));
  const socketPath = join(dir, 'broker.sock');
  const server = await createBrokerIpcServer({
    path: socketPath,
    handleRequest: async (request) => ({
      id: request.id,
      ok: true,
      result: { command: request.command },
    }),
  });

  const response = await requestBrokerIpc(socketPath, {
    id: 'ipc-1',
    protocolVersion: 1,
    command: 'ping',
    payload: {},
  });

  assert.deepEqual(response, { id: 'ipc-1', ok: true, result: { command: 'ping' } });
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/native-local-ipc.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/native/local-ipc.ts`**

Create a small stream-framed local IPC helper:

```ts
import { existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNativeFrameBuffer, encodeNativeFrame } from './frame.js';
import type { NativeBrokerRequest, NativeBrokerResponse } from './protocol.js';

export const defaultBrokerIpcPath = ({
  platform = process.platform,
  runtimeDir = process.env.XDG_RUNTIME_DIR || tmpdir(),
}: { platform?: NodeJS.Platform | string; runtimeDir?: string } = {}): string => {
  if (platform === 'win32') return '\\\\.\\pipe\\gemini-md-export-native-broker';
  return join(runtimeDir, 'gemini-md-export-native-broker.sock');
};

export const createBrokerIpcServer = async ({
  path = defaultBrokerIpcPath(),
  handleRequest,
}: {
  path?: string;
  handleRequest(request: NativeBrokerRequest): Promise<NativeBrokerResponse>;
}): Promise<{ path: string; close(): Promise<void> }> => {
  if (process.platform !== 'win32' && existsSync(path)) {
    unlinkSync(path);
  }
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeNativeFrameBuffer(buffer);
      buffer = decoded.remaining;
      for (const message of decoded.messages) {
        handleRequest(message as NativeBrokerRequest).then((response) => {
          socket.write(encodeNativeFrame(response));
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
};

export const requestBrokerIpc = (
  path: string,
  request: NativeBrokerRequest,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<NativeBrokerResponse> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Native broker IPC timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(encodeNativeFrame(request)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeNativeFrameBuffer(buffer);
      buffer = decoded.remaining;
      if (decoded.messages[0]) {
        clearTimeout(timer);
        socket.end();
        resolve(decoded.messages[0] as NativeBrokerResponse);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
```

- [ ] **Step 4: Start IPC server from native host runtime**

In `src/native/native-host-runtime.ts`, add optional startup:

```ts
if (process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC !== 'disabled') {
  createBrokerIpcServer({
    path: process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(),
    handleRequest: handle,
  }).catch(() => {
    // Native Messaging request handling still works if IPC cannot bind.
  });
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/native-protocol.test.mjs tests/native-local-ipc.test.mjs tests/native-host.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/native/local-ipc.ts src/native/native-host-runtime.ts tests/native-local-ipc.test.mjs
git commit -m "feat: add local ipc for native broker"
```

## Task 5: Add Chrome Debugger Controller

**Files:**
- Create: `src/browser/background/chrome-debugger-controller.ts`
- Create: `tests/chrome-debugger-controller.test.mjs`

- [ ] **Step 1: Write debugger controller tests**

Create `tests/chrome-debugger-controller.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectTabWithDebugger,
  classifyBrowserUrl,
} from '../build/ts/browser/background/chrome-debugger-controller.js';

test('classifies Gemini, Google login and Google verification URLs', () => {
  assert.equal(classifyBrowserUrl('https://gemini.google.com/app/abc123456789'), 'gemini');
  assert.equal(classifyBrowserUrl('https://accounts.google.com/v3/signin'), 'google_login');
  assert.equal(classifyBrowserUrl('https://www.google.com/sorry/index'), 'google_sorry');
  assert.equal(classifyBrowserUrl('https://example.com/'), 'other');
});

test('inspectTabWithDebugger attaches, reads runtime location and detaches', async () => {
  const calls = [];
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(target, version, cb) {
        calls.push(['attach', target.tabId, version]);
        cb();
      },
      sendCommand(target, method, params, cb) {
        calls.push(['sendCommand', target.tabId, method]);
        cb({ result: { value: { href: 'https://gemini.google.com/app/abc123456789' } } });
      },
      detach(target, cb) {
        calls.push(['detach', target.tabId]);
        cb();
      },
    },
  };

  const result = await inspectTabWithDebugger(42, { chromeApi });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 42);
  assert.equal(result.pageKind, 'gemini');
  assert.equal(result.url, 'https://gemini.google.com/app/abc123456789');
  assert.deepEqual(calls.map((call) => call[0]), ['attach', 'sendCommand', 'detach']);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/chrome-debugger-controller.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement controller**

Create `src/browser/background/chrome-debugger-controller.ts`:

```ts
export type BrowserPageKind = 'gemini' | 'my_activity' | 'google_login' | 'google_sorry' | 'other';

export type DebuggerTabInspection = Readonly<{
  ok: boolean;
  tabId: number;
  url: string | null;
  pageKind: BrowserPageKind;
  blockerCode: string | null;
  error?: string;
}>;

export const classifyBrowserUrl = (url: string | null | undefined): BrowserPageKind => {
  const value = String(url || '');
  if (value.startsWith('https://gemini.google.com/')) return 'gemini';
  if (value.startsWith('https://myactivity.google.com/product/gemini')) return 'my_activity';
  if (value.startsWith('https://accounts.google.com/')) return 'google_login';
  if (value.startsWith('https://www.google.com/sorry/')) return 'google_sorry';
  return 'other';
};

const blockerCodeForKind = (kind: BrowserPageKind): string | null => {
  if (kind === 'google_login') return 'google_login_required';
  if (kind === 'google_sorry') return 'google_verification_required';
  return null;
};

export const inspectTabWithDebugger = async (
  tabId: number,
  { chromeApi = globalThis.chrome, protocolVersion = '1.3' }: { chromeApi?: any; protocolVersion?: string } = {},
): Promise<DebuggerTabInspection> => {
  const target = { tabId };
  if (!Number.isInteger(tabId) || !chromeApi?.debugger) {
    return { ok: false, tabId, url: null, pageKind: 'other', blockerCode: null, error: 'debugger-api-unavailable' };
  }
  const invoke = (fn: (cb: (value?: any) => void) => void) =>
    new Promise<any>((resolve) => fn((value) => resolve(value)));
  try {
    await invoke((cb) => chromeApi.debugger.attach(target, protocolVersion, cb));
    const evaluated = await invoke((cb) =>
      chromeApi.debugger.sendCommand(
        target,
        'Runtime.evaluate',
        { expression: '({ href: location.href, readyState: document.readyState })', returnByValue: true },
        cb,
      ),
    );
    const url = evaluated?.result?.value?.href || null;
    const pageKind = classifyBrowserUrl(url);
    return { ok: true, tabId, url, pageKind, blockerCode: blockerCodeForKind(pageKind) };
  } catch (err) {
    return { ok: false, tabId, url: null, pageKind: 'other', blockerCode: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await invoke((cb) => chromeApi.debugger.detach(target, cb));
    } catch {
      // detach is best-effort
    }
  }
};
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run build:ts && node --test tests/chrome-debugger-controller.test.mjs tests/chrome-debugger-control.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/browser/background/chrome-debugger-controller.ts tests/chrome-debugger-controller.test.mjs
git commit -m "feat: add chrome debugger tab inspection"
```

## Task 6: Add Browser Session Broker With Branded Capabilities

**Files:**
- Create: `src/browser/background/browser-session-broker.ts`
- Create: `tests/browser-session-broker.test.mjs`
- Modify: `tests/mcp-command-lease-types.ts`

- [ ] **Step 1: Write broker tests**

Create `tests/browser-session-broker.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserTabs,
  claimDebuggableGeminiTab,
  getDebuggableGeminiTabs,
} from '../build/ts/browser/background/browser-session-broker.js';

const tab = {
  id: 42,
  windowId: 7,
  active: true,
  url: 'https://gemini.google.com/app/abc123456789',
  title: 'Gemini',
};

test('lists one debuggable Gemini tab from fresh debugger inspection', async () => {
  const result = await getDebuggableGeminiTabs([tab], {
    inspectTab: async () => ({
      ok: true,
      tabId: 42,
      url: tab.url,
      pageKind: 'gemini',
      blockerCode: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].tabId, 42);
});

test('ambiguous tabs block export until explicit claim', async () => {
  const result = await claimDebuggableGeminiTab([tab, { ...tab, id: 43 }], {
    inspectTab: async (tabId) => ({
      ok: true,
      tabId,
      url: `https://gemini.google.com/app/${tabId}abc123456789`,
      pageKind: 'gemini',
      blockerCode: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ambiguous_gemini_tabs');
});

test('google blocker returns typed blocker code', async () => {
  const classified = await classifyBrowserTabs([{ ...tab, url: 'https://www.google.com/sorry/index' }], {
    inspectTab: async () => ({
      ok: true,
      tabId: 42,
      url: 'https://www.google.com/sorry/index',
      pageKind: 'google_sorry',
      blockerCode: 'google_verification_required',
    }),
  });

  assert.equal(classified[0].state, 'blocked');
  assert.equal(classified[0].code, 'google_verification_required');
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/browser-session-broker.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement broker types and constructors**

Create `src/browser/background/browser-session-broker.ts`:

```ts
import { inspectTabWithDebugger, type DebuggerTabInspection } from './chrome-debugger-controller.js';

const INSPECTABLE_BROWSER_TAB: unique symbol = Symbol('InspectableBrowserTab');
const DEBUGGABLE_GEMINI_TAB: unique symbol = Symbol('DebuggableGeminiTab');
const CLAIMED_DEBUGGABLE_GEMINI_TAB: unique symbol = Symbol('ClaimedDebuggableGeminiTab');

export type RawBrowserTab = Readonly<{ id?: number; windowId?: number; active?: boolean; url?: string; title?: string }>;
export type InspectableBrowserTab = RawBrowserTab & Readonly<{ readonly [INSPECTABLE_BROWSER_TAB]: true; tabId: number }>;
export type DebuggableGeminiTab = InspectableBrowserTab & Readonly<{ readonly [DEBUGGABLE_GEMINI_TAB]: true; url: string }>;
export type ClaimedDebuggableGeminiTab = DebuggableGeminiTab & Readonly<{ readonly [CLAIMED_DEBUGGABLE_GEMINI_TAB]: true; claimId: string }>;

export type BrowserSessionBrokerOptions = Readonly<{
  inspectTab?: (tabId: number) => Promise<DebuggerTabInspection>;
  requestedTabId?: number | null;
  claimId?: string | null;
}>;

export const classifyBrowserTabs = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
) => {
  const inspectTab = options.inspectTab || ((tabId: number) => inspectTabWithDebugger(tabId));
  const result = [];
  for (const tab of tabs) {
    const tabId = Number(tab.id);
    if (!Number.isInteger(tabId)) {
      result.push({ state: 'uninspectable', code: 'missing_tab_id', tab });
      continue;
    }
    const inspection = await inspectTab(tabId);
    if (inspection.blockerCode) {
      result.push({ state: 'blocked', code: inspection.blockerCode, tab, inspection });
      continue;
    }
    if (inspection.pageKind !== 'gemini') {
      result.push({ state: 'not_gemini', code: 'page_not_gemini', tab, inspection });
      continue;
    }
    result.push({ state: 'debuggable', code: null, tab: { ...tab, tabId, url: inspection.url || tab.url || '' }, inspection });
  }
  return result;
};

export const getDebuggableGeminiTabs = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
) => {
  const classified = await classifyBrowserTabs(tabs, options);
  const debuggable = classified
    .filter((item) => item.state === 'debuggable')
    .map((item) => item.tab as DebuggableGeminiTab);
  return { ok: true, tabs: debuggable, classified };
};

export const claimDebuggableGeminiTab = async (
  tabs: readonly RawBrowserTab[],
  options: BrowserSessionBrokerOptions = {},
) => {
  const listed = await getDebuggableGeminiTabs(tabs, options);
  const candidates = options.requestedTabId
    ? listed.tabs.filter((candidate) => candidate.tabId === options.requestedTabId)
    : listed.tabs;
  if (candidates.length === 0) return { ok: false, code: 'no_debuggable_gemini_tab', tabs: listed.tabs };
  if (candidates.length > 1) return { ok: false, code: 'ambiguous_gemini_tabs', tabs: candidates };
  return {
    ok: true,
    tab: { ...candidates[0], claimId: options.claimId || crypto.randomUUID() } as ClaimedDebuggableGeminiTab,
  };
};
```

- [ ] **Step 4: Add compile-time rejection example**

In `tests/mcp-command-lease-types.ts`, add:

```ts
import type {
  ClaimedDebuggableGeminiTab,
  RawBrowserTab,
} from '../build/ts/browser/background/browser-session-broker.js';

declare function acceptsExportTab(tab: ClaimedDebuggableGeminiTab): void;

declare const rawTab: RawBrowserTab;
// @ts-expect-error raw browser tabs cannot start export workflows
acceptsExportTab(rawTab);
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/browser-session-broker.test.mjs
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/browser/background/browser-session-broker.ts tests/browser-session-broker.test.mjs tests/mcp-command-lease-types.ts
git commit -m "feat: add browser session broker capabilities"
```

## Task 7: Route Persistent Native Port Commands Through The Browser Broker

**Files:**
- Create: `src/browser/background/native-broker-client.ts`
- Modify: `src/extension-background.ts`
- Modify: `src/native/native-host-runtime.ts`
- Modify: `tests/native-host.test.mjs`
- Modify: `tests/chrome-extension-self-heal.test.mjs`

- [ ] **Step 1: Write static integration tests**

Add to `tests/native-host.test.mjs`:

```js
test('service worker opens persistent native broker port and exposes tab commands', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf-8');
  assert.match(source, /ensureNativeBrokerPort/);
  assert.match(source, /tabs\\.list/);
  assert.match(source, /tabs\\.claim/);
  assert.match(source, /claimDebuggableGeminiTab/);
  assert.match(source, /classifyBrowserTabs/);
});

test('native host forwards local ipc requests to the extension port', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'native', 'native-host-runtime.ts'), 'utf-8');
  assert.match(source, /pendingExtensionRequests/);
  assert.match(source, /sendToExtension/);
  assert.match(source, /extension\\.hello/);
  assert.match(source, /extension_unavailable/);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/native-host.test.mjs
```

Expected: FAIL because background does not keep a persistent native broker port
and native host runtime cannot forward IPC requests to the extension yet.

- [ ] **Step 3: Add extension-side persistent native port**

Create `src/browser/background/native-broker-client.ts`:

```ts
import type { NativeBrokerRequest, NativeBrokerResponse } from '../../native/protocol.js';
import {
  claimDebuggableGeminiTab,
  classifyBrowserTabs,
  type RawBrowserTab,
} from './browser-session-broker.js';

export type NativeBrowserBrokerCommand = Readonly<{
  command: 'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release';
  payload?: { tabId?: number; claimId?: string };
}>;

export const handleNativeBrowserBrokerCommand = async (
  request: NativeBrowserBrokerCommand,
  chromeApi: any = globalThis.chrome,
) => {
  const tabs = await new Promise<RawBrowserTab[]>((resolve) => {
    chromeApi.tabs.query(
      {
        url: [
          'https://gemini.google.com/*',
          'https://accounts.google.com/*',
          'https://www.google.com/sorry/*',
        ],
      },
      (items: RawBrowserTab[] = []) => resolve(items),
    );
  });
  if (request.command === 'tabs.list' || request.command === 'tabs.status') {
    return { ok: true, tabs: await classifyBrowserTabs(tabs) };
  }
  if (request.command === 'tabs.claim') {
    return claimDebuggableGeminiTab(tabs, {
      requestedTabId: request.payload?.tabId || null,
      claimId: request.payload?.claimId || null,
    });
  }
  return { ok: true, released: true, claimId: request.payload?.claimId || null };
};

export const createNativeBrokerPort = ({
  chromeApi = globalThis.chrome,
  hostName,
  onStatus,
}: {
  chromeApi?: any;
  hostName: string;
  onStatus?: (status: unknown) => void;
}) => {
  let port: any = null;
  const connect = () => {
    port = chromeApi.runtime.connectNative(hostName);
    port.onMessage.addListener(async (message: NativeBrokerRequest) => {
      const result = await handleNativeBrowserBrokerCommand(
        {
          command: message.command as NativeBrowserBrokerCommand['command'],
          payload: message.payload as NativeBrowserBrokerCommand['payload'],
        },
        chromeApi,
      );
      const response: NativeBrokerResponse = { id: message.id, ok: true, result };
      port.postMessage(response);
    });
    port.onDisconnect.addListener(() => {
      onStatus?.({ ok: false, code: 'native_broker_disconnected' });
      port = null;
    });
    port.postMessage({
      id: `extension-${Date.now()}`,
      protocolVersion: 1,
      command: 'extension.hello',
      payload: { source: 'extension-background' },
    });
    onStatus?.({ ok: true, connected: true });
    return port;
  };
  return {
    ensureConnected: () => port || connect(),
    disconnect: () => {
      port?.disconnect?.();
      port = null;
    },
  };
};
```

- [ ] **Step 4: Import the persistent port in `src/extension-background.ts`**

Add an import:

```ts
import { createNativeBrokerPort } from './browser/background/native-broker-client.js';
```

Create the background-level port:

```ts
const nativeBrokerPort = createNativeBrokerPort({
  chromeApi: chrome,
  hostName: NATIVE_HOST_NAME,
  onStatus: (status) => {
    lastNativeHostProbe = {
      ...(lastNativeHostProbe || {}),
      nativeBroker: status,
      checkedAt: new Date().toISOString(),
    };
  },
});
```

Ensure it starts from existing native health/self-heal paths, not from every
content-script heartbeat:

```ts
const ensureNativeBrokerPort = ({ reason = 'manual' } = {}) => {
  try {
    const port = nativeBrokerPort.ensureConnected();
    return { ok: true, reason, connected: !!port };
  } catch (err) {
    return { ok: false, reason, error: err?.message || String(err) };
  }
};
```

- [ ] **Step 5: Add host-side forwarding to the extension port**

In `src/native/native-host-runtime.ts`, add a pending request map. Native
Messaging is initiated by the extension; MCP/CLI reaches the same native host
through local IPC, and the native host forwards tab commands over the already
open extension port.

```ts
const pendingExtensionRequests = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
>();
let extensionWrite: ((message: unknown) => void) | null = null;
let extensionConnected = false;

const sendToExtension = (request: NativeBrokerRequest, timeoutMs = 5000): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (!extensionWrite || !extensionConnected) {
      reject(new Error('extension_unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      pendingExtensionRequests.delete(request.id);
      reject(new Error('extension_request_timeout'));
    }, timeoutMs);
    pendingExtensionRequests.set(request.id, { resolve, reject, timer });
    extensionWrite(request);
  });

const handleMessageFromExtension = async (
  message: NativeBrokerRequest | NativeBrokerResponse,
) => {
  if ('ok' in message) {
    const pending = pendingExtensionRequests.get(message.id);
    if (pending) {
      pendingExtensionRequests.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return null;
    }
  }
  if ('command' in message && message.command === 'extension.hello') {
    extensionConnected = true;
    return nativeBrokerOk(message, { connected: true });
  }
  return handle(message as NativeBrokerRequest);
};
```

After the native host `write` function is created, assign it:

```ts
extensionWrite = write;
```

In the local IPC `handleRequest`, forward tab commands:

```ts
if (String(request.command).startsWith('tabs.')) {
  return (await sendToExtension(request)) as NativeBrokerResponse;
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/native-host.test.mjs tests/chrome-extension-self-heal.test.mjs tests/browser-session-broker.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/browser/background/native-broker-client.ts src/extension-background.ts src/native/native-host-runtime.ts tests/native-host.test.mjs tests/chrome-extension-self-heal.test.mjs
git commit -m "feat: route native tab commands through browser broker"
```

## Task 8: Add MCP-Side Native Browser Broker Adapter

**Files:**
- Create: `src/mcp/native-browser-broker.ts`
- Create: `tests/native-browser-broker.test.mjs`
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-command-channel.test.mjs`

- [ ] **Step 1: Write adapter tests**

Create `tests/native-browser-broker.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNativeBrowserBrokerClient,
  shouldUseNativeBrowserBroker,
} from '../build/ts/mcp/native-browser-broker.js';

test('native broker is preferred unless explicitly disabled', () => {
  assert.equal(shouldUseNativeBrowserBroker({ disabled: false }), true);
  assert.equal(shouldUseNativeBrowserBroker({ disabled: true }), false);
});

test('native broker client maps failed ipc to fallback-ready error', async () => {
  const client = createNativeBrowserBrokerClient({
    request: async () => {
      throw new Error('socket missing');
    },
  });

  const response = await client.listTabs({ allowFallback: true });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'native_broker_unavailable');
  assert.equal(response.allowFallback, true);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run build:ts && node --test tests/native-browser-broker.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement MCP adapter**

Create `src/mcp/native-browser-broker.ts`:

```ts
import { defaultBrokerIpcPath, requestBrokerIpc } from '../native/local-ipc.js';
import { makeNativeRequest } from '../native/protocol.js';

export const shouldUseNativeBrowserBroker = ({
  disabled = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER === 'disabled',
}: { disabled?: boolean } = {}): boolean => disabled !== true;

export const createNativeBrowserBrokerClient = ({
  path = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(),
  request = (nativeRequest: ReturnType<typeof makeNativeRequest>) => requestBrokerIpc(path, nativeRequest),
} = {}) => {
  const call = async (command: 'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release', payload = {}, options = {}) => {
    try {
      return await request(makeNativeRequest(command, payload));
    } catch (err) {
      return {
        ok: false,
        code: 'native_broker_unavailable',
        error: err instanceof Error ? err.message : String(err),
        allowFallback: options.allowFallback === true,
      };
    }
  };
  return {
    listTabs: (options = {}) => call('tabs.list', {}, options),
    status: (options = {}) => call('tabs.status', {}, options),
    claim: (payload = {}, options = {}) => call('tabs.claim', payload, options),
    release: (payload = {}, options = {}) => call('tabs.release', payload, options),
  };
};
```

- [ ] **Step 4: Wire `src/mcp-server.js` to try native broker first**

Import compiled module:

```js
import {
  createNativeBrowserBrokerClient,
  shouldUseNativeBrowserBroker,
} from './build/ts/mcp/native-browser-broker.js';
```

At `gemini_tabs` list/status/claim entrypoints, call the native broker first when enabled. Preserve existing HTTP/client lifecycle fallback only if the native response is unavailable and the caller did not require native:

```js
const nativeBroker = createNativeBrowserBrokerClient();
const nativeTabs = shouldUseNativeBrowserBroker()
  ? await nativeBroker.listTabs({ allowFallback: true })
  : null;
if (nativeTabs?.ok === true) return nativeTabs.result || nativeTabs;
if (nativeTabs && nativeTabs.allowFallback !== true) return nativeTabs;
```

- [ ] **Step 5: Add static guard test**

In `tests/mcp-command-channel.test.mjs`, assert:

```js
assert.match(source, /createNativeBrowserBrokerClient/);
assert.match(source, /shouldUseNativeBrowserBroker/);
assert.doesNotMatch(source, /lastHeartbeatAt[^\\n]+claimGeminiTabForClient/);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/native-browser-broker.test.mjs tests/mcp-command-channel.test.mjs tests/mcp-tab-runtime.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/native-browser-broker.ts src/mcp-server.js tests/native-browser-broker.test.mjs tests/mcp-command-channel.test.mjs
git commit -m "feat: prefer native browser broker in mcp tabs"
```

## Task 9: Gate Export Job Creation On Claimed Debuggable Tabs

**Files:**
- Modify: `src/mcp/export-workflows.ts`
- Modify: `src/mcp-server.js`
- Modify: `tests/mcp-export-workflows.test.mjs`
- Modify: `tests/mcp-command-lease-types.ts`

- [ ] **Step 1: Write failing export gate test**

Add to `tests/mcp-export-workflows.test.mjs`:

```js
test('export workflow rejects unclaimed native broker tabs', () => {
  assert.throws(
    () =>
      validateExportTabLease({
        tabId: 42,
        url: 'https://gemini.google.com/app/abc123456789',
      }),
    /claimed_debuggable_tab_required/,
  );
});
```

- [ ] **Step 2: Add compile-time type test**

In `tests/mcp-command-lease-types.ts`:

```ts
import type {
  ClaimedDebuggableGeminiTab,
  DebuggableGeminiTab,
} from '../build/ts/browser/background/browser-session-broker.js';

declare function startNativeExport(tab: ClaimedDebuggableGeminiTab): void;
declare const debuggable: DebuggableGeminiTab;

// @ts-expect-error export requires an explicit claim
startNativeExport(debuggable);
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npm run build:ts
node --test tests/mcp-export-workflows.test.mjs
npm run typecheck
```

Expected: runtime test fails because `validateExportTabLease` is missing.

- [ ] **Step 4: Add export lease validator**

In `src/mcp/export-workflows.ts`, export:

```ts
export const validateExportTabLease = (tab: unknown) => {
  const value = tab as { claimId?: string; tabId?: number; url?: string } | null;
  if (!value?.claimId || !Number.isInteger(value.tabId) || !String(value.url || '').startsWith('https://gemini.google.com/')) {
    throw Object.assign(new Error('claimed_debuggable_tab_required'), {
      code: 'claimed_debuggable_tab_required',
    });
  }
  return value;
};
```

- [ ] **Step 5: Revalidate before export jobs**

In `src/mcp-server.js`, before creating a browser export job, require a native claim result when native broker is enabled:

```js
const nativeClaim = shouldUseNativeBrowserBroker()
  ? await nativeBroker.claim({ tabId: args.tabId, claimId: args.claimId }, { allowFallback: false })
  : null;
if (nativeClaim?.ok === false) return nativeClaim;
const exportTabLease = nativeClaim?.ok === true
  ? validateExportTabLease(nativeClaim.result?.tab || nativeClaim.result)
  : legacyClaimedReadyTab;
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:ts
node --test tests/mcp-export-workflows.test.mjs tests/mcp-command-channel.test.mjs
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/export-workflows.ts src/mcp-server.js tests/mcp-export-workflows.test.mjs tests/mcp-command-lease-types.ts
git commit -m "feat: require native claimed tab for export jobs"
```

## Task 10: Preserve Non-Intrusive CLI Defaults And Diagnostics

**Files:**
- Modify: `bin/gemini-md-export.mjs`
- Modify: `tests/gemini-cli-tui.test.mjs`
- Modify: `tests/browser-smoke.test.mjs`

- [ ] **Step 1: Write CLI assertions**

Add to `tests/gemini-cli-tui.test.mjs`:

```js
test('CLI browser status keeps native broker checks non-intrusive by default', async () => {
  const requests = [];
  const server = await createMockBridgeServer((req, res) => {
    requests.push(new URL(req.url, 'http://127.0.0.1'));
    res.end(JSON.stringify({ ok: false, blockingIssue: 'native_broker_unavailable' }));
  });

  const result = await runCli(['browser', 'status', '--plain', '--result-json'], {
    env: { GEMINI_MD_EXPORT_BRIDGE_URL: server.url },
  });

  assert.match(result.stdout, /RESULT_JSON/);
  assert.equal(requests.every((url) => url.searchParams.get('wakeBrowser') === 'false'), true);
  assert.equal(requests.every((url) => url.searchParams.get('activateTab') === 'false'), true);
  assert.equal(requests.every((url) => url.searchParams.get('focusWindow') === 'false'), true);
});
```

- [ ] **Step 2: Run failing or existing test**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs
```

Expected: may fail until CLI includes native broker diagnostics in result JSON.

- [ ] **Step 3: Add compact native broker status**

In `bin/gemini-md-export.mjs`, add native status to `browser status` output:

```js
nativeBroker: {
  enabled: parsed.flags.nativeBroker !== false,
  source: ready.nativeBroker?.source || 'unknown',
  status: ready.nativeBroker?.status || ready.blockingIssue || 'unknown',
}
```

Do not change default flags:

```js
wakeBrowser: false,
activateTab: false,
focusWindow: false,
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/gemini-cli-tui.test.mjs tests/browser-smoke.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bin/gemini-md-export.mjs tests/gemini-cli-tui.test.mjs tests/browser-smoke.test.mjs
git commit -m "feat: report native broker status non-intrusively"
```

## Task 11: Build, Bundle, And Manifest Verification

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `tests/gemini-cli-extension.test.mjs`
- Modify: `tests/native-host.test.mjs`
- Modify: `tests/chrome-extension-self-heal.test.mjs`

- [ ] **Step 1: Add bundle tests**

Add assertions to `tests/gemini-cli-extension.test.mjs`:

```js
assert.equal(existsSync(resolve(extensionDir, 'build', 'ts', 'native', 'protocol.js')), true);
assert.equal(existsSync(resolve(extensionDir, 'build', 'ts', 'native', 'local-ipc.js')), true);
assert.equal(existsSync(resolve(extensionDir, 'build', 'ts', 'browser', 'background', 'browser-session-broker.js')), true);
assert.equal(existsSync(resolve(extensionDir, 'browser-extension', 'native', 'protocol.js')), true);
assert.equal(existsSync(resolve(extensionDir, 'browser-extension', 'browser', 'background', 'native-broker-client.js')), true);
```

Add manifest assertions:

```js
assert.ok(browserManifest.permissions.includes('nativeMessaging'));
assert.ok(browserManifest.permissions.includes('debugger'));
assert.ok(browserManifest.permissions.includes('tabs'));
```

- [ ] **Step 2: Run build test**

Run:

```bash
npm run build
node --test tests/gemini-cli-extension.test.mjs tests/native-host.test.mjs
```

Expected: all pass.

- [ ] **Step 3: Fix build copying only if tests fail**

If a Gemini CLI bundle file is missing, add explicit `cpSync` from `build/ts` to
`dist/gemini-cli-extension/build/ts`. If an MV3 background import is missing,
copy `build/ts/native/**` to `dist/extension/native/**` and
`build/ts/browser/background/**` to `dist/extension/browser/background/**`.
Do not copy `docs/superpowers/**` into the user bundle.

- [ ] **Step 4: Run focused tests again**

Run:

```bash
npm run build
node --test tests/gemini-cli-extension.test.mjs tests/native-host.test.mjs tests/chrome-extension-self-heal.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/build.mjs tests/gemini-cli-extension.test.mjs tests/native-host.test.mjs tests/chrome-extension-self-heal.test.mjs
git commit -m "test: verify native broker bundle assets"
```

## Task 12: Full Verification And Main Integration Gate

**Files:**
- No source files unless verification exposes a bug.

- [ ] **Step 1: Reconcile with `origin/main` before final smoke**

Run:

```bash
git fetch origin main
git rev-list --left-right --count origin/main...HEAD
```

Expected: know whether the branch is still divergent. If `origin/main` has commits not in this branch, merge or rebase before live browser smoke.

- [ ] **Step 2: Run static and unit gates**

Run:

```bash
npm run build:ts
npm run typecheck
npm run check
npm test
```

Expected: all pass.

- [ ] **Step 3: Run bridge smoke without real browser automation**

Run:

```bash
node scripts/bridge-smoke.mjs --spawn --json
```

Expected: pass. This validates infrastructure without logging into Gemini Web or touching existing tabs.

- [ ] **Step 4: Run non-intrusive browser status**

Run only with no focus/activation/open flags:

```bash
node bin/gemini-md-export.mjs browser status --plain --result-json --no-wake --no-activate-tab --no-focus-window --no-reload --ready-wait-ms 5000
```

Expected: either ready native broker status or a typed blocker. It must not open, focus, or activate a browser tab.

- [ ] **Step 5: Run real export smoke only when target is explicit**

If multiple Gemini tabs exist, first claim the intended tab explicitly. Then run the smoke with a claimed target. If no Gemini tab exists and the user approves wake/open behavior, use explicit wake/open flags.

Expected: 50-chat export completes with receipts, or fails with one of:

- `ambiguous_gemini_tabs`
- `google_verification_required`
- `google_login_required`
- `claimed_debuggable_tab_required`
- `native_broker_unavailable`

It must not silently switch tabs, lose progress, or report success on partial export.

- [ ] **Step 6: Commit final fixes through the owning task**

If verification required fixes:

```bash
git status --short
```

Return to the task that owns the failing file, apply the fix there, rerun that
task's focused tests, and create a targeted commit with the file paths from
`git status --short`. If no fixes were required, do not create an empty commit.
