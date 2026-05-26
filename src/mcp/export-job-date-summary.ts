type AnyRecord = Record<string, any>;

export type DateImportIssueCounts = {
  matched: number;
  partial: number;
  unresolved: number;
  pending: number;
};

const nonNegativeNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

const scanDateImportStatuses = (items: unknown[]): Omit<DateImportIssueCounts, 'pending'> => {
  const counts = {
    matched: 0,
    partial: 0,
    unresolved: 0,
  };
  for (const item of items) {
    const status = (item as AnyRecord | null | undefined)?.dateImport?.status;
    if (status === 'matched') counts.matched += 1;
    if (status === 'partial') counts.partial += 1;
    if (status === 'unresolved') counts.unresolved += 1;
  }
  return counts;
};

const richestDateImportItems = (job: AnyRecord): unknown[] => {
  const successes = Array.isArray(job.successes) ? job.successes : [];
  const conversations = Array.isArray(job.metrics?.conversations) ? job.metrics.conversations : [];
  const recentSuccesses = Array.isArray(job.recentSuccesses) ? job.recentSuccesses : [];
  return [successes, conversations, recentSuccesses].sort((a, b) => b.length - a.length)[0] || [];
};

export const dateImportIssueCountsForJob = (job: AnyRecord = {}): DateImportIssueCounts => {
  const counters = job.metrics?.counters || {};
  let matched = nonNegativeNumber(counters.dateImportMatched);
  let partial = nonNegativeNumber(counters.dateImportPartial);
  let unresolved = nonNegativeNumber(counters.dateImportUnresolved);

  const scanned = scanDateImportStatuses(richestDateImportItems(job));
  matched = Math.max(matched, scanned.matched);
  partial = Math.max(partial, scanned.partial);
  unresolved = Math.max(unresolved, scanned.unresolved);

  return {
    matched,
    partial,
    unresolved,
    pending: partial + unresolved,
  };
};

export const metadataDateWarningsForJob = (job: AnyRecord = {}): string[] => {
  if (job.dateImport?.enabled !== true) return [];
  const counts = dateImportIssueCountsForJob(job);
  const warnings: string[] = [];
  if (counts.unresolved > 0) {
    warnings.push(
      `${counts.unresolved} conversa${counts.unresolved === 1 ? '' : 's'} ` +
        `${counts.unresolved === 1 ? 'ficou' : 'ficaram'} sem datas no Takeout/My Activity.`,
    );
  }
  if (counts.partial > 0) {
    warnings.push(
      `${counts.partial} conversa${counts.partial === 1 ? '' : 's'} ` +
        `${counts.partial === 1 ? 'ficou' : 'ficaram'} com datas incompletas no Takeout/My Activity.`,
    );
  }
  return warnings;
};
