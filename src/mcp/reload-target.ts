export type ReloadClient = Readonly<{
  clientId?: string | null;
  tabId?: number | string | null;
}>;

export type ReloadClientSelector = Readonly<{
  clientId?: string | null;
  tabId?: number | string | null;
}>;

const normalizeId = (value: unknown): string => String(value || '').trim();

const normalizeTabId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

export const selectExplicitReloadClient = <T extends ReloadClient>(
  liveClients: readonly T[],
  selector: ReloadClientSelector = {},
): T | null => {
  const clientId = normalizeId(selector.clientId);
  if (clientId) {
    return liveClients.find((client) => normalizeId(client.clientId) === clientId) || null;
  }

  const tabId = normalizeTabId(selector.tabId);
  if (tabId !== null) {
    return (
      liveClients.find((client) => {
        const clientTabId = normalizeTabId(client.tabId);
        return clientTabId !== null && clientTabId === tabId;
      }) || null
    );
  }

  return null;
};
