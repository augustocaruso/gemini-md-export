import { assetRefsFromChatSnapshot, buildAssetFetchPlan, receiptsForAssetFetchPlan, } from '../core/assets.js';
import { parseChatId } from '../core/chat-id.js';
import { renderChatSnapshotMarkdown } from '../core/chat-snapshot-markdown.js';
const isRecord = (value) => value !== null && typeof value === 'object';
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};
const nonNegativeElapsed = (startedAt, finishedAt) => Math.max(0, Math.round(finishedAt - startedAt));
const envDisablesPrivateReadExport = (env = {}) => {
    const value = String(env.GEMINI_MCP_PRIVATE_READ_EXPORT ?? '')
        .trim()
        .toLowerCase();
    return ['0', 'false', 'off', 'no'].includes(value);
};
export const chatIdFromExportConversation = (conversation) => {
    if (!isRecord(conversation))
        return null;
    return (parseChatId(conversation.chatId) ||
        parseChatId(conversation.url) ||
        parseChatId(conversation.id));
};
export const shouldAttemptPrivateReadExport = (conversation, args = {}, env = {}) => {
    if (args.privateReadExport === false)
        return false;
    if (envDisablesPrivateReadExport(env))
        return false;
    return !!chatIdFromExportConversation(conversation);
};
export const buildPrivateReadExportArgs = (conversation, args = {}) => {
    const chatId = chatIdFromExportConversation(conversation);
    if (!chatId) {
        throw Object.assign(new Error('Conversa sem chatId comprovado para private_read.'), {
            code: 'private_read_export_chat_id_missing',
        });
    }
    const item = isRecord(conversation) ? conversation : {};
    const waitMs = numberOrNull(args.privateReadWaitMs) || numberOrNull(args.waitMs);
    const tabId = numberOrNull(args.tabId);
    return {
        action: 'private_read',
        chatId,
        url: stringOrNull(item.url) || `https://gemini.google.com/app/${chatId}`,
        title: stringOrNull(item.title) || chatId,
        ...(stringOrNull(args.clientId) ? { clientId: stringOrNull(args.clientId) } : {}),
        ...(tabId !== null ? { tabId } : {}),
        ...(stringOrNull(args.claimId) ? { claimId: stringOrNull(args.claimId) } : {}),
        ...(stringOrNull(args.sessionId) ? { sessionId: stringOrNull(args.sessionId) } : {}),
        ...(waitMs !== null ? { waitMs } : {}),
        ...(args.privateApiTransport ? { privateApiTransport: args.privateApiTransport } : {}),
        ...(args.cookiesJson ? { cookiesJson: args.cookiesJson } : {}),
        ...(args.python ? { python: args.python } : {}),
        downloadAssets: true,
        assetsRelDir: `assets/${chatId}`,
        allowDomFallback: false,
    };
};
const snapshotFromPrivateReadResult = (result) => {
    const record = isRecord(result) ? result : {};
    const snapshot = isRecord(record.snapshot) ? record.snapshot : null;
    if (!snapshot || !parseChatId(snapshot.chatId) || !Array.isArray(snapshot.turns)) {
        throw Object.assign(new Error('private_read nao retornou snapshot exportavel.'), {
            code: 'private_read_export_snapshot_missing',
            data: result,
        });
    }
    return snapshot;
};
const adapterOf = (result) => {
    const adapter = isRecord(result) ? stringOrNull(result.adapter) : null;
    return adapter || null;
};
const arrayOf = (value) => (Array.isArray(value) ? value : []);
const assetPlanFromResult = (result, snapshot) => {
    const plan = isRecord(result) && isRecord(result.assetPlan) ? result.assetPlan : null;
    if (plan && Array.isArray(plan.refs) && Array.isArray(plan.requests)) {
        return plan;
    }
    return buildAssetFetchPlan(assetRefsFromChatSnapshot(snapshot));
};
const assetReceiptsFromResult = (result, assetPlan) => {
    const receipts = isRecord(result) ? result.assetReceipts : null;
    return Array.isArray(receipts)
        ? receipts
        : receiptsForAssetFetchPlan(assetPlan);
};
const assistantTurnCountForSnapshot = (snapshot) => {
    const metadataCount = Number(snapshot.metadata?.assistantTurnCount);
    if (Number.isFinite(metadataCount) && metadataCount >= 0)
        return metadataCount;
    return snapshot.turns.filter((turn) => turn.role === 'assistant').length;
};
export const privateReadExportResultToCollectedPayload = ({ activeClient, conversation, result, privateReadStartedAt, privateReadFinishedAt = Date.now(), }) => {
    const snapshot = snapshotFromPrivateReadResult(result);
    const chatId = parseChatId(snapshot.chatId);
    if (!chatId) {
        throw Object.assign(new Error('private_read retornou chatId invalido.'), {
            code: 'private_read_export_chat_id_invalid',
        });
    }
    const record = isRecord(result) ? result : {};
    const markdown = stringOrNull(record.markdown) || renderChatSnapshotMarkdown({ snapshot });
    const assetPlan = assetPlanFromResult(result, snapshot);
    const assetReceipts = assetReceiptsFromResult(result, assetPlan);
    const mediaFiles = arrayOf(record.mediaFiles);
    const mediaFailures = arrayOf(record.mediaFailures);
    const fallbackWarnings = arrayOf(record.fallbackWarnings);
    const adapterAttempts = arrayOf(record.adapterAttempts);
    const conversationRecord = isRecord(conversation) ? conversation : {};
    const filename = stringOrNull(conversationRecord.filename) || `${chatId}.md`;
    const privateReadMs = nonNegativeElapsed(privateReadStartedAt, privateReadFinishedAt);
    const assistantTurnCount = assistantTurnCountForSnapshot(snapshot);
    const metrics = {
        version: 1,
        timings: {
            privateReadMs,
        },
        counters: {
            turnCount: assistantTurnCount,
            totalTurnCount: snapshot.turns.length,
            assetRefCount: assetPlan.refs.length,
            assetRequestCount: assetPlan.requests.length,
            assetReceiptCount: assetReceipts.length,
            mediaFileCount: mediaFiles.length,
            mediaFailureCount: mediaFailures.length,
            privateReadFallbackWarningCount: fallbackWarnings.length,
        },
        privateRead: {
            adapter: adapterOf(result),
            fallbackWarnings,
            adapterAttempts,
        },
        assets: {
            warnings: assetPlan.warnings,
            dedupedRefCount: assetPlan.dedupedRefs.length,
        },
    };
    const payload = {
        chatId,
        title: snapshot.title,
        url: snapshot.url || `https://gemini.google.com/app/${chatId}`,
        filename,
        content: markdown,
        turns: snapshot.turns,
        ...(mediaFiles.length ? { mediaFiles } : {}),
        ...(mediaFailures.length ? { mediaFailures } : {}),
        metrics,
    };
    return {
        activeClient,
        result: {
            ok: true,
            conversation,
            payload,
            privateRead: {
                adapter: adapterOf(result),
                fallbackWarnings,
                adapterAttempts,
                assetPlan,
                assetReceipts,
                transport: record.transport || null,
            },
            returnedToOriginal: null,
        },
        conversation,
        browserCommandMs: privateReadMs,
        privateReadMs,
        expectedChatId: chatId,
        requestedChatId: isRecord(conversation)
            ? conversation.chatId || conversation.id || conversation.url || null
            : null,
    };
};
const progress = (args, event) => {
    if (!isRecord(args) || typeof args.onOperationProgress !== 'function')
        return;
    args.onOperationProgress(event);
};
const allowDomFallback = (args) => args.allowDomFallback === true;
const privateReadUnavailableError = (code, message, data = {}) => {
    const err = new Error(message);
    err.code = code;
    err.data = data;
    return err;
};
const errorWasAbort = (err) => isRecord(err) && (err.commandAborted === true || err.code === 'operation_cancelled');
const clientSelectorForPrivateRead = (client, args) => {
    const record = isRecord(client) ? client : {};
    return {
        clientId: record.clientId || args.clientId || null,
        tabId: record.tabId ?? args.tabId ?? null,
        waitMs: args.privateReadWaitMs || 25000,
    };
};
export const createPrivateReadExportCollector = (deps) => async (client, conversation, args = {}) => {
    if (!shouldAttemptPrivateReadExport(conversation, args, deps.env || {}))
        return null;
    deps.assertNotAborted(args);
    const now = deps.now || Date.now;
    const privateReadStartedAt = now();
    const privateReadArgs = buildPrivateReadExportArgs(conversation, {
        ...args,
        ...clientSelectorForPrivateRead(client, args),
        allowDomFallback: false,
    });
    try {
        progress(args, {
            phase: 'private-read-started',
            message: 'Lendo conversa pela API privada',
            targetChatId: privateReadArgs.chatId,
        });
        const result = await deps.runPrivateReadAction(privateReadArgs);
        deps.assertNotAborted(args);
        progress(args, {
            phase: isRecord(result) && result.ok ? 'private-read-finished' : 'private-read-fallback',
            message: isRecord(result) && result.ok
                ? 'Conversa lida pela API privada'
                : allowDomFallback(args)
                    ? 'API privada indisponivel; preparando fallback'
                    : 'API privada indisponivel',
            targetChatId: privateReadArgs.chatId,
            adapter: isRecord(result) ? result.adapter || null : null,
            code: isRecord(result) ? result.code || null : null,
        });
        if (!isRecord(result) || result.ok !== true) {
            const failure = isRecord(result) ? result : {};
            if (allowDomFallback(args))
                return null;
            throw privateReadUnavailableError(String(failure.code || 'private_read_export_unavailable'), String(failure.message ||
                'A rota privada nao conseguiu ler esta conversa. Fallback DOM exige confirmacao explicita.'), { privateRead: failure });
        }
        const collected = privateReadExportResultToCollectedPayload({
            activeClient: client,
            conversation,
            result,
            privateReadStartedAt,
            privateReadFinishedAt: now(),
        });
        const integrity = await deps.validateMcpExportPayload(collected.result.payload, {
            expectedChatId: collected.expectedChatId,
            requestedChatId: collected.requestedChatId,
        });
        if (!integrity.ok) {
            progress(args, {
                phase: 'private-read-fallback',
                message: allowDomFallback(args)
                    ? 'API privada retornou payload invalido; preparando fallback'
                    : 'API privada retornou payload invalido',
                targetChatId: privateReadArgs.chatId,
                code: integrity.code || 'private_read_payload_invalid',
            });
            if (allowDomFallback(args))
                return null;
            throw privateReadUnavailableError(integrity.code || 'private_read_payload_invalid', integrity.message || 'A rota privada retornou dados invalidos.', { integrity });
        }
        return {
            ...collected,
            integrity,
        };
    }
    catch (err) {
        if (errorWasAbort(err))
            throw err;
        progress(args, {
            phase: 'private-read-fallback',
            message: allowDomFallback(args)
                ? 'API privada falhou; preparando fallback'
                : 'API privada falhou',
            targetChatId: privateReadArgs.chatId,
            code: isRecord(err)
                ? err.code || 'private_read_export_failed'
                : 'private_read_export_failed',
        });
        if (allowDomFallback(args))
            return null;
        throw err;
    }
};
