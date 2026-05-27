import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationRetryRecoveryContext,
  evaluateConversationRetryDelayFsm,
  evaluateConversationRetryDelayForJobFsm,
  shouldRecoverTabBeforeConversationRetry,
} from '../build/ts/mcp/conversation-retry-recovery.js';

test('stale conversation DOM retry does not reload the browser tab before retrying', () => {
  assert.equal(shouldRecoverTabBeforeConversationRetry('stale_conversation_dom'), false);
  assert.equal(shouldRecoverTabBeforeConversationRetry('conversation_not_ready'), false);
  assert.equal(shouldRecoverTabBeforeConversationRetry('tab_operation_in_progress'), false);
  assert.equal(shouldRecoverTabBeforeConversationRetry('no_command_client_available'), true);
});

test('conversation retry recovery context preserves operation and target identifiers', () => {
  assert.deepEqual(
    buildConversationRetryRecoveryContext({
      operationId: 'job-1:014:88dda44115b51455',
      targetChatId: '88dda44115b51455',
      retryAttempt: 1,
      retryReason: 'stale_conversation_dom',
      error: new Error('URL mudou'),
    }),
    {
      operationId: 'job-1:014:88dda44115b51455',
      targetChatId: '88dda44115b51455',
      retryAttempt: 1,
      retryReason: 'stale_conversation_dom',
      error: 'URL mudou',
    },
  );
});

test('conversation retry delay FSM gives tab-busy its own recovery budget', () => {
  const genericExhausted = evaluateConversationRetryDelayFsm({
    retryReason: 'conversation_not_ready',
    attempt: 5,
    defaultRetryLimit: 5,
    defaultBaseMs: 600,
  });
  const tabBusyRetry = evaluateConversationRetryDelayFsm({
    retryReason: 'tab_operation_in_progress',
    attempt: 5,
    defaultRetryLimit: 5,
    defaultBaseMs: 600,
    tabBusyRetryLimit: 12,
    tabBusyBaseMs: 1500,
    tabBusyMaxDelayMs: 10_000,
  });

  assert.equal(genericExhausted.state, 'record_failure');
  assert.equal(genericExhausted.reason, 'retry_limit_exhausted');
  assert.equal(tabBusyRetry.state, 'retry_after_delay');
  assert.equal(tabBusyRetry.reason, 'tab_operation_in_progress_wait_for_idle');
  assert.equal(tabBusyRetry.delayMs, 7500);
});

test('conversation retry delay FSM caps long tab-busy retry delays', () => {
  const decision = evaluateConversationRetryDelayFsm({
    retryReason: 'tab_operation_in_progress',
    attempt: 9,
    tabBusyRetryLimit: 12,
    tabBusyBaseMs: 1500,
    tabBusyMaxDelayMs: 10_000,
  });

  assert.equal(decision.state, 'retry_after_delay');
  assert.equal(decision.delayMs, 10_000);
});

test('conversation retry delay FSM gives missing command client a recovery budget', () => {
  const decision = evaluateConversationRetryDelayFsm({
    retryReason: 'no_command_client_available',
    attempt: 5,
    defaultRetryLimit: 5,
    defaultBaseMs: 600,
    tabBusyRetryLimit: 12,
    tabBusyBaseMs: 1500,
    tabBusyMaxDelayMs: 10_000,
  });

  assert.equal(decision.state, 'retry_after_delay');
  assert.equal(decision.reason, 'no_command_client_available_wait_for_recovery');
  assert.equal(decision.retryLimit, 12);
});

test('conversation retry delay job FSM keeps direct exports on the caller retry budget', () => {
  const decision = evaluateConversationRetryDelayForJobFsm({
    retryReason: 'tab_operation_in_progress',
    attempt: 4,
    retryLimit: 5,
    retryBaseMs: 600,
    jobType: 'direct-chats-export',
    env: {
      GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_LIMIT: '12',
      GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_BASE_MS: '1500',
    },
  });

  assert.equal(decision.state, 'retry_after_delay');
  assert.equal(decision.retryLimit, 5);
  assert.equal(decision.delayMs, 2400);
});

test('conversation retry delay job FSM clamps recent export tab-busy env knobs', () => {
  const decision = evaluateConversationRetryDelayForJobFsm({
    retryReason: 'tab_operation_in_progress',
    attempt: 20,
    retryLimit: 5,
    retryBaseMs: 600,
    jobType: 'recent-chats-export',
    env: {
      GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_LIMIT: '999',
      GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_BASE_MS: '1',
      GEMINI_MCP_RECENT_CHATS_TAB_BUSY_RETRY_MAX_DELAY_MS: '999999',
    },
  });

  assert.equal(decision.state, 'retry_after_delay');
  assert.equal(decision.retryLimit, 30);
  assert.equal(decision.delayMs, 2000);
});
