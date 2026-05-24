import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEB_REPAIR_BLOCKED_EXIT_CODE,
  isGeminiWebChatUnavailableFailure,
  pollWebRepairExportJob,
  webRepairExitCodeForStatusCounts,
  webRepairStalledFromJobStatus,
  webRepairUnavailableFromJobStatus,
} from '../build/ts/core/web-repair-job-policy.js';

const inaccessibleFailure = (chatId) => ({
  chatId,
  error: `Timeout aguardando chat ${chatId} com DOM atualizado. Ultimo estado: chat=nenhum, turns=0, mudouDOM=sim.`,
});

test('web repair detecta lote inacessivel pelo Gemini Web apos falhas iniciais iguais', () => {
  const unavailable = webRepairUnavailableFromJobStatus({
    successCount: 0,
    failures: [
      inaccessibleFailure('aaaaaaaaaaaa'),
      inaccessibleFailure('bbbbbbbbbbbb'),
      inaccessibleFailure('cccccccccccc'),
    ],
  });

  assert.equal(unavailable?.code, 'gemini_web_chats_unavailable');
  assert.deepEqual(unavailable.failedChatIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
  assert.equal(
    webRepairExitCodeForStatusCounts({ unavailable }),
    WEB_REPAIR_BLOCKED_EXIT_CODE,
  );
});

test('web repair nao bloqueia cedo quando ja houve sucesso ou erro diferente', () => {
  assert.equal(isGeminiWebChatUnavailableFailure(inaccessibleFailure('aaaaaaaaaaaa')), true);
  assert.equal(
    webRepairUnavailableFromJobStatus({
      successCount: 1,
      failures: [
        inaccessibleFailure('aaaaaaaaaaaa'),
        inaccessibleFailure('bbbbbbbbbbbb'),
        inaccessibleFailure('cccccccccccc'),
      ],
    }),
    null,
  );
  assert.equal(
    webRepairUnavailableFromJobStatus({
      successCount: 0,
      failures: [
        inaccessibleFailure('aaaaaaaaaaaa'),
        { chatId: 'bbbbbbbbbbbb', error: 'Falha de rede temporaria.' },
        inaccessibleFailure('cccccccccccc'),
      ],
    }),
    null,
  );
});

test('web repair bloqueia job sem progresso antes do timeout global', async () => {
  const stalled = webRepairStalledFromJobStatus(
    {
      status: 'running',
      completed: 0,
      successCount: 0,
      failureCount: 0,
      current: { index: 1, chatId: 'aaaaaaaaaaaa' },
    },
    90_000,
    90_000,
  );
  assert.equal(stalled?.code, 'gemini_web_repair_stalled');
  assert.deepEqual(stalled.failedChatIds, ['aaaaaaaaaaaa']);

  const calls = [];
  let cancelled = false;
  const result = await pollWebRepairExportJob({
    bridgeUrl: 'http://127.0.0.1:47283',
    jobId: 'job-1',
    pollMs: 1,
    timeoutMs: 1000,
    preflightStallMs: 0,
    sleep: async () => {},
    callMcpTool: async (request) => {
      calls.push(request);
      if (request.args.action === 'cancel') {
        cancelled = true;
        return { ok: true, status: 'cancel_requested' };
      }
      if (cancelled) return { status: 'cancelled' };
      return {
        status: 'running',
        completed: 0,
        successCount: 0,
        failureCount: 0,
        current: { index: 1, chatId: 'aaaaaaaaaaaa' },
      };
    },
  });

  assert.equal(result.webRepairUnavailable?.code, 'gemini_web_repair_stalled');
  assert.equal(calls.some((call) => call.args.action === 'cancel'), true);
});
