import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNotebookConversationPlan,
  buildNotebookReturnPlan,
} from '../src/notebook-return-plan.mjs';

test('buildNotebookReturnPlan: preserva contexto por padrão', () => {
  assert.deepEqual(buildNotebookReturnPlan(), {
    preserveContext: true,
    tryDirectFirst: false,
    allowSoftDirectFallback: true,
    allowHardDirectFallback: false,
    mode: 'history-then-spa-link',
  });
});

test('buildNotebookReturnPlan: contexto preservado vence preferDirect', () => {
  assert.deepEqual(buildNotebookReturnPlan({ preferDirect: true, preserveContext: true }), {
    preserveContext: true,
    tryDirectFirst: false,
    allowSoftDirectFallback: true,
    allowHardDirectFallback: false,
    mode: 'history-then-spa-link',
  });
});

test('buildNotebookReturnPlan: modo direto só quando pode recarregar a página', () => {
  assert.deepEqual(buildNotebookReturnPlan({ preferDirect: true, preserveContext: false }), {
    preserveContext: false,
    tryDirectFirst: true,
    allowSoftDirectFallback: true,
    allowHardDirectFallback: true,
    mode: 'direct-first',
  });
});

test('buildNotebookReturnPlan: sem preferDirect usa histórico primeiro e fallback direto', () => {
  assert.deepEqual(buildNotebookReturnPlan({ preserveContext: false }), {
    preserveContext: false,
    tryDirectFirst: false,
    allowSoftDirectFallback: true,
    allowHardDirectFallback: true,
    mode: 'history-first',
  });
});

test('buildNotebookConversationPlan: lote preserva contexto e proíbe URL direta', () => {
  assert.deepEqual(
    buildNotebookConversationPlan({
      preserveContext: true,
      hasVisibleRow: true,
      hasKnownChatUrl: true,
    }),
    {
      preserveContext: true,
      tryVisibleRowFirst: true,
      allowDirectUrlFallback: false,
      mode: 'row-only',
    },
  );
});

test('buildNotebookConversationPlan: fora do lote pode cair para URL direta', () => {
  assert.deepEqual(
    buildNotebookConversationPlan({
      preserveContext: false,
      hasVisibleRow: true,
      hasKnownChatUrl: true,
    }),
    {
      preserveContext: false,
      tryVisibleRowFirst: true,
      allowDirectUrlFallback: true,
      mode: 'row-first-direct-fallback',
    },
  );
});

test('buildNotebookConversationPlan: sem linha visível vira direct-only se permitido', () => {
  assert.deepEqual(
    buildNotebookConversationPlan({
      preserveContext: false,
      hasVisibleRow: false,
      hasKnownChatUrl: true,
    }),
    {
      preserveContext: false,
      tryVisibleRowFirst: false,
      allowDirectUrlFallback: true,
      mode: 'direct-only',
    },
  );
});
