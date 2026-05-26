type ExportJobLike = {
  status?: string | null;
  phase?: string | null;
  cancelRequested?: boolean;
  cancelledAt?: string | null;
  current?: unknown;
  finishedAt?: string | null;
  [key: string]: unknown;
};

const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export type FinishedExportJobStatusNormalization = {
  changed: boolean;
  fromStatus: string | null;
  status: string | null;
  reason: string | null;
};

export const normalizeFinishedExportJobStatus = (
  job: ExportJobLike | null | undefined,
  options: { nowIso?: string } = {},
): FinishedExportJobStatusNormalization => {
  if (!job || typeof job !== 'object') {
    return { changed: false, fromStatus: null, status: null, reason: null };
  }

  const fromStatus = typeof job.status === 'string' && job.status ? job.status : null;
  const shouldCancel =
    fromStatus === 'cancel_requested' ||
    (job.cancelRequested === true && !TERMINAL_STATUSES.has(fromStatus || ''));

  if (!shouldCancel) {
    return { changed: false, fromStatus, status: fromStatus, reason: null };
  }

  job.cancelRequested = true;
  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.current = null;
  job.cancelledAt = job.cancelledAt || options.nowIso || new Date().toISOString();

  return {
    changed: true,
    fromStatus,
    status: 'cancelled',
    reason: fromStatus === 'cancel_requested' ? 'pending-cancel-at-finish' : 'cancel-requested-at-finish',
  };
};

export const markExportJobFinishedForReport = (
  job: ExportJobLike,
  options: {
    nowIso?: string;
    clearFields?: string[];
    appendTrace?(job: ExportJobLike, event: string, payload: FinishedExportJobStatusNormalization): void;
    touch?(job: ExportJobLike): void;
  } = {},
) => {
  for (const field of options.clearFields || []) {
    job[field] = null;
  }

  const finishedAt = options.nowIso || new Date().toISOString();
  const statusNormalization = normalizeFinishedExportJobStatus(job, { nowIso: finishedAt });
  if (statusNormalization.changed) {
    options.appendTrace?.(job, 'job_status_normalized_at_finish', statusNormalization);
  }
  job.finishedAt = finishedAt;
  options.touch?.(job);
  return { finishedAt, statusNormalization };
};
