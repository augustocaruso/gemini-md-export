import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import { buildChatReadAdapterPlan, domChatReadCapability, privateApiGeminiWebapiChatReadCapability, takeoutChatReadCapability, } from '../core/chat-read-adapter.js';
import { portableIsoSeconds } from '../core/date.js';
import { toGeminiPrivateChatId } from '../core/gemini-private-protocol.js';
import { hashText } from '../core/text-hash.js';
const ROOT_DIR = resolve(import.meta.dirname, '..', '..', '..');
const PYTHON_PACKAGE_DIR = resolve(ROOT_DIR, 'python');
const PYTHON_BOOTSTRAP_CODE = [
    'import json',
    'import gemini_webapi',
    'import pydantic',
    'print(json.dumps({"ok": True, "source": "gemini_webapi_python"}))',
].join('; ');
const stringOrNull = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};
const numberInRange = (value, fallback, min, max) => {
    const parsed = Number(value || fallback);
    const safeValue = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safeValue));
};
const recordOrNull = (value) => value !== null && typeof value === 'object' ? value : null;
const turnRole = (role) => {
    const normalized = String(role || '').toLowerCase();
    return normalized === 'model' || normalized === 'assistant' ? 'assistant' : 'user';
};
const attachmentKind = (kind) => {
    const normalized = String(kind || '').toLowerCase();
    if (normalized.includes('image'))
        return 'image';
    if (normalized.includes('video'))
        return 'video';
    if (normalized.includes('audio'))
        return 'audio';
    if (normalized.includes('media'))
        return 'media';
    if (normalized.includes('document') || normalized.includes('file'))
        return 'document';
    if (normalized.includes('artifact'))
        return 'artifact';
    return 'unknown';
};
const attachmentsFromSidecar = (value) => {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item, index) => {
        const record = recordOrNull(item);
        if (!record)
            return [];
        const label = stringOrNull(record.label) || stringOrNull(record.title) || 'Gemini asset';
        const url = stringOrNull(record.url);
        const originalUrl = stringOrNull(record.original_url) || stringOrNull(record.originalUrl);
        const assetId = stringOrNull(record.asset_id) || stringOrNull(record.assetId);
        const hash = stringOrNull(record.sha256) || stringOrNull(record.hash);
        return [
            {
                kind: attachmentKind(record.kind),
                label,
                ...(url ? { url } : {}),
                ...(hash ? { hash } : {}),
                assetRefId: assetId ||
                    (url || originalUrl
                        ? `gemini-webapi:${hashText(url || originalUrl)}`
                        : `gemini-webapi:${index}:${hashText(label)}`),
            },
        ];
    });
};
const mediaFromAssetReceipts = (value) => {
    if (!Array.isArray(value))
        return { mediaFiles: [], mediaFailures: [] };
    const mediaFiles = [];
    const mediaFailures = [];
    for (const item of value) {
        const receipt = recordOrNull(item);
        if (!receipt)
            continue;
        const assetId = stringOrNull(receipt.asset_id) || stringOrNull(receipt.assetId);
        const status = stringOrNull(receipt.status);
        if (status === 'failed') {
            mediaFailures.push({
                assetId,
                kind: stringOrNull(receipt.kind),
                label: stringOrNull(receipt.label),
                error: stringOrNull(receipt.error) || 'asset_download_failed',
            });
            continue;
        }
        const files = Array.isArray(receipt.files) ? receipt.files : [];
        for (const file of files) {
            const record = recordOrNull(file);
            const sourcePath = stringOrNull(record?.path);
            const filename = stringOrNull(record?.relative_path) || stringOrNull(record?.filename);
            if (!sourcePath || !filename)
                continue;
            try {
                mediaFiles.push({
                    filename,
                    contentBase64: readFileSync(sourcePath).toString('base64'),
                    contentType: stringOrNull(record?.content_type) || undefined,
                    assetId,
                    sha256: stringOrNull(record?.sha256) || undefined,
                    bytes: Number(record?.bytes) || undefined,
                });
            }
            catch (err) {
                mediaFailures.push({
                    assetId,
                    filename,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return { mediaFiles, mediaFailures };
};
const assetReceiptsFromSidecar = (value) => {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => {
        const record = recordOrNull(item);
        if (!record)
            return [];
        const files = Array.isArray(record.files)
            ? record.files.filter((file) => recordOrNull(file) !== null)
            : [];
        const firstFile = files[0] || null;
        const assetId = stringOrNull(record.asset_id) || stringOrNull(record.assetId);
        if (!assetId)
            return [];
        const status = stringOrNull(record.status);
        return [
            {
                ok: status !== 'failed',
                refId: assetId,
                status: status === 'downloaded' ? 'downloaded' : status === 'failed' ? 'failed' : 'metadata_only',
                filePath: stringOrNull(firstFile?.relative_path) || null,
                contentHash: stringOrNull(firstFile?.sha256) || null,
                warning: stringOrNull(record.error) || null,
            },
        ];
    });
};
const geminiWebapiPythonAdapterPlan = () => buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'privateApiGeminiWebapi',
    capabilities: [
        privateApiGeminiWebapiChatReadCapability({
            available: true,
            canReadAssets: true,
            reason: 'gemini_webapi_python_sidecar',
        }),
        domChatReadCapability({
            available: false,
            reason: 'dom_export_fallback_requires_explicit_mcp_request',
        }),
        takeoutChatReadCapability({
            available: false,
            reason: 'takeout_source_not_provided_for_python_sidecar',
        }),
    ],
});
const buildGeminiWebapiBaseCommand = ({ action, timeoutMs, python, request, }) => {
    const resolvedTimeoutMs = numberInRange(timeoutMs, 45_000, 5_000, 120_000);
    const explicitPython = stringOrNull(python) || process.env.GME_GEMINI_WEBAPI_PYTHON;
    const executable = explicitPython || process.env.GME_GEMINI_WEBAPI_RUNNER || 'uv';
    const args = explicitPython
        ? ['-m', 'gemini_md_export.gemini_webapi_adapter']
        : ['run', '--project', ROOT_DIR, 'gemini-md-export-gemini-webapi-adapter'];
    return {
        executable,
        args,
        stdin: JSON.stringify({
            action,
            ...(request || {}),
            timeout_ms: resolvedTimeoutMs,
        }),
        env: pythonPathEnv(),
        timeoutMs: resolvedTimeoutMs,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
    };
};
const pythonPathEnv = (baseEnv = process.env) => {
    const existing = baseEnv.PYTHONPATH
        ? `${PYTHON_PACKAGE_DIR}:${baseEnv.PYTHONPATH}`
        : PYTHON_PACKAGE_DIR;
    return { PYTHONPATH: existing };
};
export const buildGeminiWebapiPythonBootstrapCommand = (input = {}) => {
    const timeoutMs = numberInRange(input.timeoutMs ?? input.waitMs ?? process.env.GME_GEMINI_WEBAPI_BOOTSTRAP_TIMEOUT_MS, 180_000, 30_000, 300_000);
    const explicitPython = stringOrNull(input.python) || process.env.GME_GEMINI_WEBAPI_PYTHON;
    const executable = explicitPython || process.env.GME_GEMINI_WEBAPI_RUNNER || 'uv';
    const args = explicitPython
        ? ['-c', PYTHON_BOOTSTRAP_CODE]
        : ['run', '--project', ROOT_DIR, 'python', '-c', PYTHON_BOOTSTRAP_CODE];
    return {
        executable,
        args,
        stdin: JSON.stringify({
            action: 'bootstrap',
            timeout_ms: timeoutMs,
        }),
        env: pythonPathEnv(),
        timeoutMs,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
    };
};
export const buildGeminiWebapiPythonReadChatCommand = (input = {}) => {
    const chatId = parseChatId(input.chatId) || parseChatId(input.url);
    if (!chatId)
        throw new Error(`invalid_gemini_webapi_chat_id:${String(input.chatId || '')}`);
    const timeoutMs = numberInRange(input.timeoutMs ?? input.waitMs, 45_000, 5_000, 120_000);
    const request = {
        action: 'read_chat',
        chat_id: toGeminiPrivateChatId(chatId),
        title: stringOrNull(input.title),
        cookies_json: stringOrNull(input.cookiesJson),
        download_assets: input.downloadAssets === true,
        assets_dir: stringOrNull(input.assetsDir),
        assets_rel_dir: stringOrNull(input.assetsRelDir),
        limit: numberInRange(input.limit, 200, 1, 2000),
        timeout_ms: timeoutMs,
    };
    const explicitPython = stringOrNull(input.python) || process.env.GME_GEMINI_WEBAPI_PYTHON;
    const executable = explicitPython || process.env.GME_GEMINI_WEBAPI_RUNNER || 'uv';
    const args = explicitPython
        ? ['-m', 'gemini_md_export.gemini_webapi_adapter']
        : ['run', '--project', ROOT_DIR, 'gemini-md-export-gemini-webapi-adapter'];
    return {
        executable,
        args,
        stdin: JSON.stringify(request),
        env: pythonPathEnv(),
        timeoutMs,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
    };
};
export const buildGeminiWebapiPythonListChatsCommand = (input = {}) => buildGeminiWebapiBaseCommand({
    action: 'list_chats',
    timeoutMs: input.timeoutMs ?? input.waitMs,
    python: input.python,
    request: {
        cookies_json: stringOrNull(input.cookiesJson),
        limit: numberInRange(input.limit, 200, 1, 2000),
    },
});
export const buildGeminiWebapiPythonSessionStatusCommand = (input = {}) => buildGeminiWebapiBaseCommand({
    action: 'session_status',
    timeoutMs: input.timeoutMs ?? input.waitMs,
    python: input.python,
    request: {
        cookies_json: stringOrNull(input.cookiesJson),
    },
});
const failure = (code, message, chatId, stderr) => ({
    ok: false,
    code,
    message,
    chatId,
    ...(stderr ? { stderr } : {}),
    adapterPlan: geminiWebapiPythonAdapterPlan(),
});
const listFailure = (code, message, stderr) => ({
    ok: false,
    code,
    message,
    ...(stderr ? { stderr } : {}),
    adapterPlan: geminiWebapiPythonAdapterPlan(),
});
const sessionFailure = (code, message, stderr) => ({
    ok: false,
    code,
    message,
    ...(stderr ? { stderr } : {}),
    adapterPlan: geminiWebapiPythonAdapterPlan(),
});
const bootstrapFailure = (code, message, stderr) => ({
    ok: false,
    code,
    message,
    ...(stderr ? { stderr } : {}),
    adapterPlan: geminiWebapiPythonAdapterPlan(),
});
export const parseGeminiWebapiPythonReadChatResponse = (stdout) => {
    let payload;
    try {
        payload = JSON.parse(String(stdout || '').trim());
    }
    catch {
        return failure('gemini_webapi_python_invalid_json', 'O adapter Python gemini_webapi nao retornou JSON valido.', null);
    }
    const record = recordOrNull(payload);
    if (!record) {
        return failure('gemini_webapi_python_invalid_envelope', 'O adapter Python gemini_webapi retornou um envelope invalido.', null);
    }
    const chatId = parseChatId(record.chat_id) || parseChatId(record.private_chat_id);
    if (record.ok !== true) {
        return failure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.', chatId);
    }
    if (!chatId) {
        return failure('gemini_webapi_python_chat_id_missing', 'O adapter Python gemini_webapi nao comprovou a identidade do chat.', null);
    }
    const turns = Array.isArray(record.turns)
        ? record.turns.flatMap((item, index) => {
            const turn = recordOrNull(item);
            const markdown = stringOrNull(turn?.markdown) || stringOrNull(turn?.text);
            const createdAt = portableIsoSeconds(turn?.created_at || turn?.createdAt);
            if (!turn || !markdown)
                return [];
            return [
                {
                    role: turnRole(turn.role),
                    markdown,
                    textHash: hashText(markdown),
                    sourceOrder: index,
                    ...(createdAt ? { createdAt } : {}),
                    attachments: attachmentsFromSidecar(turn.attachments),
                },
            ];
        })
        : [];
    const turnDates = turns.flatMap((turn) => (turn.createdAt ? [turn.createdAt] : [])).sort();
    const dateCreated = portableIsoSeconds(record.date_created || record.dateCreated) || turnDates[0] || null;
    const dateLastMessage = portableIsoSeconds(record.date_last_message || record.dateLastMessage) ||
        turnDates.at(-1) ||
        null;
    const assistantMarkdown = turns
        .filter((turn) => turn.role === 'assistant')
        .map((turn) => turn.markdown)
        .join('\n\n');
    const assetReceipts = assetReceiptsFromSidecar(record.asset_receipts || record.assetReceipts);
    const { mediaFiles, mediaFailures } = mediaFromAssetReceipts(record.asset_receipts || record.assetReceipts);
    const snapshot = {
        chatId: chatId,
        title: stringOrNull(record.title) || String(chatId),
        url: canonicalGeminiChatUrl(chatId),
        turns,
        metadata: {
            assistantTurnCount: turns.filter((turn) => turn.role === 'assistant').length,
            ...(dateCreated ? { dateCreated } : {}),
            ...(dateLastMessage ? { dateLastMessage } : {}),
        },
        evidence: [
            {
                source: 'gemini-private-api',
                kind: 'gemini_webapi_python_read_chat',
                confidence: turns.length > 0 ? 'strong' : 'missing',
                textHash: assistantMarkdown ? hashText(assistantMarkdown) : undefined,
                sampleLength: assistantMarkdown.length,
                warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
            },
        ],
    };
    return {
        ok: true,
        snapshot,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
        transport: {
            source: 'gemini_webapi_python',
            privateChatId: stringOrNull(record.private_chat_id) || `c_${chatId}`,
        },
        assetReceipts,
        mediaFiles,
        mediaFailures,
        warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    };
};
const parseJsonEnvelope = (stdout) => {
    let payload;
    try {
        payload = JSON.parse(String(stdout || '').trim());
    }
    catch {
        return {
            parseError: true,
            message: 'O adapter Python gemini_webapi nao retornou JSON valido.',
        };
    }
    const record = recordOrNull(payload);
    if (!record) {
        return {
            parseError: true,
            message: 'O adapter Python gemini_webapi retornou um envelope invalido.',
        };
    }
    return record;
};
export const parseGeminiWebapiPythonBootstrapResponse = (stdout) => {
    const record = parseJsonEnvelope(stdout);
    if ('parseError' in record) {
        return bootstrapFailure('gemini_webapi_python_bootstrap_invalid_json', String(record.message));
    }
    if (record.ok !== true) {
        return bootstrapFailure(stringOrNull(record.code) || 'gemini_webapi_python_bootstrap_failed', stringOrNull(record.message) || 'Nao consegui preparar a API privada Python.');
    }
    return {
        ok: true,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
        transport: { source: 'gemini_webapi_python' },
        warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    };
};
export const parseGeminiWebapiPythonListChatsResponse = (stdout) => {
    const record = parseJsonEnvelope(stdout);
    if ('parseError' in record) {
        return listFailure('gemini_webapi_python_invalid_json', String(record.message));
    }
    if (record.ok !== true) {
        return listFailure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.');
    }
    const chats = Array.isArray(record.chats)
        ? record.chats.flatMap((item) => {
            const chat = recordOrNull(item);
            const chatId = parseChatId(chat?.chat_id) || parseChatId(chat?.chatId);
            if (!chat || !chatId)
                return [];
            return [
                {
                    chatId,
                    privateChatId: stringOrNull(chat.private_chat_id) || `c_${chatId}`,
                    title: stringOrNull(chat.title),
                    url: stringOrNull(chat.url) || canonicalGeminiChatUrl(chatId),
                    isPinned: chat.is_pinned === true || chat.isPinned === true,
                    updatedAt: portableIsoSeconds(chat.updated_at || chat.updatedAt),
                },
            ];
        })
        : [];
    return {
        ok: true,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
        transport: { source: 'gemini_webapi_python' },
        chats,
        count: chats.length,
        warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    };
};
export const parseGeminiWebapiPythonSessionStatusResponse = (stdout) => {
    const record = parseJsonEnvelope(stdout);
    if ('parseError' in record) {
        return sessionFailure('gemini_webapi_python_invalid_json', String(record.message));
    }
    if (record.ok !== true) {
        return sessionFailure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.');
    }
    if (record.authenticated !== true) {
        const accountStatus = stringOrNull(record.account_status || record.accountStatus);
        return sessionFailure(stringOrNull(record.code) || 'gemini_webapi_python_unauthenticated', stringOrNull(record.message) ||
            (accountStatus
                ? `Sessao da API privada nao autenticada (${accountStatus}).`
                : 'Sessao da API privada nao autenticada.'));
    }
    return {
        ok: true,
        adapterPlan: geminiWebapiPythonAdapterPlan(),
        transport: { source: 'gemini_webapi_python' },
        authenticated: true,
        chatCount: Number.isFinite(Number(record.chat_count)) ? Number(record.chat_count) : null,
        warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
    };
};
const runGeminiWebapiPythonCommand = async (command, parse, onSpawnFailure, onTimeout, onExitFailure) => new Promise((resolvePromise) => {
    const child = spawn(command.executable, [...command.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ...command.env,
        },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolvePromise(onTimeout(stderr));
    }, command.timeoutMs + 1000);
    child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });
    child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise(onSpawnFailure(err instanceof Error ? err.message : String(err), stderr));
    });
    child.on('close', (code) => {
        clearTimeout(timer);
        const parsed = parse(stdout);
        if (code === 0 || recordOrNull(parsed)?.ok === true) {
            resolvePromise(parsed);
            return;
        }
        resolvePromise(onExitFailure(parsed, stderr.trim() || undefined));
    });
    child.stdin.end(command.stdin);
});
export const runGeminiWebapiPythonBootstrap = async (input = {}) => {
    const command = buildGeminiWebapiPythonBootstrapCommand(input);
    return runGeminiWebapiPythonCommand(command, parseGeminiWebapiPythonBootstrapResponse, (message, stderr) => bootstrapFailure('gemini_webapi_python_bootstrap_spawn_failed', message, stderr), (stderr) => bootstrapFailure('gemini_webapi_python_bootstrap_timeout', 'A preparacao da API privada Python demorou demais. Rode novamente; as dependencias costumam ficar prontas na segunda tentativa.', stderr), (parsed, stderr) => {
        const record = recordOrNull(parsed) || {};
        return bootstrapFailure(stringOrNull(record.code) || 'gemini_webapi_python_bootstrap_failed', stringOrNull(record.message) || 'Nao consegui preparar a API privada Python.', stderr);
    });
};
const bootstrapCache = new Map();
const bootstrapCacheKey = (input = {}) => JSON.stringify({
    python: stringOrNull(input.python) || process.env.GME_GEMINI_WEBAPI_PYTHON || null,
    runner: process.env.GME_GEMINI_WEBAPI_RUNNER || null,
});
export const ensureGeminiWebapiPythonBootstrap = async (input = {}) => {
    const key = bootstrapCacheKey(input);
    const cached = bootstrapCache.get(key);
    if (cached)
        return cached;
    const pending = runGeminiWebapiPythonBootstrap(input).then((result) => {
        if (!result.ok)
            bootstrapCache.delete(key);
        return result;
    });
    bootstrapCache.set(key, pending);
    return pending;
};
export const runGeminiWebapiPythonReadChat = async (input) => {
    let command;
    const tempAssetsDir = input.downloadAssets === true && !stringOrNull(input.assetsDir)
        ? mkdtempSync(resolve(tmpdir(), 'gme-webapi-assets-'))
        : null;
    const cleanupTempAssets = () => {
        if (tempAssetsDir)
            rmSync(tempAssetsDir, { recursive: true, force: true });
    };
    try {
        command = buildGeminiWebapiPythonReadChatCommand({
            ...input,
            ...(tempAssetsDir ? { assetsDir: tempAssetsDir } : {}),
        });
    }
    catch (err) {
        cleanupTempAssets();
        return failure('invalid_gemini_webapi_chat_id', err instanceof Error ? err.message : String(err), null);
    }
    const bootstrapResult = await ensureGeminiWebapiPythonBootstrap({
        python: input.python,
    });
    if (!bootstrapResult.ok) {
        cleanupTempAssets();
        return failure(bootstrapResult.code, bootstrapResult.message, parseChatId(input.chatId) || parseChatId(input.url), bootstrapResult.stderr);
    }
    const result = await runGeminiWebapiPythonCommand(command, parseGeminiWebapiPythonReadChatResponse, (message, stderr) => failure('gemini_webapi_python_spawn_failed', message, parseChatId(input.chatId) || parseChatId(input.url), stderr), (stderr) => failure('gemini_webapi_python_timeout', 'O adapter Python gemini_webapi excedeu o tempo limite.', parseChatId(input.chatId) || parseChatId(input.url), stderr), (parsed, stderr) => {
        const record = recordOrNull(parsed) || {};
        return failure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.', parseChatId(record.chatId) || parseChatId(record.chat_id), stderr);
    });
    cleanupTempAssets();
    return result;
};
export const runGeminiWebapiPythonListChats = async (input = {}) => {
    const bootstrapResult = await ensureGeminiWebapiPythonBootstrap({
        python: input.python,
    });
    if (!bootstrapResult.ok) {
        return listFailure(bootstrapResult.code, bootstrapResult.message, bootstrapResult.stderr);
    }
    const command = buildGeminiWebapiPythonListChatsCommand(input);
    return runGeminiWebapiPythonCommand(command, parseGeminiWebapiPythonListChatsResponse, (message, stderr) => listFailure('gemini_webapi_python_spawn_failed', message, stderr), (stderr) => listFailure('gemini_webapi_python_timeout', 'O adapter Python gemini_webapi excedeu o tempo limite.', stderr), (parsed, stderr) => {
        const record = recordOrNull(parsed) || {};
        return listFailure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.', stderr);
    });
};
export const runGeminiWebapiPythonSessionStatus = async (input = {}) => {
    const bootstrapResult = await ensureGeminiWebapiPythonBootstrap({
        python: input.python,
    });
    if (!bootstrapResult.ok) {
        return sessionFailure(bootstrapResult.code, bootstrapResult.message, bootstrapResult.stderr);
    }
    const command = buildGeminiWebapiPythonSessionStatusCommand(input);
    return runGeminiWebapiPythonCommand(command, parseGeminiWebapiPythonSessionStatusResponse, (message, stderr) => sessionFailure('gemini_webapi_python_spawn_failed', message, stderr), (stderr) => sessionFailure('gemini_webapi_python_timeout', 'O adapter Python gemini_webapi excedeu o tempo limite.', stderr), (parsed, stderr) => {
        const record = recordOrNull(parsed) || {};
        return sessionFailure(stringOrNull(record.code) || 'gemini_webapi_python_failed', stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.', stderr);
    });
};
