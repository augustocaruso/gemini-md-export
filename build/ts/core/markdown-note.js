import { parseChatId } from './chat-id.js';
import { portableIsoSeconds } from './date.js';
import { parseFrontmatter } from './yaml.js';
export const assistantTurnCount = (body) => (String(body || '').match(/^##\s*🤖\s*Gemini\b/gm) || []).length;
const sampleText = (value, max = 1200) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
export const sectionsForRole = (body, role) => {
    const normalizedBody = String(body || '').replace(/\r\n?/g, '\n');
    const emoji = role === 'user' ? '🧑' : '🤖';
    const otherEmoji = role === 'user' ? '🤖' : '🧑';
    const re = new RegExp(`^##\\s*${emoji}\\s*[^\\n]*\\n\\n([\\s\\S]*?)(?=\\n\\n---\\n\\n##\\s*${otherEmoji}|\\n\\n---\\n\\n##\\s*${emoji}|(?![\\s\\S]))`, 'gm');
    return Array.from(normalizedBody.matchAll(re), (match) => match[1].trim()).filter(Boolean);
};
export const extractScoringSamples = (body, title = '') => {
    const userTurns = sectionsForRole(body, 'user');
    const assistantTurns = sectionsForRole(body, 'assistant');
    const firstAssistant = sampleText(assistantTurns[0] || '');
    const lastAssistant = sampleText(assistantTurns.at(-1) || '');
    return {
        title: sampleText(title, 500),
        firstPrompt: sampleText(userTurns[0] || ''),
        lastPrompt: sampleText(userTurns.at(-1) || ''),
        firstAssistant,
        lastAssistant,
        assistantSamples: [lastAssistant, firstAssistant]
            .filter(Boolean)
            .map((text) => sampleText(text)),
    };
};
export const buildMarkdownChatNote = ({ filePath, relativePath, raw, fallbackChatId, }) => {
    const parsed = parseFrontmatter(raw);
    const chatId = parseChatId(parsed.data.chat_id || parsed.data.url || fallbackChatId);
    if (!chatId)
        return null;
    const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : ['gemini-export'];
    const model = parsed.data.model ? String(parsed.data.model) : undefined;
    return {
        filePath,
        relativePath,
        chatId: chatId,
        title: String(parsed.data.title || ''),
        url: String(parsed.data.url || `https://gemini.google.com/app/${chatId}`),
        body: parsed.body,
        tags,
        ...(model ? { model } : {}),
        metadata: {
            ...(model ? { model } : {}),
            dateCreated: portableIsoSeconds(parsed.data.date_created) || undefined,
            dateLastMessage: portableIsoSeconds(parsed.data.date_last_message) || undefined,
            dateExported: portableIsoSeconds(parsed.data.date_exported || parsed.data.exported_at) || undefined,
            assistantTurnCount: assistantTurnCount(parsed.body),
        },
        scoring: extractScoringSamples(parsed.body, String(parsed.data.title || '')),
    };
};
