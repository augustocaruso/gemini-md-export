import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
const isElement = (value) => Boolean(value && typeof value.querySelector === 'function');
const textOf = (element) => String(element?.getAttribute('data-title') ||
    element?.getAttribute('aria-label') ||
    element?.textContent ||
    '')
    .replace(/\s+/g, ' ')
    .trim();
const domAdapterEvidence = (kind, confidence, warnings = []) => ({
    source: 'chat-dom',
    kind,
    confidence,
    warnings,
});
const absoluteUrl = (href, base) => {
    const raw = String(href || '').trim();
    if (!raw)
        return null;
    try {
        return new URL(raw, base).toString();
    }
    catch {
        return null;
    }
};
const findRowUrl = (element, baseUrl) => {
    const ownUrl = absoluteUrl(element.getAttribute('href'), baseUrl) ||
        absoluteUrl(element.getAttribute('data-url'), baseUrl);
    if (ownUrl)
        return ownUrl;
    const link = element.querySelector('a[href*="/app/"],a[href^="/app/"]');
    return absoluteUrl(link?.getAttribute('href'), baseUrl);
};
const rowSource = (element) => {
    const source = String(element.getAttribute('data-source') || '').toLowerCase();
    if (source === 'sidebar' || source === 'notebook')
        return source;
    if (element.closest?.('project-chat-history,[data-gm-notebook-chat-list]'))
        return 'notebook';
    if (element.closest?.('side-nav,mat-sidenav,[data-gm-sidebar]'))
        return 'sidebar';
    return 'unknown';
};
const routeFromUrl = (urlText) => {
    const warnings = [];
    let url;
    try {
        url = new URL(urlText);
    }
    catch {
        url = new URL('https://gemini.google.com/app');
        warnings.push('invalid_url');
    }
    const chatId = parseChatId(url.pathname);
    const notebookId = url.pathname.match(/\/notebook\/([^/?#]+)/)?.[1] || null;
    let kind = 'unknown';
    if (chatId)
        kind = 'chat';
    else if (notebookId)
        kind = 'notebook';
    else if (url.pathname === '/app' || url.pathname === '/app/')
        kind = 'home';
    if (!chatId && kind !== 'notebook')
        warnings.push('missing_chat_id');
    return {
        kind,
        url: url.toString(),
        path: url.pathname,
        chatId,
        notebookId,
        warnings,
        evidence: [
            domAdapterEvidence(chatId ? 'route-chat-id' : 'route-missing-chat-id', chatId ? 'strong' : 'missing', warnings),
        ],
    };
};
export const createGeminiWebDomAdapter = ({ documentRef, locationHref = documentRef.location?.href || 'https://gemini.google.com/app', }) => {
    const getRouteState = () => routeFromUrl(locationHref);
    const listConversationRows = () => {
        const selectors = [
            '[data-gm-conversation-row]',
            '[data-conversation-row]',
            '[data-test-id="conversation-row"]',
            'a[href*="/app/"]',
            'a[href^="/app/"]',
        ];
        const seen = new Set();
        const rows = [];
        const currentChatId = getRouteState().chatId;
        for (const selector of selectors) {
            for (const candidate of Array.from(documentRef.querySelectorAll(selector))) {
                if (!isElement(candidate) || seen.has(candidate))
                    continue;
                seen.add(candidate);
                const url = findRowUrl(candidate, locationHref);
                const chatId = parseChatId(candidate.getAttribute('data-chat-id')) ||
                    parseChatId(candidate.getAttribute('data-id')) ||
                    parseChatId(url);
                const title = textOf(candidate);
                const warnings = chatId ? [] : ['missing_chat_id'];
                rows.push({
                    source: rowSource(candidate),
                    index: rows.length,
                    title,
                    url: chatId ? url || canonicalGeminiChatUrl(chatId) : null,
                    chatId,
                    exportable: Boolean(chatId),
                    current: Boolean(chatId && currentChatId && chatId === currentChatId),
                    warnings,
                    evidence: [
                        domAdapterEvidence(chatId ? 'conversation-row-chat-id' : 'conversation-row-missing-chat-id', chatId ? 'strong' : 'missing', warnings),
                    ],
                });
            }
        }
        return rows;
    };
    const getHydrationState = () => {
        const turnCount = documentRef.querySelectorAll('user-query,model-response,[data-gm-turn],[data-role="user"],[data-role="assistant"]').length;
        const isLoading = Boolean(documentRef.querySelector('[aria-busy="true"],[data-loading="true"],.loading'));
        return {
            turnCount,
            isLoading,
            warnings: turnCount ? [] : ['empty_chat_dom'],
            evidence: [
                domAdapterEvidence(turnCount ? 'turn-count' : 'empty-chat-dom', turnCount ? 'strong' : 'missing'),
            ],
        };
    };
    const getCurrentSnapshot = () => {
        const route = getRouteState();
        return {
            ok: false,
            code: route.chatId ? 'adapter_contract_missing' : 'identity_unproven',
            message: route.chatId
                ? 'Chat DOM adapter ainda nao monta snapshot completo nesta etapa.'
                : 'A rota atual nao comprova um chatId exportavel.',
            requestedChatId: route.chatId || undefined,
            observedChatId: route.chatId || undefined,
            evidence: route.evidence,
        };
    };
    return {
        getRouteState,
        listConversationRows,
        getHydrationState,
        getCurrentSnapshot,
    };
};
