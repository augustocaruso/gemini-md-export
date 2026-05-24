const GEMINI_BRIDGE_PAGE_ORIGIN = 'https://gemini.google.com';
const ACTIVITY_BRIDGE_PAGE_ORIGIN = 'https://myactivity.google.com';
const GOOGLE_SORRY_BRIDGE_PAGE_ORIGIN = 'https://www.google.com';
const GOOGLE_LOGIN_BRIDGE_PAGE_ORIGIN = 'https://accounts.google.com';
const CHROMIUM_EXTENSION_ID_RE = /^[a-p]{32}$/;

const parseOrigin = (origin: string | null | undefined): URL | null => {
  if (!origin) return null;
  try {
    return new URL(origin);
  } catch {
    return null;
  }
};

export const isAllowedExtensionBridgeOrigin = (origin: string | null | undefined): boolean => {
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  return (
    parsed !== null &&
    parsed.protocol === 'chrome-extension:' &&
    CHROMIUM_EXTENSION_ID_RE.test(parsed.hostname)
  );
};

export const isAllowedGeminiBridgeOrigin = (origin: string | null | undefined): boolean => {
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  return parsed?.origin === GEMINI_BRIDGE_PAGE_ORIGIN || isAllowedExtensionBridgeOrigin(origin);
};

export const isAllowedActivityBridgeOrigin = (origin: string | null | undefined): boolean => {
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  return parsed?.origin === ACTIVITY_BRIDGE_PAGE_ORIGIN || isAllowedExtensionBridgeOrigin(origin);
};

export const isAllowedGoogleBlockerBridgeOrigin = (origin: string | null | undefined): boolean => {
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  return (
    parsed?.origin === GOOGLE_SORRY_BRIDGE_PAGE_ORIGIN ||
    parsed?.origin === GOOGLE_LOGIN_BRIDGE_PAGE_ORIGIN ||
    isAllowedExtensionBridgeOrigin(origin)
  );
};

export const isAllowedBridgeOrigin = (origin: string | null | undefined): boolean =>
  isAllowedGeminiBridgeOrigin(origin) ||
  isAllowedActivityBridgeOrigin(origin) ||
  isAllowedGoogleBlockerBridgeOrigin(origin);
