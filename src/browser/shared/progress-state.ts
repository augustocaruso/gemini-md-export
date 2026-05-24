export type ProgressStateLike = {
  total?: number | null;
  current?: number | null;
  completed?: number | null;
  position?: number | null;
  phase?: string | null;
  status?: string | null;
};

export const SHARED_PROGRESS_CREEP_MAX_FRACTION = 0.85;

const finiteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const progressTotal = (progress: ProgressStateLike | null | undefined): number =>
  Math.max(finiteNumber(progress?.total, 1), 1);

export const sharedProgressBarCurrent = (
  progress: ProgressStateLike | null | undefined,
): number => {
  const total = progressTotal(progress);
  const status = progress?.status || '';
  if (status === 'completed' || status === 'completed_with_errors') return total;
  const raw = finiteNumber(progress?.current ?? progress?.completed ?? 0, 0);
  return Math.max(0, Math.min(raw, total));
};

export const sharedComputeProgressMilestone = (
  progress: ProgressStateLike | null | undefined,
): { base: number; next: number } => {
  const total = progressTotal(progress);
  const current = sharedProgressBarCurrent(progress);
  return {
    base: (current / total) * 100,
    next: (Math.min(current + 1, total) / total) * 100,
  };
};

export const sharedProgressCreepCeiling = (
  progress: ProgressStateLike | null | undefined,
): number => {
  const { base, next } = sharedComputeProgressMilestone(progress);
  if (!sharedShouldRunProgressCreep(progress)) return base;
  return base + (next - base) * SHARED_PROGRESS_CREEP_MAX_FRACTION;
};

export const sharedShouldRunProgressCreep = (
  progress: ProgressStateLike | null | undefined,
): boolean => {
  if (!progress) return false;
  const total = progressTotal(progress);
  const status = progress.status || '';
  if (status === 'completed' || status === 'completed_with_errors') return false;
  if (status === 'failed' || status === 'cancelled') return false;

  const current = sharedProgressBarCurrent(progress);
  if (current >= total) return false;

  if (total > 1) return true;

  const position = finiteNumber(progress.position, 0);
  const completed = finiteNumber(progress.completed, 0);
  if (position > 0 || current > 0 || completed > 0) return true;

  const phase = String(progress.phase || '').toLowerCase();
  return (
    phase.includes('export') ||
    phase.includes('hidrata') ||
    phase.includes('navega') ||
    phase.includes('writing') ||
    phase.includes('escrit') ||
    phase.includes('salv')
  );
};

export const sharedNormalizeProgressDisplayPercent = ({
  previousProgress = null,
  nextProgress,
  previousDisplayPercent = 0,
}: {
  previousProgress?: ProgressStateLike | null;
  nextProgress: ProgressStateLike;
  previousDisplayPercent?: number | null;
}): number => {
  const previousTotal = progressTotal(previousProgress);
  const nextTotal = progressTotal(nextProgress);
  const previousCurrent = sharedProgressBarCurrent(previousProgress);
  const nextCurrent = sharedProgressBarCurrent(nextProgress);
  const { base } = sharedComputeProgressMilestone(nextProgress);
  const previousDisplay = finiteNumber(previousDisplayPercent, 0);
  const ceiling = sharedProgressCreepCeiling(nextProgress);
  const totalChanged = previousTotal !== nextTotal;
  const placeholderExpanded = previousTotal <= 1 && nextTotal > previousTotal;
  const realProgressRegressed = nextCurrent < previousCurrent;
  const displayPastNewMilestone = previousDisplay > base + 3;

  if (
    placeholderExpanded ||
    realProgressRegressed ||
    (totalChanged && nextCurrent === 0 && displayPastNewMilestone) ||
    (totalChanged && displayPastNewMilestone)
  ) {
    return base;
  }

  return Math.min(Math.max(previousDisplay, base), ceiling);
};
