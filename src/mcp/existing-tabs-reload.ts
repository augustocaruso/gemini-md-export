export type ExistingTabsExtensionReloadResult = Readonly<{
  ok: boolean;
  reloadAttempts?: number;
  client?: unknown;
  info?: unknown;
  timings?: unknown;
  error?: string;
  code?: string | null;
  data?: unknown;
}>;

type EnsureBrowserExtensionReady = (
  args: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<{
  reloadAttempts?: number | null;
  client?: unknown;
  info?: unknown;
  timings?: unknown;
}>;

export const reloadExtensionForExistingTabs = async (
  args: Record<string, unknown> = {},
  ensureBrowserExtensionReady: EnsureBrowserExtensionReady,
  summarizeClient: (client: unknown) => unknown,
  reloadTimeoutMs: number,
  normalizeReloadWaitMs: (value: unknown, fallback: number) => number,
  cleanupStaleClients?: () => void,
): Promise<ExistingTabsExtensionReloadResult | null> => {
  if (args.allowReload !== true) return null;
  try {
    const ready = await ensureBrowserExtensionReady(args, {
      allowLaunchChrome: false,
      allowReload: args.allowReload === true,
      config: {
        initialConnectTimeoutMs: 0,
        reloadTimeoutMs: normalizeReloadWaitMs(args.reloadWaitMs, reloadTimeoutMs),
      },
    });
    return {
      ok: true,
      reloadAttempts: Number(ready.reloadAttempts || 0),
      client: summarizeClient(ready.client),
      info: ready.info || null,
      timings: ready.timings || null,
    };
  } catch (err) {
    const error = err as Error & { code?: string | null; data?: unknown };
    return {
      ok: false,
      error: error.message,
      code: error.code || null,
      data: error.data || null,
    };
  } finally {
    cleanupStaleClients?.();
  }
};

export type ActivityClaimAffinityInput = Readonly<{
  baseSessionId: string;
  activityClientId: string;
  existingGeminiSessionClaim?: {
    claimId?: string | null;
    clientId?: string | null;
    tabId?: number | null;
  } | null;
  requestedVisualGroupTabId?: number | null;
}>;

export const buildActivityClaimAffinity = (
  baseSessionId: string,
  activityClientId: string,
  existingGeminiSessionClaim: ActivityClaimAffinityInput['existingGeminiSessionClaim'] = null,
  requestedVisualGroupTabId: number | null = null,
): {
  sessionId: string;
  visualGroupTabId: number | null;
  joinsExistingGeminiClaim: boolean;
} => {
  const joinsExistingGeminiClaim =
    !!existingGeminiSessionClaim?.clientId &&
    existingGeminiSessionClaim.clientId !== activityClientId;
  return {
    sessionId:
      existingGeminiSessionClaim?.claimId && joinsExistingGeminiClaim
        ? `${baseSessionId}:activity:${existingGeminiSessionClaim.claimId}`
        : baseSessionId,
    visualGroupTabId:
      existingGeminiSessionClaim?.tabId && joinsExistingGeminiClaim
        ? existingGeminiSessionClaim.tabId
        : requestedVisualGroupTabId,
    joinsExistingGeminiClaim,
  };
};

export const normalizePositiveIntegerOrNull = (
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safeValue = Math.floor(parsed);
  if (safeValue < 1) return null;
  return Math.min(safeValue, max);
};

export const previousWebConversationCountForResumeReport = (
  report: {
    webConversationCount?: unknown;
    resume?: { previousCounters?: { webConversationCount?: unknown } | null } | null;
  } | null | undefined,
  max: number,
): number | null =>
  normalizePositiveIntegerOrNull(report?.resume?.previousCounters?.webConversationCount, max) ??
  normalizePositiveIntegerOrNull(report?.webConversationCount, max);

export const recentChatsResumeCounters = (
  report: {
    webConversationCount?: unknown;
    existingVaultCount?: unknown;
    missingCount?: unknown;
    reachedEnd?: unknown;
    truncated?: unknown;
    job?: { fullHistoryVerified?: unknown } | null;
    resume?: { previousCounters?: { webConversationCount?: unknown } | null } | null;
  },
  max: number,
) => ({
  webConversationCount: previousWebConversationCountForResumeReport(report, max),
  existingVaultCount: report.existingVaultCount ?? 0,
  missingCount: report.missingCount ?? null,
  reachedEnd: report.reachedEnd ?? null,
  truncated: report.truncated ?? null,
  fullHistoryVerified: report.job?.fullHistoryVerified ?? null,
});

export const recentExportResumeScope = (
  args: { maxChats?: unknown; limit?: unknown } = {},
  resume: { previousCounters?: { webConversationCount?: unknown } | null } | null | undefined,
  exportMissingOnly: boolean,
  syncMode: boolean,
  maxChatsLoadTarget: number,
): {
  hasExplicitMaxChats: boolean;
  resumeMaxChats: number | null;
  effectiveHasMaxChats: boolean;
} => {
  const hasExplicitMaxChats = args.maxChats !== undefined || args.limit !== undefined;
  const resumeMaxChats =
    !exportMissingOnly && !syncMode
      ? normalizePositiveIntegerOrNull(
          resume?.previousCounters?.webConversationCount,
          maxChatsLoadTarget,
        )
      : null;
  return {
    hasExplicitMaxChats,
    resumeMaxChats,
    effectiveHasMaxChats: hasExplicitMaxChats || resumeMaxChats !== null,
  };
};
