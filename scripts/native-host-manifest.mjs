#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOST_NAME = 'com.augustocaruso.gemini_md_export';
const TEMPLATE_PATH = resolve(
  ROOT,
  'native-messaging',
  'com.augustocaruso.gemini_md_export.template.json',
);

const args = process.argv.slice(2);
const argValue = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
const hasFlag = (name) => args.includes(name);

const usage = () => [
  'native-host-manifest',
  '',
  'Uso:',
  '  node scripts/native-host-manifest.mjs --extension-id <id> [--browser chrome|edge|brave] [--install|--print]',
  '',
  'Gera o manifesto Native Messaging para o host com.augustocaruso.gemini_md_export.',
].join('\n');

const browser = String(argValue('--browser', 'chrome')).toLowerCase();
const extensionId = String(argValue('--extension-id', '')).trim();
if (hasFlag('--help') || !extensionId) {
  console.log(usage());
  process.exit(extensionId ? 0 : 64);
}

const nativeHostPath = resolve(ROOT, 'bin', 'gemini-md-export-native-host.mjs');
const manifest = JSON.parse(
  readFileSync(TEMPLATE_PATH, 'utf-8')
    .replace(/__ABSOLUTE_PATH_TO_GEMINI_MD_EXPORT_NATIVE_HOST__/g, nativeHostPath)
    .replace(/__EXTENSION_ID__/g, extensionId),
);

const macNativeHostDir = () => {
  const appName =
    browser === 'edge'
      ? 'Microsoft Edge'
      : browser === 'brave'
        ? 'BraveSoftware/Brave-Browser'
        : 'Google/Chrome';
  return resolve(homedir(), 'Library', 'Application Support', appName, 'NativeMessagingHosts');
};

const windowsRegistryKey = () => {
  if (browser === 'edge') {
    return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;
  }
  if (browser === 'brave') {
    return `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`;
  }
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
};

const printManifest = () => {
  console.log(JSON.stringify(manifest, null, 2));
};

const installManifest = () => {
  if (platform() === 'darwin') {
    const dir = macNativeHostDir();
    mkdirSync(dir, { recursive: true });
    const target = resolve(dir, `${HOST_NAME}.json`);
    writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(target);
    return;
  }

  if (platform() === 'win32') {
    const dir = resolve(process.env.LOCALAPPDATA || homedir(), 'gemini-md-export', 'NativeMessagingHosts');
    mkdirSync(dir, { recursive: true });
    const target = resolve(dir, `${HOST_NAME}.json`);
    writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    const key = windowsRegistryKey();
    const result = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', target, '/f'], {
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status || 1);
    console.log(target);
    return;
  }

  printManifest();
};

if (hasFlag('--install')) {
  installManifest();
} else {
  printManifest();
}
