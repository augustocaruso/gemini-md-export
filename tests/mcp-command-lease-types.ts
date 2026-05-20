import {
  type BrowserCommandRequest,
  type CommandClientLease,
  type CommandClientState,
  enqueueBrowserCommandWithLease,
} from '../src/mcp/command-lease.js';
import type {
  ClaimedDebuggableGeminiTab,
  DebuggableGeminiTab,
  RawBrowserTab,
} from '../src/browser/background/browser-session-broker.js';

declare const rawClient: CommandClientState;
declare const lease: CommandClientLease;
declare const request: BrowserCommandRequest;
declare const dispatch: (
  lease: CommandClientLease,
  request: BrowserCommandRequest,
) => Promise<unknown>;

void enqueueBrowserCommandWithLease(lease, request, dispatch);

// @ts-expect-error Raw browser client snapshots are not command capabilities.
void enqueueBrowserCommandWithLease(rawClient, request, dispatch);

declare function acceptsExportTab(tab: ClaimedDebuggableGeminiTab): void;
declare function startNativeExport(tab: ClaimedDebuggableGeminiTab): void;

declare const rawTab: RawBrowserTab;
declare const debuggable: DebuggableGeminiTab;

// @ts-expect-error Raw browser tabs cannot start export workflows.
acceptsExportTab(rawTab);

// @ts-expect-error Export requires an explicit claim.
startNativeExport(debuggable);
