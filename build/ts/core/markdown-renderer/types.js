export const normalizeMarkdownInput = (input) => {
    if (!input || typeof input !== 'object')
        return { format: 'text', value: '' };
    const value = input;
    const format = value.format === 'html' || value.format === 'markdown' || value.format === 'text'
        ? value.format
        : 'text';
    return {
        format,
        value: String(value.value ?? ''),
    };
};
export const normalizePlainText = (value) => String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim();
