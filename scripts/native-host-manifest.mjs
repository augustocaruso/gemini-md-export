#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeHostManifestCli } from '../build/ts/native/native-host-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

process.exitCode = runNativeHostManifestCli({
  argv: process.argv.slice(2),
  root,
});
