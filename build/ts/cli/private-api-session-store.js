import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
const storagePathFromEnv = (env) => [
    env?.GME_GEMINI_WEBAPI_STORAGE_STATE,
    env?.GME_GOOGLE_STORAGE_STATE,
    env?.GME_GOOGLE_COOKIES_JSON,
]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => resolve(value));
export const privateApiSessionStorageCandidates = ({ env = process.env, homeDir = homedir(), } = {}) => [
    ...storagePathFromEnv(env),
    resolve(homeDir, '.gemini-md-export', 'google-storage-state.json'),
    resolve(homeDir, '.gemini-md-export', 'storage_state.json'),
    resolve(homeDir, '.config', 'gemini-md-export', 'google-storage-state.json'),
    resolve(homeDir, '.config', 'gemini-md-export', 'storage_state.json'),
];
export const resolvePrivateApiSessionStoragePath = (options = {}) => privateApiSessionStorageCandidates(options).find((candidate) => existsSync(candidate)) || null;
export const applyPrivateApiSessionDefaults = (flags, options = {}) => {
    if (typeof flags.cookiesJson === 'string' && flags.cookiesJson.length > 0)
        return flags;
    const storagePath = resolvePrivateApiSessionStoragePath(options);
    if (!storagePath)
        return flags;
    return { ...flags, cookiesJson: storagePath };
};
