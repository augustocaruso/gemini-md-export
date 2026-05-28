import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assetRefsFromChatSnapshot,
  buildAssetFetchPlan,
  receiptsForAssetFetchPlan,
} from '../build/ts/core/assets.js';

const snapshot = {
  chatId: 'dbe5dd4b50b09c74',
  title: 'Assets',
  url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
  turns: [
    {
      role: 'assistant',
      markdown: 'See attached.',
      textHash: 'hash',
      sourceOrder: 1,
      attachments: [
        {
          kind: 'image',
          label: 'Plot',
          url: 'https://lh3.googleusercontent.com/image-1',
        },
        {
          kind: 'image',
          label: 'Plot duplicate',
          url: 'https://lh3.googleusercontent.com/image-1',
        },
        {
          kind: 'artifact',
          label: 'Interactive artifact',
          assetRefId: 'artifact:known',
        },
      ],
    },
  ],
  metadata: { assistantTurnCount: 1 },
  evidence: [{ source: 'gemini-private-api', kind: 'fixture', confidence: 'strong', warnings: [] }],
};

test('asset refs keep turn linkage and adapter source', () => {
  const refs = assetRefsFromChatSnapshot(snapshot);

  assert.equal(refs.length, 3);
  assert.equal(refs[0].chatId, snapshot.chatId);
  assert.equal(refs[0].turnSourceOrder, 1);
  assert.equal(refs[0].attachmentIndex, 0);
  assert.equal(refs[0].source, 'gemini-private-api');
  assert.equal(refs[2].id, 'artifact:known');
});

test('asset fetch plan dedupes URLs and records metadata-only refs', () => {
  const refs = assetRefsFromChatSnapshot(snapshot);
  const plan = buildAssetFetchPlan(refs);
  const receipts = receiptsForAssetFetchPlan(plan);

  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].url, 'https://lh3.googleusercontent.com/image-1');
  assert.equal(plan.dedupedRefs.length, 1);
  assert.equal(plan.dedupedRefs[0].refId, refs[1].id);
  assert.equal(plan.warnings.some((warning) => warning.startsWith('asset_metadata_only:')), true);
  assert.deepEqual(
    receipts.map((receipt) => [receipt.refId, receipt.status]),
    [
      [refs[1].id, 'deduped'],
      [refs[2].id, 'metadata_only'],
    ],
  );
});
