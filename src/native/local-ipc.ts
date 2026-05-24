import { existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNativeFrameBuffer, encodeNativeFrame } from './frame.js';
import type { NativeBrokerRequest, NativeBrokerResponse } from './protocol.js';

export const defaultBrokerIpcPath = ({
  platform = process.platform,
  runtimeDir = process.env.XDG_RUNTIME_DIR || tmpdir(),
}: {
  platform?: NodeJS.Platform | string;
  runtimeDir?: string;
} = {}): string => {
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
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
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
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Native broker IPC timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(encodeNativeFrame(request)));
    socket.on('data', (chunk: Buffer) => {
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
