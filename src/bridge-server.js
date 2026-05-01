#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpServerPath = resolve(__dirname, 'mcp-server.js');
const args = process.argv.slice(2);

process.argv = [
  process.argv[0],
  mcpServerPath,
  ...(args.includes('--bridge-only') ? args : ['--bridge-only', ...args]),
];

await import('./mcp-server.js');
