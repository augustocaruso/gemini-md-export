import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';

type JsonRecord = Record<string, unknown>;

type ToolContentItem = Readonly<{
  type?: unknown;
  text?: unknown;
}>;

export type AuthStatusFlags = Readonly<{
  bridgeUrl?: unknown;
  wakeBrowser?: unknown;
  wakeBrowserExplicit?: unknown;
  waitMs?: unknown;
  cookiesJson?: unknown;
  python?: unknown;
  clientId?: unknown;
  tabId?: unknown;
  claimId?: unknown;
  sessionId?: unknown;
}>;

export type AuthStatusResult = JsonRecord & {
  ok?: unknown;
  selectedAdapter?: unknown;
  nextAction?: unknown;
  message?: unknown;
  error?: unknown;
};

type AuthStatusToolCall = ReturnType<typeof buildAuthStatusToolCall>;

type RequestJsonOptions = Readonly<{
  method: 'POST';
  timeoutMs: number;
  body: AuthStatusToolCall;
}>;

type AuthStatusCommandDependencies = Readonly<{
  ensureBridgeAvailable: (flags: AuthStatusFlags, ui: unknown) => Promise<unknown> | unknown;
  readyWithCliWake: (
    bridgeUrl: string,
    flags: AuthStatusFlags,
    ui: unknown,
  ) => Promise<unknown> | unknown;
  requestJson: (
    bridgeUrl: string,
    pathname: '/agent/mcp-tool-call',
    options: RequestJsonOptions,
  ) => Promise<unknown>;
  writeStructuredResult: (
    ui: unknown,
    result: AuthStatusResult,
    options: { label: string },
  ) => unknown;
}>;

type RunAuthStatusCommandInput = Readonly<{
  subcommand?: string;
  flags?: AuthStatusFlags;
  ui?: unknown;
  dependencies: AuthStatusCommandDependencies;
  exitCodes?: Readonly<{
    ok: number;
    manualAction: number;
  }>;
}>;

type UsageError = Error & { code?: string };

const recordValue = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const textContentFromToolResult = (result: JsonRecord): string | null => {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const item = content.find(
    (candidate): candidate is ToolContentItem =>
      recordValue(candidate).type === 'text' && typeof recordValue(candidate).text === 'string',
  );
  return stringValue(item?.text);
};

export const buildAuthStatusToolCall = (flags: AuthStatusFlags = {}) => ({
  name: 'gemini_support' as const,
  arguments: {
    action: 'session_status' as const,
    waitMs: flags.waitMs,
    cookiesJson: flags.cookiesJson,
    pythonFallback: Boolean(flags.cookiesJson || flags.python),
    python: flags.python,
    clientId: flags.clientId,
    tabId: flags.tabId,
    claimId: flags.claimId,
    sessionId: flags.sessionId,
  },
});

export const buildAuthHelp = ({
  commonOptions = [],
  outputModes = [],
}: {
  commonOptions?: readonly string[];
  outputModes?: readonly string[];
} = {}): string =>
  [
    'gemini-md-export auth status',
    '',
    'Uso:',
    '  gemini-md-export auth status [opcoes]',
    '',
    'Verifica a sessao usada pela API privada. Primeiro tenta a extensao/navegador logado; se',
    'necessario, diagnostica o sidecar Python e o arquivo de cookies informado.',
    '',
    'Opcoes:',
    '  --cookies-json <path>   storage_state.json/JSON de cookies para o fallback Python.',
    '  --python <path>         Python explicito para o sidecar.',
    '  --wake                  Acorda/abre Gemini antes de verificar a sessao. Default do auth.',
    '  --no-wake               Nao abre navegador; usa apenas aba/extensao ja conectada.',
    '  --allow-reload          Pode recarregar extensao/abas existentes antes da verificacao.',
    '  --wait-ms <ms>          Timeout da verificacao.',
    '',
    ...commonOptions,
    '',
    ...outputModes,
  ].join('\n');

export const extractAuthStatusResult = (payload: unknown): AuthStatusResult => {
  const payloadRecord = recordValue(payload);
  const result = recordValue(payloadRecord.result ?? payload);
  const structuredContent = recordValue(result.structuredContent);
  if (Object.keys(structuredContent).length > 0) return structuredContent as AuthStatusResult;

  const text = textContentFromToolResult(result);
  if (text) {
    try {
      return recordValue(JSON.parse(text)) as AuthStatusResult;
    } catch {
      return { ok: false, error: text };
    }
  }

  return result as AuthStatusResult;
};

export const authStatusIsOk = (result: AuthStatusResult): boolean => result.ok === true;

export const formatAuthStatusLabel = (result: AuthStatusResult): string => {
  if (authStatusIsOk(result)) {
    return `Auth: ok via ${stringValue(result.selectedAdapter) || 'nenhum adapter'}`;
  }

  const nextAction = recordValue(result.nextAction);
  const message =
    stringValue(nextAction.message) ||
    stringValue(result.message) ||
    stringValue(result.error) ||
    'Sessao nao pronta.';
  return `Auth: requer acao - ${message}`;
};

const usageError = (message: string): UsageError => {
  const error = new Error(message) as UsageError;
  error.code = 'usage';
  return error;
};

const bridgePostTimeoutMs = (waitMs: unknown): number =>
  Math.max(5000, Number(waitMs || 45_000)) + 15_000;

const shouldWakeBrowserForAuthStatus = (flags: AuthStatusFlags): boolean =>
  flags.wakeBrowser === true || flags.wakeBrowserExplicit !== true;

export const runAuthStatusCommand = async ({
  subcommand = 'status',
  flags = {},
  ui = {},
  dependencies,
  exitCodes = { ok: 0, manualAction: 4 },
}: RunAuthStatusCommandInput) => {
  if (!['status', 'check'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export auth status.');
  }

  const effectiveFlags = applyPrivateApiSessionDefaults(flags);
  const bridgeUrl = stringValue(effectiveFlags.bridgeUrl) || '';
  await dependencies.ensureBridgeAvailable(effectiveFlags, ui);
  await dependencies.readyWithCliWake(
    bridgeUrl,
    {
      ...effectiveFlags,
      wakeBrowser: shouldWakeBrowserForAuthStatus(effectiveFlags),
    },
    ui,
  );

  const response = await dependencies.requestJson(bridgeUrl, '/agent/mcp-tool-call', {
    method: 'POST',
    timeoutMs: bridgePostTimeoutMs(effectiveFlags.waitMs),
    body: buildAuthStatusToolCall(effectiveFlags),
  });
  const result = extractAuthStatusResult(response);
  dependencies.writeStructuredResult(ui, result, { label: formatAuthStatusLabel(result) });
  return {
    exitCode: authStatusIsOk(result) ? exitCodes.ok : exitCodes.manualAction,
    result,
  };
};
