import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
const isMissingNodePackageError = (err, packageName) => {
    const record = err && typeof err === 'object' ? err : {};
    if (record.code !== 'ERR_MODULE_NOT_FOUND')
        return false;
    return String(record.message || '').includes(packageName);
};
export const importRuntimeNodeDependency = async (packageName, deps = {}) => {
    const importModule = deps.importModule || ((name) => import(name));
    try {
        return (await importModule(packageName));
    }
    catch (err) {
        if (!isMissingNodePackageError(err, packageName))
            throw err;
        throw err;
    }
};
const loadMarkdownDb = async () => {
    return (await importRuntimeNodeDependency('mddb'));
};
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const arrayOfStrings = (value) => {
    if (Array.isArray(value))
        return value.map(String).filter(Boolean);
    if (typeof value !== 'string')
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    }
    catch {
        return [];
    }
};
const stripMarkdownLinkTarget = (value) => {
    let target = String(value || '').trim();
    if (target.startsWith('<') && target.endsWith('>'))
        target = target.slice(1, -1).trim();
    target = target.split('#')[0]?.split('?')[0] || '';
    try {
        return decodeURI(target);
    }
    catch {
        return target;
    }
};
const localAssetTarget = (value) => {
    const target = stripMarkdownLinkTarget(value);
    if (!target || target.startsWith('/') || isAbsolute(target))
        return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target))
        return null;
    const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized.startsWith('assets/'))
        return null;
    if (normalized.split('/').some((part) => part === '..' || part === ''))
        return null;
    return normalized;
};
const walkAst = (node, visit) => {
    if (!node || typeof node !== 'object')
        return;
    const astNode = node;
    visit(astNode);
    if (!Array.isArray(astNode.children))
        return;
    for (const child of astNode.children)
        walkAst(child, visit);
};
const geminiAssetLinksFromAst = (ast) => {
    const links = new Set();
    walkAst(ast, (node) => {
        if (node.type !== 'image' && node.type !== 'link')
            return;
        const target = localAssetTarget(String(node.url ?? ''));
        if (target)
            links.add(target);
    });
    return [...links].sort();
};
const addGeminiAssetLinks = (fileInfo, ast) => {
    fileInfo.gemini_asset_links = geminiAssetLinksFromAst(ast);
};
const defaultIgnorePatterns = (vaultDir) => [
    '.git',
    '.obsidian',
    '.trash',
    '.gemini-md-export',
    '.gemini-md-export-fix',
    '.gemini-md-export-repair',
    'node_modules',
].map((dirName) => new RegExp(`${vaultDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*[\\\\/]${dirName}[\\\\/]`));
const isInternalVaultRelativePath = (relativePath) => {
    const normalized = relativePath.replace(/\\/g, '/');
    return (normalized.startsWith('.git/') ||
        normalized.startsWith('.obsidian/') ||
        normalized.startsWith('.trash/') ||
        normalized.startsWith('.gemini-md-export/') ||
        normalized.startsWith('.gemini-md-export-fix/') ||
        normalized.startsWith('.gemini-md-export-repair/') ||
        normalized.startsWith('node_modules/'));
};
export const defaultMarkdownDbCacheDir = (vaultDir) => {
    const hash = createHash('sha256').update(resolve(vaultDir)).digest('hex').slice(0, 16);
    return resolve(tmpdir(), 'gemini-md-export', 'markdown-db', hash);
};
const metadataOf = (file) => {
    const metadata = file.metadata;
    return metadata && typeof metadata === 'object' ? metadata : {};
};
const recordFromFile = ({ file, vaultDir, }) => {
    const sourcePath = stringOrNull(file.file_path);
    if (!sourcePath)
        return null;
    const resolvedPath = resolve(sourcePath);
    const relativePath = relative(vaultDir, resolvedPath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath))
        return null;
    if (isInternalVaultRelativePath(relativePath))
        return null;
    const metadata = metadataOf(file);
    const chatId = parseChatId(metadata.chat_id) || parseChatId(metadata.url) || parseChatId(basename(sourcePath));
    if (!chatId)
        return null;
    const title = stringOrNull(metadata.title) || basename(sourcePath, '.md');
    const url = stringOrNull(metadata.url) || canonicalGeminiChatUrl(chatId);
    const assetLinks = arrayOfStrings(file.gemini_asset_links);
    const missingAssets = assetLinks.filter((assetPath) => !existsSync(resolve(dirname(sourcePath), assetPath)));
    return {
        chatId,
        title,
        url,
        sourcePath: resolvedPath,
        relativePath,
        missingAssets,
    };
};
export const loadMarkdownDbFixVaultRecords = async ({ vaultDir, cacheDir, }) => {
    const resolvedVaultDir = resolve(vaultDir);
    const resolvedCacheDir = resolve(cacheDir || defaultMarkdownDbCacheDir(resolvedVaultDir));
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
        const userFiles = files.filter((file) => {
            const sourcePath = stringOrNull(file.file_path);
            if (!sourcePath)
                return false;
            const relativePath = relative(resolvedVaultDir, resolve(sourcePath));
            return Boolean(relativePath &&
                !relativePath.startsWith('..') &&
                !isAbsolute(relativePath) &&
                !isInternalVaultRelativePath(relativePath));
        });
        const records = userFiles
            .map((file) => recordFromFile({ file, vaultDir: resolvedVaultDir }))
            .filter((record) => record !== null)
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        return {
            records,
            summary: {
                totalMarkdownFiles: userFiles.length,
                recordsWithMissingAssets: records.filter((record) => (record.missingAssets || []).length > 0).length,
                cacheDir: resolvedCacheDir,
            },
        };
    }
    finally {
        process.chdir(previousCwd);
        await db.db?.destroy();
    }
};
