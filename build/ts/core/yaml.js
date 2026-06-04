import { portableIsoSeconds } from './date.js';
const yamlEscape = (value) => String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
const parseScalar = (value) => {
    const text = String(value ?? '').trim();
    if (!text)
        return '';
    if (text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (text.startsWith("'") && text.endsWith("'"))
        return text.slice(1, -1).replace(/''/g, "'");
    if (text.startsWith('[') && text.endsWith(']')) {
        return text
            .slice(1, -1)
            .split(',')
            .map((item) => parseScalar(item))
            .filter(Boolean);
    }
    if (/^-?\d+$/.test(text))
        return Number(text);
    return text;
};
export const parseFrontmatter = (content) => {
    if (!content.startsWith('---\n'))
        return { data: {}, body: content, raw: '' };
    const end = content.indexOf('\n---', 4);
    if (end < 0)
        return { data: {}, body: content, raw: '' };
    const raw = content.slice(4, end);
    const body = content.slice(end + 4).replace(/^\n/, '');
    const data = {};
    for (const line of raw.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match)
            continue;
        data[match[1]] = parseScalar(match[2]);
    }
    return { data, body, raw };
};
const tagsLine = (tags = []) => {
    const unique = Array.from(new Set([...tags.map(String), 'gemini-export'].filter(Boolean)));
    return `[${unique.join(', ')}]`;
};
const addDateLine = (lines, key, value) => {
    const date = portableIsoSeconds(value);
    if (date)
        lines.push(`${key}: ${date}`);
    return date;
};
export const buildCanonicalFrontmatter = (note, metadataPatch = {}) => {
    const metadata = { ...note.metadata, ...metadataPatch };
    const lines = ['---'];
    lines.push('type: gemini_chat');
    lines.push(`chat_id: ${String(note.chatId).toLowerCase()}`);
    if (note.title)
        lines.push(`title: "${yamlEscape(note.title)}"`);
    lines.push(`url: ${note.url}`);
    addDateLine(lines, 'date_created', metadata.dateCreated);
    addDateLine(lines, 'date_last_message', metadata.dateLastMessage);
    addDateLine(lines, 'date_exported', metadata.dateExported);
    lines.push(`turn_count: ${Math.max(0, Number(metadata.assistantTurnCount) || 0)}`);
    const model = metadata.model || note.model;
    if (model)
        lines.push(`model: "${yamlEscape(model)}"`);
    lines.push(`tags: ${tagsLine(note.tags)}`);
    lines.push('---', '', '');
    return lines.join('\n');
};
