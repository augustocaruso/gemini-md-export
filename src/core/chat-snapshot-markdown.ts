import { portableIsoSeconds } from './date.js';
import type { ChatAttachment, ChatSnapshot, ChatTurn } from './types.js';
import { buildCanonicalFrontmatter } from './yaml.js';

export type RenderChatSnapshotMarkdownInput = Readonly<{
  snapshot: ChatSnapshot;
  exportedAt?: string | Date | null;
  tags?: readonly string[];
}>;

const roleHeading = (turn: ChatTurn): string =>
  turn.role === 'user' ? '## 🧑 Usuário' : '## 🤖 Gemini';

const attachmentLine = (attachment: ChatAttachment): string => {
  const label = attachment.label || attachment.kind;
  if (attachment.url) return `- [${label}](${attachment.url})`;
  if (attachment.assetRefId) return `- ${label} (${attachment.assetRefId})`;
  return `- ${label}`;
};

const renderTurn = (turn: ChatTurn): string => {
  const markdown = String(turn.markdown || '').trim();
  const attachments = turn.attachments.length
    ? `\n\nAnexos:\n${turn.attachments.map(attachmentLine).join('\n')}`
    : '';
  return `${roleHeading(turn)}\n\n${markdown}${attachments}`;
};

export const renderChatSnapshotMarkdown = ({
  snapshot,
  exportedAt = new Date(),
  tags = ['gemini-export'],
}: RenderChatSnapshotMarkdownInput): string => {
  const frontmatter = buildCanonicalFrontmatter({
    chatId: snapshot.chatId,
    title: snapshot.title,
    url: snapshot.url,
    metadata: {
      ...snapshot.metadata,
      dateExported: snapshot.metadata.dateExported || portableIsoSeconds(exportedAt) || undefined,
    },
    tags: [...tags],
  });
  const body = snapshot.turns
    .slice()
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map(renderTurn)
    .join('\n\n---\n\n');
  return `${frontmatter}${body.trim()}\n`;
};
