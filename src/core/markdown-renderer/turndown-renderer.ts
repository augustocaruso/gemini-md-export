import TurndownService from 'turndown';

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

const normalizePlainText = (value: string): string =>
  String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim();

export const createTurndownMarkdownRenderer = (): MarkdownRenderer => {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });

  return {
    render(input: MarkdownInput | unknown): string {
      const normalized = normalizeMarkdownInput(input);
      if (normalized.format === 'html')
        return normalizePlainText(turndown.turndown(normalized.value));
      return normalizePlainText(normalized.value);
    },
  };
};
