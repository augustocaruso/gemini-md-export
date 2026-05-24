export type HostPalette = Record<string, string>;

export type HostPaletteOptions = {
  documentRef?: Document;
  isDark?: boolean;
};

const FONT_STACK = '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif';

const computedStyleFor = (documentRef: Document, element: Element): CSSStyleDeclaration | null => {
  try {
    return documentRef.defaultView?.getComputedStyle(element) || getComputedStyle(element);
  } catch {
    return null;
  }
};

export const readHostCssToken = (
  name: string,
  fallback = '',
  { documentRef = document }: { documentRef?: Document } = {},
): string => {
  const htmlValue = computedStyleFor(documentRef, documentRef.documentElement)
    ?.getPropertyValue(name)
    ?.trim();
  if (htmlValue) return htmlValue;

  const body = documentRef.body;
  if (body) {
    const bodyValue = computedStyleFor(documentRef, body)?.getPropertyValue(name)?.trim();
    if (bodyValue) return bodyValue;
  }

  return fallback;
};

export const buildHostPalette = ({
  documentRef = document,
  isDark = false,
}: HostPaletteOptions = {}): HostPalette => {
  const surfaceContainerHigh = readHostCssToken(
    '--gem-sys-color--surface-container-high',
    isDark ? '#282a2c' : '#ffffff',
    { documentRef },
  );
  const surfaceContainerHighest = readHostCssToken(
    '--gem-sys-color--surface-container-highest',
    isDark ? '#333537' : '#f8fafd',
    { documentRef },
  );
  const surfaceContainer = readHostCssToken(
    '--gem-sys-color--surface-container',
    isDark ? '#1e1f20' : '#f0f4f9',
    { documentRef },
  );
  const onSurface = readHostCssToken(
    '--gem-sys-color--on-surface',
    isDark ? '#e3e3e3' : '#1f1f1f',
    { documentRef },
  );
  const outline = readHostCssToken('--gem-sys-color--outline', isDark ? '#8e918f' : '#74777f', {
    documentRef,
  });
  const outlineVariant = readHostCssToken(
    '--gem-sys-color--outline-variant',
    isDark ? '#444746' : '#c4c7c5',
    { documentRef },
  );
  const primary = readHostCssToken('--gem-sys-color--primary', isDark ? '#a8c7fa' : '#0b57d0', {
    documentRef,
  });
  const onPrimary = readHostCssToken(
    '--gem-sys-color--on-primary',
    isDark ? '#062e6f' : '#ffffff',
    { documentRef },
  );
  const secondaryContainer = readHostCssToken(
    '--gem-sys-color--secondary-container',
    isDark ? '#004a77' : '#c2e7ff',
    { documentRef },
  );
  const onSecondaryContainer = readHostCssToken(
    '--gem-sys-color--on-secondary-container',
    isDark ? '#c2e7ff' : '#001d35',
    { documentRef },
  );

  return {
    '--gm-panel-bg': surfaceContainerHigh,
    '--gm-surface-elevated': surfaceContainerHighest,
    '--gm-surface-muted': surfaceContainer,
    '--gm-border': outlineVariant,
    '--gm-border-strong': outline,
    '--gm-text': onSurface,
    '--gm-text-muted': isDark
      ? `color-mix(in srgb, ${onSurface} 65%, transparent)`
      : `color-mix(in srgb, ${onSurface} 60%, transparent)`,
    '--gm-accent': primary,
    '--gm-accent-strong': secondaryContainer,
    '--gm-accent-text': onPrimary,
    '--gm-accent-on-strong': onSecondaryContainer,
    '--gm-success': isDark ? '#a6d4a6' : '#137333',
    '--gm-badge-bg': secondaryContainer,
    '--gm-badge-text': onSecondaryContainer,
    '--gm-font': FONT_STACK,
  };
};

export const buildDockHostPalette = (options: HostPaletteOptions = {}): HostPalette => {
  const isDark = options.isDark === true;
  const palette = buildHostPalette(options);
  return {
    '--gm-dock-bg': palette['--gm-panel-bg'],
    '--gm-dock-text': palette['--gm-text'],
    '--gm-dock-muted': palette['--gm-text-muted'],
    '--gm-dock-border': palette['--gm-border'],
    '--gm-dock-track': isDark ? 'rgba(255,255,255,0.08)' : 'rgba(60,64,67,0.12)',
    '--gm-dock-done-bg': palette['--gm-accent-strong'],
    '--gm-font': palette['--gm-font'],
    '--gm-accent': palette['--gm-accent'],
  };
};

export const buildMenuHostPalette = (options: HostPaletteOptions = {}): HostPalette => {
  const isDark = options.isDark === true;
  const palette = buildHostPalette(options);
  return {
    '--gm-menu-bg': palette['--gm-panel-bg'],
    '--gm-menu-text': palette['--gm-text'],
    '--gm-menu-muted': palette['--gm-text-muted'],
    '--gm-menu-border': palette['--gm-border'],
    '--gm-menu-divider': palette['--gm-border'],
    '--gm-menu-hover': isDark
      ? `color-mix(in srgb, ${palette['--gm-text']} 8%, transparent)`
      : `color-mix(in srgb, ${palette['--gm-text']} 6%, transparent)`,
    '--gm-menu-focus': `color-mix(in srgb, ${palette['--gm-accent']} 22%, transparent)`,
    '--gm-menu-pressed': isDark
      ? `color-mix(in srgb, ${palette['--gm-text']} 12%, transparent)`
      : `color-mix(in srgb, ${palette['--gm-text']} 10%, transparent)`,
    '--gm-menu-shadow': isDark
      ? '0 16px 36px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30)'
      : '0 16px 36px rgba(60,64,67,0.20), 0 2px 8px rgba(60,64,67,0.12)',
    '--gm-menu-accent': palette['--gm-accent'],
    '--gm-menu-font': palette['--gm-font'],
  };
};

export const applyCssVars = (element: HTMLElement, vars: HostPalette): void => {
  Object.entries(vars).forEach(([key, value]) => element.style.setProperty(key, value));
};
