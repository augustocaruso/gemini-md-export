import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MEMORY_LIMIT = 80;
const REDACTED = '[redigido]';
const SENSITIVE_KEY_RE =
  /^(markdown|html|outerHTML|innerHTML|content|prompt|response|answer|body|text|turns|conversation|conversations|title)$/i;

const safeJobId = (jobId) =>
  String(jobId || 'job')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .slice(0, 120);

export const sanitizeTraceValue = (value, depth = 0) => {
  if (depth > 5) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeTraceValue(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitizeTraceValue(item, depth + 1);
  }
  return out;
};

export const createJobTrace = ({
  jobId,
  directory,
  retentionPolicy = 'on_failure',
  memoryLimit = DEFAULT_MEMORY_LIMIT,
} = {}) => {
  const traceDir = resolve(directory || process.cwd());
  mkdirSync(traceDir, { recursive: true });
  return {
    version: 1,
    jobId,
    filePath: resolve(traceDir, `${safeJobId(jobId)}.trace.jsonl`),
    retentionPolicy,
    retained: true,
    closed: false,
    deletedAt: null,
    eventCount: 0,
    memoryLimit: Math.max(10, Math.min(1000, Number(memoryLimit) || DEFAULT_MEMORY_LIMIT)),
    events: [],
  };
};

export const appendJobTraceEvent = (trace, type, data = {}, { at = new Date() } = {}) => {
  if (!trace || trace.closed || !trace.filePath) return null;
  const event = {
    ts: at instanceof Date ? at.toISOString() : String(at),
    jobId: trace.jobId || null,
    type,
    data: sanitizeTraceValue(data),
  };
  trace.eventCount += 1;
  trace.events.push(event);
  while (trace.events.length > trace.memoryLimit) trace.events.shift();
  try {
    appendFileSync(trace.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (err) {
    trace.writeError = err?.message || String(err);
  }
  return event;
};

export const readJobTraceTail = (filePath, limit = 200) => {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line.slice(0, 500) };
      }
    });
};

export const summarizeTraceEvents = (events = []) => {
  const byType = {};
  for (const event of events) {
    const type = event?.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  return {
    eventCount: events.length,
    firstAt: events[0]?.ts || null,
    lastAt: events.at(-1)?.ts || null,
    byType,
  };
};

export const finalizeJobTrace = (
  trace,
  { status = null, retainSuccess = false, at = new Date() } = {},
) => {
  if (!trace || trace.closed) return trace;
  appendJobTraceEvent(trace, 'trace_finalized', { status, retainSuccess }, { at });
  const shouldDelete =
    trace.retentionPolicy === 'on_failure' &&
    retainSuccess !== true &&
    status === 'completed';
  if (shouldDelete && trace.filePath && existsSync(trace.filePath)) {
    try {
      rmSync(trace.filePath, { force: true });
      trace.deletedAt = at instanceof Date ? at.toISOString() : String(at);
      trace.retained = false;
    } catch (err) {
      trace.retained = true;
      trace.deleteError = err?.message || String(err);
    }
  }
  trace.closed = true;
  return trace;
};

export const summarizeJobTrace = (trace) => {
  if (!trace) return null;
  return {
    version: trace.version || 1,
    jobId: trace.jobId || null,
    filePath: trace.retained === false ? null : trace.filePath || null,
    retained: trace.retained !== false,
    retentionPolicy: trace.retentionPolicy || null,
    deletedAt: trace.deletedAt || null,
    eventCount: trace.eventCount || 0,
    writeError: trace.writeError || null,
    deleteError: trace.deleteError || null,
    recent: Array.isArray(trace.events) ? trace.events.slice(-10) : [],
  };
};

