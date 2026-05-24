export type GeminiNativeStyleProfile = {
  name: string;
  version: number;
  source: string;
  cssVars: Record<string, string>;
};

export type GeminiNativeStyleProfileOptions = {
  documentRef?: Document;
  isDark?: boolean;
};

export const GEMINI_NATIVE_STYLE_PROFILE_VERSION = 1;

export const GEMINI_LR26_NATIVE_STYLE_PROFILE: GeminiNativeStyleProfile = {
  name: 'gemini-lr26-dia-native',
  version: GEMINI_NATIVE_STYLE_PROFILE_VERSION,
  source: 'native-style-capture:playwright-computed-style:2026-05-23T20:54:00.000Z',
  cssVars: {
    '--gmn-topbar-slot-size': '40px',
    '--gmn-topbar-button-size': '40px',
    '--gmn-topbar-button-padding': '10px',
    '--gmn-topbar-icon-size': '20px',
    '--gmn-topbar-radius': '9999px',
    '--gmn-topbar-state-hover':
      'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.08))',
    '--gmn-topbar-state-focus':
      'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.10))',
    '--gmn-topbar-state-pressed':
      'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.14))',

    '--gmn-tooltip-bg': 'rgb(241, 243, 244)',
    '--gmn-tooltip-text': 'rgb(32, 33, 36)',
    '--gmn-tooltip-radius': '18px',
    '--gmn-tooltip-padding': '12px 28px',
    '--gmn-tooltip-min-height': '40px',
    '--gmn-tooltip-font-size': '14px',
    '--gmn-tooltip-line-height': '20px',
    '--gmn-tooltip-font-weight': '400',
    '--gmn-tooltip-arrow-size': '14px',
    '--gmn-tooltip-arrow-radius': '2px',

    '--gmn-menu-width': '242px',
    '--gmn-menu-radius': '20px',
    '--gmn-menu-shadow': 'rgba(0, 0, 0, 0.28) 0px 0px 20px 0px',
    '--gmn-menu-item-min-height': '56px',
    '--gmn-menu-checkbox-item-min-height': '76px',
    '--gmn-menu-item-padding': '8px 16px',
    '--gmn-menu-item-radius': '0',
    '--gmn-menu-font-size': '14px',
    '--gmn-menu-line-height': '20px',
    '--gmn-menu-font-weight': '400',
    '--gmn-menu-leading-slot-size': '20px',
    '--gmn-menu-leading-gap': '12px',
    '--gmn-menu-divider-margin': '0 16px',

    '--gmn-modal-panel-width': 'min(760px, calc(100vw - 24px))',
    '--gmn-modal-panel-height': 'min(680px, calc(100vh - 24px))',
    '--gmn-modal-panel-max-height': 'min(680px, calc(100vh - 24px))',
    '--gmn-modal-panel-radius': '28px',
    '--gmn-modal-panel-padding': '22px',
    '--gmn-modal-panel-gap': '14px',
    '--gmn-modal-font-size': '14px',
    '--gmn-modal-line-height': '1.4',
    '--gmn-modal-title-font-size': '20px',
    '--gmn-modal-title-line-height': '1.2',
    '--gmn-modal-button-height': '40px',
    '--gmn-modal-button-radius': '999px',
    '--gmn-modal-button-font-size': '13px',
    '--gmn-modal-button-font-weight': '500',
    '--gmn-modal-input-height': '40px',
    '--gmn-modal-input-radius': '999px',
    '--gmn-modal-destination-radius': '18px',
    '--gmn-modal-destination-icon-size': '36px',
    '--gmn-modal-destination-icon-glyph-size': '18px',
    '--gmn-modal-list-flex': '1 1 0',
    '--gmn-modal-list-min-height': '0',
    '--gmn-modal-list-gap': '2px',
    '--gmn-modal-list-scrollbar-width': '10px',
    '--gmn-modal-list-row-min-height': '56px',
    '--gmn-modal-list-row-radius': '16px',
    '--gmn-modal-list-row-padding': '10px 14px',
    '--gmn-modal-list-row-gap': '12px',
    '--gmn-modal-checkbox-size': '18px',
  },
};

const cloneNativeStyleProfile = (
  profile: GeminiNativeStyleProfile,
): GeminiNativeStyleProfile => ({
  name: profile.name,
  version: profile.version,
  source: profile.source,
  cssVars: { ...profile.cssVars },
});

export const buildGeminiNativeStyleProfile = (
  _options: GeminiNativeStyleProfileOptions = {},
): GeminiNativeStyleProfile => cloneNativeStyleProfile(GEMINI_LR26_NATIVE_STYLE_PROFILE);

export const applyGeminiNativeStyleVars = (
  element: HTMLElement,
  profile: GeminiNativeStyleProfile,
): void => {
  element.dataset.gmNativeStyleProfile = profile.name;
  element.dataset.gmNativeStyleVersion = String(profile.version);
  Object.entries(profile.cssVars).forEach(([key, value]) => {
    element.style.setProperty(key, value);
  });
};
