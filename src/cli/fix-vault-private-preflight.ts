import {
  authStatusIsOk,
  buildAuthStatusToolCall,
  extractAuthStatusResult,
} from './auth-status-command.js';
import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';

type FixVaultPrivatePreflightFlags = Record<string, unknown> & {
  bridgeUrl: string;
};

type MakeUi = (flags: FixVaultPrivatePreflightFlags, streams: unknown) => unknown;
type WarnTuiFallback = (ui: unknown) => unknown;
type EnsureBridgeAvailable = (
  flags: FixVaultPrivatePreflightFlags,
  ui: unknown,
) => Promise<unknown> | unknown;
type ReadyWithCliWake = (
  bridgeUrl: string,
  flags: FixVaultPrivatePreflightFlags,
  ui: unknown,
) => Promise<unknown> | unknown;
type RequestJson = (
  bridgeUrl: string,
  pathname: '/agent/mcp-tool-call',
  options: {
    method: 'POST';
    timeoutMs: number;
    body: ReturnType<typeof buildAuthStatusToolCall>;
  },
) => Promise<unknown>;

type PreflightError = Error & {
  code?: string;
  nextAction?: string;
};

export const shouldSkipFixVaultBrowserPrivatePreflight = (
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): boolean => Boolean(flags.python || flags.cookiesJson || env.GME_GEMINI_WEBAPI_RUNNER);

export const assertFixVaultBrowserPrivateSessionReady = async ({
  flags,
  streams,
  makeUi,
  warnTuiFallback,
  ensureBridgeAvailable,
  readyWithCliWake,
  requestJson,
}: {
  flags: FixVaultPrivatePreflightFlags;
  streams?: unknown;
  makeUi: MakeUi;
  warnTuiFallback: WarnTuiFallback;
  ensureBridgeAvailable: EnsureBridgeAvailable;
  readyWithCliWake: ReadyWithCliWake;
  requestJson: RequestJson;
}) => {
  flags = applyPrivateApiSessionDefaults(flags) as FixVaultPrivatePreflightFlags;
  if (shouldSkipFixVaultBrowserPrivatePreflight(flags)) return;

  const ui = makeUi(flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(flags, ui);
  if (flags.wakeBrowser === true) {
    await readyWithCliWake(flags.bridgeUrl, flags, ui);
  }
  const response = await requestJson(flags.bridgeUrl, '/agent/mcp-tool-call', {
    method: 'POST',
    timeoutMs: Math.max(5000, Number(flags.waitMs || 45_000)) + 15_000,
    body: buildAuthStatusToolCall({
      ...flags,
      cookiesJson: undefined,
      python: undefined,
    }),
  });
  const status = extractAuthStatusResult(response);
  if (authStatusIsOk(status) && status.selectedAdapter === 'browserBackground') return;

  const nextAction =
    status.nextAction && typeof status.nextAction === 'object'
      ? (status.nextAction as Record<string, unknown>)
      : {};
  const err = new Error(
    String(
      nextAction.message ||
        status.message ||
        status.error ||
        'A sessao privada do navegador nao ficou pronta para reparar o vault.',
    ),
  ) as PreflightError;
  err.code = String(nextAction.code || status.code || 'browser_session_not_connected');
  err.nextAction = String(
    nextAction.message ||
      'Abra o Gemini no navegador logado, aguarde a extensao conectar e rode fix-vault novamente.',
  );
  throw err;
};

export const createFixVaultBrowserPrivateSessionPreflight =
  (
    flags: FixVaultPrivatePreflightFlags,
    streams: unknown,
    makeUi: MakeUi,
    warnTuiFallback: WarnTuiFallback,
    ensureBridgeAvailable: EnsureBridgeAvailable,
    readyWithCliWake: ReadyWithCliWake,
    requestJson: RequestJson,
  ) =>
  () =>
    assertFixVaultBrowserPrivateSessionReady({
      flags,
      streams,
      makeUi,
      warnTuiFallback,
      ensureBridgeAvailable,
      readyWithCliWake,
      requestJson,
    });
