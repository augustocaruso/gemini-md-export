import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import { runGeminiWebapiPythonListChats, } from '../mcp/gemini-webapi-python-adapter.js';
import { createNativeBrowserBrokerClient } from '../mcp/native-browser-broker.js';
import { runPrivateApiSelectedExport, } from './private-api-selected-export.js';
const INTERNAL_DIRS = new Set([
    '.git',
    '.obsidian',
    '.trash',
    '.gemini-md-export',
    '.gemini-md-export-fix',
    '.gemini-md-export-repair',
    'node_modules',
]);
const DEFAULT_KNOWN_BOUNDARY_COUNT = 25;
const SYNC_STATE_DIR = '.gemini-md-export';
const SYNC_STATE_FILENAME = 'sync-state.json';
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const numberInRange = (value, fallback, min, max) => {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
};
const expandUserPath = (value) => {
    if (value === '~')
        return homedir();
    if (value.startsWith('~/'))
        return resolve(homedir(), value.slice(2));
    return value;
};
const resolvePathInput = (value, fallback) => {
    const raw = stringOrNull(value) || fallback;
    if (!raw)
        throw Object.assign(new Error('Informe vaultDir para sync.'), { code: 'missing_vault_dir' });
    return resolve(expandUserPath(raw));
};
export const resolvePrivateSyncStateFile = (vaultDir, syncStateFile) => {
    const explicit = stringOrNull(syncStateFile);
    if (explicit)
        return resolve(expandUserPath(explicit));
    return resolve(vaultDir, SYNC_STATE_DIR, SYNC_STATE_FILENAME);
};
const readJsonFile = (filePath) => {
    try {
        if (!existsSync(filePath))
            return null;
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
};
const writeJsonFile = (filePath, value) => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
};
const chatIdFromLooseText = (value) => {
    const parsed = parseChatId(value);
    if (parsed)
        return parsed;
    const text = String(value ?? '');
    return text.match(/\bc_([a-f0-9]{12,})\b/i)?.[1]?.toLowerCase() || null;
};
const frontmatterField = (text, key) => {
    if (!text.startsWith('---\n'))
        return null;
    const end = text.indexOf('\n---', 4);
    if (end < 0)
        return null;
    const frontmatter = text.slice(4, end);
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'im'));
    return match?.[1]?.trim().replace(/^["'](.*)["']$/, '$1') || null;
};
const collectVaultChatIds = (rootDir, out = new Set()) => {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (INTERNAL_DIRS.has(entry.name.toLowerCase()))
                continue;
            collectVaultChatIds(resolve(rootDir, entry.name), out);
            continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md'))
            continue;
        const filePath = resolve(rootDir, entry.name);
        const fromName = chatIdFromLooseText(basename(entry.name, '.md'));
        if (fromName) {
            out.add(fromName);
            continue;
        }
        let text = '';
        try {
            text = readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        const fromFrontmatter = chatIdFromLooseText(frontmatterField(text, 'chat_id')) ||
            chatIdFromLooseText(frontmatterField(text, 'url'));
        if (fromFrontmatter)
            out.add(fromFrontmatter);
    }
    return out;
};
export const scanPrivateSyncVault = (vaultDir) => {
    const rootDir = resolve(vaultDir);
    const stat = statSync(rootDir);
    if (!stat.isDirectory()) {
        throw Object.assign(new Error(`O caminho do vault nao e uma pasta: ${rootDir}`), {
            code: 'vault_dir_not_directory',
        });
    }
    const chatIds = collectVaultChatIds(rootDir);
    return {
        rootDir,
        uniqueChatIds: chatIds.size,
        chatIds,
    };
};
const normalizeInventoryChat = (chat) => {
    const chatId = parseChatId(chat.chatId || chat.chat_id || chat.privateChatId || chat.private_chat_id || chat.id);
    if (!chatId)
        return null;
    return {
        chatId,
        title: stringOrNull(chat.title),
        url: stringOrNull(chat.url) || canonicalGeminiChatUrl(chatId),
    };
};
const normalizeInventory = (result) => {
    const chats = Array.isArray(result.chats)
        ? result.chats
        : Array.isArray(result.conversations)
            ? result.conversations
            : [];
    const seen = new Set();
    const items = [];
    for (const chat of chats) {
        const item = normalizeInventoryChat(chat);
        if (!item || seen.has(item.chatId))
            continue;
        seen.add(item.chatId);
        items.push(item);
    }
    return items;
};
const syncStateBoundaryIds = (syncState) => {
    const ids = new Set();
    const add = (value) => {
        const chatId = chatIdFromLooseText(value);
        if (chatId)
            ids.add(chatId);
    };
    add(syncState?.topChatId);
    for (const chatId of Array.isArray(syncState?.boundaryChatIds) ? syncState.boundaryChatIds : []) {
        add(chatId);
    }
    return ids;
};
export const selectPrivateSyncItems = ({ inventory, existingChatIds, syncState, knownBoundaryCount, maxChats, }) => {
    const stateBoundaryIds = syncStateBoundaryIds(syncState);
    const knownTarget = numberInRange(knownBoundaryCount, DEFAULT_KNOWN_BOUNDARY_COUNT, 1, 100);
    let knownRunStart = null;
    let knownRunLength = 0;
    let boundary = {
        found: inventory.length === 0,
        type: inventory.length === 0 ? 'end-of-private-inventory' : 'not-found',
        chatId: null,
        index: inventory.length === 0 ? 0 : null,
        knownSequenceLength: 0,
    };
    for (let index = 0; index < inventory.length; index += 1) {
        const chatId = inventory[index]?.chatId;
        if (!chatId) {
            knownRunStart = null;
            knownRunLength = 0;
            continue;
        }
        if (stateBoundaryIds.has(chatId)) {
            boundary = {
                found: true,
                type: 'sync-state-boundary',
                chatId,
                index,
                knownSequenceLength: knownRunLength,
            };
            break;
        }
        if (existingChatIds.has(chatId)) {
            if (knownRunStart === null)
                knownRunStart = index;
            knownRunLength += 1;
            if (knownRunLength >= knownTarget) {
                boundary = {
                    found: true,
                    type: 'known-vault-sequence',
                    chatId,
                    index: knownRunStart,
                    knownSequenceLength: knownRunLength,
                };
                break;
            }
        }
        else {
            knownRunStart = null;
            knownRunLength = 0;
        }
    }
    const beforeBoundary = boundary.found
        ? inventory.slice(0, boundary.index ?? inventory.length)
        : inventory;
    const cap = maxChats === undefined
        ? beforeBoundary.length
        : numberInRange(maxChats, beforeBoundary.length, 0, 2000);
    const missing = beforeBoundary.filter((item) => !existingChatIds.has(item.chatId)).slice(0, cap);
    const existingInVaultBeforeBoundary = beforeBoundary.filter((item) => existingChatIds.has(item.chatId)).length;
    return {
        inventory,
        boundary,
        itemsToExport: missing,
        skippedExisting: existingInVaultBeforeBoundary,
        existingInVaultBeforeBoundary,
    };
};
const privateInventoryLimit = (args) => {
    const maxChats = numberInRange(args.maxChats, 0, 0, 2000);
    const knownBoundaryCount = numberInRange(args.knownBoundaryCount, DEFAULT_KNOWN_BOUNDARY_COUNT, 1, 100);
    return Math.max(100, Math.min(2000, (maxChats || 200) + knownBoundaryCount + 10));
};
const listChatsViaNativeOrPython = async (input) => {
    const timeoutMs = numberInRange(input.timeoutMs, 45_000, 5_000, 180_000);
    const attempts = [];
    if (!stringOrNull(input.python) && !stringOrNull(input.cookiesJson)) {
        try {
            const nativeResponse = (await createNativeBrowserBrokerClient().privateApiListChats({ limit: input.limit, timeoutMs }, { allowFallback: true }));
            const nativeResult = nativeResponse?.ok === true ? nativeResponse.result : nativeResponse;
            if (nativeResult?.ok === true) {
                return {
                    ...nativeResult,
                    source: nativeResult.source || 'browser-background',
                    attempts,
                };
            }
            attempts.push({
                adapter: 'browserBackground',
                ok: false,
                code: nativeResult?.code || 'native_private_inventory_failed',
                message: nativeResult?.message || nativeResult?.error || null,
            });
        }
        catch (err) {
            const record = err && typeof err === 'object' ? err : {};
            attempts.push({
                adapter: 'browserBackground',
                ok: false,
                code: record.code || 'native_private_inventory_failed',
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    const pythonResult = await runGeminiWebapiPythonListChats({
        limit: input.limit,
        timeoutMs,
        python: input.python,
        cookiesJson: input.cookiesJson,
    });
    if (pythonResult.ok === true) {
        return {
            ...pythonResult,
            source: 'gemini-webapi-python',
            attempts,
        };
    }
    return {
        ...pythonResult,
        attempts: [
            ...attempts,
            {
                adapter: 'privateApiGeminiWebapi',
                ok: false,
                code: pythonResult.code,
                message: pythonResult.message,
            },
        ],
    };
};
const defaultDeps = {
    now: () => new Date(),
    listChats: listChatsViaNativeOrPython,
    exportSelected: (input) => runPrivateApiSelectedExport(input),
};
const makeJob = ({ args, status, phase, outputDir, syncStateFile, inventory, inventorySource, vaultChatIdCount, decision, exportJob, progressMessage, startedAt, updatedAt, finishedAt, }) => {
    const savedFiles = exportJob?.savedFiles || [];
    const failures = exportJob?.failures || [];
    const fullHistoryVerified = decision.boundary.found === true || inventory.length < privateInventoryLimit(args);
    return {
        jobId: exportJob?.jobId || `private-sync-${Date.now().toString(36)}`,
        type: 'private-api-sync',
        sourceKind: 'export-job',
        status,
        phase,
        requested: decision.itemsToExport.length,
        completed: (exportJob?.completed ?? 0) || savedFiles.length + failures.length,
        batchTotal: decision.itemsToExport.length,
        successCount: savedFiles.length,
        failureCount: failures.length,
        loadedCount: inventory.length,
        outputDir,
        current: exportJob?.current || null,
        progressMessage,
        operationMessage: progressMessage,
        decisionSummary: {
            adapter: 'private_api',
            fullHistoryRequested: true,
            fullHistoryVerified,
            syncStateFile,
            boundary: decision.boundary,
            inventorySource,
            nextAction: status === 'completed'
                ? { code: 'done', message: 'Sync privado concluido.', command: null }
                : status === 'completed_with_errors'
                    ? {
                        code: fullHistoryVerified ? 'review_failures' : 'increase_private_inventory_limit',
                        message: fullHistoryVerified
                            ? 'Revise as falhas do export privado.'
                            : 'Nao confirmei o limite do historico privado; rode novamente com mais limite.',
                        command: null,
                    }
                    : { code: 'private_sync_failed', message: 'Sync privado falhou.', command: null },
            totals: {
                geminiWebSeen: inventory.length,
                existingInVault: vaultChatIdCount,
                missingInVault: decision.itemsToExport.length,
                downloadedNow: savedFiles.length,
                skipped: decision.skippedExisting,
                mediaWarnings: savedFiles.filter((file) => file.mediaFailureCount > 0).length,
                failed: failures.length,
            },
        },
        savedFiles,
        failures,
        syncStateFile,
        startedAt,
        updatedAt,
        ...(finishedAt ? { finishedAt } : {}),
    };
};
const statusFromExport = (exportJob, fullHistoryVerified) => {
    if (!exportJob)
        return fullHistoryVerified ? 'completed' : 'completed_with_errors';
    if (exportJob.status === 'failed')
        return 'failed';
    if (exportJob.failureCount > 0 || !fullHistoryVerified)
        return 'completed_with_errors';
    return 'completed';
};
const writeSyncState = ({ syncStateFile, inventory, decision, previousState, now, downloadedCount, existingVaultCount, inventorySource, success, }) => {
    const state = {
        ...(previousState || {}),
        adapter: 'private_api',
        updatedAt: now,
        lastAttemptAt: now,
        ...(success ? { lastSuccessfulSyncAt: now } : {}),
        ...(decision.boundary.found ? { lastFullSyncAt: now } : {}),
        topChatId: inventory[0]?.chatId || previousState?.topChatId || null,
        boundaryChatIds: inventory.slice(0, 50).map((item) => item.chatId),
        lastDownloadedCount: downloadedCount,
        lastExistingVaultCount: existingVaultCount,
        privateInventorySource: inventorySource,
        privateBoundary: decision.boundary,
    };
    writeJsonFile(syncStateFile, state);
};
export const runPrivateApiSync = async (args, deps = {}) => {
    const runtimeDeps = { ...defaultDeps, ...deps };
    const vaultDir = resolvePathInput(args.vaultDir);
    const outputDir = resolvePathInput(args.outputDir, vaultDir);
    mkdirSync(outputDir, { recursive: true });
    const syncStateFile = resolvePrivateSyncStateFile(vaultDir, args.syncStateFile);
    const startedAt = runtimeDeps.now().toISOString();
    const inventoryLimit = privateInventoryLimit(args);
    const emptyDecision = {
        inventory: [],
        boundary: {
            found: false,
            type: 'not-found',
            chatId: null,
            index: null,
            knownSequenceLength: 0,
        },
        itemsToExport: [],
        skippedExisting: 0,
        existingInVaultBeforeBoundary: 0,
    };
    args.onProgress?.(makeJob({
        args,
        status: 'running',
        phase: 'listing',
        outputDir,
        syncStateFile,
        inventory: [],
        inventorySource: null,
        vaultChatIdCount: 0,
        decision: emptyDecision,
        progressMessage: 'Listando conversas pela API privada',
        startedAt,
        updatedAt: runtimeDeps.now().toISOString(),
    }));
    const listResult = await runtimeDeps.listChats({
        limit: inventoryLimit,
        timeoutMs: args.waitMs ?? args.privateReadWaitMs ?? args.timeoutMs,
        python: args.python,
        cookiesJson: args.cookiesJson,
    });
    if (listResult?.ok !== true) {
        const err = Object.assign(new Error(stringOrNull(listResult?.message) ||
            stringOrNull(listResult?.error) ||
            'Nao consegui listar conversas pela API privada.'), {
            code: stringOrNull(listResult?.code) || 'private_inventory_unavailable',
            data: listResult,
        });
        throw err;
    }
    const inventory = normalizeInventory(listResult);
    const vaultScan = scanPrivateSyncVault(vaultDir);
    const previousState = readJsonFile(syncStateFile);
    const decision = selectPrivateSyncItems({
        inventory,
        existingChatIds: vaultScan.chatIds,
        syncState: previousState,
        knownBoundaryCount: args.knownBoundaryCount,
        maxChats: args.maxChats,
    });
    const inventorySource = stringOrNull(listResult.source);
    const preExportJob = makeJob({
        args,
        status: 'running',
        phase: 'exporting',
        outputDir,
        syncStateFile,
        inventory,
        inventorySource,
        vaultChatIdCount: vaultScan.uniqueChatIds,
        decision,
        progressMessage: decision.itemsToExport.length === 0
            ? 'Vault ja estava atualizado pela API privada'
            : 'Exportando conversas novas pela API privada',
        startedAt,
        updatedAt: runtimeDeps.now().toISOString(),
    });
    args.onProgress?.(preExportJob);
    let exportJob = null;
    if (decision.itemsToExport.length > 0) {
        exportJob = await runtimeDeps.exportSelected({
            items: decision.itemsToExport.map((item) => ({ ...item, outputDir })),
            expectedCount: decision.itemsToExport.length,
            outputDir,
            bridgeUrl: args.bridgeUrl,
            waitMs: args.waitMs,
            privateReadWaitMs: args.privateReadWaitMs,
            timeoutMs: args.timeoutMs,
            python: args.python,
            cookiesJson: args.cookiesJson,
            delayMs: args.delayMs,
            clientId: args.clientId,
            tabId: args.tabId,
            claimId: args.claimId,
            sessionId: args.sessionId,
            openIfMissing: args.openIfMissing,
            wakeBrowser: args.wakeBrowser,
            activateTab: args.activateTab,
            allowReload: args.allowReload,
            maxReadAttempts: args.maxReadAttempts,
            onProgress: (selectedJob) => {
                args.onProgress?.(makeJob({
                    args,
                    status: 'running',
                    phase: 'exporting',
                    outputDir,
                    syncStateFile,
                    inventory,
                    inventorySource,
                    vaultChatIdCount: vaultScan.uniqueChatIds,
                    decision,
                    exportJob: selectedJob,
                    progressMessage: selectedJob.progressMessage,
                    startedAt,
                    updatedAt: runtimeDeps.now().toISOString(),
                }));
            },
        });
    }
    const fullHistoryVerified = decision.boundary.found === true || inventory.length < privateInventoryLimit(args);
    const status = statusFromExport(exportJob, fullHistoryVerified);
    const finishedAt = runtimeDeps.now().toISOString();
    writeSyncState({
        syncStateFile,
        inventory,
        decision,
        previousState,
        now: finishedAt,
        downloadedCount: exportJob?.successCount || 0,
        existingVaultCount: vaultScan.uniqueChatIds,
        inventorySource,
        success: status === 'completed',
    });
    const finalJob = makeJob({
        args,
        status,
        phase: 'writing-report',
        outputDir,
        syncStateFile,
        inventory,
        inventorySource,
        vaultChatIdCount: vaultScan.uniqueChatIds,
        decision,
        exportJob,
        progressMessage: decision.itemsToExport.length === 0
            ? 'Vault ja estava atualizado pela API privada'
            : status === 'completed'
                ? 'Sync privado concluido'
                : 'Sync privado concluiu com avisos',
        startedAt,
        updatedAt: finishedAt,
        finishedAt,
    });
    args.onProgress?.(finalJob);
    return finalJob;
};
export const summarizePrivateApiSyncJob = (job) => ({
    ok: job.status === 'completed',
    status: job.status,
    jobId: job.jobId,
    adapter: 'private_api',
    outputDir: job.outputDir,
    syncStateFile: job.syncStateFile,
    requestedCount: job.requested,
    downloadedCount: job.successCount,
    failedCount: job.failureCount,
    existingInVault: job.decisionSummary.totals.existingInVault,
    geminiWebSeen: job.decisionSummary.totals.geminiWebSeen,
    missingInVault: job.decisionSummary.totals.missingInVault,
    skipped: job.decisionSummary.totals.skipped,
    fullHistoryRequested: true,
    fullHistoryVerified: job.decisionSummary.fullHistoryVerified,
    boundary: job.decisionSummary.boundary,
    inventorySource: job.decisionSummary.inventorySource,
    files: job.savedFiles.map((file) => ({
        chatId: file.chatId,
        title: file.title,
        filePath: file.filePath,
        bytes: file.bytes,
        overwritten: file.overwritten,
        mediaFileCount: file.mediaFileCount,
        mediaFailureCount: file.mediaFailureCount,
        mediaBytes: file.mediaBytes,
        dateCreated: file.dateCreated,
        dateLastMessage: file.dateLastMessage,
    })),
    failures: job.failures,
    nextAction: job.decisionSummary.nextAction,
});
