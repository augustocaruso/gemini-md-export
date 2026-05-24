import { clientHasPageBlocker, clientPageBlockerCode } from './bridge-health.js';
import type { GeminiClientSnapshot } from './client-lifecycle.js';

export type BrowserReadyBlockingIssue =
  | 'no_connected_clients'
  | 'extension_version_mismatch'
  | 'command_channel_not_ready'
  | 'no_selectable_gemini_tab'
  | 'no_active_claimable_gemini_tab'
  | string;

export type BrowserReadinessInput = Readonly<{
  allLiveClients?: readonly GeminiClientSnapshot[];
  selectableClients?: readonly GeminiClientSnapshot[];
  matchingClients?: readonly GeminiClientSnapshot[];
  commandReadyClients?: readonly GeminiClientSnapshot[];
  claimableClients?: readonly GeminiClientSnapshot[];
}>;

export type BrowserReadinessDecision = Readonly<{
  ready: boolean;
  blockingIssue: BrowserReadyBlockingIssue | null;
  connectedClientCount: number;
  selectableTabCount: number;
  claimableTabCount: number;
  matchingClientCount: number;
  commandReadyClientCount: number;
}>;

export const evaluateBrowserReadiness = ({
  allLiveClients = [],
  selectableClients = [],
  matchingClients = [],
  commandReadyClients = [],
  claimableClients = [],
}: BrowserReadinessInput = {}): BrowserReadinessDecision => {
  const ready = claimableClients.length > 0;
  let blockingIssue: BrowserReadyBlockingIssue | null = null;

  if (!ready) {
    const blockedClient = allLiveClients.find(clientHasPageBlocker);
    if (allLiveClients.length === 0) {
      blockingIssue = 'no_connected_clients';
    } else if (blockedClient) {
      blockingIssue = clientPageBlockerCode(blockedClient) || 'google_page_blocked';
    } else if (matchingClients.length === 0) {
      blockingIssue = 'extension_version_mismatch';
    } else if (commandReadyClients.length === 0) {
      blockingIssue = 'command_channel_not_ready';
    } else if (selectableClients.length === 0) {
      blockingIssue = 'no_selectable_gemini_tab';
    } else {
      blockingIssue = 'no_active_claimable_gemini_tab';
    }
  }

  return {
    ready,
    blockingIssue,
    connectedClientCount: allLiveClients.length,
    selectableTabCount: selectableClients.length,
    claimableTabCount: claimableClients.length,
    matchingClientCount: matchingClients.length,
    commandReadyClientCount: commandReadyClients.length,
  };
};
