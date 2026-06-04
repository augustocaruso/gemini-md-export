export const NATIVE_BROKER_PROTOCOL_VERSION = 1;
export const normalizeNativeCommand = (value) => {
    const command = String(value || '').trim();
    return command || 'ping';
};
export const makeNativeRequest = (command, payload, options = {}) => ({
    id: options.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    protocolVersion: options.protocolVersion || NATIVE_BROKER_PROTOCOL_VERSION,
    command,
    payload,
});
export const nativeBrokerOk = (request, result) => ({
    id: request.id,
    ok: true,
    result,
});
export const nativeBrokerError = (request, code, message, options = {}) => ({
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
