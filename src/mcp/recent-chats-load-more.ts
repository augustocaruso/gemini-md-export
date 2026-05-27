export const DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS = 8;
export const DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND = 2;
export const MAX_RECENT_CHATS_LOAD_TARGET = 1000;
export const DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS = 45_000;
export const DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS = 30_000;

export type RecentChatsLoadMoreArgs = Readonly<{
  loadMoreRounds?: unknown;
  maxLoadMoreRounds?: unknown;
  loadMoreAttempts?: unknown;
  reachedEnd?: unknown;
}>;

export type RecentChatsLoadMorePlanOptions = Readonly<{
  defaultRounds?: number;
  defaultAttemptsPerRound?: number;
  maxRounds?: number;
  maxAttemptsPerRound?: number;
  maxTargetCount?: number;
}>;

export type RecentChatsLoadMorePlan = Readonly<{
  loadedCount: number;
  targetCount: number;
  reachedEnd: boolean;
  rounds: number;
  attemptsPerRound: number;
  shouldLoadMore: boolean;
}>;

export type RecentChatsLoadMoreEnv = Readonly<Record<string, string | undefined>>;

export type RecentChatsLoadMoreRuntimeConfig = Readonly<{
  loadMoreBudgetMs: number;
  loadMoreBrowserTimeoutMs: number;
}>;

const finiteNumberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const recentChatsLoadMoreRuntimeConfig = (
  env: RecentChatsLoadMoreEnv = process.env,
): RecentChatsLoadMoreRuntimeConfig => ({
  loadMoreBudgetMs: finiteNumberOr(
    env.GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BUDGET_MS,
    DEFAULT_RECENT_CHATS_LOAD_MORE_BUDGET_MS,
  ),
  loadMoreBrowserTimeoutMs: finiteNumberOr(
    env.GEMINI_MCP_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS,
    DEFAULT_RECENT_CHATS_LOAD_MORE_BROWSER_TIMEOUT_MS,
  ),
});

export const normalizeRecentChatsLoadMorePlan = (
  currentCount: unknown,
  requestedLimit: unknown,
  args: RecentChatsLoadMoreArgs = {},
  {
    defaultRounds = DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS,
    defaultAttemptsPerRound = DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND,
    maxRounds = 30,
    maxAttemptsPerRound = 5,
    maxTargetCount = MAX_RECENT_CHATS_LOAD_TARGET,
  }: RecentChatsLoadMorePlanOptions = {},
): RecentChatsLoadMorePlan => {
  const loadedCount = Math.max(0, Number(currentCount) || 0);
  const targetCount = Math.max(1, Math.min(maxTargetCount, Number(requestedLimit) || 10));
  const requestedRounds = Number(args.loadMoreRounds ?? args.maxLoadMoreRounds ?? defaultRounds);
  const requestedAttempts = Number(args.loadMoreAttempts ?? defaultAttemptsPerRound);
  const reachedEnd = args.reachedEnd === true;

  const rounds = Math.max(
    0,
    Math.min(maxRounds, Number.isFinite(requestedRounds) ? requestedRounds : defaultRounds),
  );
  const attemptsPerRound = Math.max(
    1,
    Math.min(
      maxAttemptsPerRound,
      Number.isFinite(requestedAttempts) ? requestedAttempts : defaultAttemptsPerRound,
    ),
  );

  return {
    loadedCount,
    targetCount,
    reachedEnd,
    rounds,
    attemptsPerRound,
    shouldLoadMore: loadedCount < targetCount && !reachedEnd && rounds > 0,
  };
};
