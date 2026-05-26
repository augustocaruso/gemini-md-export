const SAFE_CONSTRUCTOR_NAMES = new Set([
  'Socket',
  'HTTPParser',
  'IncomingMessage',
  'ServerResponse',
]);

export const sanitizeAgentJsonValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown => {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return String(value);
  if (valueType === 'function' || valueType === 'symbol') return undefined;

  if (value instanceof Error) {
    const errorWithData = value as Error & { code?: unknown; data?: unknown };
    return {
      name: value.name,
      message: value.message,
      code: errorWithData.code || null,
      data: sanitizeAgentJsonValue(errorWithData.data, seen, depth + 1) ?? null,
    };
  }

  if (valueType !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';

  const ctor = value.constructor?.name || '';
  if (SAFE_CONSTRUCTOR_NAMES.has(ctor)) return `[${ctor}]`;
  if (depth >= 6) return '[MaxDepth]';

  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeAgentJsonValue(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 120)) {
    const sanitized = sanitizeAgentJsonValue(item, seen, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
};

export const stringifyAgentPayload = (payload: unknown): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify(sanitizeAgentJsonValue(payload));
  }
};
