import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, machine, platform, release } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TELEMETRY_ENVELOPE_SCHEMA = 'gemini-md-export.workflow-telemetry-envelope.v1';
export const TELEMETRY_RUN_RECORD_SCHEMA = 'gemini-md-export.workflow-run-record.v1';
export const TELEMETRY_STATUS_SCHEMA = 'gemini-md-export.workflow-telemetry-status.v1';
export const TELEMETRY_SENT_SCHEMA = 'gemini-md-export.workflow-telemetry-sent.v1';
export const DEFAULT_PAYLOAD_LEVEL = 'diagnostic_redacted';
export const PAYLOAD_LEVELS = new Set(['diagnostic_redacted', 'full_logs']);
export const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;

const APP = 'gemini-md-export';
const CONFIG_ENV = 'GEMINI_MD_EXPORT_TELEMETRY_CONFIG';
const HOME_ENV = 'GEMINI_MD_EXPORT_HOME';
const DISABLED_ENV = 'GEMINI_MD_EXPORT_TELEMETRY_DISABLED';
const ALLOW_NODE_TEST_ENV = 'GEMINI_MD_EXPORT_TELEMETRY_ALLOW_NODE_TEST';
const DEFAULTS_ENV = 'GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS';
const DEFAULTS_DISABLED_ENV = 'GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED';
const DEFAULTS_FILE_NAME = 'telemetry.defaults.json';
const LOCAL_DEFAULTS_FILE_NAME = '.telemetry-defaults.json';
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const nowIso = () => new Date().toISOString();

export const telemetryHome = () =>
  process.env[HOME_ENV]
    ? resolve(process.env[HOME_ENV])
    : resolve(homedir(), '.gemini', 'gemini-md-export');

export const telemetryConfigPath = (path = null) =>
  path || process.env[CONFIG_ENV]
    ? resolve(String(path || process.env[CONFIG_ENV]))
    : resolve(telemetryHome(), 'config.json');

export const telemetryRoot = () => resolve(telemetryHome(), 'telemetry');

export const readTelemetryConfig = (path = null) => {
  const configPath = telemetryConfigPath(path);
  let data = {};
  try {
    data = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    data = {};
  }
  let section = data.telemetry && typeof data.telemetry === 'object' ? data.telemetry : {};
  const defaults = readDistributionDefaults();
  if (shouldApplyDistributionDefaults(section, defaults)) {
    section = materializeDistributionDefaults(configPath, section, defaults);
  }
  return configFromSection(section);
};

const configFromSection = (section) => {
  const payloadLevel = PAYLOAD_LEVELS.has(section.payload_level)
    ? section.payload_level
    : DEFAULT_PAYLOAD_LEVEL;
  const maxEnvelopeBytes = clampInt(
    section.max_envelope_bytes,
    DEFAULT_MAX_ENVELOPE_BYTES,
    16 * 1024,
    2 * 1024 * 1024,
  );
  return {
    enabled: section.enabled === true,
    endpoint_url: String(section.endpoint_url || ''),
    auth_token: String(section.auth_token || ''),
    payload_level: payloadLevel,
    consent_at: String(section.consent_at || ''),
    install_id: String(section.install_id || ''),
    max_envelope_bytes: maxEnvelopeBytes,
    source: String(section.source || 'user'),
    auto_enabled_at: String(section.auto_enabled_at || ''),
    opt_out_at: String(section.opt_out_at || ''),
    defaults_path: String(section.defaults_path || ''),
    ready: Boolean(section.enabled === true && section.endpoint_url && section.auth_token && section.install_id),
  };
};

export const enableTelemetry = ({ endpointUrl, authToken, payloadLevel = DEFAULT_PAYLOAD_LEVEL, configPath = null }) => {
  const endpoint = String(endpointUrl || '').trim();
  const token = String(authToken || '').trim();
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('--endpoint precisa ser uma URL http(s).');
  if (!token) throw new Error('--token e obrigatorio.');
  if (!PAYLOAD_LEVELS.has(payloadLevel)) {
    throw new Error(`--payload-level precisa ser um destes: ${[...PAYLOAD_LEVELS].sort().join(', ')}`);
  }
  const current = readTelemetryConfig(configPath);
  writeTelemetrySection(configPath, {
    enabled: true,
    endpoint_url: endpoint,
    auth_token: token,
    payload_level: payloadLevel,
    consent_at: nowIso(),
    install_id: current.install_id || randomUUID(),
    max_envelope_bytes: current.max_envelope_bytes || DEFAULT_MAX_ENVELOPE_BYTES,
    source: 'user',
    auto_enabled_at: current.auto_enabled_at || '',
    opt_out_at: '',
    defaults_path: current.defaults_path || '',
  });
  return telemetryStatus({ configPath });
};

export const disableTelemetry = ({ configPath = null } = {}) => {
  const current = readTelemetryConfig(configPath);
  writeTelemetrySection(configPath, {
    enabled: false,
    endpoint_url: current.endpoint_url,
    auth_token: current.auth_token,
    payload_level: current.payload_level,
    consent_at: current.consent_at,
    install_id: current.install_id,
    max_envelope_bytes: current.max_envelope_bytes,
    source: 'user_disabled',
    auto_enabled_at: current.auto_enabled_at || '',
    opt_out_at: nowIso(),
    defaults_path: current.defaults_path || '',
  });
  return telemetryStatus({ configPath });
};

export const telemetryStatus = ({ configPath = null } = {}) => {
  const config = readTelemetryConfig(configPath);
  const sent = loadSent();
  const outbox = outboxDir();
  const outboxCount = existsSync(outbox) ? readdirSync(outbox).filter((name) => name.endsWith('.json')).length : 0;
  return {
    schema: TELEMETRY_STATUS_SCHEMA,
    enabled: config.enabled,
    ready: config.ready,
    endpoint_url: redactEndpoint(config.endpoint_url),
    payload_level: config.payload_level,
    consent_at: config.consent_at,
    auto_enabled_at: config.auto_enabled_at,
    opt_out_at: config.opt_out_at,
    source: config.source,
    install_id: config.install_id,
    outbox_count: outboxCount,
    sent_run_count: Array.isArray(sent.sent_run_ids) ? sent.sent_run_ids.length : 0,
    config_path: telemetryConfigPath(configPath),
    defaults_path: config.defaults_path,
  };
};

export const previewEnvelope = ({ since = '30d', limit = 20, configPath = null } = {}) => {
  const config = readTelemetryConfig(configPath);
  return buildEnvelope(loadUnsentRecords({ since, limit }), { config });
};

export const sendTelemetry = async ({ since = '30d', limit = 20, configPath = null } = {}) => {
  const config = readTelemetryConfig(configPath);
  if (!config.ready) {
    return {
      ok: false,
      sent: 0,
      queued: 0,
      failed: 0,
      reason: 'telemetry_not_enabled',
      status: telemetryStatus({ configPath }),
    };
  }
  const firstFlush = await flushOutbox({ config });
  if (firstFlush.failed > 0) {
    return { ...firstFlush, queued: 0 };
  }
  const records = loadUnsentRecords({ since, limit });
  const queued = records.length ? 1 : 0;
  if (records.length) enqueueEnvelope(buildEnvelope(records, { config }));
  const secondFlush = await flushOutbox({ config });
  return {
    ...secondFlush,
    sent: Number(firstFlush.sent || 0) + Number(secondFlush.sent || 0),
    queued,
  };
};

export const recordTelemetryRun = async ({
  workflow,
  phase = null,
  status = null,
  exitCode = null,
  durationMs = null,
  command = '',
  result = null,
  error = null,
  source = 'cli',
} = {}) => {
  if (isAutoTelemetryDisabled()) return null;
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${slug(workflow || 'run')}-${randomUUID().slice(0, 8)}`;
  const payloadSummary = summarizePayload(result, error);
  const inferred = inferStatus({ status, exitCode, result, error });
  const record = {
    schema: TELEMETRY_RUN_RECORD_SCHEMA,
    run_id: runId,
    recorded_at: nowIso(),
    workflow: workflow || 'gemini-md-export:unknown',
    phase: phase || payloadSummary.phase || inferred.phase || '',
    status: inferred.status,
    exit_code: exitCode,
    duration_ms: durationMs,
    source,
    command: redactSnippet(command, 1200),
    blocked_reason: inferred.blockedReason,
    next_action: payloadSummary.next_action || inferred.nextAction,
    human_decision_required: inferred.humanDecisionRequired,
    payload_summary: payloadSummary,
    diagnostic_snippets: diagnosticSnippets(result, error),
  };
  const path = resolve(runsDir(), `${runId}.json`);
  atomicWriteJson(path, record);
  await safeAutoSendRecord(record, { rawPayload: result || error || null });
  return record;
};

export const recordCliTelemetry = async (parsed, { exitCode, result = null, error = null, durationMs = null, version = null } = {}) => {
  if (!parsed || parsed.command === 'telemetry' || parsed.command === 'help' || parsed.command === 'version') return null;
  const workflow = workflowForParsed(parsed);
  return recordTelemetryRun({
    workflow,
    phase: phaseForParsed(parsed, result),
    status: result?.status || null,
    exitCode,
    durationMs,
    command: ['gemini-md-export', parsed.command, ...parsed.positionals].filter(Boolean).join(' '),
    result: {
      ...(result && typeof result === 'object' ? result : { value: result }),
      cliVersion: version,
    },
    error,
  });
};

export const redactSnippet = (value, maxChars = 800) => {
  let text = String(value ?? '');
  const home = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(home, 'g'), '~');
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  text = text.replace(/\b(re|sk|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[secret]');
  text = text.replace(/(--(?:token|auth-token|api-key|secret|password)\s+)(\S+)/gi, '$1[secret]');
  text = text.replace(/([?&](?:token|key|api_key|auth|secret|password)=)[^&\s]+/gi, '$1[redacted]');
  text = text.replace(/(https?:\/\/[^\s?#]+)\?[^ \n\t]+/gi, '$1?[redacted-query]');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
  return text;
};

export const redactObject = (value, depth = 0) => {
  if (depth > 6) return '[max-depth]';
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => redactObject(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const lower = key.toLowerCase();
      if (['token', 'auth_token', 'api_key', 'apikey', 'secret', 'password', 'authorization'].includes(lower)) {
        out[key] = '[redacted]';
      } else if (['content', 'markdown', 'html', 'raw', 'body'].includes(lower) && typeof item === 'string') {
        out[key] = redactSnippet(item, 240);
      } else {
        out[key] = redactObject(item, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') return redactSnippet(value, 1200);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return redactSnippet(String(value), 300);
};

export const buildEnvelope = (records, { config = readTelemetryConfig(), rawPayloads = {} } = {}) => {
  const envelope = {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    envelope_id: randomUUID(),
    generated_at: nowIso(),
    install_id: config.install_id,
    payload_level: config.payload_level,
    client: {
      app: APP,
      node: process.version,
      platform: platform(),
      release: release(),
      machine: machine(),
    },
    records: records.map((record) => telemetryRecord(record, {
      payloadLevel: config.payload_level,
      rawPayload: rawPayloads[record.run_id],
    })),
    limits: {
      max_envelope_bytes: config.max_envelope_bytes,
    },
    truncated: false,
  };
  return fitEnvelope(envelope, config.max_envelope_bytes);
};

const safeAutoSendRecord = async (record, { rawPayload = null } = {}) => {
  try {
    const config = readTelemetryConfig();
    if (!config.ready) return null;
    const envelope = buildEnvelope([record], { config, rawPayloads: { [record.run_id]: rawPayload } });
    enqueueEnvelope(envelope);
    return await flushOutbox({ config, limit: 3 });
  } catch {
    return null;
  }
};

const flushOutbox = async ({ config = readTelemetryConfig(), limit = 20 } = {}) => {
  if (!config.ready) return { ok: false, sent: 0, failed: 0, reason: 'telemetry_not_enabled', errors: [] };
  const dir = outboxDir();
  const paths = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort().slice(0, limit).map((name) => resolve(dir, name))
    : [];
  let sent = 0;
  let failed = 0;
  const errors = [];
  for (const path of paths) {
    try {
      const envelope = JSON.parse(readFileSync(path, 'utf-8'));
      await postEnvelope(envelope, config);
      markSent(envelope);
      unlinkSync(path);
      sent += 1;
    } catch (err) {
      failed += 1;
      errors.push(redactSnippet(err?.message || String(err), 300));
      bumpAttempt(path);
    }
  }
  return { ok: failed === 0, sent, failed, errors: errors.slice(0, 5) };
};

const postEnvelope = async (envelope, config) => {
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body, 'utf-8') > config.max_envelope_bytes) {
    throw new Error('telemetry envelope exceeds max_envelope_bytes');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.auth_token}`,
        'Content-Type': 'application/json',
        'X-Gemini-Md-Export-Telemetry-Schema': TELEMETRY_ENVELOPE_SCHEMA,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`telemetry HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const writeTelemetrySection = (configPath, telemetry) => {
  const path = telemetryConfigPath(configPath);
  let data = {};
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    data = {};
  }
  data.telemetry = telemetry;
  atomicWriteJson(path, data);
};

const shouldApplyDistributionDefaults = (section, defaults) => {
  if (!defaults) return false;
  if (section.enabled === true && section.endpoint_url && section.auth_token) return false;
  if (
    section.enabled === false &&
    (section.opt_out_at || section.consent_at || section.endpoint_url || section.auth_token)
  ) {
    return false;
  }
  return Boolean(defaults.enabled === true && defaults.endpoint_url && defaults.auth_token);
};

const materializeDistributionDefaults = (configPath, section, defaults) => {
  const values = {
    enabled: true,
    endpoint_url: String(section.endpoint_url || defaults.endpoint_url || ''),
    auth_token: String(section.auth_token || defaults.auth_token || ''),
    payload_level: PAYLOAD_LEVELS.has(section.payload_level || defaults.payload_level)
      ? section.payload_level || defaults.payload_level
      : DEFAULT_PAYLOAD_LEVEL,
    consent_at: String(section.consent_at || defaults.consent_at || ''),
    install_id: String(section.install_id || randomUUID()),
    max_envelope_bytes: clampInt(
      section.max_envelope_bytes || defaults.max_envelope_bytes,
      DEFAULT_MAX_ENVELOPE_BYTES,
      16 * 1024,
      2 * 1024 * 1024,
    ),
    source: 'distribution_default',
    auto_enabled_at: String(section.auto_enabled_at || nowIso()),
    opt_out_at: '',
    defaults_path: String(defaults._path || ''),
  };
  writeTelemetrySection(configPath, values);
  return values;
};

const readDistributionDefaults = () => {
  if (process.env[DEFAULTS_DISABLED_ENV] === '1') return null;
  for (const path of distributionDefaultCandidates()) {
    let data = null;
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      continue;
    }
    const telemetry = data.telemetry && typeof data.telemetry === 'object' ? data.telemetry : data;
    if (!telemetry || typeof telemetry !== 'object') continue;
    return { ...telemetry, _path: path };
  }
  return null;
};

const distributionDefaultCandidates = () => {
  if (process.env[DEFAULTS_ENV]) return [resolve(String(process.env[DEFAULTS_ENV]))];
  return [
    resolve(MODULE_ROOT, DEFAULTS_FILE_NAME),
    resolve(MODULE_ROOT, LOCAL_DEFAULTS_FILE_NAME),
  ];
};

const loadUnsentRecords = ({ since = '30d', limit = 20 } = {}) => {
  const sent = new Set(loadSent().sent_run_ids || []);
  const sinceMs = parseSinceMs(since);
  const cutoff = Date.now() - sinceMs;
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => resolve(dir, name))
    .map((path) => {
      try {
        const record = JSON.parse(readFileSync(path, 'utf-8'));
        const recordedAt = Date.parse(record.recorded_at || '') || statSync(path).mtimeMs;
        return { record, recordedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ record, recordedAt }) => recordedAt >= cutoff && !sent.has(String(record.run_id || '')))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(({ record }) => record);
};

const summarizePayload = (result, error) => {
  const source = result && typeof result === 'object' ? result : {};
  const failures = Array.isArray(source.failures) ? source.failures : [];
  const warnings = [
    source.warning,
    source.loadWarning,
    ...(Array.isArray(source.warnings) ? source.warnings : []),
  ].filter(Boolean);
  const errors = [
    error?.message,
    source.error,
    source.loadMoreError,
    source.refreshError,
    ...failures.slice(0, 5).map((failure) => failure.error || failure.message).filter(Boolean),
  ].filter(Boolean);
  return {
    ok: source.ok ?? (error ? false : null),
    status: source.status || null,
    phase: source.phase || null,
    job_id: source.jobId || null,
    counts: compactCounts(source),
    warnings: warnings.slice(0, 10).map((item) => redactSnippet(item, 300)),
    errors: errors.slice(0, 10).map((item) => redactSnippet(item, 300)),
    next_action: source.nextAction || source.next_action || null,
    relevant_paths: [source.reportFile, source.traceFile, source.resumeReportFile]
      .filter(Boolean)
      .map((path) => pathLabel(path)),
    path_hashes: Object.fromEntries(
      [source.reportFile, source.traceFile, source.resumeReportFile]
        .filter(Boolean)
        .map((path) => [pathLabel(path), sha256(String(path)).slice(0, 16)]),
    ),
    signals: compactSignals(source),
  };
};

const compactCounts = (source = {}) => {
  const keys = [
    'webConversationCount',
    'existingVaultCount',
    'missingCount',
    'downloadedCount',
    'skippedCount',
    'warningCount',
    'failedCount',
    'connectedClientCount',
    'selectableTabCount',
    'commandReadyClientCount',
    'totalCount',
    'knownLoadedCount',
    'minimumKnownCount',
  ];
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
};

const compactSignals = (source = {}) =>
  [
    source.blockingIssue ? `blockingIssue:${source.blockingIssue}` : null,
    source.loadMoreTimedOut ? 'load_more_timed_out' : null,
    source.fullHistoryRequested && !source.fullHistoryVerified ? 'full_history_not_verified' : null,
    source.ready === false ? 'not_ready' : null,
    source.totalKnown === false ? 'partial_count' : null,
  ].filter(Boolean);

const diagnosticSnippets = (result, error) => {
  const snippets = [];
  if (error?.message) snippets.push(redactSnippet(error.message, 500));
  if (result?.nextAction) snippets.push(redactSnippet(result.nextAction, 500));
  if (Array.isArray(result?.failures)) {
    for (const failure of result.failures.slice(0, 3)) {
      snippets.push(redactSnippet(failure.error || failure.message || JSON.stringify(failure), 500));
    }
  }
  return snippets;
};

const inferStatus = ({ status, exitCode, result, error }) => {
  if (error) {
    return {
      status: 'failed',
      phase: error.code || null,
      blockedReason: blockerForExit(exitCode, error),
      nextAction: nextActionForExit(exitCode, error),
      humanDecisionRequired: exitCode === 2,
    };
  }
  const normalized = String(status || result?.status || '').toLowerCase();
  if (normalized === 'completed_with_errors') {
    return { status: 'completed_with_warnings', blockedReason: '', nextAction: result?.nextAction || '', humanDecisionRequired: false };
  }
  if (exitCode === 0 || result?.ok === true) {
    return { status: 'completed', blockedReason: '', nextAction: result?.nextAction || '', humanDecisionRequired: false };
  }
  if (exitCode === 1) {
    return { status: 'completed_with_warnings', blockedReason: '', nextAction: result?.nextAction || '', humanDecisionRequired: false };
  }
  return {
    status: normalized || 'failed',
    blockedReason: blockerForExit(exitCode),
    nextAction: result?.nextAction || nextActionForExit(exitCode),
    humanDecisionRequired: exitCode === 2,
  };
};

const blockerForExit = (exitCode, error = null) => {
  if (exitCode === 2) return 'manual_action_required';
  if (exitCode === 3) return 'bridge_unavailable';
  if (exitCode === 4) return 'extension_unready';
  if (exitCode === 5) return 'job_failed';
  if (exitCode === 64) return 'usage_error';
  if (error?.code) return String(error.code);
  return exitCode && exitCode !== 0 ? `exit_${exitCode}` : '';
};

const nextActionForExit = (exitCode, error = null) => {
  if (exitCode === 3) return 'Rodar gemini-md-export doctor --plain e verificar bridge local.';
  if (exitCode === 4) return 'Recarregar/abrir Gemini Web e validar a extensao do navegador.';
  if (exitCode === 2) return 'Executar a acao manual indicada pela CLI.';
  if (exitCode === 5) return 'Abrir reportFile/traceFile do job e transformar a falha em teste.';
  return error?.message ? redactSnippet(error.message, 300) : '';
};

const telemetryRecord = (record, { payloadLevel, rawPayload }) => {
  const out = {
    run_id: record.run_id,
    recorded_at: record.recorded_at,
    workflow: record.workflow,
    source: record.source,
    exit_code: record.exit_code,
    duration_ms: record.duration_ms,
    status: record.status,
    phase: record.phase,
    blocked_reason: record.blocked_reason,
    next_action: record.next_action,
    human_decision_required: record.human_decision_required,
    payload_summary: redactObject(record.payload_summary || {}),
    diagnostic_snippets: record.diagnostic_snippets || [],
  };
  if (payloadLevel === 'full_logs') {
    out.command = record.command || '';
    out.raw_payload_redacted = rawPayload ? redactObject(rawPayload) : { unavailable: true };
  }
  return out;
};

const fitEnvelope = (envelope, maxBytes) => {
  const size = () => Buffer.byteLength(JSON.stringify(envelope), 'utf-8');
  while (size() > maxBytes && envelope.records.length > 1) {
    envelope.records.pop();
    envelope.truncated = true;
  }
  if (size() > maxBytes) {
    for (const record of envelope.records) {
      delete record.raw_payload_redacted;
      record.raw_payload_omitted = 'envelope_size_limit';
    }
    envelope.truncated = true;
  }
  return envelope;
};

const enqueueEnvelope = (envelope) => {
  const generated = String(envelope.generated_at || nowIso()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = resolve(outboxDir(), `${generated}-${envelope.envelope_id}.json`);
  atomicWriteJson(path, { ...envelope, queued_at: nowIso(), attempts: Number(envelope.attempts || 0) });
  return path;
};

const markSent = (envelope) => {
  const sent = loadSent();
  const ids = new Set(sent.sent_run_ids || []);
  for (const record of envelope.records || []) {
    if (record.run_id) ids.add(String(record.run_id));
  }
  atomicWriteJson(sentPath(), {
    schema: TELEMETRY_SENT_SCHEMA,
    sent_run_ids: [...ids].sort(),
    updated_at: nowIso(),
  });
};

const loadSent = () => {
  try {
    const data = JSON.parse(readFileSync(sentPath(), 'utf-8'));
    return {
      schema: TELEMETRY_SENT_SCHEMA,
      sent_run_ids: Array.isArray(data.sent_run_ids) ? data.sent_run_ids : [],
    };
  } catch {
    return { schema: TELEMETRY_SENT_SCHEMA, sent_run_ids: [] };
  }
};

const bumpAttempt = (path) => {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    atomicWriteJson(path, {
      ...data,
      attempts: Number(data.attempts || 0) + 1,
      last_attempt_at: nowIso(),
    });
  } catch {
    // Best-effort diagnostics only.
  }
};

const atomicWriteJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
};

const runsDir = () => {
  const dir = resolve(telemetryRoot(), 'runs');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const outboxDir = () => {
  const dir = resolve(telemetryRoot(), 'outbox');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const sentPath = () => resolve(telemetryRoot(), 'telemetry-sent.json');

const isAutoTelemetryDisabled = () =>
  process.env[DISABLED_ENV] === '1' ||
  (process.env.NODE_TEST_CONTEXT && process.env[ALLOW_NODE_TEST_ENV] !== '1');

const workflowForParsed = (parsed) => {
  if (parsed.command === 'export') return `gemini-md-export:export:${parsed.positionals[0] || 'unknown'}`;
  if (parsed.command === 'job') return `gemini-md-export:job:${parsed.positionals[0] || 'unknown'}`;
  if (parsed.command === 'diagnose') return `gemini-md-export:diagnose:${parsed.positionals[0] || 'unknown'}`;
  if (parsed.command === 'tabs') return `gemini-md-export:tabs:${parsed.positionals[0] || 'list'}`;
  if (parsed.command === 'chats') return `gemini-md-export:chats:${parsed.positionals[0] || 'count'}`;
  if (parsed.command === 'export-dir') return `gemini-md-export:export-dir:${parsed.positionals[0] || 'get'}`;
  if (parsed.command === 'cleanup') return `gemini-md-export:cleanup:${parsed.positionals[0] || 'unknown'}`;
  return `gemini-md-export:${parsed.command}`;
};

const phaseForParsed = (parsed, result) => result?.phase || parsed.positionals[0] || parsed.command;

const parseSinceMs = (value) => {
  const match = String(value || '30d').match(/^(\d+)([dhm])$/i);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return count * 60 * 1000;
  if (unit === 'h') return count * 60 * 60 * 1000;
  return count * 24 * 60 * 60 * 1000;
};

const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const pathLabel = (value) => {
  const text = String(value || '');
  if (!text) return '';
  const home = homedir();
  if (text.startsWith(home)) return `~${text.slice(home.length)}`;
  return basename(text) || text;
};

const redactEndpoint = (url) => redactSnippet(String(url || ''), 400);

const slug = (value) =>
  String(value || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'run';
