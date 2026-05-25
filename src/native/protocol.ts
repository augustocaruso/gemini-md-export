export const NATIVE_BROKER_PROTOCOL_VERSION = 1;

export type NativeBrokerCommand =
  | 'ping'
  | 'healthz'
  | 'tabs.list'
  | 'tabs.status'
  | 'tabs.claim'
  | 'tabs.release'
  | 'tabs.reload'
  | 'export.start'
  | 'export.cancel'
  | 'job.progress'
  | 'extension.hello'
  | 'proxyHttp';

export type NativeBrokerRequest<TPayload = unknown> = Readonly<{
  id: string;
  protocolVersion: number;
  command: NativeBrokerCommand;
  payload: TPayload;
}>;

export type NativeBrokerError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  nextAction: string;
  data?: unknown;
}>;

export type NativeBrokerResponse<TResult = unknown> =
  | Readonly<{ id: string; ok: true; result: TResult }>
  | Readonly<{ id: string; ok: false; error: NativeBrokerError }>;

export const normalizeNativeCommand = (value: unknown): NativeBrokerCommand => {
  const command = String(value || '').trim() as NativeBrokerCommand;
  return command || 'ping';
};

export const makeNativeRequest = <TPayload>(
  command: NativeBrokerCommand,
  payload: TPayload,
  options: { id?: string; protocolVersion?: number } = {},
): NativeBrokerRequest<TPayload> => ({
  id: options.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  protocolVersion: options.protocolVersion || NATIVE_BROKER_PROTOCOL_VERSION,
  command,
  payload,
});

export const nativeBrokerOk = <TResult>(
  request: Pick<NativeBrokerRequest, 'id'>,
  result: TResult,
): NativeBrokerResponse<TResult> => ({
  id: request.id,
  ok: true,
  result,
});

export const nativeBrokerError = (
  request: Pick<NativeBrokerRequest, 'id'> | null,
  code: string,
  message: string,
  options: { retryable?: boolean; nextAction?: string; data?: unknown } = {},
): NativeBrokerResponse<never> => ({
  id: request?.id || '',
  ok: false,
  error: {
    code,
    message,
    retryable: options.retryable === true,
    nextAction: options.nextAction || message,
    ...(options.data === undefined ? {} : { data: options.data }),
  },
});
