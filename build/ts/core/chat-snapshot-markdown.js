import { portableIsoSeconds } from './date.js';
import { buildCanonicalFrontmatter } from './yaml.js';
const roleHeading = (turn) => turn.role === 'user' ? '## 🧑 Usuário' : '## 🤖 Gemini';
const attachmentLine = (attachment) => {
    const label = attachment.label || attachment.kind;
    if (attachment.kind === 'image' && attachment.url)
        return `- ![${label}](${attachment.url})`;
    if (attachment.url)
        return `- [${label}](${attachment.url})`;
    if (attachment.assetRefId)
        return `- ${label} (${attachment.assetRefId})`;
    return `- ${label}`;
};
const renderTurn = (turn) => {
    const markdown = String(turn.markdown || '').trim();
    const attachments = turn.attachments.length
        ? `\n\nAnexos:\n${turn.attachments.map(attachmentLine).join('\n')}`
        : '';
    return `${roleHeading(turn)}\n\n${markdown}${attachments}`;
};
export const renderChatSnapshotMarkdown = ({ snapshot, exportedAt = new Date(), tags = ['gemini-export'], }) => {
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
