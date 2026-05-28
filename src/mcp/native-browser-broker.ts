import { defaultBrokerIpcPath, requestBrokerIpc } from '../native/local-ipc.js';
import {
  makeNativeRequest,
  type NativeBrokerCommand,
  type NativeBrokerRequest,
} from '../native/protocol.js';

type NativeBrowserBrokerCommand = Extract<
  NativeBrokerCommand,
  | 'tabs.list'
  | 'tabs.status'
  | 'tabs.claim'
  | 'tabs.release'
  | 'tabs.activate'
  | 'tabs.reload'
  | 'extension.status'
  | 'extension.selfHealContentScripts'
  | 'extension.reloadManagedTabs'
  | 'extension.reloadSelf'
>;

type NativeBrowserBrokerOptions = Readonly<{
  allowFallback?: boolean;
}>;

type NativeBrowserBrokerClientOptions = Readonly<{
  path?: string;
  request?: (request: NativeBrokerRequest) => Promise<unknown>;
}>;

const DEFAULT_EXTENSION_SELF_HEAL_TIMEOUT_MS = 30_000;

const numberPayload = (payload: unknown, key: string, fallback: number): number => {
  if (!payload || typeof payload !== 'object') return fallback;
  const value = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const nativeRequestTimeoutMs = (request: NativeBrokerRequest): number =>
  numberPayload(request.payload, 'timeoutMs', 5000);

export const nativeBrowserBrokerIpcTimeoutMs = (request: NativeBrokerRequest): number =>
  nativeRequestTimeoutMs(request) + 1500;

export const shouldUseNativeBrowserBroker = ({
  disabled = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER === 'disabled',
}: {
  disabled?: boolean;
} = {}): boolean => disabled !== true;

export const nativeBrowserBrokerFailureCode = (response: unknown): string => {
  const value = response as {
    code?: unknown;
    error?: { code?: unknown; message?: unknown } | string;
  } | null;
  const nestedCode =
    value?.error && typeof value.error === 'object' ? String(value.error.code || '') : '';
  return nestedCode || String(value?.code || '');
};

export const canFallbackFromNativeBrowserBrokerFailure = (
  response: unknown,
  { strict = false }: { strict?: boolean } = {},
): boolean => {
  if (strict) return false;
  const value = response as {
    allowFallback?: unknown;
    error?: { message?: unknown } | string;
  } | null;
  if (value?.allowFallback === true) return true;

  const code = nativeBrowserBrokerFailureCode(response);
  if (
    code === 'native_broker_unavailable' ||
    code === 'extension_unavailable' ||
    code === 'extension_request_timeout' ||
    code === 'native_broker_probe_timeout'
  ) {
    return true;
  }

  const message =
    typeof value?.error === 'string'
      ? value.error
      : value?.error && typeof value.error === 'object'
        ? String(value.error.message || '')
        : String((value as { error?: unknown } | null)?.error || '');
  return /ECONNREFUSED|ENOENT|EPIPE|socket|timeout/i.test(message);
};

export const createNativeBrowserBrokerClient = ({
  path = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(),
  request = (nativeRequest: NativeBrokerRequest) =>
    requestBrokerIpc(path, nativeRequest, {
      timeoutMs: nativeBrowserBrokerIpcTimeoutMs(nativeRequest),
    }),
}: NativeBrowserBrokerClientOptions = {}) => {
  const call = async (
    command: NativeBrowserBrokerCommand,
    payload: Record<string, unknown> = {},
    options: NativeBrowserBrokerOptions = {},
  ) => {
    try {
      return await request(makeNativeRequest(command, payload));
    } catch (err) {
      return {
        ok: false as const,
        code: 'native_broker_unavailable',
        error: err instanceof Error ? err.message : String(err),
        allowFallback: options.allowFallback === true,
      };
    }
  };

  return {
    listTabs: (options: NativeBrowserBrokerOptions = {}) => call('tabs.list', {}, options),
    status: (options: NativeBrowserBrokerOptions = {}) => call('tabs.status', {}, options),
    claim: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
      call('tabs.claim', payload, options),
    release: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
      call('tabs.release', payload, options),
    activate: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
      call('tabs.activate', payload, options),
    reload: (payload: Record<string, unknown> = {}, options: NativeBrowserBrokerOptions = {}) =>
      call('tabs.reload', payload, options),
    extensionStatus: (options: NativeBrowserBrokerOptions = {}) =>
      call('extension.status', {}, options),
    selfHealContentScripts: (
      payload: Record<string, unknown> = {},
      options: NativeBrowserBrokerOptions = {},
    ) =>
      call(
        'extension.selfHealContentScripts',
        { timeoutMs: DEFAULT_EXTENSION_SELF_HEAL_TIMEOUT_MS, ...payload },
        options,
      ),
    reloadManagedTabs: (
      payload: Record<string, unknown> = {},
      options: NativeBrowserBrokerOptions = {},
    ) => call('extension.reloadManagedTabs', payload, options),
    reloadExtensionSelf: (
      payload: Record<string, unknown> = {},
      options: NativeBrowserBrokerOptions = {},
    ) => call('extension.reloadSelf', payload, options),
  };
};
