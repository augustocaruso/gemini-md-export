import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const BROWSER_SIDE_EFFECTS_STATE_FILENAME = 'browser-side-effects.json';

export type BrowserSideEffectKind =
  | 'browser-launch'
  | 'extension-reload'
  | 'tab-activation'
  | 'tab-navigation'
  | 'tab-reload'
  | 'tab-claim'
  | 'tab-dom-mutation';

export type BrowserSideEffectsState = Readonly<{
  disabled: boolean;
  reason?: string | null;
  source?: string | null;
  path?: string | null;
  disabledAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  expired?: boolean;
  error?: string | null;
}>;

export type BrowserSideEffectAllowedDecision = Readonly<{
  ok: true;
  kind: BrowserSideEffectKind;
}>;

export type BrowserSideEffectBlockedDecision = Readonly<{
  ok: false;
  kind: BrowserSideEffectKind;
  code:
    | 'browser_side_effects_disabled'
    | 'browser_side_effect_proxy_blocked'
    | 'browser_side_effect_requires_explicit_intent';
  message: string;
  state: BrowserSideEffectsState;
  bridgeRole: string;
}>;

export type BrowserSideEffectDecision =
  | BrowserSideEffectAllowedDecision
  | BrowserSideEffectBlockedDecision;

type ReadStateOptions = Readonly<{
  diagnosticDir?: string;
  env?: Record<string, string | undefined>;
  nowMs?: number;
}>;

type WriteStateOptions = Readonly<{
  diagnosticDir?: string;
  disabled: boolean;
  reason?: string | null;
  source?: string | null;
  expiresAt?: string | null;
  nowMs?: number;
}>;

const defaultDiagnosticDir = (): string => resolve(homedir(), '.gemini-md-export');

const truthy = (value: unknown): boolean =>
  /^(1|true|yes|sim|on)$/i.test(String(value || '').trim());

const allowValue = (value: unknown): boolean =>
  /^(1|true|yes|sim|on|allow|allowed|enable|enabled|control|cli)$/i.test(
    String(value || '').trim(),
  );

const explicitOffValue = (value: unknown): boolean =>
  /^(0|false|no|nao|não|off|disabled|disable|deny|denied)$/i.test(String(value || '').trim());

export type BrowserControlRuntimeState = Readonly<{
  authorized: boolean;
  source: string;
  reason: string;
}>;

export const browserControlRuntimeState = (
  env: Record<string, string | undefined> = process.env,
): BrowserControlRuntimeState => {
  const explicitControl = (
    [
      ['GEMINI_MCP_BROWSER_CONTROL', env.GEMINI_MCP_BROWSER_CONTROL],
      ['GEMINI_MD_EXPORT_BROWSER_CONTROL', env.GEMINI_MD_EXPORT_BROWSER_CONTROL],
      ['GME_BROWSER_CONTROL', env.GME_BROWSER_CONTROL],
    ] satisfies Array<[string, string | undefined]>
  ).find(([, value]) => value !== undefined && value !== null);

  if (explicitControl) {
    const [name, value] = explicitControl;
    return allowValue(value)
      ? { authorized: true, source: name, reason: `env:${name}` }
      : { authorized: false, source: name, reason: `env:${name}:${value}` };
  }

  const sideEffectsValue = (
    [
      ['GEMINI_MCP_BROWSER_SIDE_EFFECTS', env.GEMINI_MCP_BROWSER_SIDE_EFFECTS],
      ['GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS', env.GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS],
    ] satisfies Array<[string, string | undefined]>
  ).find(([, value]) => value !== undefined && value !== null);

  if (sideEffectsValue) {
    const [name, value] = sideEffectsValue;
    if (allowValue(value)) return { authorized: true, source: name, reason: `env:${name}` };
    if (explicitOffValue(value)) {
      return { authorized: false, source: name, reason: `env:${name}:${value}` };
    }
  }

  return {
    authorized: true,
    source: 'runtime-default',
    reason: 'explicit-command-required',
  };
};

export const shouldStartBrowserBridgeHttp = ({
  env = process.env,
}: {
  bridgeOnly?: boolean;
  env?: Record<string, string | undefined>;
} = {}): boolean => {
  if (explicitOffValue(env.GEMINI_MCP_BRIDGE_HTTP)) return false;
  if (allowValue(env.GEMINI_MCP_BRIDGE_HTTP)) return true;
  return browserControlRuntimeState(env).authorized;
};

const disabledEnvValue = (env: Record<string, string | undefined>): string | null => {
  const disabledFlag = [
    ['GEMINI_MCP_BROWSER_SIDE_EFFECTS_DISABLED', env.GEMINI_MCP_BROWSER_SIDE_EFFECTS_DISABLED],
    [
      'GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS_DISABLED',
      env.GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS_DISABLED,
    ],
  ].find(([, value]) => value !== undefined && value !== null);
  if (disabledFlag) {
    const [name, value] = disabledFlag;
    if (truthy(value)) return `env:${name}`;
    if (explicitOffValue(value)) return null;
    return `env:${name}:${value}`;
  }

  const runtime = browserControlRuntimeState(env);
  return runtime.authorized ? null : runtime.reason;
};

const envDisablesBrowserSideEffects = (env: Record<string, string | undefined>): boolean => {
  const value = disabledEnvValue(env);
  return !!value;
};

const parseJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const browserSideEffectsStatePath = (diagnosticDir = defaultDiagnosticDir()): string =>
  resolve(diagnosticDir, BROWSER_SIDE_EFFECTS_STATE_FILENAME);

export const readBrowserSideEffectsState = ({
  diagnosticDir = defaultDiagnosticDir(),
  env = process.env,
  nowMs = Date.now(),
}: ReadStateOptions = {}): BrowserSideEffectsState => {
  const envValue = disabledEnvValue(env);
  if (envValue && envDisablesBrowserSideEffects(env)) {
    return {
      disabled: true,
      reason: `env:${envValue}`,
      source: 'env',
      path: null,
    };
  }

  const path = browserSideEffectsStatePath(diagnosticDir);
  if (!existsSync(path)) {
    return { disabled: false, source: 'none', path };
  }

  const payload = parseJsonObject(readFileSync(path, 'utf-8'));
  if (!payload) {
    return {
      disabled: true,
      reason: 'invalid-state-file',
      source: 'file',
      path,
      error: 'invalid_json',
    };
  }

  const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : null;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  if (expired) {
    return {
      disabled: false,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      source: 'file',
      path,
      expiresAt,
      expired: true,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    };
  }

  return {
    disabled: payload.disabled === true,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
    source: typeof payload.source === 'string' ? payload.source : 'file',
    path,
    disabledAt: typeof payload.disabledAt === 'string' ? payload.disabledAt : null,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    expiresAt,
  };
};

export const setBrowserSideEffectsDisabled = ({
  diagnosticDir = defaultDiagnosticDir(),
  disabled,
  reason = disabled ? 'manual-disable' : 'manual-enable',
  source = 'mcp',
  expiresAt = null,
  nowMs = Date.now(),
}: WriteStateOptions): BrowserSideEffectsState => {
  const path = browserSideEffectsStatePath(diagnosticDir);
  mkdirSync(diagnosticDir, { recursive: true });
  const nowIso = new Date(nowMs).toISOString();
  const payload = {
    disabled,
    reason,
    source,
    disabledAt: disabled ? nowIso : null,
    updatedAt: nowIso,
    expiresAt,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return readBrowserSideEffectsState({
    diagnosticDir,
    env: { GEMINI_MCP_BROWSER_CONTROL: 'cli' },
    nowMs,
  });
};

export const clearBrowserSideEffectsState = ({
  diagnosticDir = defaultDiagnosticDir(),
}: {
  diagnosticDir?: string;
} = {}): BrowserSideEffectsState => {
  const path = browserSideEffectsStatePath(diagnosticDir);
  rmSync(path, { force: true });
  return { disabled: false, source: 'none', path };
};

const normalizeRole = (role: unknown): string => String(role || 'starting').trim() || 'starting';

export const decideBrowserSideEffectAllowed = ({
  kind,
  explicit = false,
  bridgeRole = 'starting',
  state = { disabled: false },
}: {
  kind: BrowserSideEffectKind;
  explicit?: boolean;
  bridgeRole?: string | null;
  state?: BrowserSideEffectsState;
}): BrowserSideEffectDecision => {
  const role = normalizeRole(bridgeRole);
  if (state.disabled) {
    return {
      ok: false,
      kind,
      code: 'browser_side_effects_disabled',
      message:
        'Controle do navegador esta temporariamente desativado para evitar reload/abertura automatica. Reative apenas depois de conferir processos antigos.',
      state,
      bridgeRole: role,
    };
  }

  if (role === 'proxy') {
    return {
      ok: false,
      kind,
      code: 'browser_side_effect_proxy_blocked',
      message:
        'Esta instancia MCP esta em modo proxy e nao pode controlar navegador localmente; ela deve encaminhar para o bridge primario ou retornar diagnostico.',
      state,
      bridgeRole: role,
    };
  }

  if (explicit !== true) {
    return {
      ok: false,
      kind,
      code: 'browser_side_effect_requires_explicit_intent',
      message:
        'Controle do navegador exige intencao explicita. Use openIfMissing/wakeBrowser/allowReload/reload apenas quando essa for a acao desejada.',
      state,
      bridgeRole: role,
    };
  }

  return { ok: true, kind };
};

export const browserSideEffectError = (decision: BrowserSideEffectBlockedDecision): Error => {
  const error = new Error(decision.message);
  Object.assign(error, {
    code: decision.code,
    data: {
      kind: decision.kind,
      bridgeRole: decision.bridgeRole,
      sideEffects: decision.state,
    },
  });
  return error;
};

export const assertBrowserSideEffectAllowed = (
  input: Parameters<typeof decideBrowserSideEffectAllowed>[0],
): BrowserSideEffectAllowedDecision => {
  const decision = decideBrowserSideEffectAllowed(input);
  if (decision.ok) return decision;
  throw browserSideEffectError(decision);
};

const commandSideEffects: Readonly<Record<string, BrowserSideEffectKind>> = Object.freeze({
  'activate-browser-tab': 'tab-activation',
  'activate-tab': 'tab-activation',
  'claim-tab': 'tab-claim',
  'get-chat-by-id': 'tab-navigation',
  'load-more-conversations': 'tab-dom-mutation',
  'open-chat': 'tab-navigation',
  'release-tab-claim': 'tab-claim',
  'release-tab-claim-by-tab-id': 'tab-claim',
  'reload-extension-self': 'extension-reload',
  'reload-gemini-tabs': 'tab-reload',
  'reload-page': 'tab-reload',
});

export const browserCommandSideEffectKind = (commandType: unknown): BrowserSideEffectKind | null =>
  commandSideEffects[String(commandType || '')] || null;

export const markBrowserSideEffectCommandArgs = <T extends Record<string, unknown>>(
  commandType: unknown,
  args: T,
  explicit: boolean,
): T & { explicit?: true; explicitBrowserSideEffect?: true; browserAuthorityLeaseId?: string } => {
  if (!explicit || !browserCommandSideEffectKind(commandType)) return args;
  const existingLeaseId =
    typeof args.browserAuthorityLeaseId === 'string' && args.browserAuthorityLeaseId.trim()
      ? args.browserAuthorityLeaseId
      : null;
  return {
    ...args,
    explicit: true,
    explicitBrowserSideEffect: true,
    browserAuthorityLeaseId: existingLeaseId || `explicit-${String(commandType || 'command')}`,
  };
};
