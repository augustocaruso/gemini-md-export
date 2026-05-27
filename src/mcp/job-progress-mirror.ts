type AnyRecord = Record<string, any>;

const positiveTabId = (value: unknown): number | null => {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
};

const compactUniqueNumbers = (items: readonly unknown[]): number[] =>
  Array.from(
    new Set(
      items
        .map(positiveTabId)
        .filter((value): value is number => value !== null),
    ),
  );

export const jobProgressMirrorTabIdsForJob = (
  job: AnyRecord = {},
  primaryTabIdValue: unknown = null,
): number[] => {
  const primaryTabId = positiveTabId(primaryTabIdValue);
  const visualTabIds = Array.isArray(job.nativeExportLease?.visual?.tabIds)
    ? job.nativeExportLease.visual.tabIds
    : [];
  return compactUniqueNumbers([
    job.activityCompanion?.tabId,
    job.activityCompanion?.client?.tabId,
    ...visualTabIds,
  ]).filter((tabId) => tabId !== primaryTabId);
};

export const shouldMirrorJobProgressToClient = (
  client: AnyRecord | null | undefined,
  {
    primaryClientId = null,
    mirrorTabIds = [],
  }: {
    primaryClientId?: unknown;
    mirrorTabIds?: readonly unknown[];
  } = {},
): boolean => {
  if (!client) return false;
  if (primaryClientId && client.clientId === primaryClientId) return false;
  if (client.kind !== 'activity') return false;
  const tabId = positiveTabId(client.tabId);
  if (tabId === null) return false;
  return compactUniqueNumbers(mirrorTabIds).includes(tabId);
};

export const setJobProgressForPrimaryAndMirrors = (
  job: AnyRecord = {},
  primaryClient: AnyRecord | null | undefined,
  payload: AnyRecord,
  clients: Iterable<AnyRecord>,
  setClientJobProgressAndNotify: (client: AnyRecord | null | undefined, payload: AnyRecord) => void,
): void => {
  setClientJobProgressAndNotify(primaryClient, payload);
  const mirrorTabIds = jobProgressMirrorTabIdsForJob(job, primaryClient?.tabId);
  const primaryClientId = primaryClient?.clientId || null;
  for (const client of clients) {
    if (!shouldMirrorJobProgressToClient(client, { primaryClientId, mirrorTabIds })) continue;
    setClientJobProgressAndNotify(client, {
      ...payload,
      mirroredFromClientId: primaryClientId,
    });
  }
};
