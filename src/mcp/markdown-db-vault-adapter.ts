import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import type { FixVaultPrivateRepairRecord } from '../core/fix-vault-flow.js';

type UnknownRecord = Record<string, unknown>;

type MarkdownDbFile = UnknownRecord & {
  file_path?: string;
  metadata?: UnknownRecord | null;
  gemini_asset_links?: unknown;
};

type MarkdownDbInstance = {
  db?: { destroy(): Promise<void> };
  init(): Promise<MarkdownDbInstance>;
  indexFolder(input: {
    folderPath: string;
    ignorePatterns?: RegExp[];
    customConfig?: {
      include?: string[];
      exclude?: string[];
      computedFields?: Array<(fileInfo: UnknownRecord, ast: unknown) => void>;
    };
  }): Promise<void>;
  getFiles(query?: { extensions?: string[] }): Promise<MarkdownDbFile[]>;
};

type MarkdownDbModule = {
  MarkdownDB: new (config: UnknownRecord) => MarkdownDbInstance;
};

type RuntimeNodeDependencyImportDeps = {
  moduleDir?: string;
  importModule?: (packageName: string) => Promise<unknown>;
  installRuntimeDependencies?: (packageRoot: string) => Promise<void>;
};

type RuntimeDependencyInstallCommand = Readonly<{
  file: string;
  args: readonly string[];
}>;

type MarkdownAstNode = {
  type?: unknown;
  url?: unknown;
  children?: unknown;
};

export type MarkdownDbVaultLoadResult = Readonly<{
  records: readonly FixVaultPrivateRepairRecord[];
  summary: Readonly<{
    totalMarkdownFiles: number;
    recordsWithMissingAssets: number;
    cacheDir: string;
  }>;
}>;

const MARKDOWN_DB_CACHE_DIR = '.gemini-md-export/markdown-db';

const moduleDir = dirname(fileURLToPath(import.meta.url));

const readPackageName = (filePath: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { name?: unknown };
    return stringOrNull(parsed.name);
  } catch {
    return null;
  }
};

const packageRootFromModuleDir = (startDir: string): string | null => {
  let current = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = resolve(current, 'package.json');
    if (existsSync(packagePath) && readPackageName(packagePath) === 'gemini-md-export') {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

const isMissingNodePackageError = (err: unknown, packageName: string): boolean => {
  const record = err && typeof err === 'object' ? (err as UnknownRecord) : {};
  if (record.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return String((record as { message?: unknown }).message || '').includes(packageName);
};

export const runtimeDependencyInstallCommand = (
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeDependencyInstallCommand => {
  if (platform === 'win32') {
    return {
      file: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'install', '--omit=dev'],
    };
  }
  return { file: 'npm', args: ['install', '--omit=dev'] };
};

const installRuntimeDependencies = (packageRoot: string): Promise<void> =>
  new Promise((resolveInstall, rejectInstall) => {
    const command = runtimeDependencyInstallCommand();
    const child = execFile(
      command.file,
      [...command.args],
      {
        cwd: packageRoot,
        timeout: 180_000,
        windowsHide: true,
      },
      (err) => {
        if (err) rejectInstall(err);
        else resolveInstall();
      },
    );
    child.stdin?.end();
  });

export const importRuntimeNodeDependency = async (
  packageName: string,
  deps: RuntimeNodeDependencyImportDeps = {},
): Promise<UnknownRecord> => {
  const importModule = deps.importModule || ((name: string) => import(name));
  try {
    return (await importModule(packageName)) as UnknownRecord;
  } catch (err) {
    if (!isMissingNodePackageError(err, packageName)) throw err;
    const packageRoot = packageRootFromModuleDir(deps.moduleDir || moduleDir);
    if (!packageRoot) throw err;
    const installer = deps.installRuntimeDependencies || installRuntimeDependencies;
    await installer(packageRoot);
    return (await importModule(packageName)) as UnknownRecord;
  }
};

const loadMarkdownDb = async (): Promise<MarkdownDbModule> => {
  return (await importRuntimeNodeDependency('mddb')) as MarkdownDbModule;
};

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const arrayOfStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const stripMarkdownLinkTarget = (value: string): string => {
  let target = String(value || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  target = target.split('#')[0]?.split('?')[0] || '';
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
};

const localAssetTarget = (value: string): string | null => {
  const target = stripMarkdownLinkTarget(value);
  if (!target || target.startsWith('/') || isAbsolute(target)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('assets/')) return null;
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null;
  return normalized;
};

const walkAst = (node: unknown, visit: (node: MarkdownAstNode) => void): void => {
  if (!node || typeof node !== 'object') return;
  const astNode = node as MarkdownAstNode;
  visit(astNode);
  if (!Array.isArray(astNode.children)) return;
  for (const child of astNode.children) walkAst(child, visit);
};

const geminiAssetLinksFromAst = (ast: unknown): string[] => {
  const links = new Set<string>();
  walkAst(ast, (node) => {
    if (node.type !== 'image' && node.type !== 'link') return;
    const target = localAssetTarget(String(node.url ?? ''));
    if (target) links.add(target);
  });
  return [...links].sort();
};

const addGeminiAssetLinks = (fileInfo: UnknownRecord, ast: unknown): void => {
  fileInfo.gemini_asset_links = geminiAssetLinksFromAst(ast);
};

const defaultIgnorePatterns = (vaultDir: string): RegExp[] =>
  [
    '.git',
    '.obsidian',
    '.trash',
    '.gemini-md-export',
    '.gemini-md-export-fix',
    '.gemini-md-export-repair',
    'node_modules',
  ].map(
    (dirName) =>
      new RegExp(`${vaultDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*[\\\\/]${dirName}[\\\\/]`),
  );

const metadataOf = (file: MarkdownDbFile): UnknownRecord => {
  const metadata = file.metadata;
  return metadata && typeof metadata === 'object' ? metadata : {};
};

const recordFromFile = ({
  file,
  vaultDir,
}: Readonly<{
  file: MarkdownDbFile;
  vaultDir: string;
}>): FixVaultPrivateRepairRecord | null => {
  const sourcePath = stringOrNull(file.file_path);
  if (!sourcePath) return null;
  const resolvedPath = resolve(sourcePath);
  const relativePath = relative(vaultDir, resolvedPath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  const metadata = metadataOf(file);
  const chatId =
    parseChatId(metadata.chat_id) || parseChatId(metadata.url) || parseChatId(basename(sourcePath));
  if (!chatId) return null;
  const title = stringOrNull(metadata.title) || basename(sourcePath, '.md');
  const url = stringOrNull(metadata.url) || canonicalGeminiChatUrl(chatId);
  const assetLinks = arrayOfStrings(file.gemini_asset_links);
  const missingAssets = assetLinks.filter(
    (assetPath) => !existsSync(resolve(dirname(sourcePath), assetPath)),
  );
  return {
    chatId,
    title,
    url,
    sourcePath: resolvedPath,
    relativePath,
    missingAssets,
  };
};

export const loadMarkdownDbFixVaultRecords = async ({
  vaultDir,
  cacheDir = resolve(vaultDir, MARKDOWN_DB_CACHE_DIR),
}: Readonly<{
  vaultDir: string;
  cacheDir?: string;
}>): Promise<MarkdownDbVaultLoadResult> => {
  const resolvedVaultDir = resolve(vaultDir);
  const resolvedCacheDir = resolve(cacheDir);
  mkdirSync(resolvedCacheDir, { recursive: true });
  rmSync(resolve(resolvedCacheDir, 'markdown-db.sqlite'), { force: true });
  rmSync(resolve(resolvedCacheDir, '.markdowndb'), { recursive: true, force: true });

  const { MarkdownDB } = await loadMarkdownDb();
  const db = new MarkdownDB({
    client: 'sqlite3',
    connection: { filename: resolve(resolvedCacheDir, 'markdown-db.sqlite') },
    useNullAsDefault: true,
  });
  await db.init();
  const previousCwd = process.cwd();
  try {
    process.chdir(resolvedCacheDir);
    await db.indexFolder({
      folderPath: resolvedVaultDir,
      ignorePatterns: defaultIgnorePatterns(resolvedVaultDir),
      customConfig: {
        include: ['**/*.md'],
        computedFields: [addGeminiAssetLinks],
      },
    });
    const files = await db.getFiles({ extensions: ['md'] });
    const records = files
      .map((file) => recordFromFile({ file, vaultDir: resolvedVaultDir }))
      .filter((record): record is FixVaultPrivateRepairRecord => record !== null)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      records,
      summary: {
        totalMarkdownFiles: files.length,
        recordsWithMissingAssets: records.filter(
          (record) => (record.missingAssets || []).length > 0,
        ).length,
        cacheDir: resolvedCacheDir,
      },
    };
  } finally {
    process.chdir(previousCwd);
    await db.db?.destroy();
  }
};
