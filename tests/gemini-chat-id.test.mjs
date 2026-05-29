import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractChatIdFromUrl,
  normalizeConversationChatId,
  stripGeminiPrefix,
} from '../build/ts/mcp/gemini-chat-id.js';

test('MCP chat id helpers preserve legacy normalization order', () => {
  assert.equal(stripGeminiPrefix('c_dbe5dd4b50b09c74'), 'dbe5dd4b50b09c74');
  assert.equal(
    extractChatIdFromUrl('https://gemini.google.com/app/dbe5dd4b50b09c74?x=1'),
    'dbe5dd4b50b09c74',
  );
  assert.equal(
    normalizeConversationChatId({
      id: 'c_aaaaaaaaaaaa',
      url: 'https://gemini.google.com/app/bbbbbbbbbbbb',
      chatId: 'c_dbe5dd4b50b09c74',
    }),
    'dbe5dd4b50b09c74',
  );
});
