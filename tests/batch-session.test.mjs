import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createBatchExportSession,
  normalizeBatchExportSession,
  serializeConversationItem,
} from '../src/batch-session.mjs';

test('serializeConversationItem: mantém apenas campos relevantes', () => {
  assert.deepEqual(
    serializeConversationItem({
      id: 'c_123',
      title: 'Chat',
      url: 'https://gemini.google.com/app/123',
      ignored: 'x',
    }),
    {
      id: 'c_123',
      title: 'Chat',
      url: 'https://gemini.google.com/app/123',
    },
  );
});

test('createBatchExportSession: cria sessão serializável para retomar lote', () => {
  const session = createBatchExportSession({
    items: [
      { id: 'c_1', title: 'Um', source: 'notebook', notebookUrl: 'https://gemini.google.com/notebook/x' },
      { id: 'c_2', title: 'Dois', source: 'notebook' },
    ],
    originalWasNotebook: true,
    originalNotebookReturnItem: { id: 'c_1', title: 'Um', source: 'notebook' },
  });

  assert.equal(session.kind, 'batch-export');
  assert.equal(session.nextIndex, 0);
  assert.equal(session.items.length, 2);
  assert.equal(session.originalWasNotebook, true);
  assert.deepEqual(session.failureIds, []);
});

test('normalizeBatchExportSession: saneia nextIndex e itens inválidos', () => {
  const normalized = normalizeBatchExportSession({
    kind: 'batch-export',
    nextIndex: 99,
    failureIds: [1, 'x'],
    items: [{ id: 'c_1', title: 'Um' }, null],
  });

  assert.deepEqual(normalized, {
    kind: 'batch-export',
    version: 1,
    createdAt: normalized.createdAt,
    nextIndex: 1,
    failureIds: ['1', 'x'],
    originalWasNotebook: false,
    originalItem: null,
    originalNotebookReturnItem: null,
    items: [{ id: 'c_1', title: 'Um' }],
  });
});

test('normalizeBatchExportSession: retorna null sem itens válidos', () => {
  assert.equal(
    normalizeBatchExportSession({ kind: 'batch-export', items: [] }),
    null,
  );
});
