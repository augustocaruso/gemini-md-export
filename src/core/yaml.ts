import { portableIsoSeconds } from './date.js';
import type { ChatId, ChatMetadata, IsoDateTime } from './types.js';

export type FrontmatterData = Record<string, unknown>;

export type ParsedFrontmatter = {
  data: FrontmatterData;
  body: string;
  raw: string;
};

export type CanonicalFrontmatterInput = {
  chatId: ChatId | string;
  title?: string;
  url: string;
  metadata: Partial<ChatMetadata> & { assistantTurnCount?: number };
  model?: string;
  tags?: string[];
};

const yamlEscape = (value: unknown): string =>
  String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

const parseScalar = (value: unknown): unknown => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
};

export const parseFrontmatter = (content: string): ParsedFrontmatter => {
  if (!content.startsWith('---\n')) return { data: {}, body: content, raw: '' };
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: content, raw: '' };
  const raw = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  const data: FrontmatterData = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = parseScalar(match[2]);
  }
  return { data, body, raw };
};

const tagsLine = (tags: string[] = []): string => {
  const unique = Array.from(new Set([...tags.map(String), 'gemini-export'].filter(Boolean)));
  return `[${unique.join(', ')}]`;
};

const addDateLine = (lines: string[], key: string, value: unknown): IsoDateTime | null => {
  const date = portableIsoSeconds(value);
  if (date) lines.push(`${key}: ${date}`);
  return date;
};

export const buildCanonicalFrontmatter = (
  note: CanonicalFrontmatterInput,
  metadataPatch: Partial<ChatMetadata> = {},
): string => {
  const metadata = { ...note.metadata, ...metadataPatch };
  const lines = ['---'];
  lines.push('type: gemini_chat');
  lines.push(`chat_id: ${String(note.chatId).toLowerCase()}`);
  if (note.title) lines.push(`title: "${yamlEscape(note.title)}"`);
  lines.push(`url: ${note.url}`);
  addDateLine(lines, 'date_created', metadata.dateCreated);
  addDateLine(lines, 'date_last_message', metadata.dateLastMessage);
  addDateLine(lines, 'date_exported', metadata.dateExported);
  lines.push(`turn_count: ${Math.max(0, Number(metadata.assistantTurnCount) || 0)}`);
  const model = metadata.model || note.model;
  if (model) lines.push(`model: "${yamlEscape(model)}"`);
  lines.push(`tags: ${tagsLine(note.tags)}`);
  lines.push('---', '', '');
  return lines.join('\n');
};
