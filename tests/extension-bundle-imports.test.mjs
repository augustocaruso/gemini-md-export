import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

const staticRelativeImports = (source) =>
  Array.from(source.matchAll(/\bimport\s+(?:[^'"]+\s+from\s+)?['"](\.[^'"]+)['"]/g)).map(
    (match) => match[1],
  );

const collectMissingStaticImports = (entryPath, seen = new Set()) => {
  if (seen.has(entryPath)) return [];
  seen.add(entryPath);

  const source = readFileSync(entryPath, 'utf-8');
  const missing = [];
  for (const specifier of staticRelativeImports(source)) {
    const resolved = resolve(dirname(entryPath), specifier);
    if (!existsSync(resolved)) {
      missing.push(resolved);
      continue;
    }
    missing.push(...collectMissingStaticImports(resolved, seen));
  }
  return missing;
};

test('extension background bundle includes every static relative import it references', () => {
  const backgroundPath = resolve(ROOT, 'dist', 'extension', 'background.js');

  assert.deepEqual(collectMissingStaticImports(backgroundPath), []);
});
