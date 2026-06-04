import TurndownService from 'turndown';
import { normalizeMarkdownInput, normalizePlainText, } from './types.js';
export { normalizeMarkdownInput } from './types.js';
export const createTurndownMarkdownRenderer = () => {
    const turndown = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
    });
    return {
        render(input) {
            const normalized = normalizeMarkdownInput(input);
            if (normalized.format === 'html')
                return normalizePlainText(turndown.turndown(normalized.value));
            return normalizePlainText(normalized.value);
        },
    };
};
