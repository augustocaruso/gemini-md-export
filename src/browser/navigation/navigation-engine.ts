import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import type { ChatId, SanitizedEvidence } from '../../core/types.js';
import type { GeminiConversationRow } from '../dom-adapter/types.js';
import type {
  NavigationBlockedResult,
  NavigationEngine,
  NavigationEngineOptions,
  NavigationResult,
  NavigationTarget,
} from './types.js';

const navigationEvidence = (
  kind: string,
  confidence: SanitizedEvidence['confidence'],
  warnings: string[] = [],
): SanitizedEvidence => ({
  source: 'chat-dom',
  kind,
  confidence,
  warnings,
});

const blocked = (
  code: NavigationBlockedResult['code'],
  message: string,
  patch: Partial<NavigationBlockedResult> = {},
): NavigationBlockedResult => ({
  ok: false,
  code,
  message,
  warnings: patch.warnings || [],
  evidence: patch.evidence || [navigationEvidence(code, 'missing', patch.warnings || [])],
  requestedChatId: patch.requestedChatId,
  observedChatId: patch.observedChatId,
});

const rowMatchesChatId = (row: GeminiConversationRow, chatId: ChatId): boolean =>
  row.chatId === chatId || parseChatId(row.url) === chatId;

const targetChatId = (target: NavigationTarget): ChatId | null =>
  parseChatId(target.chatId) ||
  parseChatId(target.url) ||
  parseChatId(target.row?.chatId) ||
  parseChatId(target.row?.url);

const rowFromTarget = (
  rows: GeminiConversationRow[],
  target: NavigationTarget,
  chatId: ChatId | null,
): GeminiConversationRow | null => {
  if (target.row) return target.row;
  if (target.rowIndex !== undefined && target.rowIndex !== null) {
    const index = Number(target.rowIndex);
    return Number.isInteger(index) && index >= 0 ? rows[index] || null : null;
  }
  if (chatId) return rows.find((row) => rowMatchesChatId(row, chatId)) || null;
  return null;
};

const currentRouteRow = (
  rows: GeminiConversationRow[],
  target: NavigationTarget,
  chatId: ChatId,
): GeminiConversationRow => {
  const row = rowFromTarget(rows, target, chatId);
  if (row) return row;
  return {
    source: 'unknown',
    index: 0,
    title: chatId,
    url: canonicalGeminiChatUrl(chatId),
    chatId,
    exportable: true,
    current: true,
    warnings: [],
    evidence: [navigationEvidence('current_route_chat_id', 'strong')],
  };
};

export const createNavigationEngine = ({
  adapter,
  isBusy = () => false,
  openUrl,
  clickRow,
  waitForHydration,
}: NavigationEngineOptions): NavigationEngine => ({
  async openChat(target: NavigationTarget): Promise<NavigationResult> {
    if (isBusy()) {
      return blocked('busy_tab', 'Esta aba ja esta ocupada com outra operacao.', {
        requestedChatId: String(target.chatId || ''),
      });
    }

    const route = adapter.getRouteState();
    const requestedChatId = targetChatId(target);
    if (requestedChatId && route.chatId === requestedChatId) {
      const hydration = adapter.getHydrationState();
      const hydrated =
        hydration.turnCount <= 0 && waitForHydration
          ? await waitForHydration({
              chatId: requestedChatId,
              url: canonicalGeminiChatUrl(requestedChatId),
              row: currentRouteRow(adapter.listConversationRows(), target, requestedChatId),
            })
          : {
              ok: true as const,
              turnCount: hydration.turnCount,
              warnings: hydration.warnings,
              evidence: hydration.evidence,
            };
      if (!hydrated.ok) return hydrated;
      return {
        ok: true,
        chatId: requestedChatId,
        url: canonicalGeminiChatUrl(requestedChatId),
        opened: false,
        reason: 'already-current',
        turnCount: hydrated.turnCount,
        warnings: [...route.warnings, ...hydration.warnings, ...(hydrated.warnings || [])],
        evidence: [...route.evidence, ...hydration.evidence, ...(hydrated.evidence || [])],
      };
    }

    const rows = adapter.listConversationRows();
    const row = rowFromTarget(rows, target, requestedChatId);
    if (!row) {
      return blocked('not_found', 'Nao encontrei uma linha de conversa para o alvo pedido.', {
        requestedChatId: requestedChatId || String(target.chatId || ''),
      });
    }
    const chatId = requestedChatId || row.chatId;
    if (!chatId || !row.exportable || !row.url) {
      return blocked('identity_unproven', 'A linha encontrada nao comprova um chatId exportavel.', {
        requestedChatId: String(target.chatId || ''),
        observedChatId: row.chatId || undefined,
        warnings: row.warnings.length ? row.warnings : ['missing_chat_id'],
        evidence: row.evidence,
      });
    }

    if (openUrl) {
      await openUrl(row.url, row);
    } else if (clickRow) {
      await clickRow(row);
    } else {
      return blocked('adapter_contract_missing', 'Nenhum mecanismo de abertura foi fornecido.', {
        requestedChatId: chatId,
      });
    }

    const hydrated = waitForHydration
      ? await waitForHydration({ chatId, url: row.url, row })
      : { ok: true as const, turnCount: adapter.getHydrationState().turnCount };
    if (!hydrated.ok) return hydrated;

    return {
      ok: true,
      chatId,
      url: row.url,
      opened: true,
      reason: openUrl ? 'opened-url' : 'clicked-row',
      turnCount: hydrated.turnCount,
      warnings: [...row.warnings, ...(hydrated.warnings || [])],
      evidence: [...row.evidence, ...(hydrated.evidence || [])],
    };
  },
});
