const normalizeId = (value) => String(value || '').trim();
const normalizeTabId = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
};
export const selectExplicitReloadClient = (liveClients, selector = {}) => {
    const clientId = normalizeId(selector.clientId);
    if (clientId) {
        return liveClients.find((client) => normalizeId(client.clientId) === clientId) || null;
    }
    const tabId = normalizeTabId(selector.tabId);
    if (tabId !== null) {
        return (liveClients.find((client) => {
            const clientTabId = normalizeTabId(client.tabId);
            return clientTabId !== null && clientTabId === tabId;
        }) || null);
    }
    return null;
};
