export type ProgressStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ProgressMode = 'determinate' | 'indeterminate';

export type ProgressSurface = 'gui' | 'tui' | 'plain' | 'jsonl';

export type ProgressSourceKind =
  | 'export-job'
  | 'gui-export'
  | 'activity-scan'
  | 'fix-vault'
  | 'ready'
  | 'count';

export type ProgressCounts = {
  downloaded?: number | null;
  skipped?: number | null;
  failed?: number | null;
  warnings?: number | null;
  webSeen?: number | null;
  existing?: number | null;
  missing?: number | null;
};

export type ProgressCurrentItem = {
  title?: string | null;
  chatId?: string | null;
};

export type ProgressViewInput = {
  sourceKind: ProgressSourceKind;
  status?: string | null;
  phase?: string | null;
  title?: string | null;
  label?: string | null;
  statusLabel?: string | null;
  current?: number | null;
  total?: number | null;
  completed?: number | null;
  position?: number | null;
  displayCurrent?: number | null;
  barCurrent?: number | null;
  percent?: number | null;
  displayPercent?: number | null;
  mode?: ProgressMode | null;
  countLabel?: string | null;
  currentItem?: ProgressCurrentItem | null;
  counts?: ProgressCounts | null;
  warnings?: string[] | null;
};

export type ProgressViewModel = {
  sourceKind: ProgressSourceKind;
  status: ProgressStatus;
  phase: string | null;
  mode: ProgressMode;
  title: string;
  label: string;
  statusLabel: string;
  current: number;
  total: number;
  displayCurrent: number;
  barCurrent: number;
  percent: number;
  displayPercent: number;
  terminal: boolean;
  successful: boolean;
  failed: boolean;
  countLabel: string;
  currentItem: ProgressCurrentItem | null;
  counts: Required<ProgressCounts>;
  warnings: string[];
};

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

const finiteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const normalizeStatus = (status: unknown): ProgressStatus => {
  if (
    status === 'idle' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'cancel_requested' ||
    status === 'completed' ||
    status === 'completed_with_errors' ||
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return 'running';
};

const progressTotal = (value: unknown): number => Math.max(0, finiteNumber(value, 0));

const safeDeterminateTotal = (value: unknown): number => Math.max(1, finiteNumber(value, 1));

const statusLabelFor = (status: ProgressStatus, phase: string | null): string => {
  if (status === 'completed') return 'Concluido';
  if (status === 'completed_with_errors') return 'Concluido com avisos';
  if (status === 'failed') return 'Falhou';
  if (status === 'cancelled') return 'Cancelado';
  if (status === 'cancel_requested') return 'Cancelando';
  if (phase === 'loading-history') return 'Carregando historico';
  if (phase === 'scanning-vault') return 'Comparando vault';
  if (phase === 'loading-metadata') return 'Indexando datas';
  if (phase === 'resolving-metadata') return 'Conferindo datas';
  if (phase === 'exporting') return 'Exportando';
  if (phase === 'writing-report') return 'Finalizando';
  return 'Preparando';
};

const normalizedCounts = (counts: ProgressCounts | null | undefined): Required<ProgressCounts> => ({
  downloaded: finiteNumber(counts?.downloaded, 0),
  skipped: finiteNumber(counts?.skipped, 0),
  failed: finiteNumber(counts?.failed, 0),
  warnings: finiteNumber(counts?.warnings, 0),
  webSeen: counts?.webSeen == null ? null : finiteNumber(counts.webSeen, 0),
  existing: counts?.existing == null ? null : finiteNumber(counts.existing, 0),
  missing: counts?.missing == null ? null : finiteNumber(counts.missing, 0),
});

const isTerminal = (status: ProgressStatus): boolean => TERMINAL_STATUSES.has(status);

const percentFor = ({
  status,
  current,
  total,
  mode,
}: {
  status: ProgressStatus;
  current: number;
  total: number;
  mode: ProgressMode;
}): number => {
  if (status === 'completed' || status === 'completed_with_errors') return 100;
  if (mode === 'indeterminate' || total <= 0) return 0;
  return Math.round(clamp((current / safeDeterminateTotal(total)) * 100, 0, 100));
};

export const buildProgressViewModel = (input: ProgressViewInput): ProgressViewModel => {
  const status = normalizeStatus(input.status);
  const phase = input.phase || null;
  const rawTotal = progressTotal(input.total);
  const mode = input.mode || (rawTotal > 0 ? 'determinate' : 'indeterminate');
  const total = mode === 'determinate' ? safeDeterminateTotal(rawTotal) : 0;
  const terminal = isTerminal(status);
  const baseCurrent =
    status === 'completed' || status === 'completed_with_errors'
      ? total
      : clamp(finiteNumber(input.current ?? input.completed, 0), 0, total || Number.MAX_SAFE_INTEGER);
  const current = mode === 'determinate' ? clamp(baseCurrent, 0, total) : Math.max(0, baseCurrent);
  const displayCurrent =
    input.displayCurrent == null
      ? current
      : mode === 'determinate'
        ? clamp(finiteNumber(input.displayCurrent, current), 0, total)
        : Math.max(0, finiteNumber(input.displayCurrent, current));
  const barCurrent =
    input.barCurrent == null
      ? current
      : mode === 'determinate'
        ? clamp(finiteNumber(input.barCurrent, current), 0, total)
        : Math.max(0, finiteNumber(input.barCurrent, current));
  const percent = input.percent == null ? percentFor({ status, current, total, mode }) : clamp(finiteNumber(input.percent, 0), 0, 100);
  const displayPercent =
    input.displayPercent == null
      ? percent
      : clamp(finiteNumber(input.displayPercent, percent), 0, 100);
  const counts = normalizedCounts(input.counts);

  const countLabel =
    input.countLabel ||
    (input.sourceKind === 'count' && counts.webSeen != null && counts.webSeen > 0
      ? `${counts.webSeen} encontradas`
      : '');

  return {
    sourceKind: input.sourceKind,
    status,
    phase,
    mode,
    title: input.title || '',
    label: input.label || '',
    statusLabel: input.statusLabel || statusLabelFor(status, phase),
    current,
    total,
    displayCurrent,
    barCurrent,
    percent,
    displayPercent,
    terminal,
    successful: status === 'completed' || status === 'completed_with_errors',
    failed: status === 'failed' || status === 'cancelled',
    countLabel,
    currentItem: input.currentItem || null,
    counts,
    warnings: Array.isArray(input.warnings) ? input.warnings.map(String) : [],
  };
};

const jobTotals = (job: Record<string, any>): Required<ProgressCounts> => {
  const decision = job.decisionSummary || {};
  const totals = decision.totals || {};
  return normalizedCounts({
    downloaded: totals.downloadedNow ?? job.successCount ?? 0,
    skipped: totals.skipped ?? job.skippedCount ?? 0,
    failed: totals.failed ?? job.failureCount ?? 0,
    warnings: totals.mediaWarnings ?? 0,
    webSeen: totals.geminiWebSeen ?? job.webConversationCount ?? job.loadedCount ?? null,
    existing: totals.existingInVault ?? job.existingVaultCount ?? null,
    missing: totals.missingInVault ?? job.missingCount ?? null,
  });
};

const loadedConversationCount = (job: Record<string, any>, counts: Required<ProgressCounts>): number | null => {
  for (const value of [
    job.knownLoadedCount,
    job.minimumKnownCount,
    job.loadedCount,
    job.webConversationCount,
    counts.webSeen,
  ]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const indeterminateCountLabel = (job: Record<string, any>, counts: Required<ProgressCounts>): string => {
  const loaded = loadedConversationCount(job, counts);
  if (loaded !== null && loaded > 0) return `${loaded} encontradas`;
  if (job.tuiKind === 'count') return 'procurando conversas';
  return 'trabalhando';
};

export const buildExportJobProgressViewModel = (job: Record<string, any>): ProgressViewModel => {
  const counts = jobTotals(job);
  const total = finiteNumber(job.requested ?? job.missingCount ?? job.webConversationCount, 0);
  const status = normalizeStatus(job.status);
  const phase = typeof job.phase === 'string' ? job.phase : null;
  const terminal = isTerminal(status);
  const completed = Math.max(0, finiteNumber(job.completed, 0));
  const currentIndex = Math.max(0, finiteNumber(job.current?.index ?? job.position, 0));
  const mode =
    total > 0 &&
    !['queued', 'loading-history', 'scanning-vault', 'loading-metadata', 'resolving-metadata'].includes(
      String(phase || ''),
    )
      ? 'determinate'
      : 'indeterminate';
  const current = total > 0 ? (terminal ? Math.min(completed, total) : Math.min(completed, total)) : completed;
  const displayCurrent =
    total > 0 && !terminal && phase === 'exporting'
      ? Math.min(total, Math.max(completed + 1, currentIndex, 1))
      : current;
  const barCurrent =
    total > 0 && !terminal && phase === 'exporting'
      ? Math.min(total - 0.02, completed + 0.62)
      : current;
  const currentItem =
    job.current?.title || job.current?.chatId
      ? { title: job.current.title || null, chatId: job.current.chatId || null }
      : null;

  return buildProgressViewModel({
    sourceKind: job.sourceKind || 'export-job',
    status,
    phase,
    mode,
    title: 'Gemini Markdown Export',
    label: job.progressMessage || job.decisionSummary?.headline || 'Sincronizando...',
    current,
    total,
    displayCurrent,
    barCurrent,
    countLabel: total > 0 ? `${Math.min(displayCurrent, total)}/${total}` : indeterminateCountLabel(job, counts),
    currentItem,
    counts,
  });
};

export const buildGuiExportProgressViewModel = (progress: Record<string, any>): ProgressViewModel =>
  buildProgressViewModel({
    sourceKind: 'gui-export',
    status: progress.status || 'running',
    phase: progress.phase || null,
    title: progress.title || 'Baixando conversas',
    label: progress.label || 'Baixando conversas...',
    current: progress.current ?? progress.completed ?? 0,
    completed: progress.completed,
    total: progress.total ?? 1,
    position: progress.position,
    displayPercent: progress.displayPercent,
    currentItem:
      progress.title || progress.chatId || progress.currentChatId
        ? {
            title: progress.title || null,
            chatId: progress.currentChatId || progress.chatId || null,
          }
        : null,
    counts: { failed: progress.errorCount ?? 0 },
  });

export const buildActivityProgressViewModel = (progress: Record<string, any>): ProgressViewModel => {
  const candidateTotal = Math.max(0, finiteNumber(progress.candidateTotal, 0));
  const resolved = Math.max(0, finiteNumber(progress.resolvedCount, 0));
  const scanned = Math.max(0, finiteNumber(progress.scannedCardCount, 0));
  const loaded = Math.max(scanned, finiteNumber(progress.loadedCardCount, 0));
  const maxCards = Math.max(1, finiteNumber(progress.maxCards || loaded || 1, 1));
  const rawStatus = normalizeStatus(progress.status || 'running');
  const pending = Math.max(0, candidateTotal - Math.min(resolved, candidateTotal));
  const status = rawStatus === 'completed' && pending > 0 ? 'failed' : rawStatus;
  let label = `${scanned} itens lidos`;
  if (status === 'completed') label = 'Todas as datas encontradas';
  else if (rawStatus === 'completed' && pending > 0) label = `${pending} pendente(s)`;
  else if (status === 'failed') label = rawStatus === 'completed' && pending > 0 ? `${pending} pendente(s)` : 'Falhou';
  else if (loaded > scanned) label = `${scanned} itens lidos · ${loaded} carregados`;
  const total = candidateTotal > 0 ? candidateTotal : maxCards;
  const current = candidateTotal > 0 ? Math.min(resolved, candidateTotal) : scanned;

  return buildProgressViewModel({
    sourceKind: 'activity-scan',
    status,
    phase: 'activity-scan',
    title: 'Identificando chats',
    label,
    current,
    total,
    countLabel: candidateTotal > 0 ? `${Math.min(resolved, candidateTotal)} de ${candidateTotal}` : '',
  });
};

export const buildFixVaultProgressViewModel = ({
  current,
  total,
  message,
}: {
  current: number;
  total: number;
  message: string;
}): ProgressViewModel =>
  buildProgressViewModel({
    sourceKind: 'fix-vault',
    status: 'running',
    phase: 'fix-vault',
    title: 'Fix vault',
    label: message,
    current,
    total,
    countLabel: `${current}/${total}`,
  });

const ordinalFor = (view: ProgressViewModel): number => Math.max(view.displayCurrent, view.current, view.barCurrent);

export const mergeProgressViewModel = (
  previous: ProgressViewModel | null | undefined,
  next: ProgressViewModel,
): ProgressViewModel => {
  if (!previous) return next;
  if (next.terminal) return next;
  if (previous.sourceKind !== next.sourceKind) return next;
  if (previous.total > next.total) {
    return {
      ...next,
      total: previous.total,
      current: Math.max(previous.current, next.current),
      displayCurrent: Math.max(previous.displayCurrent, next.displayCurrent),
      barCurrent: Math.max(previous.barCurrent, next.barCurrent),
      label: previous.label || next.label,
      currentItem: previous.currentItem || next.currentItem,
    };
  }
  if (ordinalFor(next) < ordinalFor(previous)) return previous;
  return next;
};

const shouldRunProgressCreep = (view: ProgressViewModel): boolean => {
  if (view.terminal || view.failed) return false;
  if (view.mode === 'indeterminate') return false;
  if (view.current >= view.total) return false;
  if (view.total > 1) return true;
  const phase = String(view.phase || '').toLowerCase();
  return (
    view.displayCurrent > 0 ||
    phase.includes('export') ||
    phase.includes('hidrata') ||
    phase.includes('navega') ||
    phase.includes('writing') ||
    phase.includes('escrit') ||
    phase.includes('salv')
  );
};

export const progressCreepCeiling = (view: ProgressViewModel): number => {
  if (!shouldRunProgressCreep(view)) return view.percent;
  const next = Math.min(100, ((Math.min(view.current + 1, view.total) / safeDeterminateTotal(view.total)) * 100));
  return view.percent + (next - view.percent) * 0.85;
};

export const normalizeProgressDisplayPercent = (
  previous: ProgressViewModel | null | undefined,
  next: ProgressViewModel,
  previousDisplayPercent = previous?.displayPercent ?? 0,
): number => {
  if (next.status === 'completed' || next.status === 'completed_with_errors') return 100;
  const previousTotal = previous?.total ?? 1;
  const previousCurrent = previous?.current ?? 0;
  const previousDisplay = finiteNumber(previousDisplayPercent, 0);
  const ceiling = progressCreepCeiling(next);
  const totalChanged = previousTotal !== next.total;
  const placeholderExpanded = previousTotal <= 1 && next.total > previousTotal;
  const realProgressRegressed = next.current < previousCurrent;
  const displayPastNewMilestone = previousDisplay > next.percent + 3;

  if (
    placeholderExpanded ||
    realProgressRegressed ||
    (totalChanged && next.current === 0 && displayPastNewMilestone) ||
    (totalChanged && displayPastNewMilestone)
  ) {
    return next.percent;
  }

  return Math.min(Math.max(previousDisplay, next.percent), ceiling);
};
