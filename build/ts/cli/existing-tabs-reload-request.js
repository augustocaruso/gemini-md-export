import { shouldReloadAllExistingTabsForReady } from './browser-ready-policy.js';
export const buildExistingTabsReloadRequestParams = (flags = {}, ready = {}) => ({
    action: 'reload',
    openIfMissing: false,
    allowReload: true,
    reloadAll: shouldReloadAllExistingTabsForReady(ready, flags),
    delayMs: flags.delayMs,
    ...(flags.allowHttpBrowserFallback === true ? { allowHttpBrowserFallback: true } : {}),
});
