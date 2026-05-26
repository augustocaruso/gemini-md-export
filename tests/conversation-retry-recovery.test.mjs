import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationRetryRecoveryContext,
  shouldRecoverTabBeforeConversationRetry,
} from '../build/ts/mcp/conversation-retry-recovery.js';

test('stale conversation DOM retry does not reload the browser tab before retrying', () => {
  assert.equal(shouldRecoverTabBeforeConversationRetry('stale_conversation_dom'), false);
  assert.equal(shouldRecoverTabBeforeConversationRetry('conversation_not_ready'), false);
  assert.equal(shouldRecoverTabBeforeConversationRetry('tab_operation_in_progress'), false);
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
