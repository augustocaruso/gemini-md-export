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

const normalizeCount = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
};

const normalizeKind = (...values) =>
  values.find((value) => typeof value === 'string' && value.length > 0) || null;

const addCountEvidence = (items, field, value, kind = 'sidebar') => {
  const count = normalizeCount(value);
  if (count === null) return;
  items.push({ field, count, kind });
};

export const browserSidebarCountEvidenceGroups = (client = {}) => {
  const groups = [];
  const addPageGroup = (name, page, pageKind) => {
    if (!page || typeof page !== 'object') return;
    const kind = normalizeKind(page.kind, page.pageKind, pageKind);
    const isNotebook = kind === 'notebook';
    const evidence = [];
    addCountEvidence(evidence, 'sidebarConversationCount', page.sidebarConversationCount, 'sidebar');
    addCountEvidence(evidence, 'bridgeConversationCount', page.bridgeConversationCount, 'sidebar');
    if (!isNotebook) {
      addCountEvidence(evidence, 'listedConversationCount', page.listedConversationCount, 'listed');
    }
    if (evidence.length > 0) groups.push({ source: name, pageKind: kind, evidence });
  };

  addPageGroup('client.page', client.page, client.pageKind);
  addPageGroup(
    'client.lastSnapshot.page',
    client.lastSnapshot?.page,
    normalizeKind(client.lastSnapshot?.pageKind, client.lastSnapshot?.kind),
  );

  return groups;
};

export const inferRecentChatsCountStatus = (client, loadedCount, options = {}) => {
  const count = normalizeCount(loadedCount) ?? 0;
  if (options.reachedEnd === true) {
    return {
      countStatus: 'complete',
      totalKnown: true,
      totalCount: count,
      countSource: 'sidebar_end',
      countConfidence: 'confirmed',
      countEvidence: [],
    };
  }

  const countEvidence = browserSidebarCountEvidenceGroups(client);
  const confirmingGroup = countEvidence.find((group) => {
    if (count <= 0 || group.evidence.length < 2) return false;
    if (!group.evidence.some((item) => item.kind === 'sidebar')) return false;
    return group.evidence.every((item) => item.count === count);
  });

  if (confirmingGroup) {
    return {
      countStatus: 'complete',
      totalKnown: true,
      totalCount: count,
      countSource: 'browser_dom_count_match',
      countConfidence: 'dom-counts-agree',
      countEvidence: [confirmingGroup],
    };
  }

  return {
    countStatus: 'partial',
    totalKnown: false,
    totalCount: null,
    countSource: 'unconfirmed',
    countConfidence: 'partial',
    countEvidence,
  };
};
