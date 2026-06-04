import { assetRefsFromChatSnapshot, buildAssetFetchPlan } from '../../core/assets.js';
import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import { browserBackgroundChatReadCapability, buildChatReadAdapterPlan, domChatReadCapability, takeoutChatReadCapability, } from '../../core/chat-read-adapter.js';
import { renderChatSnapshotMarkdown } from '../../core/chat-snapshot-markdown.js';
import { buildGeminiPrivateBatchRequest, buildGeminiPrivateListChatsPayload, buildGeminiPrivateReadChatPayload, decodeGeminiBatchExecuteResponseWithDiagnostics, extractGeminiBatchRpcPayload, GEMINI_PRIVATE_RPC, normalizeGeminiPrivateReadChatSnapshot, } from '../../core/gemini-private-protocol.js';
import { extractGeminiPrivateSessionFields, looksLikeGoogleVerificationHtml, } from '../../core/gemini-private-session.js';
import { createBrowserSafeMarkdownRenderer, } from '../../core/markdown-renderer/browser-safe-renderer.js';
export { extractGeminiPrivateSessionFields } from '../../core/gemini-private-session.js';
const failure = (code, message, chatId, status, diagnostics) => ({
    ok: false,
    code,
    message,
    chatId,
    adapterPlan: privateApiAdapterPlan(),
    ...(status === undefined ? {} : { status }),
    ...(diagnostics ? { diagnostics } : {}),
});
const listFailure = (code, message, status, diagnostics) => ({
    ok: false,
    code,
    message,
    adapterPlan: privateApiAdapterPlan(),
    ...(status === undefined ? {} : { status }),
    ...(diagnostics ? { diagnostics } : {}),
});
const sessionFailure = (code, message, status) => ({
    ok: false,
    authenticated: false,
    code,
    message,
    adapterPlan: privateApiAdapterPlan(),
    ...(status === undefined ? {} : { status }),
});
const privateApiAdapterPlan = () => buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'browserBackground',
    capabilities: [
        browserBackgroundChatReadCapability({
            available: true,
            reason: 'extension_background_fetch_with_browser_credentials',
        }),
        domChatReadCapability({
            available: false,
            reason: 'dom_export_fallback_requires_explicit_mcp_request',
        }),
        takeoutChatReadCapability({
            available: false,
            reason: 'takeout_source_not_available_in_extension_background',
        }),
    ],
});
const normalizeTimeoutMs = (value, fallbackMs) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return fallbackMs;
    return Math.max(1, Math.min(120_000, numeric));
};
const requestFailureMessage = (err) => {
    if (err instanceof Error && err.name === 'AbortError') {
        return 'Tempo esgotado ao consultar a API privada do Gemini.';
    }
    return err instanceof Error ? err.message : String(err);
};
const privateApiTimeoutError = () => Object.assign(new Error('Tempo esgotado ao consultar a API privada do Gemini.'), {
    name: 'AbortError',
});
const withPrivateApiTimeout = async (promise, timeoutMs, onTimeout) => new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
        try {
            onTimeout?.();
        }
        catch {
            // Ignore abort races.
        }
        reject(privateApiTimeoutError());
    }, timeoutMs);
    promise.then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
    }, (err) => {
        clearTimeout(timeoutId);
        reject(err);
    });
});
const fetchWithTimeout = async (fetchImpl, url, init, timeoutMs) => {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    return withPrivateApiTimeout(fetchImpl(url, {
        ...(init || {}),
        ...(controller ? { signal: controller.signal } : {}),
    }), timeoutMs, () => controller?.abort());
};
const readResponseTextWithTimeout = async (response, timeoutMs) => withPrivateApiTimeout(response.text(), timeoutMs);
const readResponseArrayBufferWithTimeout = async (response, timeoutMs) => {
    if (typeof response.arrayBuffer !== 'function') {
        throw new Error('A resposta do asset nao oferece arrayBuffer().');
    }
    return withPrivateApiTimeout(response.arrayBuffer(), timeoutMs);
};
const summarizeDecodeDiagnostics = ({ parseableFrameCount, malformedLineCount, warnings, }) => ({
    parseableFrameCount,
    malformedLineCount,
    warnings,
});
const fetchGeminiAppSession = async (fetchImpl, timeoutMs) => {
    const appResponse = await fetchWithTimeout(fetchImpl, 'https://gemini.google.com/app', {
        credentials: 'include',
    }, timeoutMs);
    if (!appResponse.ok) {
        return {
            ok: false,
            response: appResponse,
            session: null,
            html: '',
        };
    }
    const html = await readResponseTextWithTimeout(appResponse, timeoutMs);
    return {
        ok: true,
        response: appResponse,
        session: extractGeminiPrivateSessionFields(html),
        html,
    };
};
const timestampToIso = (value) => {
    if (!Array.isArray(value) || value.length < 1)
        return null;
    const seconds = Number(value[0]);
    const nanos = Number(value[1] || 0);
    if (!Number.isFinite(seconds) || seconds <= 0)
        return null;
    return new Date((seconds + nanos / 1_000_000_000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
};
const listChatsFromPayload = (payload) => {
    const body = payload && typeof payload === 'object' && 'body' in payload
        ? payload.body
        : payload;
    const chatList = Array.isArray(body) && Array.isArray(body[2]) ? body[2] : [];
    return chatList.flatMap((item) => {
        if (!Array.isArray(item))
            return [];
        const privateChatId = String(item[0] || '').trim();
        const chatId = parseChatId(privateChatId);
        if (!chatId)
            return [];
        return [
            {
                chatId,
                privateChatId,
                title: String(item[1] || '').trim() || null,
                url: canonicalGeminiChatUrl(chatId),
                isPinned: Boolean(item[2]),
                updatedAt: timestampToIso(item[5]),
            },
        ];
    });
};
const mergeListChats = (groups) => {
    const seen = new Set();
    const chats = [];
    for (const group of groups) {
        for (const chat of group) {
            if (seen.has(chat.chatId))
                continue;
            seen.add(chat.chatId);
            chats.push(chat);
        }
    }
    return chats;
};
const safeAssetPathPart = (value, fallback) => {
    const text = String(value || '')
        .replace(/[\\/]+/g, '/')
        .split('/')
        .pop()
        ?.replace(/[^\w .@()+,-]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return text || fallback;
};
const extensionForContentType = (contentType) => {
    const normalized = String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (normalized === 'image/jpeg')
        return '.jpg';
    if (normalized === 'image/png')
        return '.png';
    if (normalized === 'image/webp')
        return '.webp';
    if (normalized === 'image/gif')
        return '.gif';
    if (normalized === 'application/pdf')
        return '.pdf';
    if (normalized === 'video/mp4')
        return '.mp4';
    if (normalized === 'audio/mpeg')
        return '.mp3';
    return '';
};
const assetOutputFilename = ({ assetsRelDir, label, contentType, index, }) => {
    const safeDir = String(assetsRelDir || 'assets')
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => safeAssetPathPart(part, 'assets'))
        .join('/');
    let basename = safeAssetPathPart(label, `asset-${String(index + 1).padStart(2, '0')}`);
    if (!/\.[a-z0-9]{2,8}$/i.test(basename))
        basename += extensionForContentType(contentType);
    return `${safeDir}/${basename}`;
};
const uniqueAssetOutputFilename = (filename, usedFilenames) => {
    const normalized = filename.replace(/\\/g, '/');
    const normalizedKey = normalized.toLowerCase();
    if (!usedFilenames.has(normalizedKey)) {
        usedFilenames.add(normalizedKey);
        return normalized;
    }
    const slashIndex = normalized.lastIndexOf('/');
    const dir = slashIndex >= 0 ? `${normalized.slice(0, slashIndex + 1)}` : '';
    const basename = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
    const extensionMatch = basename.match(/(\.[a-z0-9]{2,8})$/i);
    const extension = extensionMatch?.[1] || '';
    const stem = extension ? basename.slice(0, -extension.length) : basename;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
        const candidate = `${dir}${stem}-${String(suffix).padStart(2, '0')}${extension}`;
        const candidateKey = candidate.toLowerCase();
        if (usedFilenames.has(candidateKey))
            continue;
        usedFilenames.add(candidateKey);
        return candidate;
    }
    throw new Error('Nao consegui gerar nome unico para asset da API privada.');
};
const base64FromArrayBuffer = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
};
const fetchSnapshotAssets = async ({ snapshot, fetchImpl, timeoutMs, assetsRelDir, }) => {
    const plan = buildAssetFetchPlan(assetRefsFromChatSnapshot(snapshot));
    const mediaFiles = [];
    const mediaFailures = [];
    const usedFilenames = new Set();
    for (const [index, request] of plan.requests.entries()) {
        try {
            const response = await fetchWithTimeout(fetchImpl, request.url, { credentials: 'include' }, timeoutMs);
            if (!response.ok) {
                mediaFailures.push({
                    refId: request.refId,
                    url: request.url,
                    label: request.label,
                    error: 'asset_fetch_http_error',
                    status: response.status,
                });
                continue;
            }
            const contentType = response.headers?.get('content-type') || null;
            const buffer = await readResponseArrayBufferWithTimeout(response, timeoutMs);
            const filename = uniqueAssetOutputFilename(assetOutputFilename({
                assetsRelDir,
                label: request.label,
                contentType,
                index,
            }), usedFilenames);
            mediaFiles.push({
                filename,
                contentBase64: base64FromArrayBuffer(buffer),
                contentType,
                bytes: buffer.byteLength,
                sourceUrl: request.url,
                refId: request.refId,
            });
        }
        catch (err) {
            mediaFailures.push({
                refId: request.refId,
                url: request.url,
                label: request.label,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { mediaFiles, mediaFailures };
};
export const readGeminiPrivateChat = async ({ chatId: rawChatId, title, fetchImpl = fetch, requestId = Date.now() % 100000, markdownRenderer = createBrowserSafeMarkdownRenderer(), timeoutMs: rawTimeoutMs, downloadAssets = false, assetsRelDir, }) => {
    const chatId = parseChatId(rawChatId);
    if (!chatId) {
        return failure('invalid_private_chat_id', 'Identidade de chat invalida para leitura pela API privada.', null);
    }
    try {
        const timeoutMs = normalizeTimeoutMs(rawTimeoutMs, 30_000);
        const app = await fetchGeminiAppSession(fetchImpl, timeoutMs);
        if (!app.ok) {
            return failure('private_api_app_fetch_failed', 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.', chatId, app.response.status);
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return failure('google_verification_required', 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.', chatId, app.response.status);
        }
        const session = app.session;
        if (!session.at) {
            return failure('private_api_token_missing', 'A pagina autenticada do Gemini nao trouxe o token necessario para READ_CHAT.', chatId);
        }
        const request = buildGeminiPrivateBatchRequest({
            rpcId: GEMINI_PRIVATE_RPC.READ_CHAT,
            payload: buildGeminiPrivateReadChatPayload(chatId),
            session,
            requestId,
            sourcePath: '/app',
        });
        const rpcResponse = await fetchWithTimeout(fetchImpl, request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            credentials: 'include',
        }, timeoutMs);
        if (!rpcResponse.ok) {
            return failure('private_api_rpc_fetch_failed', 'O endpoint privado READ_CHAT respondeu com erro HTTP.', chatId, rpcResponse.status);
        }
        const rpcText = await readResponseTextWithTimeout(rpcResponse, timeoutMs);
        if (looksLikeGoogleVerificationHtml(rpcText)) {
            return failure('google_verification_required', 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.', chatId, rpcResponse.status);
        }
        const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
        if (decoded.parseableFrameCount === 0) {
            return failure('private_api_wire_format_changed', 'O endpoint privado READ_CHAT respondeu em um formato que nao conseguimos decodificar.', chatId, rpcResponse.status, summarizeDecodeDiagnostics(decoded));
        }
        const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.READ_CHAT);
        if (!payload.ok) {
            return failure('private_api_rpc_empty', 'O endpoint privado READ_CHAT respondeu sem corpo de conversa.', chatId, payload.status, summarizeDecodeDiagnostics(decoded));
        }
        const snapshot = normalizeGeminiPrivateReadChatSnapshot({
            requestedChatId: chatId,
            payload,
            title: title || undefined,
            markdownRenderer,
        });
        const media = downloadAssets
            ? await fetchSnapshotAssets({
                snapshot,
                fetchImpl,
                timeoutMs,
                assetsRelDir: assetsRelDir || `assets/${chatId}`,
            })
            : { mediaFiles: [], mediaFailures: [] };
        return {
            ok: true,
            snapshot,
            markdown: renderChatSnapshotMarkdown({ snapshot }),
            transport: {
                source: 'extension-background-fetch',
                appStatus: app.response.status,
                rpcStatus: payload.status,
            },
            mediaFiles: media.mediaFiles,
            mediaFailures: media.mediaFailures,
            adapterPlan: privateApiAdapterPlan(),
        };
    }
    catch (err) {
        return failure('private_api_request_failed', requestFailureMessage(err), chatId);
    }
};
export const listGeminiPrivateChats = async ({ fetchImpl = fetch, requestId = Date.now() % 100000, limit = 200, timeoutMs: rawTimeoutMs, } = {}) => {
    try {
        const timeoutMs = normalizeTimeoutMs(rawTimeoutMs, 30_000);
        const app = await fetchGeminiAppSession(fetchImpl, timeoutMs);
        if (!app.ok) {
            return listFailure('private_api_app_fetch_failed', 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.', app.response.status);
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return listFailure('google_verification_required', 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.', app.response.status);
        }
        const session = app.session;
        if (!session.at) {
            return listFailure('private_api_token_missing', 'A pagina autenticada do Gemini nao trouxe o token necessario para LIST_CHATS.');
        }
        const groups = [];
        const statuses = [];
        for (const source of [1, 0]) {
            const request = buildGeminiPrivateBatchRequest({
                rpcId: GEMINI_PRIVATE_RPC.LIST_CHATS,
                payload: buildGeminiPrivateListChatsPayload({ limit, source }),
                session,
                requestId: requestId + source,
                sourcePath: '/app',
            });
            const rpcResponse = await fetchWithTimeout(fetchImpl, request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                credentials: 'include',
            }, timeoutMs);
            statuses.push(rpcResponse.status);
            if (!rpcResponse.ok) {
                return listFailure('private_api_rpc_fetch_failed', 'O endpoint privado LIST_CHATS respondeu com erro HTTP.', rpcResponse.status);
            }
            const rpcText = await readResponseTextWithTimeout(rpcResponse, timeoutMs);
            if (looksLikeGoogleVerificationHtml(rpcText)) {
                return listFailure('google_verification_required', 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.', rpcResponse.status);
            }
            const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
            if (decoded.parseableFrameCount === 0) {
                return listFailure('private_api_wire_format_changed', 'O endpoint privado LIST_CHATS respondeu em um formato que nao conseguimos decodificar.', rpcResponse.status, summarizeDecodeDiagnostics(decoded));
            }
            const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.LIST_CHATS);
            if (payload.ok)
                groups.push(listChatsFromPayload(payload));
        }
        const chats = mergeListChats(groups);
        return {
            ok: true,
            chats,
            count: chats.length,
            transport: {
                source: 'extension-background-fetch',
                appStatus: app.response.status,
                rpcStatuses: statuses,
            },
            adapterPlan: privateApiAdapterPlan(),
        };
    }
    catch (err) {
        return listFailure('private_api_request_failed', requestFailureMessage(err));
    }
};
export const checkGeminiPrivateSession = async ({ fetchImpl = fetch, timeoutMs: rawTimeoutMs, } = {}) => {
    try {
        const timeoutMs = normalizeTimeoutMs(rawTimeoutMs, 20_000);
        const app = await fetchGeminiAppSession(fetchImpl, timeoutMs);
        if (!app.ok) {
            return sessionFailure('private_api_app_fetch_failed', 'Nao consegui carregar a pagina autenticada do Gemini.', app.response.status);
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return sessionFailure('google_verification_required', 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.', app.response.status);
        }
        if (!app.session.at) {
            return sessionFailure('private_api_token_missing', 'A sessao do navegador nao trouxe o token privado do Gemini.');
        }
        return {
            ok: true,
            authenticated: true,
            transport: {
                source: 'extension-background-fetch',
                appStatus: app.response.status,
            },
            adapterPlan: privateApiAdapterPlan(),
        };
    }
    catch (err) {
        return sessionFailure('private_api_request_failed', requestFailureMessage(err));
    }
};
