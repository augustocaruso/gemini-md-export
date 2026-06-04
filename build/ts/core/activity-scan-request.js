export const metadataActivityScanTimeoutMs = (value = process.env.GEMINI_MD_EXPORT_ACTIVITY_SCAN_TIMEOUT_MS) => {
    const configured = Number(value || 90000);
    return Number.isFinite(configured) && configured > 0 ? Math.max(1000, configured) : 90000;
};
export const requestMetadataActivityScan = async ({ bridgeUrl, candidates, resume = null, openIfMissing = true, timeoutMs = metadataActivityScanTimeoutMs(), fetchImpl = fetch, }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(`${bridgeUrl}/agent/activity-scan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                candidates: candidates.map((candidate) => ({
                    chatId: candidate.chatId,
                    title: candidate.scoring.title,
                    firstPrompt: candidate.scoring.firstPrompt,
                    lastPrompt: candidate.scoring.lastPrompt,
                    firstAssistant: candidate.scoring.firstAssistant,
                    lastAssistant: candidate.scoring.lastAssistant,
                    assistantSamples: candidate.scoring.assistantSamples,
                })),
                resume: resume || null,
                openIfMissing,
                openDetails: true,
            }),
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};
        if (!response.ok || payload.ok === false) {
            const err = new Error(payload.nextAction || payload.error || `Bridge retornou HTTP ${response.status}`);
            Object.assign(err, { code: payload.code || null });
            throw err;
        }
        return payload;
    }
    catch (err) {
        if (err.name === 'AbortError') {
            const timeoutError = new Error(`My Activity demorou mais de ${Math.round(timeoutMs / 1000)}s para responder.`);
            Object.assign(timeoutError, {
                code: 'activity_scan_timeout',
                timeoutMs,
            });
            throw timeoutError;
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
};
