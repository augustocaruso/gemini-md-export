export type ChromeDebuggerTarget = Readonly<{
  tabId: number;
}>;

export type ChromeDebuggerApi = Readonly<{
  runtime?: {
    lastError?: {
      message?: string;
    } | null;
  };
  debugger?: {
    attach(target: ChromeDebuggerTarget, protocolVersion: string, callback: () => void): void;
    sendCommand(
      target: ChromeDebuggerTarget,
      method: string,
      params: Record<string, unknown>,
      callback: (result?: unknown) => void,
    ): void;
    detach(target: ChromeDebuggerTarget, callback?: () => void): void;
  };
}>;

export type ActivateTabWithDebuggerOptions = Readonly<{
  chromeApi?: ChromeDebuggerApi;
  protocolVersion?: string;
  reason?: string;
  disableDebugger?: boolean;
}>;

export type DebuggerActivationResult = Readonly<{
  ok: boolean;
  mode: 'chrome-debugger-cdp';
  reason: string;
  tabId: number | null;
  protocolVersion?: string;
  result?: unknown;
  error?: string;
}>;

const lastChromeErrorMessage = (chromeApi: ChromeDebuggerApi): string | null => {
  const message = chromeApi.runtime?.lastError?.message;
  return typeof message === 'string' && message ? message : null;
};

const callbackResult = <T>(
  chromeApi: ChromeDebuggerApi,
  invoke: (callback: (result?: T) => void) => void,
  errorReason: string,
): Promise<T | undefined> =>
  new Promise((resolve) => {
    try {
      invoke((result?: T) => {
        const error = lastChromeErrorMessage(chromeApi);
        if (error) {
          resolve({ __chromeDebuggerError: { reason: errorReason, error } } as T);
          return;
        }
        resolve(result);
      });
    } catch (err) {
      resolve({
        __chromeDebuggerError: {
          reason: errorReason,
          error: err instanceof Error ? err.message : String(err),
        },
      } as T);
    }
  });

const debuggerErrorFromResult = (result: unknown): { reason: string; error: string } | null => {
  const marker = (result as { __chromeDebuggerError?: { reason?: string; error?: string } } | null)
    ?.__chromeDebuggerError;
  if (!marker?.error) return null;
  return {
    reason: marker.reason || 'debugger-command-failed',
    error: marker.error,
  };
};

export const shouldUseDebuggerForTabControl = (
  chromeApi: ChromeDebuggerApi | undefined,
  options: Pick<ActivateTabWithDebuggerOptions, 'disableDebugger'> = {},
): boolean =>
  options.disableDebugger !== true &&
  typeof chromeApi?.debugger?.attach === 'function' &&
  typeof chromeApi.debugger.sendCommand === 'function' &&
  typeof chromeApi.debugger.detach === 'function';

export const activateTabWithDebugger = async (
  tabId: number,
  options: ActivateTabWithDebuggerOptions = {},
): Promise<DebuggerActivationResult> => {
  const chromeApi =
    options.chromeApi || (globalThis as unknown as { chrome?: ChromeDebuggerApi }).chrome;
  const protocolVersion = options.protocolVersion || '1.3';
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return {
      ok: false,
      mode: 'chrome-debugger-cdp',
      reason: 'tab-id-unavailable',
      tabId: null,
    };
  }
  if (!chromeApi || !shouldUseDebuggerForTabControl(chromeApi, options) || !chromeApi.debugger) {
    return {
      ok: false,
      mode: 'chrome-debugger-cdp',
      reason: 'debugger-api-unavailable',
      tabId,
    };
  }
  const debuggerApi = chromeApi.debugger;

  const target = { tabId };
  const attached = await callbackResult(
    chromeApi,
    (callback) => debuggerApi.attach(target, protocolVersion, callback),
    'debugger-attach-failed',
  );
  const attachError = debuggerErrorFromResult(attached);
  if (attachError) {
    return {
      ok: false,
      mode: 'chrome-debugger-cdp',
      reason: attachError.reason,
      error: attachError.error,
      tabId,
      protocolVersion,
    };
  }

  try {
    const result = await callbackResult(
      chromeApi,
      (callback) => debuggerApi.sendCommand(target, 'Page.bringToFront', {}, callback),
      'debugger-command-failed',
    );
    const commandError = debuggerErrorFromResult(result);
    if (commandError) {
      return {
        ok: false,
        mode: 'chrome-debugger-cdp',
        reason: commandError.reason,
        error: commandError.error,
        tabId,
        protocolVersion,
      };
    }
    return {
      ok: true,
      mode: 'chrome-debugger-cdp',
      reason: options.reason || 'activate-tab',
      tabId,
      protocolVersion,
      result,
    };
  } finally {
    await new Promise<void>((resolve) => {
      try {
        debuggerApi.detach(target, () => resolve());
      } catch {
        resolve();
      }
    });
  }
};
