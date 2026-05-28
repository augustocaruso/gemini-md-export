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

export type DebuggerScreenshotClip = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}>;

export type DebuggerScreenshotCapture =
  | Readonly<{
      ok: true;
      tabId: number;
      mimeType: 'image/png';
      contentBase64: string;
      clip: DebuggerScreenshotClip;
    }>
  | Readonly<{
      ok: false;
      tabId: number;
      error: string;
      code: string;
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

const screenshotDataValue = (result: unknown): string => {
  const value = (result as { data?: unknown } | null)?.data;
  return typeof value === 'string' ? value : '';
};

const normalizeScreenshotClip = (clip: DebuggerScreenshotClip): DebuggerScreenshotClip | null => {
  const x = Math.max(0, Number(clip?.x));
  const y = Math.max(0, Number(clip?.y));
  const width = Math.max(1, Number(clip?.width));
  const height = Math.max(1, Number(clip?.height));
  const scale = Math.max(0.1, Math.min(4, Number(clip?.scale || 1)));
  if (![x, y, width, height, scale].every(Number.isFinite)) return null;
  return { x, y, width, height, scale };
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

export const captureTabClipWithDebugger = async (
  tabId: number,
  clip: DebuggerScreenshotClip,
  {
    chromeApi = (globalThis as { chrome?: ChromeDebuggerApi }).chrome,
    protocolVersion = '1.3',
  }: { chromeApi?: ChromeDebuggerApi; protocolVersion?: string } = {},
): Promise<DebuggerScreenshotCapture> => {
  const normalizedClip = normalizeScreenshotClip(clip);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, tabId, code: 'tab-id-unavailable', error: 'tab-id-unavailable' };
  }
  if (!normalizedClip) {
    return { ok: false, tabId, code: 'invalid-clip', error: 'invalid-clip' };
  }
  if (!chromeApi?.debugger) {
    return {
      ok: false,
      tabId,
      code: 'debugger-api-unavailable',
      error: 'debugger-api-unavailable',
    };
  }

  const target = { tabId };
  const attached = await callbackResult(chromeApi, (callback) =>
    chromeApi.debugger?.attach(target, protocolVersion, callback),
  );
  if (!attached.ok) {
    return { ok: false, tabId, code: 'debugger-attach-failed', error: attached.error };
  }

  try {
    const captured = await callbackResult(chromeApi, (callback) =>
      chromeApi.debugger?.sendCommand(
        target,
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
          clip: normalizedClip,
        },
        callback,
      ),
    );
    if (!captured.ok) {
      return {
        ok: false,
        tabId,
        code: 'screenshot-capture-failed',
        error: captured.error,
      };
    }

    const contentBase64 = screenshotDataValue(captured.value);
    if (!contentBase64) {
      return {
        ok: false,
        tabId,
        code: 'screenshot-empty',
        error: 'screenshot-empty',
      };
    }

    return {
      ok: true,
      tabId,
      mimeType: 'image/png',
      contentBase64,
      clip: normalizedClip,
    };
  } finally {
    await callbackResult(chromeApi, (callback) => chromeApi.debugger?.detach(target, callback));
  }
};
