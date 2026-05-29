import type {
  BrowserAuthorityEffect,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from '../src/mcp/browser-authority/index.js';

declare const lease: BrowserLease;
declare const unleasedLaunch: BrowserAuthorityEffect & { type: 'browser.launch' };
declare const leasedLaunch: LeasedBrowserAuthorityEffect & { type: 'browser.launch' };

declare function executeBrowserEffect(effect: LeasedBrowserAuthorityEffect): void;
declare function acceptLease(value: BrowserLease): void;

acceptLease(lease);
executeBrowserEffect(leasedLaunch);

// @ts-expect-error Browser mutations require a leased effect.
executeBrowserEffect(unleasedLaunch);
