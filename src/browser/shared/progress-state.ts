import {
  buildProgressViewModel,
  normalizeProgressDisplayPercent,
  progressCreepCeiling,
} from '../../core/progress-view-model.js';

export type ProgressStateLike = {
  total?: number | null;
  current?: number | null;
  completed?: number | null;
  position?: number | null;
  phase?: string | null;
  status?: string | null;
};

export const SHARED_PROGRESS_CREEP_MAX_FRACTION = 0.85;

export const sharedProgressBarCurrent = (
  progress: ProgressStateLike | null | undefined,
): number => {
  const view = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: progress?.status || 'running',
    phase: progress?.phase || null,
    current: progress?.current ?? progress?.completed ?? 0,
    completed: progress?.completed ?? null,
    total: progress?.total ?? 1,
    position: progress?.position ?? null,
  });
  return view.current;
};

export const sharedComputeProgressMilestone = (
  progress: ProgressStateLike | null | undefined,
): { base: number; next: number } => {
  const view = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: progress?.status || 'running',
    phase: progress?.phase || null,
    current: progress?.current ?? progress?.completed ?? 0,
    completed: progress?.completed ?? null,
    total: progress?.total ?? 1,
    position: progress?.position ?? null,
  });
  return {
    base: view.percent,
    next: Math.min(100, (Math.min(view.current + 1, view.total) / Math.max(1, view.total)) * 100),
  };
};

export const sharedProgressCreepCeiling = (
  progress: ProgressStateLike | null | undefined,
): number => {
  const view = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: progress?.status || 'running',
    phase: progress?.phase || null,
    current: progress?.current ?? progress?.completed ?? 0,
    completed: progress?.completed ?? null,
    total: progress?.total ?? 1,
    position: progress?.position ?? null,
  });
  return progressCreepCeiling(view);
};

export const sharedShouldRunProgressCreep = (
  progress: ProgressStateLike | null | undefined,
): boolean => sharedProgressCreepCeiling(progress) > sharedComputeProgressMilestone(progress).base;

export const sharedNormalizeProgressDisplayPercent = ({
  previousProgress = null,
  nextProgress,
  previousDisplayPercent = 0,
}: {
  previousProgress?: ProgressStateLike | null;
  nextProgress: ProgressStateLike;
  previousDisplayPercent?: number | null;
}): number => {
  const previous = previousProgress
    ? buildProgressViewModel({
        sourceKind: 'gui-export',
        status: previousProgress.status || 'running',
        phase: previousProgress.phase || null,
        current: previousProgress.current ?? previousProgress.completed ?? 0,
        completed: previousProgress.completed ?? null,
        total: previousProgress.total ?? 1,
        position: previousProgress.position ?? null,
        displayPercent: previousDisplayPercent,
      })
    : null;
  const next = buildProgressViewModel({
    sourceKind: 'gui-export',
    status: nextProgress.status || 'running',
    phase: nextProgress.phase || null,
    current: nextProgress.current ?? nextProgress.completed ?? 0,
    completed: nextProgress.completed ?? null,
    total: nextProgress.total ?? 1,
    position: nextProgress.position ?? null,
  });
  return normalizeProgressDisplayPercent(previous, next, previousDisplayPercent ?? 0);
};
