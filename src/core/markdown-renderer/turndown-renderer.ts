import TurndownService from 'turndown';
import {
  type MarkdownInput,
  type MarkdownRenderer,
  normalizeMarkdownInput,
  normalizePlainText,
} from './types.js';

export type { MarkdownInput, MarkdownRenderer } from './types.js';
export { normalizeMarkdownInput } from './types.js';

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
