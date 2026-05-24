import type { ChatId, SanitizedEvidence } from '../../core/types.js';
import type { GeminiConversationRow, GeminiDomAdapter } from '../dom-adapter/types.js';

export type NavigationTarget = {
  chatId?: ChatId | string | null;
  url?: string | null;
  rowIndex?: number | null;
  row?: GeminiConversationRow | null;
};

export type NavigationBlockedCode =
  | 'identity_unproven'
  | 'not_found'
  | 'busy_tab'
  | 'timeout'
  | 'empty_chat'
  | 'adapter_contract_missing';

export type NavigationBlockedResult = {
  ok: false;
  code: NavigationBlockedCode;
  message: string;
  requestedChatId?: string;
  observedChatId?: string;
  warnings: string[];
  evidence: SanitizedEvidence[];
};

export type NavigationOkResult = {
  ok: true;
  chatId: ChatId;
  url: string;
  opened: boolean;
  reason: 'already-current' | 'opened-url' | 'clicked-row';
  turnCount: number | null;
  warnings: string[];
  evidence: SanitizedEvidence[];
};

export type NavigationResult = NavigationOkResult | NavigationBlockedResult;

export type HydrationWaitResult =
  | {
      ok: true;
      turnCount: number;
      warnings?: string[];
      evidence?: SanitizedEvidence[];
    }
  | NavigationBlockedResult;

export type NavigationEngineOptions = {
  adapter: GeminiDomAdapter;
  isBusy?: () => boolean;
  openUrl?: (url: string, row: GeminiConversationRow) => void | Promise<void>;
  clickRow?: (row: GeminiConversationRow) => void | Promise<void>;
  waitForHydration?: (target: {
    chatId: ChatId;
    url: string;
    row: GeminiConversationRow;
  }) => HydrationWaitResult | Promise<HydrationWaitResult>;
};

export type NavigationEngine = {
  openChat: (target: NavigationTarget) => Promise<NavigationResult>;
};
