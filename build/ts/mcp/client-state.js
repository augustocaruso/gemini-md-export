const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const mergeExplicitNullableClientState = (current, payload) => ({
    tabClaim: hasOwn(payload, 'tabClaim') ? (payload.tabClaim ?? null) : (current.tabClaim ?? null),
    metrics: hasOwn(payload, 'metrics') ? (payload.metrics ?? null) : (current.metrics ?? null),
});
export const currentTabOperationInProgress = (client) => Boolean(client.metrics?.tabOperation?.active) ||
    Boolean(client.summary?.metrics?.tabOperation?.active);
