import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import type { BlockedResult, SanitizedEvidence } from '../../core/types.js';
import type {
  GeminiConversationRow,
  GeminiDomAdapter,
  GeminiHydrationState,
  GeminiRouteState,
} from './types.js';

export type GeminiWebDomAdapterOptions = {
  documentRef: Document;
  locationHref?: string;
};

const isElement = (value: unknown): value is Element =>
  Boolean(value && typeof (value as Element).querySelector === 'function');

const textOf = (element: Element | null | undefined): string =>
  String(
    element?.getAttribute('data-title') ||
      element?.getAttribute('aria-label') ||
      element?.textContent ||
      '',
  )
    .replace(/\s+/g, ' ')
    .trim();

const domAdapterEvidence = (
  kind: string,
  confidence: SanitizedEvidence['confidence'],
  warnings: string[] = [],
): SanitizedEvidence => ({
  source: 'chat-dom',
  kind,
  confidence,
  warnings,
});

const absoluteUrl = (href: string | null | undefined, base: string): string | null => {
  const raw = String(href || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
};

const findRowUrl = (element: Element, baseUrl: string): string | null => {
  const ownUrl =
    absoluteUrl(element.getAttribute('href'), baseUrl) ||
    absoluteUrl(element.getAttribute('data-url'), baseUrl);
  if (ownUrl) return ownUrl;
  const link = element.querySelector('a[href*="/app/"],a[href^="/app/"]');
  return absoluteUrl(link?.getAttribute('href'), baseUrl);
};

const rowSource = (element: Element): GeminiConversationRow['source'] => {
  const source = String(element.getAttribute('data-source') || '').toLowerCase();
  if (source === 'sidebar' || source === 'notebook') return source;
  if (element.closest?.('project-chat-history,[data-gm-notebook-chat-list]')) return 'notebook';
  if (element.closest?.('side-nav,mat-sidenav,[data-gm-sidebar]')) return 'sidebar';
  return 'unknown';
};

const routeFromUrl = (urlText: string): GeminiRouteState => {
  const warnings: string[] = [];
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    url = new URL('https://gemini.google.com/app');
    warnings.push('invalid_url');
  }
  const chatId = parseChatId(url.pathname);
  const notebookId = url.pathname.match(/\/notebook\/([^/?#]+)/)?.[1] || null;
  let kind: GeminiRouteState['kind'] = 'unknown';
  if (chatId) kind = 'chat';
  else if (notebookId) kind = 'notebook';
  else if (url.pathname === '/app' || url.pathname === '/app/') kind = 'home';
  if (!chatId && kind !== 'notebook') warnings.push('missing_chat_id');
  return {
    kind,
    url: url.toString(),
    path: url.pathname,
    chatId,
    notebookId,
    warnings,
    evidence: [
      domAdapterEvidence(
        chatId ? 'route-chat-id' : 'route-missing-chat-id',
        chatId ? 'strong' : 'missing',
        warnings,
      ),
    ],
  };
};

export const createGeminiWebDomAdapter = ({
  documentRef,
  locationHref = documentRef.location?.href || 'https://gemini.google.com/app',
}: GeminiWebDomAdapterOptions): GeminiDomAdapter => {
  const getRouteState = () => routeFromUrl(locationHref);

  const listConversationRows = (): GeminiConversationRow[] => {
    const selectors = [
      '[data-gm-conversation-row]',
      '[data-conversation-row]',
      '[data-test-id="conversation-row"]',
      'a[href*="/app/"]',
      'a[href^="/app/"]',
    ];
    const seen = new Set<Element>();
    const rows: GeminiConversationRow[] = [];
    const currentChatId = getRouteState().chatId;

    for (const selector of selectors) {
      for (const candidate of Array.from(documentRef.querySelectorAll(selector))) {
        if (!isElement(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);
        const url = findRowUrl(candidate, locationHref);
        const chatId =
          parseChatId(candidate.getAttribute('data-chat-id')) ||
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
            domAdapterEvidence(
              chatId ? 'conversation-row-chat-id' : 'conversation-row-missing-chat-id',
              chatId ? 'strong' : 'missing',
              warnings,
            ),
          ],
        });
      }
    }

    return rows;
  };

  const getHydrationState = (): GeminiHydrationState => {
    const turnCount = documentRef.querySelectorAll(
      'user-query,model-response,[data-gm-turn],[data-role="user"],[data-role="assistant"]',
    ).length;
    const isLoading = Boolean(
      documentRef.querySelector('[aria-busy="true"],[data-loading="true"],.loading'),
    );
    return {
      turnCount,
      isLoading,
      warnings: turnCount ? [] : ['empty_chat_dom'],
      evidence: [
        domAdapterEvidence(
          turnCount ? 'turn-count' : 'empty-chat-dom',
          turnCount ? 'strong' : 'missing',
        ),
      ],
    };
  };

  const getCurrentSnapshot = (): BlockedResult => {
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
