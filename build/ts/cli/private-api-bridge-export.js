import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const numberInRange = (value, fallback, min, max) => {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
};
const normalizeBridgeUrl = (value) => {
    const raw = stringOrNull(value);
    if (!raw) {
        throw Object.assign(new Error('Bridge local nao configurada para export privado.'), {
            code: 'bridge_private_export_unavailable',
        });
    }
    return raw.replace(/\/+$/, '');
};
const jsonFetch = async (bridgeUrl, path, { method = 'GET', body, timeoutMs = 15_000, } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    try {
        const response = await fetch(new URL(path, `${normalizeBridgeUrl(bridgeUrl)}/`), {
            method,
            signal: controller.signal,
            headers: {
                accept: 'application/json',
                ...(bodyText ? { 'content-type': 'application/json' } : {}),
            },
            body: bodyText,
        });
        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        if (!response.ok) {
            const message = stringOrNull(json.error) ||
                stringOrNull(json.message) ||
                `Bridge retornou HTTP ${response.status}.`;
            throw Object.assign(new Error(message), {
                code: stringOrNull(json.code) || 'bridge_private_export_unavailable',
                data: json,
            });
        }
        return json;
    }
    catch (err) {
        if (err instanceof Error && 'code' in err)
            throw err;
        throw Object.assign(new Error(err instanceof Error
            ? `Bridge local indisponivel para export privado: ${err.message}`
            : 'Bridge local indisponivel para export privado.'), { code: 'bridge_private_export_unavailable', cause: err });
    }
    finally {
        clearTimeout(timeout);
    }
};
const appendParams = (path, params) => {
    const url = new URL(path, 'http://127.0.0.1');
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '')
            continue;
        url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
};
const readJsonFileIfExists = (filePath) => {
    const resolved = stringOrNull(filePath);
    if (!resolved || !existsSync(resolved))
        return null;
    try {
        return JSON.parse(readFileSync(resolved, 'utf-8'));
    }
    catch {
        return null;
    }
};
const bridgeStatusToPrivateStatus = (status) => {
    if (status === 'completed')
        return 'completed';
    if (status === 'completed_with_errors')
        return 'completed_with_errors';
    if (status === 'running')
        return 'running';
    return 'failed';
};
const bridgePhaseToPrivatePhase = (phase) => phase === 'writing-report' ? 'writing-report' : 'exporting';
const savedFilesFromReport = (report, job) => {
    const successes = Array.isArray(report?.successes)
        ? report?.successes
        : Array.isArray(job.recentSuccesses)
            ? job.recentSuccesses
            : [];
    return successes.map((item) => ({
        chatId: stringOrNull(item.chatId) || '',
        title: stringOrNull(item.title),
        filePath: stringOrNull(item.filePath) || '',
        filename: stringOrNull(item.filename) || '',
        bytes: Number(item.bytes || 0),
        overwritten: item.overwritten === true,
        mediaFileCount: Number(item.mediaFileCount || 0),
        mediaFailureCount: Number(item.mediaFailureCount || 0),
        mediaBytes: Number(item.mediaBytes || item.metrics?.counters?.savedMediaBytes || 0),
        dateCreated: stringOrNull(item.dateCreated || item.dateImport?.dateCreated),
        dateLastMessage: stringOrNull(item.dateLastMessage || item.dateImport?.dateLastMessage),
        adapter: stringOrNull(item.adapter || item.metrics?.privateRead?.adapter),
    }));
};
const failuresFromReport = (report, job) => {
    const failures = Array.isArray(report?.failures)
        ? report?.failures
        : Array.isArray(job.failures)
            ? job.failures
            : [];
    return failures.map((item, index) => ({
        index: Number(item.index || index + 1),
        chatId: stringOrNull(item.chatId),
        title: stringOrNull(item.title),
        error: stringOrNull(item.error || item.message) || 'Falha sem detalhe.',
        code: stringOrNull(item.code),
    }));
};
const currentFromBridgeJob = (job, requested) => {
    const current = job.current && typeof job.current === 'object' ? job.current : null;
    if (!current)
        return null;
    const index = Number(current.index || job.position || job.completed || 1);
    const chatId = stringOrNull(current.chatId);
    if (!chatId)
        return null;
    return {
        index,
        batchPosition: index,
        batchTotal: requested,
        chatId,
        title: stringOrNull(current.title) || chatId,
    };
};
const toPrivateApiSelectedExportJob = ({ bridgeJob, report, fallbackOutputDir, fallbackRequested, }) => {
    const savedFiles = savedFilesFromReport(report, bridgeJob);
    const failures = failuresFromReport(report, bridgeJob);
    const requested = numberInRange(bridgeJob.requested ?? report?.requested ?? fallbackRequested, Math.max(fallbackRequested, savedFiles.length + failures.length), 0, 2000);
    const completed = numberInRange(bridgeJob.completed ?? savedFiles.length + failures.length, savedFiles.length + failures.length, 0, requested);
    const status = bridgeStatusToPrivateStatus(bridgeJob.status);
    const now = new Date().toISOString();
    return {
        jobId: stringOrNull(bridgeJob.jobId) || `bridge-private-${Date.now().toString(36)}`,
        type: 'private-api-selected-export',
        sourceKind: 'export-job',
        status,
        phase: bridgePhaseToPrivatePhase(bridgeJob.phase),
        requested,
        completed,
        batchTotal: requested,
        successCount: Number(bridgeJob.successCount ?? report?.successCount ?? savedFiles.length),
        failureCount: Number(bridgeJob.failureCount ?? report?.failureCount ?? failures.length),
        outputDir: stringOrNull(bridgeJob.outputDir || report?.outputDir) || fallbackOutputDir,
        current: status === 'running' ? currentFromBridgeJob(bridgeJob, requested) : null,
        progressMessage: stringOrNull(bridgeJob.progressMessage) || 'Export privado em andamento',
        operationMessage: stringOrNull(bridgeJob.progressMessage) || 'Export privado em andamento',
        decisionSummary: {
            headline: 'Export privado unificado',
            totals: {
                downloadedNow: savedFiles.length,
                failed: failures.length,
                skipped: 0,
                geminiWebSeen: requested,
                missingInVault: 0,
            },
        },
        savedFiles,
        failures,
        startedAt: stringOrNull(bridgeJob.createdAt) || now,
        updatedAt: stringOrNull(bridgeJob.updatedAt) || now,
        ...(TERMINAL_STATUSES.has(String(bridgeJob.status))
            ? { finishedAt: stringOrNull(bridgeJob.finishedAt) || now }
            : {}),
    };
};
const requestBodyForBridgePrivateExport = (args) => ({
    outputDir: stringOrNull(args.outputDir) ? resolve(String(args.outputDir)) : undefined,
    items: args.items,
    expectedCount: args.expectedCount,
    limit: args.limit,
    waitMs: args.waitMs,
    privateReadWaitMs: args.privateReadWaitMs,
    timeoutMs: args.timeoutMs,
    delayMs: args.delayMs,
    clientId: args.clientId,
    tabId: args.tabId,
    claimId: args.claimId,
    sessionId: args.sessionId,
    openIfMissing: args.openIfMissing === true || args.wakeBrowser === true,
    wakeBrowser: args.wakeBrowser === true,
    activateTab: args.activateTab === true,
    allowReload: args.allowReload === true,
    python: args.python,
    cookiesJson: args.cookiesJson,
    privateReadExport: true,
    allowDomFallback: false,
});
export const runPrivateApiSelectedExportViaBridge = async (args) => {
    if (args.items.length === 0) {
        throw Object.assign(new Error('Nenhuma conversa selecionada para export privado pela bridge.'), {
            code: 'bridge_private_export_selection_empty',
        });
    }
    const outputDir = stringOrNull(args.outputDir) ? resolve(String(args.outputDir)) : resolve('.');
    const expectedCount = numberInRange(args.expectedCount ?? args.items.length, args.items.length, 0, 2000);
    const pollMs = numberInRange(args.pollMs, 1200, 50, 10_000);
    const timeoutMs = numberInRange(args.timeoutMs, 120_000, 5_000, 30 * 60_000);
    const startedAt = Date.now();
    const started = await jsonFetch(args.bridgeUrl, '/agent/reexport-chats', {
        method: 'POST',
        timeoutMs: 20_000,
        body: requestBodyForBridgePrivateExport(args),
    });
    let privateJob = toPrivateApiSelectedExportJob({
        bridgeJob: started,
        report: null,
        fallbackOutputDir: outputDir,
        fallbackRequested: expectedCount,
    });
    args.onProgress?.(privateJob);
    let bridgeJob = started;
    while (!TERMINAL_STATUSES.has(String(bridgeJob.status))) {
        if (Date.now() - startedAt > timeoutMs) {
            throw Object.assign(new Error(`Timeout aguardando export privado ${privateJob.jobId}.`), {
                code: 'bridge_private_export_timeout',
                data: { jobId: privateJob.jobId, timeoutMs },
            });
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
        bridgeJob = await jsonFetch(args.bridgeUrl, appendParams('/agent/export-job-status', { jobId: privateJob.jobId }), { timeoutMs: 20_000 });
        privateJob = toPrivateApiSelectedExportJob({
            bridgeJob,
            report: null,
            fallbackOutputDir: outputDir,
            fallbackRequested: expectedCount,
        });
        args.onProgress?.(privateJob);
    }
    const report = readJsonFileIfExists(bridgeJob.reportFile);
    privateJob = toPrivateApiSelectedExportJob({
        bridgeJob,
        report,
        fallbackOutputDir: outputDir,
        fallbackRequested: expectedCount,
    });
    args.onProgress?.(privateJob);
    return privateJob;
};
