export const isActivationTimeoutAlreadyReflected = (client) => client?.lastCommandTimeoutType === 'activate-browser-tab' &&
    (client.isActiveTab === true || client.page?.isActiveTab === true);
export const isRecentCommandFailureBlocking = (client, now, cooldownMs) => {
    const timedOutAt = Number(client?.lastCommandTimeoutAt || 0);
    if (!Number.isFinite(timedOutAt) || timedOutAt <= 0)
        return false;
    if (now - timedOutAt > cooldownMs)
        return false;
    return !isActivationTimeoutAlreadyReflected(client);
};
