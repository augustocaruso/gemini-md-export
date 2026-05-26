import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  looksLikeManagedClaimGroupTitle,
} from '../build/ts/browser/background/tab-claim-managed-group.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('managed claim group title accepts exporter labels and rejects user labels', () => {
  assert.equal(looksLikeManagedClaimGroupTitle('Export 30'), true);
  assert.equal(looksLikeManagedClaimGroupTitle('Gemini Export'), true);
  assert.equal(looksLikeManagedClaimGroupTitle('📥 Exportando'), true);
  assert.equal(looksLikeManagedClaimGroupTitle('Receitas'), false);
});

test('extension background uses the typed managed claim group predicate', () => {
  const source = readFileSync(resolve(ROOT, 'src', 'extension-background.ts'), 'utf8');

  assert.match(source, /tab-claim-managed-group/);
  assert.doesNotMatch(source, /const looksLikeManagedClaimGroupTitle = \(title\) =>/);
});
