export type ProgressStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type ProgressSnapshot = {
  title: string;
  label: string;
  current: number;
  total: number;
  status: ProgressStatus;
};

type ProgressPortOptions = {
  dockId: string;
  initialTitle?: string;
  documentRef: Document;
  isDarkTheme?: () => boolean;
  ensureDock: (options: {
    dockId: string;
    initialTitle?: string;
    documentRef: Document;
  }) => HTMLElement;
  applyTheme: (dock: HTMLElement, options: { dark: boolean }) => void;
  getElements: (options: { dockId: string; documentRef: Document }) => {
    titleEl: HTMLElement | null;
    countEl: HTMLElement | null;
    labelEl: HTMLElement | null;
    barEl: HTMLElement | null;
  };
  setVisible: (dock: HTMLElement, visible: boolean) => void;
};

export type ProgressPort = {
  begin: (snapshot: ProgressSnapshot) => void;
  update: (patch: Partial<ProgressSnapshot>) => void;
  finish: (patch?: Partial<ProgressSnapshot>) => void;
  hide: () => void;
  snapshot: () => ProgressSnapshot | null;
};

const clampPercent = (current: number, total: number, status: ProgressStatus): number => {
  if (status === 'completed' || status === 'completed_with_errors') return 100;
  const safeTotal = Math.max(1, Number(total) || 1);
  return Math.max(
    0,
    Math.min(100, Math.round((Math.max(0, Number(current) || 0) / safeTotal) * 100)),
  );
};

const isDoneStatus = (status: ProgressStatus): boolean =>
  status === 'completed' || status === 'completed_with_errors';

export const createSharedProgressPort = (options: ProgressPortOptions): ProgressPort => {
  let current: ProgressSnapshot | null = null;

  const render = () => {
    const dock = options.ensureDock({
      dockId: options.dockId,
      initialTitle: options.initialTitle || '',
      documentRef: options.documentRef,
    });
    if (!current) {
      options.setVisible(dock, false);
      dock.classList.remove('gm-dock-done');
      return;
    }

    options.applyTheme(dock, { dark: options.isDarkTheme?.() === true });
    const { titleEl, countEl, labelEl, barEl } = options.getElements({
      dockId: options.dockId,
      documentRef: options.documentRef,
    });
    const safeTotal = Math.max(1, Number(current.total) || 1);
    const safeCurrent = Math.max(0, Number(current.current) || 0);
    if (titleEl) titleEl.textContent = current.title;
    if (countEl)
      countEl.textContent =
        current.total > 0 ? `${Math.min(safeCurrent, safeTotal)} de ${safeTotal}` : '';
    if (labelEl) labelEl.textContent = current.label;
    if (barEl) barEl.style.width = `${clampPercent(safeCurrent, safeTotal, current.status)}%`;
    if (isDoneStatus(current.status)) dock.classList.add('gm-dock-done');
    else dock.classList.remove('gm-dock-done');
    options.setVisible(dock, true);
  };

  return {
    begin(snapshot) {
      current = { ...snapshot };
      render();
    },
    update(patch) {
      current = {
        title: patch.title || current?.title || options.initialTitle || '',
        label: patch.label || current?.label || '',
        current: patch.current ?? current?.current ?? 0,
        total: patch.total ?? current?.total ?? 1,
        status: patch.status || current?.status || 'running',
      };
      render();
    },
    finish(patch = {}) {
      const total = patch.total ?? current?.total ?? 1;
      current = {
        title: patch.title || current?.title || options.initialTitle || '',
        label: patch.label || current?.label || 'Concluido',
        current: patch.current ?? total,
        total,
        status: patch.status || current?.status || 'completed',
      };
      render();
    },
    hide() {
      current = null;
      render();
    },
    snapshot() {
      return current ? { ...current } : null;
    },
  };
};
