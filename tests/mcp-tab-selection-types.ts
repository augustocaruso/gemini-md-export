import {
  assertClaimableGeminiTab,
  assertClaimedReadyGeminiTab,
  type ClaimableGeminiTab,
  type ClaimedReadyGeminiTab,
  type GeminiClientSnapshot,
} from '../src/mcp/client-lifecycle.js';

declare const rawClient: GeminiClientSnapshot;
declare const claimGeminiTab: (client: ClaimableGeminiTab) => void;
declare const exportFromClaimedTab: (client: ClaimedReadyGeminiTab) => void;
declare const requireRuntimeSignal: (client: { lastRuntimeSignalAt: number }) => void;
declare const requireCommandReady: (client: { commandReady: true }) => void;
declare const requireHeartbeat: (client: { lastHeartbeatAt: number }) => void;

claimGeminiTab(
  assertClaimableGeminiTab(rawClient, {
    now: 1_000,
    staleAfterMs: 45_000,
  }),
);

// @ts-expect-error Raw bridge snapshots must pass through the lifecycle broker before claim.
claimGeminiTab(rawClient);

exportFromClaimedTab(
  assertClaimedReadyGeminiTab(rawClient, {
    now: 1_000,
    staleAfterMs: 45_000,
    requireClaimed: true,
    sessionId: 'session-a',
    claims: [
      {
        claimId: 'claim-a',
        clientId: rawClient.clientId,
        sessionId: 'session-a',
        tabId: rawClient.tabId,
        expiresAtMs: 60_000,
      },
    ],
  }),
);

const claimedReady = assertClaimedReadyGeminiTab(rawClient, {
  now: 1_000,
  staleAfterMs: 45_000,
  requireClaimed: true,
  sessionId: 'session-a',
  claims: [
    {
      claimId: 'claim-a',
      clientId: rawClient.clientId,
      sessionId: 'session-a',
      tabId: rawClient.tabId,
      expiresAtMs: 60_000,
    },
  ],
});
requireRuntimeSignal(claimedReady);
requireCommandReady(claimedReady);

// @ts-expect-error Command-ready tabs must not expose heartbeat as their compile-time proof.
requireHeartbeat(claimedReady);

// @ts-expect-error Export jobs require a claimed-ready tab, not merely a raw client.
exportFromClaimedTab(rawClient);

const inactiveClient = {
  clientId: 'chat-inactive',
  tabId: 123,
  isActiveTab: false,
  lastHeartbeatAt: 1_000,
  page: {
    url: 'https://gemini.google.com/app/88a98a108cdcfb61',
    chatId: '88a98a108cdcfb61',
  },
} satisfies GeminiClientSnapshot;

// @ts-expect-error A statically-known inactive tab is never claimable.
claimGeminiTab(inactiveClient);
