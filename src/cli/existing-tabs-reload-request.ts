import { shouldReloadAllExistingTabsForReady } from './browser-ready-policy.js';

export type ExistingTabsReloadCliFlags = Readonly<{
  allowReload?: boolean;
  allowHttpBrowserFallback?: boolean;
  delayMs?: unknown;
}>;

export type ExistingTabsReloadReadyState = Readonly<Record<string, unknown>>;

export const buildExistingTabsReloadRequestParams = (
  flags: ExistingTabsReloadCliFlags = {},
  ready: ExistingTabsReloadReadyState = {},
) => ({
  action: 'reload',
  openIfMissing: false,
  allowReload: true,
  reloadAll: shouldReloadAllExistingTabsForReady(ready, flags),
  delayMs: flags.delayMs,
  ...(flags.allowHttpBrowserFallback === true ? { allowHttpBrowserFallback: true } : {}),
});
