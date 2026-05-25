import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isActivationTimeoutAlreadyReflected,
  isRecentCommandFailureBlocking,
} from '../build/ts/mcp/command-channel-health.js';

test('timeout de ativacao nao bloqueia comando quando heartbeat ja marcou aba ativa', () => {
  const client = {
    isActiveTab: true,
    lastCommandTimeoutAt: 1_000,
    lastCommandTimeoutType: 'activate-browser-tab',
  };

  assert.equal(isActivationTimeoutAlreadyReflected(client), true);
  assert.equal(isRecentCommandFailureBlocking(client, 1_500, 60_000), false);
});

test('timeout de ativacao ainda bloqueia se a aba nao ficou ativa', () => {
  const client = {
    isActiveTab: false,
    lastCommandTimeoutAt: 1_000,
    lastCommandTimeoutType: 'activate-browser-tab',
  };

  assert.equal(isActivationTimeoutAlreadyReflected(client), false);
  assert.equal(isRecentCommandFailureBlocking(client, 1_500, 60_000), true);
});

test('timeouts comuns continuam bloqueando durante cooldown', () => {
  const client = {
    isActiveTab: true,
    lastCommandTimeoutAt: 1_000,
    lastCommandTimeoutType: 'get-chat-by-id',
  };

  assert.equal(isRecentCommandFailureBlocking(client, 1_500, 60_000), true);
  assert.equal(isRecentCommandFailureBlocking(client, 70_000, 60_000), false);
});
