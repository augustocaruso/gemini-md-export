import {
  assertClaimableGeminiTab,
  type ClaimableGeminiTab,
  explainGeminiClientLifecycleRejection,
  type GeminiClientLifecycleCode,
  type GeminiClientLifecycleOptions,
  type GeminiClientSnapshot,
  type GeminiPageSnapshot,
  getClaimableGeminiTabs,
  toClaimableGeminiTab,
} from './client-lifecycle.js';

export type { GeminiClientSnapshot, GeminiPageSnapshot };

export type ActiveClaimableGeminiClient = ClaimableGeminiTab;
export type ActiveClaimableGeminiClientOptions = GeminiClientLifecycleOptions;
export type ActiveClaimableGeminiClientRejection = GeminiClientLifecycleCode;

export type ActiveClaimableGeminiClientDiagnostic = Readonly<{
  ok: false;
  code: ActiveClaimableGeminiClientRejection;
  message: string;
  state?: string;
  nextAction?: string;
  retryable?: boolean;
  manualReloadRecommended?: boolean;
}>;

export const explainActiveClaimableGeminiClientRejection = explainGeminiClientLifecycleRejection;

export const toActiveClaimableGeminiClient = toClaimableGeminiTab;

export const assertActiveClaimableGeminiClient = assertClaimableGeminiTab;

export const getActiveClaimableGeminiClients = getClaimableGeminiTabs;
