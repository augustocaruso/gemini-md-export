import { isAbsolute, resolve } from 'node:path';
const EXTENSION_MANIFEST_NAME = 'Gemini Chat -> Markdown Export';
const stringValue = (value) => String(value || '').trim();
export const normalizePathKey = (value, { platform = process.platform } = {}) => {
    const text = stringValue(value);
    return platform === 'win32' ? text.toLowerCase() : text;
};
const normalizeBrowser = (value) => stringValue(value).toLowerCase();
const normalizeProfile = (value) => stringValue(value).toLowerCase();
const profileKeyFor = (item) => `${normalizeBrowser(item.browser)}\0${normalizeProfile(item.profile)}`;
const manifestLooksLikeThisExtension = (manifest) => {
    const record = manifest && typeof manifest === 'object' ? manifest : {};
    return record.name === EXTENSION_MANIFEST_NAME || record.short_name === EXTENSION_MANIFEST_NAME;
};
const hostPermissionsLookLikeThisExtension = (setting) => {
    const record = setting && typeof setting === 'object' ? setting : {};
    const permissions = record.active_permissions && typeof record.active_permissions === 'object'
        ? record.active_permissions
        : {};
    const hosts = Array.isArray(permissions.explicit_host) ? permissions.explicit_host : [];
    return hosts.some((host) => String(host || '').includes('gemini.google.com'));
};
const pathLooksLikeThisExtension = (path) => /(?:GeminiMdExport|gemini-md-export)/i.test(String(path || ''));
const isAbsoluteForPlatform = (path, platform) => platform === 'win32' ? /^[a-z]:[\\/]/i.test(path) : isAbsolute(path);
const loadedExtensionPriority = (item, context) => {
    const pathKey = normalizePathKey(item.extensionPath, context);
    if (pathKey === normalizePathKey(context.canonicalExtensionPath, context))
        return 0;
    if (pathKey === normalizePathKey(context.legacyExtensionPath, context))
        return 1;
    if (pathKey === normalizePathKey(context.sourceExtensionPath, context))
        return 2;
    return 3;
};
const statusForSingleLoadedExtension = (item, context) => {
    const priority = loadedExtensionPriority(item, context);
    return priority <= 2 ? 'already-current-path' : 'sync';
};
export const planLoadedBrowserExtensionSync = (loadedExtensions = [], { canonicalExtensionPath = '', legacyExtensionPath = '', sourceExtensionPath = '', platform = process.platform, } = {}) => {
    const context = {
        canonicalExtensionPath,
        legacyExtensionPath,
        sourceExtensionPath,
        platform,
    };
    const groups = new Map();
    for (const item of loadedExtensions) {
        const key = profileKeyFor(item);
        const list = groups.get(key) || [];
        list.push(item);
        groups.set(key, list);
    }
    const planned = [];
    for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => {
            const priority = loadedExtensionPriority(a, context) - loadedExtensionPriority(b, context);
            if (priority !== 0)
                return priority;
            return String(a.extensionId || '').localeCompare(String(b.extensionId || ''));
        });
        const keeper = sorted[0] || null;
        for (const item of group) {
            if (keeper && group.length > 1 && item !== keeper) {
                planned.push({
                    ...item,
                    status: 'duplicate-needs-removal',
                    shouldSync: false,
                    duplicateOf: String(keeper.extensionId || '') || null,
                    keepExtensionPath: String(keeper.extensionPath || '') || null,
                });
                continue;
            }
            const status = statusForSingleLoadedExtension(item, context);
            planned.push({
                ...item,
                status,
                shouldSync: status === 'sync',
                duplicateOf: null,
                keepExtensionPath: null,
            });
        }
    }
    return planned;
};
export const discoverLoadedBrowserExtensionsFromProfiles = (profileRecords = [], { isExtensionDir = () => false, platform = process.platform } = {}) => {
    const found = [];
    const seen = new Set();
    for (const record of profileRecords) {
        const settings = record.settings || {};
        for (const [extensionId, settingValue] of Object.entries(settings)) {
            const setting = settingValue && typeof settingValue === 'object'
                ? settingValue
                : {};
            const rawPath = setting.path || setting.install_path;
            if (!rawPath)
                continue;
            const rawPathText = String(rawPath);
            const resolvedPath = isAbsoluteForPlatform(rawPathText, platform)
                ? rawPathText
                : resolve(String(record.profileDir || ''), rawPathText);
            const manifestMatches = manifestLooksLikeThisExtension(setting.manifest);
            const pathMatches = isExtensionDir(resolvedPath) || pathLooksLikeThisExtension(resolvedPath);
            const hostMatches = hostPermissionsLookLikeThisExtension(setting);
            if (!manifestMatches && !pathMatches && !hostMatches)
                continue;
            const key = [
                normalizeBrowser(record.browser),
                normalizeProfile(record.profile),
                String(extensionId || ''),
                normalizePathKey(resolvedPath, { platform }),
            ].join('\0');
            if (seen.has(key))
                continue;
            seen.add(key);
            found.push({
                browser: record.browser,
                profile: record.profile,
                extensionId,
                extensionPath: resolvedPath,
                preferencesPath: record.preferencesPath,
                preferencesFile: record.fileName,
            });
        }
    }
    return found;
};
