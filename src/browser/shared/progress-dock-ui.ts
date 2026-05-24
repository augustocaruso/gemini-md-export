import { applyCssVars, buildDockHostPalette } from './host-palette.js';

export const SHARED_PROGRESS_DOCK_ID = 'gm-md-export-progress-dock';

export const ensureSharedProgressDock = ({
  dockId = SHARED_PROGRESS_DOCK_ID,
  initialTitle = '',
  documentRef = document,
}: {
  dockId?: string;
  initialTitle?: string;
  documentRef?: Document;
} = {}): HTMLElement => {
  let dock = documentRef.getElementById(dockId);
  if (dock) return dock;

  dock = documentRef.createElement('div');
  dock.id = dockId;
  dock.setAttribute('data-gm-shared-progress-dock', 'true');
  dock.hidden = true;
  Object.assign(dock.style, {
    position: 'fixed',
    left: '50%',
    bottom: '18px',
    transform: 'translateX(-50%)',
    zIndex: '10002',
    display: 'none',
    pointerEvents: 'none',
    width: 'min(360px, calc(100vw - 24px))',
  });
  dock.innerHTML = `
    <style>
      #${dockId} .gm-dock-card {
        font-family: var(--gm-font);
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 22px;
        background: var(--gm-dock-bg);
        color: var(--gm-dock-text);
        border: 1px solid var(--gm-dock-border);
        box-shadow:
          0 16px 40px rgba(0,0,0,0.40),
          0 2px 8px rgba(0,0,0,0.24);
        backdrop-filter: blur(14px);
      }
      #${dockId} .gm-dock-track {
        height: 6px;
        background: var(--gm-dock-track);
        border-radius: 999px;
        overflow: hidden;
        position: relative;
      }
      #${dockId} .gm-dock-bar {
        height: 100%;
        width: 0%;
        background: var(--gm-accent);
        border-radius: 999px;
        position: relative;
        overflow: hidden;
        transition: width 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
        will-change: width;
      }
      #${dockId} .gm-dock-bar::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(
          90deg,
          rgba(255,255,255,0) 0%,
          rgba(255,255,255,0.55) 50%,
          rgba(255,255,255,0) 100%
        );
        transform: translateX(-100%);
        animation: gm-dock-shimmer 1500ms linear infinite;
      }
      #${dockId}.gm-dock-done .gm-dock-bar {
        background: var(--gm-dock-done-bg, var(--gm-accent));
      }
      #${dockId}.gm-dock-done .gm-dock-bar::after {
        animation: none;
        opacity: 0;
      }
      @keyframes gm-dock-shimmer {
        0%   { transform: translateX(-100%); }
        100% { transform: translateX(100%); }
      }
    </style>
    <div class="gm-dock-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <strong id="${dockId}-title" style="font-size:12px;font-weight:600;letter-spacing:0.01em;"></strong>
        <span id="${dockId}-count" style="font-size:11px;color:var(--gm-dock-muted);white-space:nowrap;"></span>
      </div>
      <div id="${dockId}-label" style="font-size:12px;color:var(--gm-dock-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      <div class="gm-dock-track">
        <div id="${dockId}-bar" class="gm-dock-bar"></div>
      </div>
    </div>
  `;
  documentRef.body.appendChild(dock);
  const titleEl = documentRef.getElementById(`${dockId}-title`);
  if (titleEl) titleEl.textContent = initialTitle;
  return dock;
};

export const applySharedProgressDockTheme = (
  dock: HTMLElement | null,
  { dark = false, documentRef = document }: { dark?: boolean; documentRef?: Document } = {},
): void => {
  if (!dock) return;
  applyCssVars(dock, buildDockHostPalette({ documentRef, isDark: dark }));
};

export const getSharedProgressDockElements = ({
  dockId = SHARED_PROGRESS_DOCK_ID,
  documentRef = document,
}: {
  dockId?: string;
  documentRef?: Document;
} = {}): {
  titleEl: HTMLElement | null;
  countEl: HTMLElement | null;
  labelEl: HTMLElement | null;
  barEl: HTMLElement | null;
} => ({
  titleEl: documentRef.getElementById(`${dockId}-title`),
  countEl: documentRef.getElementById(`${dockId}-count`),
  labelEl: documentRef.getElementById(`${dockId}-label`),
  barEl: documentRef.getElementById(`${dockId}-bar`),
});

export const setSharedProgressDockVisible = (dock: HTMLElement | null, visible: boolean): void => {
  if (!dock) return;
  dock.hidden = !visible;
  dock.style.display = visible ? 'block' : 'none';
};
