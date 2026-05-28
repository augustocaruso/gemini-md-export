import {
  type BrowserTabLifecycleState,
  evaluateBrowserLaunchGate,
  observeBrowserLaunchResult,
} from './blocker-aware-tab-lifecycle.js';

type UnknownRecord = Record<string, unknown>;

export type McpBrowserLaunchGateInput = Readonly<{
  previousState: unknown;
  browserTabs: UnknownRecord | null;
  nowMs: number;
  launchId: string;
  targetUrl: string;
}>;

export type McpBlockedBrowserLaunch = Readonly<{
  attempted: false;
  supported: true;
  skipped: true;
  reason: 'terminal-browser-blocker';
  blocker: ReturnType<typeof evaluateBrowserLaunchGate>['blocker'];
  browserDiagnostic: UnknownRecord;
}>;

export type McpBrowserLaunchGate = Readonly<{
  canLaunch: boolean;
  state: BrowserTabLifecycleState;
  blockedLaunch: McpBlockedBrowserLaunch | null;
  blockedLaunchState: UnknownRecord | null;
}>;

const recordOrEmpty = (value: unknown): UnknownRecord =>
  value !== null && typeof value === 'object' ? (value as UnknownRecord) : {};

const blockedBrowserDiagnostic = (
  browserTabs: UnknownRecord | null,
  blocker: McpBlockedBrowserLaunch['blocker'],
): UnknownRecord => ({
  ok: browserTabs?.ok === true,
  source: browserTabs?.source || 'unknown',
  diagnosis: blocker
    ? {
        kind: blocker.kind,
        terminal: true,
        url: blocker.url || null,
      }
    : browserTabs?.diagnosis || null,
  error: browserTabs?.error || null,
});

export const evaluateMcpBrowserLaunchGate = ({
  previousState,
  browserTabs,
  nowMs,
  launchId,
  targetUrl,
}: McpBrowserLaunchGateInput): McpBrowserLaunchGate => {
  const gate = evaluateBrowserLaunchGate({
    launchState: previousState,
    diagnosis: browserTabs?.diagnosis || null,
    nowMs,
    launchId,
    source: 'mcp',
    targetUrl,
  });
  if (gate.canLaunch) {
    return {
      canLaunch: true,
      state: gate.state,
      blockedLaunch: null,
      blockedLaunchState: null,
    };
  }
  const blockedLaunch: McpBlockedBrowserLaunch = {
    attempted: false,
    supported: true,
    skipped: true,
    reason: 'terminal-browser-blocker',
    blocker: gate.blocker,
    browserDiagnostic: blockedBrowserDiagnostic(browserTabs, gate.blocker),
  };
  return {
    canLaunch: false,
    state: gate.state,
    blockedLaunch,
    blockedLaunchState: {
      ...recordOrEmpty(previousState),
      source: 'mcp',
      launchId,
      status: 'blocked',
      lastAttemptAt: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
      targetUrl,
      blockingIssue: gate.blocker?.code || null,
      tabLifecycle: gate.state,
      launch: blockedLaunch,
    },
  };
};

export const observeMcpBrowserLaunchResultState = ({
  state,
  nowMs = Date.now(),
  launchId,
  targetUrl,
  result,
}: Readonly<{
  state: BrowserTabLifecycleState;
  nowMs?: number;
  launchId: string;
  targetUrl: string;
  result: Readonly<Record<string, unknown>>;
}>): BrowserTabLifecycleState =>
  observeBrowserLaunchResult({
    state,
    nowMs,
    launchId,
    source: 'mcp',
    targetUrl,
    result,
  }).state;
