import { canonicalGeminiChatUrl, parseChatId } from './chat-id.js';
import { portableIsoSeconds } from './date.js';
import { hashText } from './text-hash.js';
export const GEMINI_PRIVATE_BATCH_ENDPOINT = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
export const GEMINI_PRIVATE_RPC = {
    LIST_CHATS: 'MaZiqc',
    READ_CHAT: 'hNvQHb',
};
const PRIVATE_CHAT_ID_RE = /^c_([a-f0-9]{12,})$/i;
export const toGeminiPrivateChatId = (value) => {
    const text = String(value ?? '').trim();
    const prefixed = text.match(PRIVATE_CHAT_ID_RE)?.[1];
    const chatId = parseChatId(prefixed || text);
    return chatId ? `c_${chatId}` : null;
};
const stripGeminiPrivateChatId = (value) => {
    const text = String(value ?? '').trim();
    const prefixed = text.match(PRIVATE_CHAT_ID_RE)?.[1];
    return parseChatId(prefixed || text);
};
export const buildGeminiPrivateReadChatPayload = (chatId, limit = 10) => {
    const privateChatId = toGeminiPrivateChatId(chatId);
    if (!privateChatId)
        throw new Error(`invalid_private_chat_id:${String(chatId || '')}`);
    return [privateChatId, limit, null, 1, [1], [4], null, 1];
};
export const buildGeminiPrivateListChatsPayload = ({ limit = 10, cursor = null, source = 0, } = {}) => [limit, null, [source, cursor, 1]];
export const buildGeminiPrivateBatchRequest = ({ rpcId, payload, session, requestId = 1, sourcePath = '/app', }) => {
    const url = new URL(GEMINI_PRIVATE_BATCH_ENDPOINT);
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('hl', session.hl || 'en');
    url.searchParams.set('_reqid', String(requestId));
    url.searchParams.set('rt', 'c');
    url.searchParams.set('source-path', sourcePath);
    if (session.bl)
        url.searchParams.set('bl', session.bl);
    if (session.fSid)
        url.searchParams.set('f.sid', session.fSid);
    const body = new URLSearchParams();
    body.set('at', session.at);
    body.set('f.req', JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]));
    return {
        method: 'POST',
        url: url.toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Same-Domain': '1',
        },
        body: body.toString(),
    };
};
const uniqueWarnings = (warnings) => [...new Set(warnings)];
export const decodeGeminiBatchExecuteResponseWithDiagnostics = (raw) => {
    const frames = [];
    let malformedLineCount = 0;
    const warnings = [];
    const frameLines = String(raw || '')
        .replace(/^\)\]\}'\s*/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('[') || line.startsWith('{'));
    for (const line of frameLines) {
        try {
            frames.push(JSON.parse(line));
        }
        catch {
            malformedLineCount += 1;
            warnings.push('malformed_json_frame');
        }
    }
    if (frameLines.length === 0)
        warnings.push('no_json_frames');
    return {
        frames,
        parseableFrameCount: frames.length,
        malformedLineCount,
        warnings: uniqueWarnings(warnings),
    };
};
export const decodeGeminiBatchExecuteResponse = (raw) => decodeGeminiBatchExecuteResponseWithDiagnostics(raw).frames;
const parseRpcBody = (value) => {
    if (typeof value !== 'string')
        return value;
    if (!value.trim())
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};
const rpcStatus = (entry) => {
    const status = entry[5];
    if (Array.isArray(status) && Number.isFinite(Number(status[0])))
        return Number(status[0]);
    return null;
};
export const extractGeminiBatchRpcPayload = (frames, rpcId) => {
    for (const frame of frames) {
        if (!Array.isArray(frame))
            continue;
        for (const entry of frame) {
            if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== rpcId)
                continue;
            const body = parseRpcBody(entry[2]);
            return {
                ok: body !== null,
                rpcId,
                body,
                status: rpcStatus(entry),
                raw: entry,
            };
        }
    }
    return { ok: false, rpcId, body: null, status: null, raw: null };
};
const walk = (value, visit) => {
    visit(value);
    if (Array.isArray(value)) {
        for (const child of value)
            walk(child, visit);
        return;
    }
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            walk(child, visit);
    }
};
export const extractGeminiPrivateListChatIds = (payload) => {
    const body = isBatchPayload(payload) ? payload.body : payload;
    const seen = new Set();
    const output = [];
    walk(body, (item) => {
        if (typeof item !== 'string')
            return;
        const privateChatId = toGeminiPrivateChatId(item);
        const chatId = stripGeminiPrivateChatId(item);
        if (!privateChatId || !chatId || seen.has(privateChatId))
            return;
        seen.add(privateChatId);
        output.push({ privateChatId, chatId });
    });
    return output;
};
const isBatchPayload = (value) => Boolean(value && typeof value === 'object' && 'body' in value && 'rpcId' in value);
const looksLikeHtmlFragment = (value) => /<\/?[a-z][\s\S]*>/i.test(value) && /[<>]/.test(value);
const renderTextLeaf = (value, renderer) => {
    const text = value.trim();
    if (!text)
        return '';
    if (!renderer)
        return text;
    return renderer.render({
        format: looksLikeHtmlFragment(text) ? 'html' : 'text',
        value: text,
    });
};
const collectTextLeaves = (value, output = [], renderer) => {
    if (typeof value === 'string') {
        const text = renderTextLeaf(value, renderer).trim();
        if (text)
            output.push(text);
        return output;
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            collectTextLeaves(child, output, renderer);
        }
    }
    return output;
};
const textAt = (value, renderer) => collectTextLeaves(value, [], renderer).join('\n\n');
const PRIVATE_ASSET_URL_RE = /^https:\/\/[^\s]+googleusercontent\.com\/\S+$/i;
const PRIVATE_ASSET_FILENAME_RE = /^[^\s\\/][\s\S]*\.(?:png|jpe?g|gif|webp|heic|heif|bmp|svg|pdf|mp4|mov|webm|mp3|wav|m4a|aac|txt|csv|json|docx?|xlsx?|pptx?)$/i;
const PRIVATE_ASSET_MIME_RE = /^[a-z]+\/[-+.\w]+$/i;
const isPrivateAssetUrl = (value) => typeof value === 'string' && PRIVATE_ASSET_URL_RE.test(value.trim());
const isPrivateAssetFilename = (value) => typeof value === 'string' && PRIVATE_ASSET_FILENAME_RE.test(value.trim());
const isPrivateAssetMime = (value) => typeof value === 'string' && PRIVATE_ASSET_MIME_RE.test(value.trim());
const attachmentKindFromMimeOrFilename = (mime, filename) => {
    const normalizedMime = String(mime || '').toLowerCase();
    if (normalizedMime.startsWith('image/'))
        return 'image';
    if (normalizedMime.startsWith('video/'))
        return 'video';
    if (normalizedMime.startsWith('audio/'))
        return 'audio';
    if (normalizedMime)
        return 'document';
    if (/\.(?:png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i.test(filename))
        return 'image';
    if (/\.(?:mp4|mov|webm)$/i.test(filename))
        return 'video';
    if (/\.(?:mp3|wav|m4a|aac)$/i.test(filename))
        return 'audio';
    return 'document';
};
const extractPrivateAssetTextBlocks = (markdown) => {
    const parts = markdown
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0)
        return { markdown: '', attachments: [] };
    const cleanParts = [];
    const attachments = [];
    const seen = new Set();
    let index = 0;
    while (index < parts.length) {
        const filename = parts[index];
        const url = parts[index + 1];
        if (isPrivateAssetFilename(filename) && isPrivateAssetUrl(url)) {
            let nextIndex = index + 2;
            if (String(parts[nextIndex] || '').startsWith('$'))
                nextIndex += 1;
            const mime = isPrivateAssetMime(parts[nextIndex]) ? parts[nextIndex] : null;
            if (mime)
                nextIndex += 1;
            const dedupeKey = `${filename}\n${url}`;
            if (!seen.has(dedupeKey)) {
                seen.add(dedupeKey);
                attachments.push({
                    kind: attachmentKindFromMimeOrFilename(mime, filename),
                    label: filename,
                    url,
                });
            }
            index = nextIndex;
            continue;
        }
        cleanParts.push(parts[index]);
        index += 1;
    }
    return {
        markdown: cleanParts.join('\n\n'),
        attachments,
    };
};
const candidateText = (candidate, renderer) => {
    if (!Array.isArray(candidate))
        return '';
    return textAt(candidate[1], renderer) || textAt(candidate[22], renderer);
};
const candidateListFromTurn = (turn) => {
    const candidateContainer = Array.isArray(turn[3]) ? turn[3][0] : null;
    if (!Array.isArray(candidateContainer))
        return [];
    return Array.isArray(candidateContainer[0]) ? candidateContainer : [candidateContainer];
};
const primaryAssistantCandidate = (turn, renderer) => {
    const candidates = candidateListFromTurn(turn);
    return (candidates.find((candidate) => candidateText(candidate, renderer).trim()) ||
        candidates.find((candidate) => artifactAttachments(candidate).length > 0) ||
        null);
};
const artifactAttachments = (candidate) => {
    if (!Array.isArray(candidate) || candidate[12] === null || candidate[12] === undefined) {
        return [];
    }
    return [
        {
            kind: 'artifact',
            label: 'Gemini artifact',
            assetRefId: `private-api-artifact:${hashText(JSON.stringify(candidate[12]))}`,
        },
    ];
};
const isoFromPrivateEpoch = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    for (const divisor of [1, 1_000, 1_000_000]) {
        const seconds = value / divisor;
        if (seconds >= 946_684_800 && seconds <= 4_102_444_800) {
            return portableIsoSeconds(seconds * 1_000);
        }
    }
    return null;
};
const turnCreatedAt = (turn) => Array.isArray(turn[4]) ? isoFromPrivateEpoch(turn[4][0]) : null;
const turnDateRange = (turns) => {
    const dates = turns
        .map((turn) => turn.createdAt)
        .filter((date) => Boolean(date))
        .sort();
    if (dates.length === 0)
        return {};
    return {
        dateCreated: dates[0],
        dateLastMessage: dates.at(-1),
    };
};
const turnPairsFromBody = (body, renderer) => {
    const turns = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
    const output = [];
    for (const turn of turns) {
        if (!Array.isArray(turn))
            continue;
        const user = extractPrivateAssetTextBlocks(textAt(turn[2], renderer));
        const candidate = primaryAssistantCandidate(turn, renderer);
        const assistant = extractPrivateAssetTextBlocks(candidateText(candidate, renderer));
        if (!user.markdown && !assistant.markdown)
            continue;
        output.push({
            createdAt: turnCreatedAt(turn),
            user: user.markdown,
            userAttachments: user.attachments,
            assistant: assistant.markdown,
            assistantAttachments: [...assistant.attachments, ...artifactAttachments(candidate)],
        });
    }
    return output;
};
const snapshotEvidence = (markdown, warnings = []) => ({
    source: 'gemini-private-api',
    kind: 'read_chat_private_api',
    confidence: markdown.trim() ? 'strong' : 'missing',
    textHash: markdown ? hashText(markdown) : undefined,
    sampleLength: markdown.length,
    warnings,
});
export const normalizeGeminiPrivateReadChatSnapshot = ({ requestedChatId, payload, title, markdownRenderer, }) => {
    const chatId = stripGeminiPrivateChatId(requestedChatId);
    if (!chatId)
        throw new Error(`invalid_private_chat_id:${String(requestedChatId || '')}`);
    const body = isBatchPayload(payload) ? payload.body : payload;
    const pairs = turnPairsFromBody(body, markdownRenderer);
    const turns = [];
    pairs.forEach((pair, index) => {
        if (pair.user) {
            turns.push({
                role: 'user',
                markdown: pair.user,
                textHash: hashText(pair.user),
                sourceOrder: index * 2,
                attachments: pair.userAttachments,
                ...(pair.createdAt ? { createdAt: pair.createdAt } : {}),
            });
        }
        if (pair.assistant) {
            turns.push({
                role: 'assistant',
                markdown: pair.assistant,
                textHash: hashText(pair.assistant),
                sourceOrder: index * 2 + 1,
                attachments: pair.assistantAttachments,
                ...(pair.createdAt ? { createdAt: pair.createdAt } : {}),
            });
        }
    });
    const assistantMarkdown = turns
        .filter((turn) => turn.role === 'assistant')
        .map((turn) => turn.markdown)
        .join('\n\n');
    return {
        chatId,
        title: title || String(chatId),
        url: canonicalGeminiChatUrl(chatId),
        turns,
        metadata: {
            assistantTurnCount: turns.filter((turn) => turn.role === 'assistant').length,
            ...turnDateRange(turns),
        },
        evidence: [snapshotEvidence(assistantMarkdown)],
    };
};
