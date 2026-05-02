#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_BRIDGE_URL = process.env.GEMINI_MD_EXPORT_BRIDGE_URL || 'http://127.0.0.1:47283';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const NATIVE_PROTOCOL_VERSION = 1;

let bridgeProcess = null;
let inputBuffer = Buffer.alloc(0);

const readPackageVersion = () => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const VERSION = readPackageVersion();

const makeError = (code, message, data = {}) => ({
  ok: false,
  code,
  error: message,
  ...data,
});

const writeNativeMessage = (message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
};

const safeJsonParse = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch (err) {
    return makeError('invalid_json', err?.message || String(err));
  }
};

const readNativeMessages = (chunk, onMessage) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const size = inputBuffer.readUInt32LE(0);
    if (size > 16 * 1024 * 1024) {
      inputBuffer = Buffer.alloc(0);
      onMessage(makeError('message_too_large', `Mensagem native muito grande: ${size} bytes.`));
      return;
    }
    if (inputBuffer.length < 4 + size) return;
    const payload = inputBuffer.subarray(4, 4 + size);
    inputBuffer = inputBuffer.subarray(4 + size);
    onMessage(safeJsonParse(payload));
  }
};

const withTimeout = async (promise, timeoutMs, message = 'Timeout falando com native host.') => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise(controller.signal);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(message);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const bridgeFetch = async ({
  bridgeUrl = DEFAULT_BRIDGE_URL,
  path = '/healthz',
  method = 'GET',
  payload = undefined,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) => {
  if (!String(path || '').startsWith('/')) {
    return makeError('invalid_path', 'Caminho da bridge precisa começar com /.');
  }
  const url = new URL(path, bridgeUrl);
  try {
    return await withTimeout(
      async (signal) => {
        const response = await fetch(url, {
          method,
          headers: payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        return {
          ok: response.ok,
          status: response.status,
          data,
          text: response.ok ? undefined : text,
        };
      },
      Math.max(100, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS),
      `Timeout falando com a bridge em ${timeoutMs}ms.`,
    );
  } catch (err) {
    return makeError('bridge_fetch_failed', err?.message || String(err), {
      bridgeUrl,
      path,
    });
  }
};

const startBridge = ({
  host = '127.0.0.1',
  port = 47283,
  keepAliveMs = 900_000,
  exitWhenIdle = true,
} = {}) => {
  if (bridgeProcess && !bridgeProcess.killed && bridgeProcess.exitCode === null) {
    return {
      ok: true,
      alreadyRunning: true,
      pid: bridgeProcess.pid,
    };
  }

  const args = [
    resolve(__dirname, 'bridge-server.js'),
    '--bridge-only',
    '--host',
    String(host),
    '--port',
    String(port),
    '--keep-alive-ms',
    String(keepAliveMs),
  ];
  if (exitWhenIdle) args.push('--exit-when-idle');

  bridgeProcess = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  bridgeProcess.unref();
  return {
    ok: true,
    started: true,
    pid: bridgeProcess.pid,
    host,
    port,
  };
};

const handleCommand = async (message = {}) => {
  if (message?.ok === false && message.code) return message;
  const command = String(message.command || message.type || '').trim();
  const payload = message.payload || {};

  if (command === 'ping') {
    return {
      ok: true,
      transport: 'nativeMessaging',
      nativeProtocolVersion: NATIVE_PROTOCOL_VERSION,
      version: VERSION,
      pid: process.pid,
      node: process.version,
    };
  }

  if (command === 'healthz') {
    return bridgeFetch({
      bridgeUrl: payload.bridgeUrl || DEFAULT_BRIDGE_URL,
      path: '/healthz',
      timeoutMs: payload.timeoutMs || 2500,
    });
  }

  if (command === 'ready') {
    const params = new URLSearchParams({
      detail: payload.detail || 'compact',
      wakeBrowser: payload.wakeBrowser === true ? 'true' : 'false',
      selfHeal: payload.selfHeal === true ? 'true' : 'false',
    });
    return bridgeFetch({
      bridgeUrl: payload.bridgeUrl || DEFAULT_BRIDGE_URL,
      path: `/agent/ready?${params.toString()}`,
      timeoutMs: payload.timeoutMs || 5000,
    });
  }

  if (command === 'startBridge') {
    return startBridge(payload);
  }

  if (command === 'proxyHttp') {
    return bridgeFetch({
      bridgeUrl: payload.bridgeUrl || DEFAULT_BRIDGE_URL,
      path: payload.path || '/',
      method: payload.method || 'GET',
      payload: payload.payload,
      timeoutMs: payload.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  return makeError('unknown_command', `Comando native desconhecido: ${command || '(vazio)'}`);
};

const handleNativeMessage = async (message) => {
  const id = message?.id ?? null;
  try {
    const result = await handleCommand(message);
    writeNativeMessage({ id, ...result });
  } catch (err) {
    writeNativeMessage({
      id,
      ...makeError('native_host_error', err?.message || String(err)),
    });
  }
};

process.stdin.on('data', (chunk) => {
  readNativeMessages(chunk, (message) => {
    handleNativeMessage(message);
  });
});

process.stdin.on('end', () => {
  process.exit(0);
});
