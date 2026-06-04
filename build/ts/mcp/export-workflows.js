import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import { portableIsoSeconds } from '../core/date.js';
import { assistantTurnCount, sectionsForRole } from '../core/markdown-note.js';
import { hashText } from '../core/text-hash.js';
import { parseFrontmatter } from '../core/yaml.js';
export const validateExportTabLease = (tab) => {
    const value = tab;
    const tabId = Number(value?.tabId);
    const url = stringValue(value?.url);
    const claimId = stringValue(value?.claimId);
    if (!claimId || !Number.isInteger(tabId) || !url.startsWith('https://gemini.google.com/')) {
        throw Object.assign(new Error('claimed_debuggable_tab_required'), {
            code: 'claimed_debuggable_tab_required',
        });
    }
    return { claimId, tabId, url, visual: value?.visual || null };
};
export const exportTabLeaseFromNativeClaimResult = (result) => {
    const value = result;
    return {
        ...(value?.tab || value || {}),
        visual: value?.visual || value?.tab?.visual || null,
    };
};
const markdownContentOf = (payload = {}) => {
    if (typeof payload.content === 'string')
        return payload.content;
    if (typeof payload.contentBase64 === 'string') {
        return Buffer.from(payload.contentBase64, 'base64').toString('utf-8');
    }
    return '';
};
const evidence = (kind, confidence, markdown, warnings = []) => ({
    source: 'chat-dom',
    kind,
    confidence,
    textHash: markdown ? hashText(markdown) : undefined,
    sampleLength: markdown.length,
    warnings,
});
const blocked = (code, message, markdown, extras = {}) => ({
    ok: false,
    code,
    message,
    evidence: [evidence(code, 'missing', markdown, [message])],
    ...extras,
});
const stringValue = (value) => value === null || value === undefined ? '' : String(value);
const turnRoleOf = (turn) => {
    const role = stringValue(turn?.role).toLowerCase();
    if (role === 'user' || role === 'assistant')
        return role;
    return null;
};
const turnMarkdownOf = (turn) => {
    const value = turn;
    return stringValue(value?.markdown || value?.text || value?.content).trim();
};
const turnsFromPayload = (turns) => {
    if (!Array.isArray(turns))
        return [];
    return turns
        .map((turn, index) => {
        const role = turnRoleOf(turn);
        const markdown = turnMarkdownOf(turn);
        if (!role || !markdown)
            return null;
        return {
            role,
            markdown,
            textHash: hashText(markdown),
            sourceOrder: index,
            attachments: [],
        };
    })
        .filter((turn) => turn !== null);
};
const turnsFromMarkdownBody = (body) => {
    const userTurns = sectionsForRole(body, 'user').map((markdown, index) => ({
        role: 'user',
        markdown,
        textHash: hashText(markdown),
        sourceOrder: index * 2,
        attachments: [],
    }));
    const assistantTurns = sectionsForRole(body, 'assistant').map((markdown, index) => ({
        role: 'assistant',
        markdown,
        textHash: hashText(markdown),
        sourceOrder: index * 2 + 1,
        attachments: [],
    }));
    return [...userTurns, ...assistantTurns].sort((a, b) => a.sourceOrder - b.sourceOrder);
};
const parseChatIdFromFilename = (filename) => {
    const text = stringValue(filename).replace(/\.md$/i, '');
    return parseChatId(text);
};
export const validateMcpExportPayloadBeforeWrite = (payload = {}, input = {}) => {
    const markdown = markdownContentOf(payload);
    if (!markdown.trim()) {
        return blocked('empty_chat', 'Exportacao abortada: a extensao nao retornou Markdown para salvar. Nenhum arquivo foi salvo.', markdown);
    }
    const parsed = parseFrontmatter(markdown);
    const expectedChatId = parseChatId(input.expectedChatId);
    const requestedChatId = parseChatId(input.requestedChatId);
    const payloadChatId = parseChatId(payload.chatId);
    const frontmatterChatId = parseChatId(parsed.data.chat_id || parsed.data.url);
    const urlChatId = parseChatId(payload.url || parsed.data.url);
    const filenameChatId = parseChatIdFromFilename(payload.filename);
    const observedChatId = payloadChatId || frontmatterChatId || urlChatId || filenameChatId;
    if (!observedChatId) {
        return blocked('identity_unproven', 'Exportacao abortada: a extensao nao retornou um chatId comprovado. Nenhum arquivo foi salvo.', markdown, {
            requestedChatId: stringValue(input.expectedChatId || input.requestedChatId) || undefined,
        });
    }
    const expected = expectedChatId || requestedChatId;
    if (expected && expected !== observedChatId) {
        return blocked('chat_id_mismatch', `Exportacao abortada: o browser retornou o chat ${observedChatId}, mas o MCP pediu ${expected}. Nenhum arquivo foi salvo.`, markdown, {
            requestedChatId: expected,
            observedChatId,
        });
    }
    for (const candidate of [frontmatterChatId, urlChatId, filenameChatId].filter(Boolean)) {
        if (candidate !== observedChatId) {
            return blocked('chat_id_mismatch', `Exportacao abortada: os metadados retornados pela extensao misturam chats diferentes (${observedChatId} e ${candidate}). Nenhum arquivo foi salvo.`, markdown, {
                requestedChatId: expected || undefined,
                observedChatId,
            });
        }
    }
    const bodyAssistantTurns = assistantTurnCount(parsed.body);
    const metricTurnCount = Number(payload.metrics?.counters?.turnCount);
    const declaredTurnCount = Number(parsed.data.turn_count);
    const assistantCount = bodyAssistantTurns || (Number.isFinite(metricTurnCount) ? metricTurnCount : 0);
    if (assistantCount <= 0) {
        return blocked('empty_chat', `Exportacao abortada: a conversa ${observedChatId} nao tem resposta do Gemini no Markdown retornado. Nenhum arquivo foi salvo.`, markdown, {
            requestedChatId: expected || undefined,
            observedChatId,
        });
    }
    const warnings = [];
    if (Number.isFinite(declaredTurnCount) && declaredTurnCount !== bodyAssistantTurns) {
        warnings.push('turn_count_frontmatter_differs_from_body');
    }
    if (Number.isFinite(metricTurnCount) && metricTurnCount !== bodyAssistantTurns) {
        warnings.push('turn_count_metric_differs_from_body');
    }
    const turns = turnsFromPayload(payload.turns);
    const snapshotTurns = turns.length > 0 ? turns : turnsFromMarkdownBody(parsed.body);
    const markdownHash = hashText(markdown);
    const sanitizedEvidence = [
        evidence('mcp_export_payload_integrity', 'strong', markdown, warnings),
    ];
    return {
        ok: true,
        snapshot: {
            chatId: observedChatId,
            title: stringValue(payload.title || parsed.data.title || observedChatId),
            url: stringValue(payload.url || parsed.data.url || canonicalGeminiChatUrl(observedChatId)),
            turns: snapshotTurns,
            metadata: {
                model: parsed.data.model ? stringValue(parsed.data.model) : undefined,
                dateCreated: portableIsoSeconds(parsed.data.date_created) || undefined,
                dateLastMessage: portableIsoSeconds(parsed.data.date_last_message) || undefined,
                dateExported: portableIsoSeconds(parsed.data.date_exported || parsed.data.exported_at) || undefined,
                assistantTurnCount: bodyAssistantTurns,
            },
            evidence: sanitizedEvidence,
        },
        markdownHash,
        assistantTurnCount: bodyAssistantTurns,
        evidence: sanitizedEvidence,
        warnings,
    };
};
