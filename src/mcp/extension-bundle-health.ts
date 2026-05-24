import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type MissingStaticImport = Readonly<{
  importer: string;
  specifier: string;
  resolvedPath: string;
}>;

export type ExtensionBundleHealth = Readonly<{
  ok: boolean;
  extensionPath: string | null;
  entrypoints: readonly string[];
  missingImports: readonly MissingStaticImport[];
}>;

export type LocalDoctorStatusInput = Readonly<{
  loadedOk: boolean;
  versionMatches: boolean;
  nativeHostOk: boolean;
  nativeHostStatus: string;
  nativeHostNextAction: string;
  bundleHealthOk?: boolean | null;
}>;

export type LocalDoctorStatus = Readonly<{
  ok: boolean;
  warnings: readonly string[];
  nextAction: string;
}>;

const STATIC_RELATIVE_IMPORT_RE =
  /\bimport\s+(?:[^'"]+\s+from\s+)?['"](\.[^'"]+)['"]/g;

const staticRelativeImports = (source: string): string[] =>
  Array.from(source.matchAll(STATIC_RELATIVE_IMPORT_RE)).map((match) => match[1] ?? '');

const collectMissingStaticImports = (
  entryPath: string,
  seen: Set<string>,
): MissingStaticImport[] => {
  if (seen.has(entryPath)) return [];
  seen.add(entryPath);

  let source = '';
  try {
    source = readFileSync(entryPath, 'utf-8');
  } catch {
    return [];
  }

  const missing: MissingStaticImport[] = [];
  for (const specifier of staticRelativeImports(source)) {
    const resolvedPath = resolve(dirname(entryPath), specifier);
    if (!existsSync(resolvedPath)) {
      missing.push({ importer: entryPath, specifier, resolvedPath });
      continue;
    }
    missing.push(...collectMissingStaticImports(resolvedPath, seen));
  }
  return missing;
};

export const diagnoseExtensionBundle = (
  extensionPath: string | null | undefined,
  entrypoints: readonly string[] = ['background.js'],
): ExtensionBundleHealth => {
  const root = String(extensionPath || '').trim();
  if (!root || !existsSync(root)) {
    return {
      ok: false,
      extensionPath: root || null,
      entrypoints,
      missingImports: entrypoints.map((entrypoint) => ({
        importer: root ? resolve(root, entrypoint) : entrypoint,
        specifier: entrypoint,
        resolvedPath: root ? resolve(root, entrypoint) : entrypoint,
      })),
    };
  }

  const seen = new Set<string>();
  const missingImports = entrypoints.flatMap((entrypoint) => {
    const entryPath = resolve(root, entrypoint);
    if (!existsSync(entryPath)) {
      return [{ importer: entryPath, specifier: entrypoint, resolvedPath: entryPath }];
    }
    return collectMissingStaticImports(entryPath, seen);
  });

  return {
    ok: missingImports.length === 0,
    extensionPath: root,
    entrypoints,
    missingImports,
  };
};

export const summarizeLocalDoctorStatus = ({
  loadedOk,
  versionMatches,
  nativeHostOk,
  nativeHostStatus,
  nativeHostNextAction,
  bundleHealthOk = true,
}: LocalDoctorStatusInput): LocalDoctorStatus => {
  const warnings: string[] = [];
  if (!loadedOk) warnings.push('extensao_nao_encontrada_no_perfil');
  if (loadedOk && !versionMatches) warnings.push('runtime_versao_diferente_dos_arquivos');
  if (loadedOk && bundleHealthOk === false) {
    warnings.push('browser_extension_bundle_missing_imports');
  }
  if (!nativeHostOk) warnings.push(`native_host_${nativeHostStatus}`);

  let nextAction = '';
  if (!loadedOk) {
    nextAction = 'Carregue a extensão unpacked correta neste navegador/perfil.';
  } else if (bundleHealthOk === false) {
    nextAction = 'Reinstale ou recarregue a extensão: o pacote carregado está incompleto.';
  } else if (!versionMatches) {
    nextAction = 'Recarregue o card da extensão e a aba Gemini.';
  } else if (!nativeHostOk) {
    nextAction = nativeHostNextAction;
  }

  return {
    ok: loadedOk && versionMatches && nativeHostOk && bundleHealthOk !== false,
    warnings,
    nextAction,
  };
};
