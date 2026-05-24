import type { IsoDateTime } from './types.js';

export const portableIsoSeconds = (value: unknown): IsoDateTime | null => {
  if (!value) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z') as IsoDateTime;
};
