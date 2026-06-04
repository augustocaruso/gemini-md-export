import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import { buildGeminiPrivateBatchRequest, buildGeminiPrivateListChatsPayload, buildGeminiPrivateReadChatPayload, decodeGeminiBatchExecuteResponseWithDiagnostics, extractGeminiBatchRpcPayload, GEMINI_PRIVATE_RPC, normalizeGeminiPrivateReadChatSnapshot, } from '../../core/gemini-private-protocol.js';
import { extractGeminiPrivateSessionFields, looksLikeGoogleVerificationHtml, } from '../../core/gemini-private-session.js';
const normalizeContentPrivateTimeoutMs = (value, fallbackMs) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return fallbackMs;
    return Math.max(1, Math.min(120_000, numeric));
};
const timeoutError = () => Object.assign(new Error('Tempo esgotado ao consultar a API privada do Gemini.'), {
    name: 'AbortError',
});
const contentPrivateWithTimeout = async (promise, timeoutMs, onTimeout) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        try {
            onTimeout?.();
        }
        catch {
            // Ignore abort races.
        }
        reject(timeoutError());
    }, timeoutMs);
    promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
    }, (err) => {
        clearTimeout(timer);
        reject(err);
    });
});
const contentPrivateFetchWithTimeout = async (fetchImpl, url, init, timeoutMs) => {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    return contentPrivateWithTimeout(fetchImpl(url, {
        ...(init || {}),
        ...(controller ? { signal: controller.signal } : {}),
    }), timeoutMs, () => controller?.abort());
};
const contentPrivateReadTextWithTimeout = (response, timeoutMs) => contentPrivateWithTimeout(response.text(), timeoutMs);
const contentPrivateRequestFailureMessage = (err) => {
    if (err instanceof Error && err.name === 'AbortError') {
        return 'Tempo esgotado ao consultar a API privada do Gemini.';
    }
    return err instanceof Error ? err.message : String(err);
};
const markdownRoleHeading = (role) => role === 'user' ? '## 🧑 Usuário' : '## 🤖 Gemini';
const renderSnapshotMarkdownInContent = (snapshot) => {
    const frontmatter = typeof buildFrontmatter === 'function'
        ? buildFrontmatter({
            chatId: snapshot.chatId,
            title: snapshot.title,
            url: snapshot.url,
            turnCount: snapshot.metadata?.assistantTurnCount,
        })
        : `---\ntype: gemini_chat\nchat_id: ${snapshot.chatId}\ntitle: "${snapshot.title}"\nurl: ${snapshot.url}\ntags: [gemini-export]\n---\n\n`;
    const body = snapshot.turns
        .slice()
        .sort((left, right) => left.sourceOrder - right.sourceOrder)
        .map((turn) => `${markdownRoleHeading(turn.role)}\n\n${String(turn.markdown || '').trim()}`)
        .join('\n\n---\n\n');
    return `${frontmatter}${body.trim()}\n`;
};
const fetchAppSessionInContent = async (fetchImpl, timeoutMs) => {
    const response = await contentPrivateFetchWithTimeout(fetchImpl, 'https://gemini.google.com/app', { credentials: 'include' }, timeoutMs);
    if (!response.ok)
        return { ok: false, response, html: '', session: null };
    const html = await contentPrivateReadTextWithTimeout(response, timeoutMs);
    return {
        ok: true,
        response,
        html,
        session: extractGeminiPrivateSessionFields(html),
    };
};
const contentPrivateTimestampToIso = (value) => {
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
                updatedAt: contentPrivateTimestampToIso(item[5]),
            },
        ];
    });
};
const mergeContentPrivateChats = (groups) => {
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
export const checkGeminiPrivateSessionFromContent = async ({ fetchImpl = fetch, timeoutMs: rawTimeoutMs, } = {}) => {
    try {
        const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 20_000);
        const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
        if (!app.ok) {
            return {
                ok: false,
                authenticated: false,
                code: 'private_api_app_fetch_failed',
                message: 'Nao consegui carregar a pagina autenticada do Gemini.',
                status: app.response.status,
            };
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return {
                ok: false,
                authenticated: false,
                code: 'google_verification_required',
                message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
                status: app.response.status,
            };
        }
        if (!app.session.at) {
            return {
                ok: false,
                authenticated: false,
                code: 'private_api_token_missing',
                message: 'A sessao do navegador nao trouxe o token privado do Gemini.',
            };
        }
        return {
            ok: true,
            authenticated: true,
            transport: { source: 'content-fetch', appStatus: app.response.status, rpcStatus: null },
        };
    }
    catch (err) {
        return {
            ok: false,
            authenticated: false,
            code: 'private_api_request_failed',
            message: contentPrivateRequestFailureMessage(err),
        };
    }
};
export const readGeminiPrivateChatFromContent = async ({ chatId: rawChatId, title, fetchImpl = fetch, requestId = Date.now() % 100000, timeoutMs: rawTimeoutMs, }) => {
    const chatId = parseChatId(rawChatId);
    if (!chatId) {
        return {
            ok: false,
            code: 'invalid_private_chat_id',
            message: 'Identidade de chat invalida para leitura pela API privada.',
            chatId: null,
        };
    }
    try {
        const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 30_000);
        const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
        if (!app.ok) {
            return {
                ok: false,
                code: 'private_api_app_fetch_failed',
                message: 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
                chatId,
                status: app.response.status,
            };
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return {
                ok: false,
                code: 'google_verification_required',
                message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
                chatId,
                status: app.response.status,
            };
        }
        if (!app.session.at) {
            return {
                ok: false,
                code: 'private_api_token_missing',
                message: 'A pagina autenticada do Gemini nao trouxe o token necessario para READ_CHAT.',
                chatId,
            };
        }
        const request = buildGeminiPrivateBatchRequest({
            rpcId: GEMINI_PRIVATE_RPC.READ_CHAT,
            payload: buildGeminiPrivateReadChatPayload(chatId),
            session: app.session,
            requestId,
            sourcePath: '/app',
        });
        const rpcResponse = await contentPrivateFetchWithTimeout(fetchImpl, request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            credentials: 'include',
        }, timeoutMs);
        if (!rpcResponse.ok) {
            return {
                ok: false,
                code: 'private_api_rpc_fetch_failed',
                message: 'O endpoint privado READ_CHAT respondeu com erro HTTP.',
                chatId,
                status: rpcResponse.status,
            };
        }
        const rpcText = await contentPrivateReadTextWithTimeout(rpcResponse, timeoutMs);
        if (looksLikeGoogleVerificationHtml(rpcText)) {
            return {
                ok: false,
                code: 'google_verification_required',
                message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
                chatId,
                status: rpcResponse.status,
            };
        }
        const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
        if (decoded.parseableFrameCount === 0) {
            return {
                ok: false,
                code: 'private_api_wire_format_changed',
                message: 'O endpoint privado READ_CHAT respondeu em um formato que nao conseguimos decodificar.',
                chatId,
                status: rpcResponse.status,
            };
        }
        const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.READ_CHAT);
        if (!payload.ok) {
            return {
                ok: false,
                code: 'private_api_rpc_empty',
                message: 'O endpoint privado READ_CHAT respondeu sem corpo de conversa.',
                chatId,
                status: payload.status,
            };
        }
        const snapshot = normalizeGeminiPrivateReadChatSnapshot({
            requestedChatId: chatId,
            payload,
            title: title || undefined,
        });
        return {
            ok: true,
            snapshot,
            markdown: renderSnapshotMarkdownInContent(snapshot),
            transport: {
                source: 'content-fetch',
                appStatus: app.response.status,
                rpcStatus: payload.status,
            },
        };
    }
    catch (err) {
        return {
            ok: false,
            code: 'private_api_request_failed',
            message: contentPrivateRequestFailureMessage(err),
            chatId,
        };
    }
};
export const listGeminiPrivateChatsFromContent = async ({ fetchImpl = fetch, requestId = Date.now() % 100000, limit = 200, timeoutMs: rawTimeoutMs, } = {}) => {
    try {
        const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 30_000);
        const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
        if (!app.ok) {
            return {
                ok: false,
                code: 'private_api_app_fetch_failed',
                message: 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
                status: app.response.status,
            };
        }
        if (looksLikeGoogleVerificationHtml(app.html)) {
            return {
                ok: false,
                code: 'google_verification_required',
                message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
                status: app.response.status,
            };
        }
        if (!app.session.at) {
            return {
                ok: false,
                code: 'private_api_token_missing',
                message: 'A pagina autenticada do Gemini nao trouxe o token necessario para LIST_CHATS.',
            };
        }
        const groups = [];
        const statuses = [];
        for (const source of [1, 0]) {
            const request = buildGeminiPrivateBatchRequest({
                rpcId: GEMINI_PRIVATE_RPC.LIST_CHATS,
                payload: buildGeminiPrivateListChatsPayload({ limit, source }),
                session: app.session,
                requestId: requestId + source,
                sourcePath: '/app',
            });
            const rpcResponse = await contentPrivateFetchWithTimeout(fetchImpl, request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                credentials: 'include',
            }, timeoutMs);
            statuses.push(rpcResponse.status);
            if (!rpcResponse.ok) {
                return {
                    ok: false,
                    code: 'private_api_rpc_fetch_failed',
                    message: 'O endpoint privado LIST_CHATS respondeu com erro HTTP.',
                    status: rpcResponse.status,
                };
            }
            const rpcText = await contentPrivateReadTextWithTimeout(rpcResponse, timeoutMs);
            if (looksLikeGoogleVerificationHtml(rpcText)) {
                return {
                    ok: false,
                    code: 'google_verification_required',
                    message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
                    status: rpcResponse.status,
                };
            }
            const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
            const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.LIST_CHATS);
            if (payload.ok)
                groups.push(listChatsFromPayload(payload));
        }
        const chats = mergeContentPrivateChats(groups);
        return {
            ok: true,
            chats,
            count: chats.length,
            transport: { source: 'content-fetch', appStatus: app.response.status, rpcStatuses: statuses },
        };
    }
    catch (err) {
        return {
            ok: false,
            code: 'private_api_request_failed',
            message: contentPrivateRequestFailureMessage(err),
        };
    }
};
