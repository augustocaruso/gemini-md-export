const recordValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const countValue = (value) => Math.max(0, Number(value) || 0);
const dateImportTotals = (value) => {
    const raw = recordValue(value);
    if (Object.keys(raw).length === 0)
        return null;
    const partial = countValue(raw.partial);
    const unresolved = countValue(raw.unresolved);
    return {
        matched: countValue(raw.matched),
        partial,
        unresolved,
        pending: countValue(raw.pending ?? partial + unresolved),
    };
};
export const summarizeJobTotals = (job = {}) => {
    const decision = recordValue(job.decisionSummary);
    const totals = recordValue(decision.totals);
    const dateImport = dateImportTotals(totals.dateImport);
    const mediaWarnings = countValue(totals.mediaWarnings);
    const summaryWarnings = Array.isArray(decision.warnings) ? decision.warnings.length : 0;
    return {
        downloaded: countValue(totals.downloadedNow ?? job.successCount),
        failed: countValue(totals.failed ?? job.failureCount),
        skipped: countValue(totals.skipped ?? job.skippedCount),
        warnings: Math.max(mediaWarnings + (dateImport?.pending || 0), summaryWarnings),
        webSeen: totals.geminiWebSeen ?? job.webConversationCount ?? job.loadedCount ?? null,
        existing: totals.existingInVault ?? job.existingVaultCount ?? null,
        missing: totals.missingInVault ?? job.missingCount ?? null,
        dateImport,
    };
};
