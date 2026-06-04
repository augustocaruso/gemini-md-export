const positiveTabId = (value) => {
    const tabId = Number(value);
    return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
};
const compactUniqueNumbers = (items) => Array.from(new Set(items.map(positiveTabId).filter((value) => value !== null)));
export const jobProgressMirrorTabIdsForJob = (job = {}, primaryTabIdValue = null) => {
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
export const shouldMirrorJobProgressToClient = (client, { primaryClientId = null, mirrorTabIds = [], } = {}) => {
    if (!client)
        return false;
    if (primaryClientId && client.clientId === primaryClientId)
        return false;
    if (client.kind !== 'activity')
        return false;
    const tabId = positiveTabId(client.tabId);
    if (tabId === null)
        return false;
    return compactUniqueNumbers(mirrorTabIds).includes(tabId);
};
export const setJobProgressForPrimaryAndMirrors = (job = {}, primaryClient, payload, clients, setClientJobProgressAndNotify) => {
    setClientJobProgressAndNotify(primaryClient, payload);
    const mirrorTabIds = jobProgressMirrorTabIdsForJob(job, primaryClient?.tabId);
    const primaryClientId = primaryClient?.clientId || null;
    for (const client of clients) {
        if (!shouldMirrorJobProgressToClient(client, { primaryClientId, mirrorTabIds }))
            continue;
        setClientJobProgressAndNotify(client, {
            ...payload,
            mirroredFromClientId: primaryClientId,
        });
    }
};
