import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
const EXTENSION_DISPLAY_NAME = 'Gemini Chat -> Markdown Export';
const cleanPath = (value) => String(value || '').replace(/[\\/]+$/, '');
const sameResolvedPath = (left, right) => {
    if (!left || !right)
        return false;
    try {
        return resolve(left) === resolve(right);
    }
    catch {
        return cleanPath(left) === cleanPath(right);
    }
};
const normalizedActiveJobCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};
const readJsonSafe = (filePath) => {
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    catch {
        return null;
    }
};
const manifestName = (dir) => {
    const manifest = readJsonSafe(resolve(dir, 'manifest.json'));
    const name = manifest?.name;
    const shortName = manifest?.short_name;
    if (typeof name === 'string' && name)
        return name;
    if (typeof shortName === 'string' && shortName)
        return shortName;
    return null;
};
const extensionManifestLooksValid = (dir) => manifestName(dir) === EXTENSION_DISPLAY_NAME;
export const readExtensionBuildStamp = (dir) => {
    if (!dir)
        return null;
    for (const fileName of ['background.js', 'content.js']) {
        try {
            const source = readFileSync(resolve(dir, fileName), 'utf-8');
            const match = source.match(/\bbuildStamp\s*[:=]\s*['"](\d{8}-\d{4})['"]/) ||
                source.match(/\bBUILD_STAMP\s*=\s*['"](\d{8}-\d{4})['"]/) ||
                source.match(/\bbuild\s+(\d{8}-\d{4})\b/);
            if (match?.[1])
                return match[1];
        }
        catch {
            // Build stamp is diagnostic only.
        }
    }
    return null;
};
const decision = (input, status, reason, { ok = status !== 'sync-failed' && status !== 'source-invalid' && status !== 'target-invalid', shouldSync = false, shouldReloadExistingTabs = input.allowReload === true, } = {}) => ({
    status,
    ok,
    shouldSync,
    shouldReloadExistingTabs,
    reason,
    sourceDir: input.sourceDir ? resolve(input.sourceDir) : null,
    targetDir: input.loadedExtension?.path ? resolve(input.loadedExtension.path) : null,
    activeJobCount: normalizedActiveJobCount(input.activeJobCount),
});
const isSafeTargetDir = (targetDir) => {
    if (!targetDir || !isAbsolute(targetDir))
        return false;
    const resolved = resolve(targetDir);
    return resolved !== dirname(resolved) && resolved.length > 8;
};
export const evaluateLocalExtensionSync = (input) => {
    if (input.allowReload !== true) {
        return decision(input, 'skipped-reload-disabled', 'Reload nao autorizado.', {
            shouldReloadExistingTabs: false,
        });
    }
    const activeJobCount = normalizedActiveJobCount(input.activeJobCount);
    if (activeJobCount > 0) {
        return decision(input, 'blocked-active-job', 'Ha job ativo; nao sincronizar nem recarregar.', {
            shouldReloadExistingTabs: false,
        });
    }
    const loadedExtension = input.loadedExtension || null;
    if (!loadedExtension) {
        return decision(input, 'skipped-no-loaded-extension', 'Extensao carregada nao encontrada.');
    }
    if (loadedExtension.locationKind !== 'unpacked') {
        return decision(input, 'skipped-non-unpacked', 'Extensao carregada nao e unpacked.');
    }
    const sourceDir = input.sourceDir ? resolve(input.sourceDir) : null;
    if (!sourceDir || !existsSync(sourceDir)) {
        return decision(input, 'source-missing', 'Pasta fonte da extensao nao encontrada.');
    }
    if (!extensionManifestLooksValid(sourceDir)) {
        return decision(input, 'source-invalid', 'Manifest da pasta fonte nao parece esta extensao.', {
            ok: false,
        });
    }
    const targetDir = loadedExtension.path ? resolve(loadedExtension.path) : null;
    if (!targetDir)
        return decision(input, 'target-missing', 'Pasta carregada nao informada.');
    if (!isSafeTargetDir(targetDir)) {
        return decision(input, 'target-unsafe', 'Pasta carregada nao e um alvo seguro.', {
            ok: false,
            shouldReloadExistingTabs: false,
        });
    }
    if (sameResolvedPath(sourceDir, targetDir)) {
        return decision(input, 'skipped-current-path', 'A extensao ja aponta para a pasta fonte.');
    }
    if (existsSync(targetDir) && !extensionManifestLooksValid(targetDir)) {
        return decision(input, 'target-invalid', 'Manifest da pasta carregada nao parece esta extensao.', {
            ok: false,
            shouldReloadExistingTabs: false,
        });
    }
    const sourceBuildStamp = readExtensionBuildStamp(sourceDir);
    const targetBuildStamp = readExtensionBuildStamp(targetDir);
    if (sourceBuildStamp && sourceBuildStamp === targetBuildStamp) {
        return decision(input, 'skipped-up-to-date', 'A pasta carregada ja tem o build stamp atual.');
    }
    return decision(input, 'ready-to-sync', 'Pasta unpacked carregada pode ser sincronizada.', {
        shouldSync: true,
    });
};
const replaceDirectoryContents = (sourceDir, targetDir) => {
    mkdirSync(targetDir, { recursive: true });
    let removedEntryCount = 0;
    for (const entry of readdirSync(targetDir)) {
        rmSync(resolve(targetDir, entry), { recursive: true, force: true });
        removedEntryCount += 1;
    }
    let copiedEntryCount = 0;
    for (const entry of readdirSync(sourceDir)) {
        cpSync(resolve(sourceDir, entry), resolve(targetDir, entry), { recursive: true });
        copiedEntryCount += 1;
    }
    return { copiedEntryCount, removedEntryCount };
};
export const syncLoadedUnpackedExtension = (input) => {
    const initial = evaluateLocalExtensionSync(input);
    const sourceBuildStamp = readExtensionBuildStamp(initial.sourceDir);
    const previousBuildStamp = readExtensionBuildStamp(initial.targetDir);
    if (!initial.shouldSync) {
        return {
            ...initial,
            sourceBuildStamp,
            previousBuildStamp,
            targetBuildStamp: previousBuildStamp,
        };
    }
    try {
        const counts = replaceDirectoryContents(initial.sourceDir || '', initial.targetDir || '');
        const targetBuildStamp = readExtensionBuildStamp(initial.targetDir);
        return {
            ...initial,
            status: 'synced',
            ok: true,
            shouldSync: false,
            sourceBuildStamp,
            previousBuildStamp,
            targetBuildStamp,
            ...counts,
        };
    }
    catch (err) {
        return {
            ...initial,
            status: 'sync-failed',
            ok: false,
            shouldSync: false,
            shouldReloadExistingTabs: false,
            sourceBuildStamp,
            previousBuildStamp,
            targetBuildStamp: readExtensionBuildStamp(initial.targetDir),
            error: err instanceof Error ? err.message : String(err),
        };
    }
};
export const resolveSourceExtensionDir = (packageRoot) => {
    for (const candidate of [
        resolve(packageRoot, 'dist', 'extension'),
        resolve(packageRoot, 'browser-extension'),
    ]) {
        if (existsSync(candidate) && extensionManifestLooksValid(candidate))
            return candidate;
    }
    return null;
};
