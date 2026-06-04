import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

const staticImports = (source) => {
  const imports = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?/gm)) {
    imports.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push(match[1]);
  }
  return imports;
};

const isLocalBrowserImport = (specifier) =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');

const collectMissingStaticImports = (entryPath, seen = new Set()) => {
  if (seen.has(entryPath)) return [];
  seen.add(entryPath);

  const source = readFileSync(entryPath, 'utf-8');
  const missing = [];
  for (const specifier of staticImports(source).filter(isLocalBrowserImport)) {
    const resolved = resolve(dirname(entryPath), specifier);
    if (!existsSync(resolved)) {
      missing.push(resolved);
      continue;
    }
    missing.push(...collectMissingStaticImports(resolved, seen));
  }
  return missing;
};

const collectBareStaticImports = (entryPath, seen = new Set()) => {
  if (seen.has(entryPath)) return [];
  seen.add(entryPath);

  const source = readFileSync(entryPath, 'utf-8');
  const bare = [];
  for (const specifier of staticImports(source)) {
    if (!isLocalBrowserImport(specifier)) {
      bare.push({ file: entryPath, specifier });
      continue;
    }

    const resolved = resolve(dirname(entryPath), specifier);
    if (existsSync(resolved)) {
      bare.push(...collectBareStaticImports(resolved, seen));
    }
  }
  return bare;
};

const extensionBackgroundEntries = [
  resolve(ROOT, 'dist', 'extension', 'background.js'),
  resolve(ROOT, 'dist', 'gemini-cli-extension', 'browser-extension', 'background.js'),
];

const collectJavaScriptFiles = (directory) => {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...collectJavaScriptFiles(path));
      continue;
    }
    if (entry.isFile() && path.endsWith('.js')) output.push(path);
  }
  return output;
};

const collectBareImportsInFile = (filePath) =>
  staticImports(readFileSync(filePath, 'utf-8'))
    .filter((specifier) => !isLocalBrowserImport(specifier))
    .map((specifier) => ({ file: filePath, specifier }));

const extensionPackageDirs = [
  resolve(ROOT, 'dist', 'extension'),
  resolve(ROOT, 'dist', 'gemini-cli-extension', 'browser-extension'),
];

test('extension background bundles include every static local import they reference', () => {
  for (const backgroundPath of extensionBackgroundEntries) {
    assert.deepEqual(collectMissingStaticImports(backgroundPath), []);
  }
});

test('extension background bundles do not reference bare module specifiers', () => {
  for (const backgroundPath of extensionBackgroundEntries) {
    assert.deepEqual(collectBareStaticImports(backgroundPath), []);
  }
});

test('extension browser packages do not ship JavaScript with bare module specifiers', () => {
  for (const packageDir of extensionPackageDirs) {
    const bareImports = collectJavaScriptFiles(packageDir).flatMap(collectBareImportsInFile);
    assert.deepEqual(bareImports, []);
  }
});

test('generated browser extension bundles are valid JavaScript', () => {
  const generatedScripts = [
    resolve(ROOT, 'dist', 'extension', 'content.js'),
    resolve(ROOT, 'dist', 'extension', 'background.js'),
    resolve(ROOT, 'dist', 'gemini-cli-extension', 'browser-extension', 'content.js'),
    resolve(ROOT, 'dist', 'gemini-cli-extension', 'browser-extension', 'background.js'),
  ];

  for (const scriptPath of generatedScripts) {
    const result = spawnSync(process.execPath, ['--check', scriptPath], {
      encoding: 'utf-8',
    });

    assert.equal(
      result.status,
      0,
      `${scriptPath} failed node --check\n${result.stderr || result.stdout}`,
    );
  }
});
