import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowedBridgeOrigin,
  isAllowedExtensionBridgeOrigin,
  isAllowedGeminiBridgeOrigin,
} from '../build/ts/mcp/bridge-origin.js';

test('bridge origin policy allows Gemini, My Activity, Google blocker pages and extension origins', () => {
  assert.equal(isAllowedBridgeOrigin(null), true);
  assert.equal(isAllowedBridgeOrigin('https://gemini.google.com'), true);
  assert.equal(isAllowedBridgeOrigin('https://myactivity.google.com'), true);
  assert.equal(isAllowedBridgeOrigin('https://www.google.com'), true);
  assert.equal(isAllowedBridgeOrigin('https://accounts.google.com'), true);
  assert.equal(
    isAllowedBridgeOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'),
    true,
  );
});

test('bridge origin policy keeps write endpoints scoped to Gemini or extension origins', () => {
  assert.equal(isAllowedGeminiBridgeOrigin('https://gemini.google.com'), true);
  assert.equal(
    isAllowedGeminiBridgeOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'),
    true,
  );
  assert.equal(isAllowedGeminiBridgeOrigin('https://myactivity.google.com'), false);
  assert.equal(isAllowedGeminiBridgeOrigin('https://accounts.google.com'), false);
});

test('bridge origin policy rejects unrelated and malformed extension origins', () => {
  assert.equal(isAllowedExtensionBridgeOrigin('chrome-extension://short'), false);
  assert.equal(isAllowedBridgeOrigin('https://example.com'), false);
  assert.equal(isAllowedBridgeOrigin('not a url'), false);
});
