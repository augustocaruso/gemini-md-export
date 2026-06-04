const GEMINI_BRIDGE_PAGE_ORIGIN = 'https://gemini.google.com';
const ACTIVITY_BRIDGE_PAGE_ORIGIN = 'https://myactivity.google.com';
const GOOGLE_SORRY_BRIDGE_PAGE_ORIGIN = 'https://www.google.com';
const GOOGLE_LOGIN_BRIDGE_PAGE_ORIGIN = 'https://accounts.google.com';
const CHROMIUM_EXTENSION_ID_RE = /^[a-p]{32}$/;
const parseOrigin = (origin) => {
    if (!origin)
        return null;
    try {
        return new URL(origin);
    }
    catch {
        return null;
    }
};
export const isAllowedExtensionBridgeOrigin = (origin) => {
    if (!origin)
        return true;
    const parsed = parseOrigin(origin);
    return (parsed !== null &&
        parsed.protocol === 'chrome-extension:' &&
        CHROMIUM_EXTENSION_ID_RE.test(parsed.hostname));
};
export const isAllowedGeminiBridgeOrigin = (origin) => {
    if (!origin)
        return true;
    const parsed = parseOrigin(origin);
    return parsed?.origin === GEMINI_BRIDGE_PAGE_ORIGIN || isAllowedExtensionBridgeOrigin(origin);
};
export const isAllowedActivityBridgeOrigin = (origin) => {
    if (!origin)
        return true;
    const parsed = parseOrigin(origin);
    return parsed?.origin === ACTIVITY_BRIDGE_PAGE_ORIGIN || isAllowedExtensionBridgeOrigin(origin);
};
export const isAllowedGoogleBlockerBridgeOrigin = (origin) => {
    if (!origin)
        return true;
    const parsed = parseOrigin(origin);
    return (parsed?.origin === GOOGLE_SORRY_BRIDGE_PAGE_ORIGIN ||
        parsed?.origin === GOOGLE_LOGIN_BRIDGE_PAGE_ORIGIN ||
        isAllowedExtensionBridgeOrigin(origin));
};
export const isAllowedBridgeOrigin = (origin) => isAllowedGeminiBridgeOrigin(origin) ||
    isAllowedActivityBridgeOrigin(origin) ||
    isAllowedGoogleBlockerBridgeOrigin(origin);
