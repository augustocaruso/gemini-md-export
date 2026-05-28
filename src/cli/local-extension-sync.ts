import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const EXTENSION_DISPLAY_NAME = 'Gemini Chat -> Markdown Export';

type LoadedExtension = Readonly<{
  id?: string | null;
  locationKind?: string | null;
  path?: string | null;
}>;

export type LocalExtensionSyncInput = Readonly<{
  allowReload?: boolean;
  activeJobCount?: number;
  sourceDir?: string | null;
  loadedExtension?: LoadedExtension | null;
}>;

export type LocalExtensionSyncStatus =
  | 'ready-to-sync'
  | 'synced'
  | 'blocked-active-job'
  | 'skipped-reload-disabled'
  | 'skipped-no-loaded-extension'
  | 'skipped-non-unpacked'
  | 'skipped-current-path'
  | 'skipped-up-to-date'
  | 'source-missing'
  | 'source-invalid'
  | 'target-missing'
  | 'target-unsafe'
  | 'target-invalid'
  | 'sync-failed';

export type LocalExtensionSyncDecision = Readonly<{
  status: LocalExtensionSyncStatus;
  ok: boolean;
  shouldSync: boolean;
  shouldReloadExistingTabs: boolean;
  reason: string;
  sourceDir: string | null;
  targetDir: string | null;
  activeJobCount: number;
}>;

export type LocalExtensionSyncResult = LocalExtensionSyncDecision &
  Readonly<{
    sourceBuildStamp?: string | null;
    previousBuildStamp?: string | null;
    targetBuildStamp?: string | null;
    copiedEntryCount?: number;
    removedEntryCount?: number;
    error?: string | null;
  }>;

type JsonRecord = Record<string, unknown>;

const cleanPath = (value: string | null | undefined): string =>
  String(value || '').replace(/[\\/]+$/, '');

const sameResolvedPath = (left: string | null, right: string | null): boolean => {
  if (!left || !right) return false;
  try {
    return resolve(left) === resolve(right);
  } catch {
    return cleanPath(left) === cleanPath(right);
  }
};

const normalizedActiveJobCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const readJsonSafe = (filePath: string): JsonRecord | null => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as JsonRecord;
  } catch {
    return null;
  }
};

const manifestName = (dir: string): string | null => {
  const manifest = readJsonSafe(resolve(dir, 'manifest.json'));
  const name = manifest?.name;
  const shortName = manifest?.short_name;
  if (typeof name === 'string' && name) return name;
  if (typeof shortName === 'string' && shortName) return shortName;
  return null;
};

const extensionManifestLooksValid = (dir: string): boolean =>
  manifestName(dir) === EXTENSION_DISPLAY_NAME;

export const readExtensionBuildStamp = (dir: string | null | undefined): string | null => {
  if (!dir) return null;
  for (const fileName of ['background.js', 'content.js']) {
    try {
      const source = readFileSync(resolve(dir, fileName), 'utf-8');
      const match =
        source.match(/\bbuildStamp\s*[:=]\s*['"](\d{8}-\d{4})['"]/) ||
        source.match(/\bBUILD_STAMP\s*=\s*['"](\d{8}-\d{4})['"]/) ||
        source.match(/\bbuild\s+(\d{8}-\d{4})\b/);
      if (match?.[1]) return match[1];
    } catch {
      // Build stamp is diagnostic only.
    }
  }
  return null;
};

const decision = (
  input: LocalExtensionSyncInput,
  status: LocalExtensionSyncStatus,
  reason: string,
  {
    ok = status !== 'sync-failed' && status !== 'source-invalid' && status !== 'target-invalid',
    shouldSync = false,
    shouldReloadExistingTabs = input.allowReload === true,
  }: Partial<
    Pick<LocalExtensionSyncDecision, 'ok' | 'shouldSync' | 'shouldReloadExistingTabs'>
  > = {},
): LocalExtensionSyncDecision => ({
  status,
  ok,
  shouldSync,
  shouldReloadExistingTabs,
  reason,
  sourceDir: input.sourceDir ? resolve(input.sourceDir) : null,
  targetDir: input.loadedExtension?.path ? resolve(input.loadedExtension.path) : null,
  activeJobCount: normalizedActiveJobCount(input.activeJobCount),
});

const isSafeTargetDir = (targetDir: string): boolean => {
  if (!targetDir || !isAbsolute(targetDir)) return false;
  const resolved = resolve(targetDir);
  return resolved !== dirname(resolved) && resolved.length > 8;
};

export const evaluateLocalExtensionSync = (
  input: LocalExtensionSyncInput,
): LocalExtensionSyncDecision => {
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
  if (!targetDir) return decision(input, 'target-missing', 'Pasta carregada nao informada.');
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
    return decision(
      input,
      'target-invalid',
      'Manifest da pasta carregada nao parece esta extensao.',
      {
        ok: false,
        shouldReloadExistingTabs: false,
      },
    );
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

const replaceDirectoryContents = (
  sourceDir: string,
  targetDir: string,
): Pick<LocalExtensionSyncResult, 'copiedEntryCount' | 'removedEntryCount'> => {
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

export const syncLoadedUnpackedExtension = (
  input: LocalExtensionSyncInput,
): LocalExtensionSyncResult => {
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
  } catch (err) {
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

export const resolveSourceExtensionDir = (packageRoot: string): string | null => {
  for (const candidate of [
    resolve(packageRoot, 'dist', 'extension'),
    resolve(packageRoot, 'browser-extension'),
  ]) {
    if (existsSync(candidate) && extensionManifestLooksValid(candidate)) return candidate;
  }
  return null;
};
