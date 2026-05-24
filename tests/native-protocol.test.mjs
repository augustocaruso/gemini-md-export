import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeNativeFrameBuffer, encodeNativeFrame } from '../build/ts/native/frame.js';
import {
  makeNativeRequest,
  nativeBrokerError,
  nativeBrokerOk,
  normalizeNativeCommand,
} from '../build/ts/native/protocol.js';

test('native frames encode and decode Chrome length-prefixed JSON', () => {
  const frame = encodeNativeFrame({ id: 'r1', command: 'tabs.list', payload: { limit: 2 } });
  const decoded = decodeNativeFrameBuffer(frame);

  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].id, 'r1');
  assert.equal(decoded.messages[0].command, 'tabs.list');
  assert.equal(decoded.remaining.length, 0);
});

test('partial native frame keeps remaining bytes until payload arrives', () => {
  const frame = encodeNativeFrame({ id: 'r2', command: 'ping' });
  const first = decodeNativeFrameBuffer(frame.subarray(0, 3));
  const second = decodeNativeFrameBuffer(Buffer.concat([first.remaining, frame.subarray(3)]));

  assert.equal(first.messages.length, 0);
  assert.equal(second.messages[0].id, 'r2');
});

test('protocol helpers preserve request ids and typed errors', () => {
  const request = makeNativeRequest('tabs.claim', { tabId: 42 }, { id: 'claim-1' });
  const ok = nativeBrokerOk(request, { claimId: 'c1' });
  const error = nativeBrokerError(request, 'ambiguous_gemini_tabs', 'Escolha uma aba Gemini.');

  assert.equal(normalizeNativeCommand(request.command), 'tabs.claim');
  assert.deepEqual(ok, { id: 'claim-1', ok: true, result: { claimId: 'c1' } });
  assert.equal(error.id, 'claim-1');
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'ambiguous_gemini_tabs');
});
