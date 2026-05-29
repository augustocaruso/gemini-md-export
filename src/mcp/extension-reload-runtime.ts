import { reloadExtensionFromOwnedDevToolsActivePort } from '../cdp/runtime-options.js';
import {
  type LocalExtensionCdpReloadInput,
  runLocalExtensionCdpReload,
} from '../cli/local-extension-cdp-reload.js';

export type AssumedExtensionReloadResult = Readonly<{
  ok: true;
  reloading: true;
  assumed: true;
  reason: 'extension-context-invalidated';
  detail: string;
}>;

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
  }
  return String(err || '');
};

export const isExtensionContextInvalidatedError = (err: unknown): boolean =>
  /Extension context invalidated/i.test(errorMessage(err));

export const extensionReloadAssumedResultForError = (
  err: unknown,
): AssumedExtensionReloadResult | null => {
  if (!isExtensionContextInvalidatedError(err)) return null;
  return {
    ok: true,
    reloading: true,
    assumed: true,
    reason: 'extension-context-invalidated',
    detail: errorMessage(err),
  };
};

type BrowserSideEffectAssert = (
  kind: 'extension-reload',
  options: Readonly<{ explicit: boolean }>,
) => void;

type ExtensionReloadBody = LocalExtensionCdpReloadInput & Readonly<{ explicit?: boolean }>;

export type BridgeCdpExtensionReloadHttpResult = Readonly<{
  status: number;
  body: unknown;
}>;

const normalizeExtensionReloadBody = (body: unknown): ExtensionReloadBody =>
  body && typeof body === 'object' ? (body as ExtensionReloadBody) : {};

const errorCode = (err: unknown): string =>
  err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code || 'cdp_extension_reload_failed')
    : 'cdp_extension_reload_failed';

export const runBridgeCdpExtensionReloadHttpRequest = async (
  body: Promise<unknown>,
  assertBrowserSideEffect: BrowserSideEffectAssert,
): Promise<BridgeCdpExtensionReloadHttpResult> => {
  try {
    const reloadBody = normalizeExtensionReloadBody(await body);
    assertBrowserSideEffect('extension-reload', {
      explicit: reloadBody.allowReload === true || reloadBody.explicit === true,
    });
    return {
      status: 200,
      body: await runLocalExtensionCdpReload(reloadBody, {
        reloadExtensionFromDevToolsActivePort: reloadExtensionFromOwnedDevToolsActivePort,
      }),
    };
  } catch (err) {
    return {
      status: 503,
      body: {
        ok: false,
        mode: 'cdp-browser-websocket',
        attempted: true,
        code: errorCode(err),
        error: errorMessage(err),
      },
    };
  }
};
