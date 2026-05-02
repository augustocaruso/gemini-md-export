export const DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS = 8;
export const DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND = 2;
export const MAX_RECENT_CHATS_LOAD_TARGET = 1000;

export const normalizeRecentChatsLoadMorePlan = (
  currentCount,
  requestedLimit,
  args = {},
  {
    defaultRounds = DEFAULT_RECENT_CHATS_LOAD_MORE_ROUNDS,
    defaultAttemptsPerRound = DEFAULT_RECENT_CHATS_LOAD_ATTEMPTS_PER_ROUND,
    maxRounds = 30,
    maxAttemptsPerRound = 5,
    maxTargetCount = MAX_RECENT_CHATS_LOAD_TARGET,
  } = {},
) => {
  const loadedCount = Math.max(0, Number(currentCount) || 0);
  const targetCount = Math.max(1, Math.min(maxTargetCount, Number(requestedLimit) || 10));
  const requestedRounds = Number(args.loadMoreRounds ?? args.maxLoadMoreRounds ?? defaultRounds);
  const requestedAttempts = Number(args.loadMoreAttempts ?? defaultAttemptsPerRound);
  const reachedEnd = args.reachedEnd === true;

  const rounds = Math.max(0, Math.min(maxRounds, Number.isFinite(requestedRounds) ? requestedRounds : defaultRounds));
  const attemptsPerRound = Math.max(
    1,
    Math.min(maxAttemptsPerRound, Number.isFinite(requestedAttempts) ? requestedAttempts : defaultAttemptsPerRound),
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
