const TIMEOUT_LAYER_LABELS = {
  bridge: 'bridge local',
  browser: 'navegador',
  dom: 'DOM do Gemini',
  job: 'job',
  cleanup: 'limpeza',
  extension: 'extensão',
  unknown: 'operação',
};

export const normalizeTimeoutLayer = (layer) =>
  Object.prototype.hasOwnProperty.call(TIMEOUT_LAYER_LABELS, layer) ? layer : 'unknown';

export const buildTimeoutContext = ({
  layer = 'unknown',
  operation = null,
  timeoutMs = null,
  elapsedMs = null,
  jobId = null,
  sessionId = null,
  tabId = null,
  claimId = null,
  traceFile = null,
} = {}) => ({
  layer: normalizeTimeoutLayer(layer),
  layerLabel: TIMEOUT_LAYER_LABELS[normalizeTimeoutLayer(layer)],
  operation: operation || null,
  timeoutMs: timeoutMs === null || timeoutMs === undefined ? null : Math.max(0, Number(timeoutMs) || 0),
  elapsedMs: elapsedMs === null || elapsedMs === undefined ? null : Math.max(0, Number(elapsedMs) || 0),
  jobId: jobId || null,
  sessionId: sessionId || null,
  tabId: tabId ?? null,
  claimId: claimId || null,
  traceFile: traceFile || null,
});

export const formatTimeoutContext = (context = {}) => {
  const normalized = buildTimeoutContext(context);
  const parts = [`camada: ${normalized.layerLabel}`];
  if (normalized.operation) parts.push(`operação: ${normalized.operation}`);
  if (normalized.timeoutMs !== null) parts.push(`limite: ${normalized.timeoutMs}ms`);
  if (normalized.elapsedMs !== null) parts.push(`decorrido: ${normalized.elapsedMs}ms`);
  if (normalized.jobId) parts.push(`job: ${normalized.jobId}`);
  if (normalized.traceFile) parts.push(`trace: ${normalized.traceFile}`);
  return parts.join('; ');
};

export const createLayeredTimeoutError = ({
  code = 'timeout',
  message = null,
  data = null,
  ...contextInput
} = {}) => {
  const context = buildTimeoutContext(contextInput);
  const error = new Error(message || `Timeout (${formatTimeoutContext(context)}).`);
  error.code = code;
  error.layer = context.layer;
  error.operation = context.operation;
  error.timeoutMs = context.timeoutMs;
  error.elapsedMs = context.elapsedMs;
  error.traceFile = context.traceFile;
  error.data = {
    ...(data && typeof data === 'object' ? data : {}),
    timeout: context,
  };
  return error;
};

export const decorateErrorWithTimeoutContext = (error, contextInput = {}) => {
  if (!error || typeof error !== 'object') return error;
  const context = buildTimeoutContext({
    layer: error.layer,
    operation: error.operation,
    timeoutMs: error.timeoutMs,
    elapsedMs: error.elapsedMs,
    traceFile: error.traceFile,
    ...contextInput,
  });
  error.layer = context.layer;
  error.operation = context.operation;
  error.timeoutMs = context.timeoutMs;
  error.elapsedMs = context.elapsedMs;
  error.traceFile = context.traceFile;
  error.data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    timeout: context,
  };
  return error;
};

