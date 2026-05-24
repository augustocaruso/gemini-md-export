import type { MetadataCandidate } from '../../core/metadata-evidence.js';
import type {
  BlockedResult,
  ChatId,
  ChatSnapshot,
  MetadataEvidence,
  SanitizedEvidence,
} from '../../core/types.js';

export type GeminiRouteKind = 'chat' | 'notebook' | 'home' | 'unknown';

export type GeminiRouteState = {
  kind: GeminiRouteKind;
  url: string;
  path: string;
  chatId: ChatId | null;
  notebookId: string | null;
  warnings: string[];
  evidence: SanitizedEvidence[];
};

export type GeminiConversationRow = {
  source: 'sidebar' | 'notebook' | 'unknown';
  index: number;
  title: string;
  url: string | null;
  chatId: ChatId | null;
  exportable: boolean;
  current: boolean;
  warnings: string[];
  evidence: SanitizedEvidence[];
};

export type GeminiHydrationState = {
  turnCount: number;
  isLoading: boolean;
  warnings: string[];
  evidence: SanitizedEvidence[];
};

export type GeminiDomAdapter = {
  getRouteState: () => GeminiRouteState;
  listConversationRows: () => GeminiConversationRow[];
  getHydrationState: () => GeminiHydrationState;
  getCurrentSnapshot: () => ChatSnapshot | BlockedResult;
};

export type ActivityScanInput = {
  candidates: MetadataCandidate[];
  maxCards?: number;
};

export type ActivityScanResult = {
  evidence: MetadataEvidence[];
  loadedCardCount: number;
  scannedCardCount: number;
  resolvedChatIds: ChatId[];
  lastSeenActivityToken: string | null;
  warnings: string[];
};

export type ActivityDomAdapter = {
  scanLoadedEvidence: (input: ActivityScanInput) => ActivityScanResult;
};
