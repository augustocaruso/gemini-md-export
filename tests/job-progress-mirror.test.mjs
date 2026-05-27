import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jobProgressMirrorTabIdsForJob,
  setJobProgressForPrimaryAndMirrors,
  shouldMirrorJobProgressToClient,
} from '../build/ts/mcp/job-progress-mirror.js';

test('job progress mirror selects companion My Activity tabs without primary tab', () => {
  const tabIds = jobProgressMirrorTabIdsForJob(
    {
      activityCompanion: {
        tabId: 99,
        client: { tabId: 99 },
      },
      nativeExportLease: {
        visual: {
          tabIds: [42, 99, 99, 'invalid'],
        },
      },
    },
    42,
  );

  assert.deepEqual(tabIds, [99]);
});

test('job progress mirror only targets activity clients in selected tabs', () => {
  const mirrorTabIds = [99];
  assert.equal(
    shouldMirrorJobProgressToClient(
      { clientId: 'activity-1', kind: 'activity', tabId: 99 },
      { primaryClientId: 'chat-1', mirrorTabIds },
    ),
    true,
  );
  assert.equal(
    shouldMirrorJobProgressToClient(
      { clientId: 'chat-1', kind: 'chat', tabId: 42 },
      { primaryClientId: 'chat-1', mirrorTabIds },
    ),
    false,
  );
  assert.equal(
    shouldMirrorJobProgressToClient(
      { clientId: 'activity-2', kind: 'activity', tabId: 100 },
      { primaryClientId: 'chat-1', mirrorTabIds },
    ),
    false,
  );
});

test('job progress mirror sends payload to primary and companion clients', () => {
  const calls = [];
  setJobProgressForPrimaryAndMirrors(
    {
      activityCompanion: { tabId: 99 },
      nativeExportLease: { visual: { tabIds: [42, 99] } },
    },
    { clientId: 'chat-1', kind: 'chat', tabId: 42 },
    { jobId: 'job-1', status: 'running' },
    [
      { clientId: 'chat-1', kind: 'chat', tabId: 42 },
      { clientId: 'activity-1', kind: 'activity', tabId: 99 },
    ],
    (client, payload) => calls.push({ client, payload }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].client.clientId, 'activity-1');
  assert.equal(calls[1].payload.mirroredFromClientId, 'chat-1');
});
