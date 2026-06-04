export type MarkdownInput = Readonly<{
  format: 'html' | 'markdown' | 'text';
  value: string;
}>;

export type MarkdownRenderer = Readonly<{
  render(input: MarkdownInput | unknown): string;
}>;

export const normalizeMarkdownInput = (input: MarkdownInput | unknown): MarkdownInput => {
  if (!input || typeof input !== 'object') return { format: 'text', value: '' };
  const value = input as { format?: unknown; value?: unknown };
  const format =
    value.format === 'html' || value.format === 'markdown' || value.format === 'text'
      ? value.format
      : 'text';
  return {
    format,
    value: String(value.value ?? ''),
  };
};

export const normalizePlainText = (value: string): string =>
  String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim();
