import {
  type BrowserTabLifecycleState,
  evaluateBrowserLaunchGate,
  type ManagedBrowserTab,
  observeBrowserLaunchResult,
} from '../mcp/blocker-aware-tab-lifecycle.js';

type UnknownRecord = Record<string, unknown>;

export type CliBrowserLaunchGateInput = Readonly<{
  previousState: unknown;
  browserTabs: UnknownRecord | null;
  nowMs: number;
  launchId: string;
  targetUrl?: string;
  readyBlockingIssue?: unknown;
}>;

export type CliBlockedBrowserLaunch = Readonly<{
  attempted: false;
  supported: true;
  skipped: true;
  reason: 'terminal-browser-blocker';
  blocker: ReturnType<typeof evaluateBrowserLaunchGate>['blocker'];
  browserDiagnostic: UnknownRecord | null;
}>;

export type CliBrowserLaunchGate = Readonly<{
  canLaunch: boolean;
  launchId: string;
  targetUrl: string;
  state: BrowserTabLifecycleState;
  blockedLaunch: CliBlockedBrowserLaunch | null;
  blockedLaunchState: UnknownRecord | null;
  waitNote: Readonly<{ note: string; issue: unknown; inlineMessage: string | null }> | null;
}>;

const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';

const recordOrEmpty = (value: unknown): UnknownRecord =>
  value !== null && typeof value === 'object' ? (value as UnknownRecord) : {};

export const evaluateCliBrowserLaunchGate = ({
  previousState,
  browserTabs,
  nowMs,
  launchId,
  targetUrl = DEFAULT_GEMINI_URL,
  readyBlockingIssue = null,
}: CliBrowserLaunchGateInput): CliBrowserLaunchGate => {
  const gate = evaluateBrowserLaunchGate({
    launchState: previousState,
    diagnosis: browserTabs?.diagnosis || null,
    nowMs,
    launchId,
    source: 'cli',
    targetUrl,
  });
  if (gate.canLaunch) {
    return {
      canLaunch: true,
      launchId,
      targetUrl,
      state: gate.state,
      blockedLaunch: null,
      blockedLaunchState: null,
      waitNote: null,
    };
  }

  const blockedLaunch: CliBlockedBrowserLaunch = {
    attempted: false,
    supported: true,
    skipped: true,
    reason: 'terminal-browser-blocker',
    blocker: gate.blocker,
    browserDiagnostic: browserTabs,
  };
  return {
    canLaunch: false,
    launchId,
    targetUrl,
    state: gate.state,
    blockedLaunch,
    blockedLaunchState: {
      ...recordOrEmpty(previousState),
      source: 'cli',
      launchId,
      status: 'blocked',
      lastAttemptAt: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
      blockingIssue: gate.blocker?.code || readyBlockingIssue || null,
      tabLifecycle: gate.state,
      launch: blockedLaunch,
    },
    waitNote: {
      note: gate.blocker?.nextAction || 'Resolva o bloqueio no navegador',
      issue: gate.blocker?.code || readyBlockingIssue || null,
      inlineMessage: gate.blocker?.message || null,
    },
  };
};

export const observeCliBrowserLaunchResultState = ({
  state,
  nowMs = Date.now(),
  launchId,
  targetUrl = DEFAULT_GEMINI_URL,
  result,
}: Readonly<{
  state: BrowserTabLifecycleState;
  nowMs?: number;
  launchId: string;
  targetUrl?: string;
  result: Readonly<Record<string, unknown>>;
}>): BrowserTabLifecycleState =>
  observeBrowserLaunchResult({
    state,
    nowMs,
    launchId,
    source: 'cli' satisfies ManagedBrowserTab['source'],
    targetUrl,
    result,
  }).state;
