export type BrowserPageKind = 'gemini' | 'my_activity' | 'google_login' | 'google_sorry' | 'other';

export type DebuggerTabInspection = Readonly<{
  ok: boolean;
  tabId: number;
  url: string | null;
  pageKind: BrowserPageKind;
  blockerCode: string | null;
  readyState?: string | null;
  error?: string;
}>;

type ChromeDebuggerTarget = Readonly<{ tabId: number }>;

type ChromeDebuggerApi = Readonly<{
  runtime?: { lastError?: { message?: string } | null };
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

export const classifyBrowserUrl = (url: string | null | undefined): BrowserPageKind => {
  const value = String(url || '');
  if (value.startsWith('https://gemini.google.com/')) return 'gemini';
  if (value.startsWith('https://myactivity.google.com/product/gemini')) return 'my_activity';
  if (value.startsWith('https://accounts.google.com/')) return 'google_login';
  if (value.startsWith('https://www.google.com/sorry/')) return 'google_sorry';
  return 'other';
};

const blockerCodeForKind = (kind: BrowserPageKind): string | null => {
  if (kind === 'google_login') return 'google_login_required';
  if (kind === 'google_sorry') return 'google_verification_required';
  return null;
};

const lastChromeError = (chromeApi: ChromeDebuggerApi): string | null => {
  const message = chromeApi.runtime?.lastError?.message;
  return typeof message === 'string' && message ? message : null;
};

const callbackResult = <T>(
  chromeApi: ChromeDebuggerApi,
  invoke: (callback: (value?: T) => void) => void,
): Promise<{ ok: true; value?: T } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    try {
      invoke((value?: T) => {
        const error = lastChromeError(chromeApi);
        if (error) {
          resolve({ ok: false, error });
          return;
        }
        resolve({ ok: true, value });
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

const runtimeInspectionValue = (
  result: unknown,
): { href?: string | null; readyState?: string | null } => {
  const value = (result as { result?: { value?: unknown } } | null)?.result?.value;
  return value && typeof value === 'object'
    ? (value as { href?: string | null; readyState?: string | null })
    : {};
};

export const inspectTabWithDebugger = async (
  tabId: number,
  {
    chromeApi = (globalThis as { chrome?: ChromeDebuggerApi }).chrome,
    protocolVersion = '1.3',
  }: { chromeApi?: ChromeDebuggerApi; protocolVersion?: string } = {},
): Promise<DebuggerTabInspection> => {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return {
      ok: false,
      tabId,
      url: null,
      pageKind: 'other',
      blockerCode: null,
      error: 'tab-id-unavailable',
    };
  }
  if (!chromeApi?.debugger) {
    return {
      ok: false,
      tabId,
      url: null,
      pageKind: 'other',
      blockerCode: null,
      error: 'debugger-api-unavailable',
    };
  }

  const target = { tabId };
  const attached = await callbackResult(chromeApi, (callback) =>
    chromeApi.debugger?.attach(target, protocolVersion, callback),
  );
  if (!attached.ok) {
    return {
      ok: false,
      tabId,
      url: null,
      pageKind: 'other',
      blockerCode: null,
      error: attached.error,
    };
  }

  try {
    const evaluated = await callbackResult(chromeApi, (callback) =>
      chromeApi.debugger?.sendCommand(
        target,
        'Runtime.evaluate',
        {
          expression: '({ href: location.href, readyState: document.readyState })',
          returnByValue: true,
        },
        callback,
      ),
    );
    if (!evaluated.ok) {
      return {
        ok: false,
        tabId,
        url: null,
        pageKind: 'other',
        blockerCode: null,
        error: evaluated.error,
      };
    }
    const value = runtimeInspectionValue(evaluated.value);
    const url = value.href || null;
    const pageKind = classifyBrowserUrl(url);
    return {
      ok: true,
      tabId,
      url,
      readyState: value.readyState || null,
      pageKind,
      blockerCode: blockerCodeForKind(pageKind),
    };
  } finally {
    await callbackResult(chromeApi, (callback) => chromeApi.debugger?.detach(target, callback));
  }
};
