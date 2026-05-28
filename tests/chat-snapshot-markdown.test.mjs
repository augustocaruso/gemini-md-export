import assert from 'node:assert/strict';
import test from 'node:test';

import { renderChatSnapshotMarkdown } from '../build/ts/core/chat-snapshot-markdown.js';

test('chat snapshot markdown renderer owns frontmatter, turns and attachments', () => {
  const markdown = renderChatSnapshotMarkdown({
    exportedAt: '2026-05-28T12:00:00Z',
    snapshot: {
      chatId: 'dbe5dd4b50b09c74',
      title: 'Private API proof',
      url: 'https://gemini.google.com/app/dbe5dd4b50b09c74',
      turns: [
        {
          role: 'assistant',
          markdown: 'Resposta',
          textHash: 'hash-a',
          sourceOrder: 1,
          attachments: [
            {
              kind: 'artifact',
              label: 'Gemini artifact',
              assetRefId: 'private-api-artifact:abc',
            },
          ],
        },
        {
          role: 'user',
          markdown: 'Pergunta',
          textHash: 'hash-u',
          sourceOrder: 0,
          attachments: [],
        },
      ],
      metadata: {
        assistantTurnCount: 1,
      },
      evidence: [{ source: 'gemini-private-api', kind: 'fixture', confidence: 'strong', warnings: [] }],
    },
  });

  assert.match(markdown, /^---\ntype: gemini_chat\nchat_id: dbe5dd4b50b09c74/m);
  assert.match(markdown, /date_exported: 2026-05-28T12:00:00Z/);
  assert.match(markdown, /## 🧑 Usuário\n\nPergunta\n\n---\n\n## 🤖 Gemini\n\nResposta/);
  assert.match(markdown, /Anexos:\n- Gemini artifact \(private-api-artifact:abc\)/);
});
