import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import {
  buildChatReadAdapterPlan,
  domChatReadCapability,
  privateApiGeminiWebapiChatReadCapability,
  takeoutChatReadCapability,
} from '../core/chat-read-adapter.js';
import { toGeminiPrivateChatId } from '../core/gemini-private-protocol.js';
import { hashText } from '../core/text-hash.js';
import type { ChatAttachment, ChatId, ChatSnapshot, ChatTurn } from '../core/types.js';

type UnknownRecord = Record<string, unknown>;

export type GeminiWebapiPythonReadChatInput = Readonly<{
  chatId?: unknown;
  url?: unknown;
  title?: unknown;
  cookiesJson?: unknown;
  python?: unknown;
  timeoutMs?: unknown;
  waitMs?: unknown;
  limit?: unknown;
}>;

export type GeminiWebapiPythonReadChatCommand = Readonly<{
  executable: string;
  args: readonly string[];
  stdin: string;
  env: Record<string, string>;
  timeoutMs: number;
  adapterPlan: ReturnType<typeof geminiWebapiPythonAdapterPlan>;
}>;

export type GeminiWebapiPythonReadChatResult =
  | Readonly<{
      ok: true;
      snapshot: ChatSnapshot;
      adapterPlan: ReturnType<typeof geminiWebapiPythonAdapterPlan>;
      transport: Readonly<{
        source: 'gemini_webapi_python';
        privateChatId: string;
      }>;
      warnings: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: string;
      message: string;
      chatId: string | null;
      stderr?: string;
      adapterPlan: ReturnType<typeof geminiWebapiPythonAdapterPlan>;
    }>;

const ROOT_DIR = resolve(import.meta.dirname, '..', '..', '..');
const PYTHON_PACKAGE_DIR = resolve(ROOT_DIR, 'python');

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const numberInRange = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value || fallback);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
};

const recordOrNull = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;

const turnRole = (role: unknown): 'user' | 'assistant' => {
  const normalized = String(role || '').toLowerCase();
  return normalized === 'model' || normalized === 'assistant' ? 'assistant' : 'user';
};

const attachmentKind = (kind: unknown): ChatAttachment['kind'] => {
  const normalized = String(kind || '').toLowerCase();
  if (normalized.includes('image')) return 'image';
  if (normalized.includes('document') || normalized.includes('file')) return 'document';
  if (normalized.includes('artifact')) return 'artifact';
  return 'unknown';
};

const attachmentsFromSidecar = (value: unknown): ChatAttachment[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = recordOrNull(item);
    if (!record) return [];
    const label = stringOrNull(record.label) || stringOrNull(record.title) || 'Gemini asset';
    const url = stringOrNull(record.url);
    return [
      {
        kind: attachmentKind(record.kind),
        label,
        ...(url ? { url, assetRefId: `gemini-webapi:${hashText(url)}` } : {}),
        ...(!url ? { assetRefId: `gemini-webapi:${index}:${hashText(label)}` } : {}),
      },
    ];
  });
};

const geminiWebapiPythonAdapterPlan = () =>
  buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'privateApiGeminiWebapi',
    capabilities: [
      privateApiGeminiWebapiChatReadCapability({
        available: true,
        canReadAssets: true,
        reason: 'gemini_webapi_python_sidecar',
      }),
      domChatReadCapability({
        available: true,
        reason: 'dom_export_fallback_available_from_connected_content_script',
      }),
      takeoutChatReadCapability({
        available: false,
        reason: 'takeout_source_not_provided_for_python_sidecar',
      }),
    ],
  });

const pythonPathEnv = (baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const existing = baseEnv.PYTHONPATH
    ? `${PYTHON_PACKAGE_DIR}:${baseEnv.PYTHONPATH}`
    : PYTHON_PACKAGE_DIR;
  return { PYTHONPATH: existing };
};

export const buildGeminiWebapiPythonReadChatCommand = (
  input: GeminiWebapiPythonReadChatInput = {},
): GeminiWebapiPythonReadChatCommand => {
  const chatId = parseChatId(input.chatId) || parseChatId(input.url);
  if (!chatId) throw new Error(`invalid_gemini_webapi_chat_id:${String(input.chatId || '')}`);
  const timeoutMs = numberInRange(input.timeoutMs ?? input.waitMs, 45_000, 5_000, 120_000);
  const request = {
    action: 'read_chat',
    chat_id: toGeminiPrivateChatId(chatId),
    title: stringOrNull(input.title),
    cookies_json: stringOrNull(input.cookiesJson),
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

const failure = (
  code: string,
  message: string,
  chatId: string | null,
  stderr?: string,
): GeminiWebapiPythonReadChatResult => ({
  ok: false,
  code,
  message,
  chatId,
  ...(stderr ? { stderr } : {}),
  adapterPlan: geminiWebapiPythonAdapterPlan(),
});

export const parseGeminiWebapiPythonReadChatResponse = (
  stdout: string,
): GeminiWebapiPythonReadChatResult => {
  let payload: unknown;
  try {
    payload = JSON.parse(String(stdout || '').trim());
  } catch {
    return failure(
      'gemini_webapi_python_invalid_json',
      'O adapter Python gemini_webapi nao retornou JSON valido.',
      null,
    );
  }

  const record = recordOrNull(payload);
  if (!record) {
    return failure(
      'gemini_webapi_python_invalid_envelope',
      'O adapter Python gemini_webapi retornou um envelope invalido.',
      null,
    );
  }

  const chatId = parseChatId(record.chat_id) || parseChatId(record.private_chat_id);
  if (record.ok !== true) {
    return failure(
      stringOrNull(record.code) || 'gemini_webapi_python_failed',
      stringOrNull(record.message) || 'O adapter Python gemini_webapi falhou.',
      chatId,
    );
  }
  if (!chatId) {
    return failure(
      'gemini_webapi_python_chat_id_missing',
      'O adapter Python gemini_webapi nao comprovou a identidade do chat.',
      null,
    );
  }

  const turns: ChatTurn[] = Array.isArray(record.turns)
    ? record.turns.flatMap((item, index) => {
        const turn = recordOrNull(item);
        const markdown = stringOrNull(turn?.markdown) || stringOrNull(turn?.text);
        if (!turn || !markdown) return [];
        return [
          {
            role: turnRole(turn.role),
            markdown,
            textHash: hashText(markdown),
            sourceOrder: index,
            attachments: attachmentsFromSidecar(turn.attachments),
          },
        ];
      })
    : [];
  const assistantMarkdown = turns
    .filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.markdown)
    .join('\n\n');
  const snapshot: ChatSnapshot = {
    chatId: chatId as ChatId,
    title: stringOrNull(record.title) || String(chatId),
    url: canonicalGeminiChatUrl(chatId as ChatId),
    turns,
    metadata: {
      assistantTurnCount: turns.filter((turn) => turn.role === 'assistant').length,
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
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
};

export const runGeminiWebapiPythonReadChat = async (
  input: GeminiWebapiPythonReadChatInput,
): Promise<GeminiWebapiPythonReadChatResult> => {
  let command: GeminiWebapiPythonReadChatCommand;
  try {
    command = buildGeminiWebapiPythonReadChatCommand(input);
  } catch (err) {
    return failure(
      'invalid_gemini_webapi_chat_id',
      err instanceof Error ? err.message : String(err),
      null,
    );
  }

  return new Promise((resolvePromise) => {
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
      resolvePromise(
        failure(
          'gemini_webapi_python_timeout',
          'O adapter Python gemini_webapi excedeu o tempo limite.',
          parseChatId(input.chatId) || parseChatId(input.url),
          stderr,
        ),
      );
    }, command.timeoutMs + 1000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise(
        failure(
          'gemini_webapi_python_spawn_failed',
          err instanceof Error ? err.message : String(err),
          parseChatId(input.chatId) || parseChatId(input.url),
          stderr,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseGeminiWebapiPythonReadChatResponse(stdout);
      if (code === 0 || parsed.ok) {
        resolvePromise(parsed);
        return;
      }
      resolvePromise(
        failure(parsed.code, parsed.message, parsed.chatId, stderr.trim() || undefined),
      );
    });
    child.stdin.end(command.stdin);
  });
};
