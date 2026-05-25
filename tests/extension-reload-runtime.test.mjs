import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extensionReloadAssumedResultForError,
  isExtensionContextInvalidatedError,
} from '../build/ts/mcp/extension-reload-runtime.js';

test('erro de contexto invalidado conta como reload automatico em andamento', () => {
  const error = new Error('Extension context invalidated.');

  assert.equal(isExtensionContextInvalidatedError(error), true);
  assert.deepEqual(extensionReloadAssumedResultForError(error), {
    ok: true,
    reloading: true,
    assumed: true,
    reason: 'extension-context-invalidated',
    detail: 'Extension context invalidated.',
  });
});

test('erro comum nao e convertido em reload assumido', () => {
  const error = new Error('tab_operation_in_progress');

  assert.equal(isExtensionContextInvalidatedError(error), false);
  assert.equal(extensionReloadAssumedResultForError(error), null);
});
