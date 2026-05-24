import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BUDGET_PATH = resolve(ROOT, 'tests', 'fixtures', 'javascript-surface-budget.json');
const ROOTS = ['bin', 'debug', 'gemini-cli-extension', 'scripts', 'src'];
const IGNORED_DIRS = new Set(['build', 'dist', 'node_modules']);

const isJavaScriptSource = (path) => /\.(?:mjs|js)$/i.test(path);

const syntaxNodeCount = (filePath) => {
  const text = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let count = 0;
  const visit = (node) => {
    count += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return count;
};

const collectProductionJavaScript = (dir, files = []) => {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir).sort()) {
    const path = resolve(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(name)) collectProductionJavaScript(path, files);
      continue;
    }
    if (stat.isFile() && isJavaScriptSource(path)) files.push(path);
  }
  return files;
};

test('production JavaScript syntax surface cannot grow', () => {
  assert.equal(existsSync(BUDGET_PATH), true, 'missing JavaScript surface budget fixture');
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf-8'));
  const actualFiles = ROOTS.flatMap((root) => collectProductionJavaScript(resolve(ROOT, root)))
    .map((path) => relative(ROOT, path))
    .sort();
  const actual = Object.fromEntries(
    actualFiles.map((path) => [path, syntaxNodeCount(resolve(ROOT, path))]),
  );

  const budgetFiles = budget.syntaxNodes || {};
  const newFiles = actualFiles.filter((path) => !(path in budgetFiles));
  assert.deepEqual(newFiles, [], 'new production JS/MJS files must be implemented in TypeScript');

  for (const [path, maxNodes] of Object.entries(budgetFiles)) {
    if (!(path in actual)) continue;
    assert.ok(
      actual[path] <= maxNodes,
      `${path} grew from budget ${maxNodes} to ${actual[path]} syntax nodes; move logic to TypeScript instead`,
    );
  }

  const total = Object.values(actual).reduce((sum, value) => sum + value, 0);
  assert.ok(
    total <= budget.maxTotalSyntaxNodes,
    `production JS/MJS surface grew from budget ${budget.maxTotalSyntaxNodes} to ${total} syntax nodes`,
  );
});
