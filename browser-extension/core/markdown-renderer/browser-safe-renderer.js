import { normalizeMarkdownInput, normalizePlainText, } from './types.js';
const NAMED_ENTITIES = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
};
const decodeHtmlEntities = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, rawName) => {
    const name = rawName.toLowerCase();
    if (name.startsWith('#x')) {
        const codePoint = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (name.startsWith('#')) {
        const codePoint = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[name] ?? entity;
});
const stripTags = (value) => value.replace(/<[^>]*>/g, '');
const normalizeMarkdownSpacing = (value) => normalizePlainText(value)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
const hrefFromAttributes = (attributes) => {
    const match = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^'"\s>]+))/i);
    const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
    return href ? decodeHtmlEntities(href).trim() : null;
};
const renderInline = (value) => {
    let html = String(value || '').replace(/<br\b[^>]*\/?>/gi, '\n');
    html = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attributes, label) => {
        const text = renderInline(label);
        const href = hrefFromAttributes(String(attributes || ''));
        return href && text ? `[${text}](${href})` : text;
    });
    html = html.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => `**${renderInline(inner)}**`);
    html = html.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => `_${renderInline(inner)}_`);
    html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner) => `\`${decodeHtmlEntities(stripTags(String(inner || ''))).trim()}\``);
    return decodeHtmlEntities(stripTags(html))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
};
const renderHtmlFragment = (value) => {
    const placeholders = [];
    const stash = (markdown) => {
        const index = placeholders.push(markdown) - 1;
        return `@@GME_MARKDOWN_RENDERER_${index}@@`;
    };
    let html = String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
        const code = decodeHtmlEntities(stripTags(String(inner || ''))).trim();
        return code ? stash(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`) : '';
    });
    html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => {
        const text = renderInline(inner);
        return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n';
    });
    html = html.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner) => {
        const text = renderInline(inner);
        return text ? `\n- ${text}\n` : '\n';
    });
    html = html
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|ul|ol|blockquote|table|thead|tbody|tr)\b[^>]*>/gi, '\n\n')
        .replace(/<(p|div|section|article|ul|ol|blockquote|table|thead|tbody|tr)\b[^>]*>/gi, '');
    let markdown = renderInline(html);
    markdown = markdown.replace(/@@GME_MARKDOWN_RENDERER_(\d+)@@/g, (_match, rawIndex) => {
        const index = Number(rawIndex);
        return placeholders[index] ?? '';
    });
    return normalizeMarkdownSpacing(markdown);
};
export const createBrowserSafeMarkdownRenderer = () => ({
    render(input) {
        const normalized = normalizeMarkdownInput(input);
        if (normalized.format === 'html')
            return renderHtmlFragment(normalized.value);
        return normalizePlainText(normalized.value);
    },
});
