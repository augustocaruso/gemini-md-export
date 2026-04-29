export const DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS = 10_000;

const normalizeTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
};

export const shouldRefreshRecentChats = (client, args = {}, options = {}) => {
  if (args.refresh === true) return true;
  if (args.refresh === false) return false;

  const conversations = Array.isArray(client?.conversations) ? client.conversations : [];
  if (conversations.length === 0) return true;
  const requestedCount = Number(options.requestedCount);
  if (Number.isFinite(requestedCount) && requestedCount > 0 && conversations.length >= requestedCount) {
    return false;
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : DEFAULT_RECENT_CHATS_CACHE_MAX_AGE_MS;
  const lastSeenAt = normalizeTimestamp(client?.lastSeenAt);

  if (!Number.isFinite(lastSeenAt)) return true;
  return now - lastSeenAt > maxAgeMs;
};

export const buildRecentChatsRefreshPlan = (client, args = {}, options = {}) => {
  const shouldRefresh = shouldRefreshRecentChats(client, args, options);
  const conversations = Array.isArray(client?.conversations) ? client.conversations : [];
  return {
    shouldRefresh,
    preferFastRefresh: shouldRefresh && conversations.length > 0,
  };
};
