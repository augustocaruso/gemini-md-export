type AnyRecord = Record<string, unknown>;

type DateImportTotals = {
  matched: number;
  partial: number;
  unresolved: number;
  pending: number;
};

const recordValue = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};

const countValue = (value: unknown): number => Math.max(0, Number(value) || 0);

const dateImportTotals = (value: unknown): DateImportTotals | null => {
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) return null;
  const partial = countValue(raw.partial);
  const unresolved = countValue(raw.unresolved);
  return {
    matched: countValue(raw.matched),
    partial,
    unresolved,
    pending: countValue(raw.pending ?? partial + unresolved),
  };
};

export const summarizeJobTotals = (job: AnyRecord = {}) => {
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
