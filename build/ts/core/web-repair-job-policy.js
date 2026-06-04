export const WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT = 3;
export const WEB_REPAIR_BLOCKED_EXIT_CODE = 2;
export const WEB_REPAIR_PREFLIGHT_STALL_MS = 90_000;
export const isGeminiWebChatUnavailableFailure = (failure) => {
    const error = String(failure?.error || '');
    return (/Timeout aguardando chat\b/i.test(error) && /chat=nenhum/i.test(error) && /turns=0/i.test(error));
};
export const webRepairUnavailableFromJobStatus = (status) => {
    const successCount = Number(status?.successCount || 0);
    if (successCount > 0)
        return null;
    const failures = (status?.failures || []).filter(Boolean);
    if (failures.length < WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT)
        return null;
    const checked = failures.slice(0, WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT);
    if (!checked.every(isGeminiWebChatUnavailableFailure))
        return null;
    return {
        code: 'gemini_web_chats_unavailable',
        message: 'O Gemini Web desta conta nao abriu os primeiros chats que precisavam de reparo.',
        nextAction: 'Use uma sessao do navegador logada na conta dona desses chats ou repare esses raw exports por outra fonte antes de escrever datas.',
        checkedFailures: checked.length,
        failedChatIds: checked.map((failure) => String(failure.chatId || '')).filter(Boolean),
    };
};
export const webRepairStalledFromJobStatus = (status, stalledMs, stallLimitMs = WEB_REPAIR_PREFLIGHT_STALL_MS) => {
    const successCount = Number(status?.successCount || 0);
    const failureCount = Number(status?.failureCount || 0);
    const completed = Number(status?.completed || 0);
    if (successCount > 0 || failureCount > 0 || completed > 0)
        return null;
    if (!status?.current?.chatId)
        return null;
    if (stalledMs < stallLimitMs)
        return null;
    const chatId = String(status.current.chatId);
    return {
        code: 'gemini_web_repair_stalled',
        message: 'O reparo pelo Gemini Web ficou sem progresso no primeiro chat suspeito.',
        nextAction: 'Verifique se a aba Gemini desta conta consegue abrir esse chat; o fluxo bloqueou antes de escrever datas.',
        checkedFailures: 0,
        failedChatIds: [chatId],
    };
};
export const webRepairExitCodeForStatusCounts = ({ failed = 0, unavailable = null, }) => {
    if (unavailable || failed > 0)
        return WEB_REPAIR_BLOCKED_EXIT_CODE;
    return 0;
};
export const webRepairHasExplicitTarget = (options) => Boolean(options.claimId || options.clientId || (options.tabId !== null && options.tabId !== undefined));
export const buildWebRepairExplicitTargetStatus = (options) => ({
    ready: true,
    explicitTarget: {
        claimId: options.claimId || null,
        clientId: options.clientId || null,
        tabId: options.tabId ?? null,
    },
    globalReadinessSkipped: true,
});
export const webRepairTargetRequestArgs = (options) => ({
    claimId: options.claimId || undefined,
    clientId: options.clientId || undefined,
    tabId: options.tabId ?? undefined,
    sessionId: options.sessionId || undefined,
    activateTab: options.activateTab === true,
});
const TERMINAL_JOB_STATUSES = new Set([
    'completed',
    'completed_with_errors',
    'failed',
    'cancelled',
]);
const cancelExportJob = async ({ bridgeUrl, jobId, callMcpTool, }) => {
    try {
        return await callMcpTool({
            bridgeUrl,
            name: 'gemini_job',
            args: { action: 'cancel', jobId },
        });
    }
    catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
};
const waitForCancelledExportJob = async ({ bridgeUrl, jobId, pollMs, callMcpTool, sleep, }) => {
    const deadline = Date.now() + 10000;
    let lastStatus = null;
    while (Date.now() <= deadline) {
        lastStatus = await callMcpTool({
            bridgeUrl,
            name: 'gemini_job',
            args: { action: 'status', jobId },
        });
        if (TERMINAL_JOB_STATUSES.has(lastStatus.status))
            return lastStatus;
        await sleep(pollMs);
    }
    return lastStatus;
};
export const pollWebRepairExportJob = async ({ bridgeUrl, jobId, pollMs, timeoutMs, preflightStallMs = WEB_REPAIR_PREFLIGHT_STALL_MS, callMcpTool, sleep, }) => {
    const startedAt = Date.now();
    let status = null;
    let lastProgressKey = '';
    let lastProgressAt = startedAt;
    while (Date.now() - startedAt <= timeoutMs) {
        status = await callMcpTool({
            bridgeUrl,
            name: 'gemini_job',
            args: { action: 'status', jobId },
        });
        if (TERMINAL_JOB_STATUSES.has(status.status))
            return status;
        const progressKey = [
            status.completed || 0,
            status.successCount || 0,
            status.failureCount || 0,
            status.current?.index || 0,
            status.current?.chatId || '',
        ].join(':');
        if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            lastProgressAt = Date.now();
        }
        const unavailable = webRepairUnavailableFromJobStatus(status) ||
            webRepairStalledFromJobStatus(status, Date.now() - lastProgressAt, preflightStallMs);
        if (unavailable) {
            const cancelStatus = await cancelExportJob({ bridgeUrl, jobId, callMcpTool });
            const terminalStatus = await waitForCancelledExportJob({
                bridgeUrl,
                jobId,
                pollMs,
                callMcpTool,
                sleep,
            });
            return {
                ...(terminalStatus || status),
                webRepairUnavailable: unavailable,
                cancelStatus,
            };
        }
        await sleep(pollMs);
    }
    throw new Error(`Timeout aguardando job de reexportacao ${jobId}.`);
};
