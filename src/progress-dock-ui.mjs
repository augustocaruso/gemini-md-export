export const SHARED_PROGRESS_DOCK_ID = 'gm-md-export-progress-dock';

export const ensureSharedProgressDock = ({
  dockId = SHARED_PROGRESS_DOCK_ID,
  initialTitle = '',
  documentRef = document,
} = {}) => {
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
        gap: 8px;
        padding: 12px 14px;
        border-radius: 18px;
        background: var(--gm-dock-bg);
        color: var(--gm-dock-text);
        border: 1px solid var(--gm-dock-border);
        box-shadow: 0 10px 30px rgba(0,0,0,0.16);
        backdrop-filter: blur(10px);
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

export const applySharedProgressDockTheme = (dock, { dark = false } = {}) => {
  if (!dock) return;
  const vars = dark
    ? {
        '--gm-dock-bg': 'rgba(31,35,41,0.94)',
        '--gm-dock-text': '#e8eaed',
        '--gm-dock-muted': '#aab4be',
        '--gm-dock-border': 'rgba(255,255,255,0.08)',
        '--gm-dock-track': 'rgba(255,255,255,0.08)',
        '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
        '--gm-accent': '#8ab4f8',
      }
    : {
        '--gm-dock-bg': 'rgba(255,255,255,0.94)',
        '--gm-dock-text': '#202124',
        '--gm-dock-muted': '#5f6368',
        '--gm-dock-border': 'rgba(60,64,67,0.12)',
        '--gm-dock-track': 'rgba(60,64,67,0.12)',
        '--gm-font': '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif',
        '--gm-accent': '#1a73e8',
      };
  Object.entries(vars).forEach(([key, value]) => dock.style.setProperty(key, value));
};

export const getSharedProgressDockElements = ({
  dockId = SHARED_PROGRESS_DOCK_ID,
  documentRef = document,
} = {}) => ({
  titleEl: documentRef.getElementById(`${dockId}-title`),
  countEl: documentRef.getElementById(`${dockId}-count`),
  labelEl: documentRef.getElementById(`${dockId}-label`),
  barEl: documentRef.getElementById(`${dockId}-bar`),
});

export const setSharedProgressDockVisible = (dock, visible) => {
  if (!dock) return;
  dock.hidden = !visible;
  dock.style.display = visible ? 'block' : 'none';
};
