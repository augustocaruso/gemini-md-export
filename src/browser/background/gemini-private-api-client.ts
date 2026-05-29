import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import {
  browserBackgroundChatReadCapability,
  buildChatReadAdapterPlan,
  domChatReadCapability,
  takeoutChatReadCapability,
} from '../../core/chat-read-adapter.js';
import { renderChatSnapshotMarkdown } from '../../core/chat-snapshot-markdown.js';
import {
  buildGeminiPrivateBatchRequest,
  buildGeminiPrivateListChatsPayload,
  buildGeminiPrivateReadChatPayload,
  decodeGeminiBatchExecuteResponseWithDiagnostics,
  extractGeminiBatchRpcPayload,
  GEMINI_PRIVATE_RPC,
  type GeminiBatchDecodeDiagnostics,
  normalizeGeminiPrivateReadChatSnapshot,
} from '../../core/gemini-private-protocol.js';
import {
  createTurndownMarkdownRenderer,
  type MarkdownRenderer,
} from '../../core/markdown-renderer/turndown-renderer.js';
import type { ChatId, ChatSnapshot } from '../../core/types.js';

type GeminiPrivateApiReadDiagnostics = Omit<GeminiBatchDecodeDiagnostics, 'frames'>;

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'include';
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type GeminiPrivateApiReadChatResult =
  | {
      ok: true;
      snapshot: ChatSnapshot;
      markdown: string;
      transport: {
        source: 'extension-background-fetch';
        appStatus: number;
        rpcStatus: number | null;
      };
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    }
  | {
      ok: false;
      code:
        | 'invalid_private_chat_id'
        | 'private_api_app_fetch_failed'
        | 'private_api_token_missing'
        | 'private_api_rpc_fetch_failed'
        | 'private_api_rpc_empty'
        | 'private_api_wire_format_changed'
        | 'google_verification_required'
        | 'private_api_request_failed';
      message: string;
      chatId: string | null;
      status?: number | null;
      diagnostics?: GeminiPrivateApiReadDiagnostics;
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    };

export type GeminiPrivateApiListChat = Readonly<{
  chatId: string;
  privateChatId: string;
  title: string | null;
  url: string;
  isPinned: boolean;
  updatedAt: string | null;
}>;

export type GeminiPrivateApiListChatsResult =
  | {
      ok: true;
      chats: readonly GeminiPrivateApiListChat[];
      count: number;
      transport: {
        source: 'extension-background-fetch';
        appStatus: number;
        rpcStatuses: readonly (number | null)[];
      };
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    }
  | {
      ok: false;
      code:
        | 'private_api_app_fetch_failed'
        | 'private_api_token_missing'
        | 'private_api_rpc_fetch_failed'
        | 'private_api_wire_format_changed'
        | 'google_verification_required'
        | 'private_api_request_failed';
      message: string;
      status?: number | null;
      diagnostics?: GeminiPrivateApiReadDiagnostics;
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    };

export type GeminiPrivateApiSessionStatusResult =
  | {
      ok: true;
      authenticated: true;
      transport: {
        source: 'extension-background-fetch';
        appStatus: number;
      };
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    }
  | {
      ok: false;
      authenticated: false;
      code:
        | 'private_api_app_fetch_failed'
        | 'private_api_token_missing'
        | 'google_verification_required'
        | 'private_api_request_failed';
      message: string;
      status?: number | null;
      adapterPlan: ReturnType<typeof privateApiAdapterPlan>;
    };

export type ReadGeminiPrivateChatInput = Readonly<{
  chatId: unknown;
  title?: string | null;
  fetchImpl?: FetchLike;
  requestId?: number;
  markdownRenderer?: MarkdownRenderer;
}>;

export type ListGeminiPrivateChatsInput = Readonly<{
  fetchImpl?: FetchLike;
  requestId?: number;
  limit?: number;
}>;

export type CheckGeminiPrivateSessionInput = Readonly<{
  fetchImpl?: FetchLike;
}>;

const unescapeJsonString = (value: string): string => {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
};

const extractField = (html: string, key: string): string | null => {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*"(.*?)"`));
  return match?.[1] ? unescapeJsonString(match[1]) : null;
};

export const extractGeminiPrivateSessionFields = (html: string) => ({
  at: extractField(html, 'SNlM0e') || '',
  bl: extractField(html, 'cfb2h'),
  fSid: extractField(html, 'FdrFJe'),
  hl: extractField(html, 'TuX5cc'),
});

const failure = (
  code: GeminiPrivateApiReadChatResult extends infer Result
    ? Result extends { ok: false; code: infer Code }
      ? Code
      : never
    : never,
  message: string,
  chatId: string | null,
  status?: number | null,
  diagnostics?: GeminiPrivateApiReadDiagnostics,
): GeminiPrivateApiReadChatResult => ({
  ok: false,
  code,
  message,
  chatId,
  adapterPlan: privateApiAdapterPlan(),
  ...(status === undefined ? {} : { status }),
  ...(diagnostics ? { diagnostics } : {}),
});

const listFailure = (
  code: Extract<GeminiPrivateApiListChatsResult, { ok: false }>['code'],
  message: string,
  status?: number | null,
  diagnostics?: GeminiPrivateApiReadDiagnostics,
): GeminiPrivateApiListChatsResult => ({
  ok: false,
  code,
  message,
  adapterPlan: privateApiAdapterPlan(),
  ...(status === undefined ? {} : { status }),
  ...(diagnostics ? { diagnostics } : {}),
});

const sessionFailure = (
  code: Extract<GeminiPrivateApiSessionStatusResult, { ok: false }>['code'],
  message: string,
  status?: number | null,
): GeminiPrivateApiSessionStatusResult => ({
  ok: false,
  authenticated: false,
  code,
  message,
  adapterPlan: privateApiAdapterPlan(),
  ...(status === undefined ? {} : { status }),
});

const privateApiAdapterPlan = () =>
  buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'browserBackground',
    capabilities: [
      browserBackgroundChatReadCapability({
        available: true,
        reason: 'extension_background_fetch_with_browser_credentials',
      }),
      domChatReadCapability({
        available: false,
        reason: 'dom_export_fallback_requires_explicit_mcp_request',
      }),
      takeoutChatReadCapability({
        available: false,
        reason: 'takeout_source_not_available_in_extension_background',
      }),
    ],
  });

const looksLikeGoogleVerificationHtml = (value: string): boolean =>
  /<html[\s>]/i.test(value) &&
  (/\/sorry\//i.test(value) ||
    /CaptchaRedirect/i.test(value) ||
    /unusual traffic/i.test(value) ||
    /detected unusual traffic/i.test(value) ||
    /Our systems have detected/i.test(value) ||
    /<title>\s*Sorry/i.test(value));

const summarizeDecodeDiagnostics = ({
  parseableFrameCount,
  malformedLineCount,
  warnings,
}: GeminiBatchDecodeDiagnostics): GeminiPrivateApiReadDiagnostics => ({
  parseableFrameCount,
  malformedLineCount,
  warnings,
});

const fetchGeminiAppSession = async (fetchImpl: FetchLike) => {
  const appResponse = await fetchImpl('https://gemini.google.com/app', {
    credentials: 'include',
  });
  if (!appResponse.ok) {
    return {
      ok: false as const,
      response: appResponse,
      session: null,
      html: '',
    };
  }
  const html = await appResponse.text();
  return {
    ok: true as const,
    response: appResponse,
    session: extractGeminiPrivateSessionFields(html),
    html,
  };
};

const timestampToIso = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length < 1) return null;
  const seconds = Number(value[0]);
  const nanos = Number(value[1] || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date((seconds + nanos / 1_000_000_000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const listChatsFromPayload = (payload: unknown): GeminiPrivateApiListChat[] => {
  const body =
    payload && typeof payload === 'object' && 'body' in payload
      ? (payload as { body?: unknown }).body
      : payload;
  const chatList = Array.isArray(body) && Array.isArray(body[2]) ? body[2] : [];
  return chatList.flatMap((item): GeminiPrivateApiListChat[] => {
    if (!Array.isArray(item)) return [];
    const privateChatId = String(item[0] || '').trim();
    const chatId = parseChatId(privateChatId);
    if (!chatId) return [];
    return [
      {
        chatId,
        privateChatId,
        title: String(item[1] || '').trim() || null,
        url: canonicalGeminiChatUrl(chatId),
        isPinned: Boolean(item[2]),
        updatedAt: timestampToIso(item[5]),
      },
    ];
  });
};

const mergeListChats = (
  groups: readonly GeminiPrivateApiListChat[][],
): GeminiPrivateApiListChat[] => {
  const seen = new Set<string>();
  const chats: GeminiPrivateApiListChat[] = [];
  for (const group of groups) {
    for (const chat of group) {
      if (seen.has(chat.chatId)) continue;
      seen.add(chat.chatId);
      chats.push(chat);
    }
  }
  return chats;
};

export const readGeminiPrivateChat = async ({
  chatId: rawChatId,
  title,
  fetchImpl = fetch as FetchLike,
  requestId = Date.now() % 100000,
  markdownRenderer = createTurndownMarkdownRenderer(),
}: ReadGeminiPrivateChatInput): Promise<GeminiPrivateApiReadChatResult> => {
  const chatId = parseChatId(rawChatId);
  if (!chatId) {
    return failure(
      'invalid_private_chat_id',
      'Identidade de chat invalida para leitura pela API privada.',
      null,
    );
  }

  try {
    const app = await fetchGeminiAppSession(fetchImpl);
    if (!app.ok) {
      return failure(
        'private_api_app_fetch_failed',
        'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
        chatId,
        app.response.status,
      );
    }

    if (looksLikeGoogleVerificationHtml(app.html)) {
      return failure(
        'google_verification_required',
        'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        chatId,
        app.response.status,
      );
    }

    const session = app.session;
    if (!session.at) {
      return failure(
        'private_api_token_missing',
        'A pagina autenticada do Gemini nao trouxe o token necessario para READ_CHAT.',
        chatId,
      );
    }

    const request = buildGeminiPrivateBatchRequest({
      rpcId: GEMINI_PRIVATE_RPC.READ_CHAT,
      payload: buildGeminiPrivateReadChatPayload(chatId),
      session,
      requestId,
      sourcePath: '/app',
    });
    const rpcResponse = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: 'include',
    });
    if (!rpcResponse.ok) {
      return failure(
        'private_api_rpc_fetch_failed',
        'O endpoint privado READ_CHAT respondeu com erro HTTP.',
        chatId,
        rpcResponse.status,
      );
    }

    const rpcText = await rpcResponse.text();
    if (looksLikeGoogleVerificationHtml(rpcText)) {
      return failure(
        'google_verification_required',
        'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        chatId,
        rpcResponse.status,
      );
    }

    const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
    if (decoded.parseableFrameCount === 0) {
      return failure(
        'private_api_wire_format_changed',
        'O endpoint privado READ_CHAT respondeu em um formato que nao conseguimos decodificar.',
        chatId,
        rpcResponse.status,
        summarizeDecodeDiagnostics(decoded),
      );
    }

    const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.READ_CHAT);
    if (!payload.ok) {
      return failure(
        'private_api_rpc_empty',
        'O endpoint privado READ_CHAT respondeu sem corpo de conversa.',
        chatId,
        payload.status,
        summarizeDecodeDiagnostics(decoded),
      );
    }

    const snapshot = normalizeGeminiPrivateReadChatSnapshot({
      requestedChatId: chatId,
      payload,
      title: title || undefined,
      markdownRenderer,
    });

    return {
      ok: true,
      snapshot,
      markdown: renderChatSnapshotMarkdown({ snapshot }),
      transport: {
        source: 'extension-background-fetch',
        appStatus: app.response.status,
        rpcStatus: payload.status,
      },
      adapterPlan: privateApiAdapterPlan(),
    };
  } catch (err) {
    return failure(
      'private_api_request_failed',
      err instanceof Error ? err.message : String(err),
      chatId as ChatId,
    );
  }
};

export const listGeminiPrivateChats = async ({
  fetchImpl = fetch as FetchLike,
  requestId = Date.now() % 100000,
  limit = 200,
}: ListGeminiPrivateChatsInput = {}): Promise<GeminiPrivateApiListChatsResult> => {
  try {
    const app = await fetchGeminiAppSession(fetchImpl);
    if (!app.ok) {
      return listFailure(
        'private_api_app_fetch_failed',
        'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
        app.response.status,
      );
    }
    if (looksLikeGoogleVerificationHtml(app.html)) {
      return listFailure(
        'google_verification_required',
        'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        app.response.status,
      );
    }
    const session = app.session;
    if (!session.at) {
      return listFailure(
        'private_api_token_missing',
        'A pagina autenticada do Gemini nao trouxe o token necessario para LIST_CHATS.',
      );
    }

    const groups: GeminiPrivateApiListChat[][] = [];
    const statuses: (number | null)[] = [];
    for (const source of [1, 0]) {
      const request = buildGeminiPrivateBatchRequest({
        rpcId: GEMINI_PRIVATE_RPC.LIST_CHATS,
        payload: buildGeminiPrivateListChatsPayload({ limit, source }),
        session,
        requestId: requestId + source,
        sourcePath: '/app',
      });
      const rpcResponse = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: 'include',
      });
      statuses.push(rpcResponse.status);
      if (!rpcResponse.ok) {
        return listFailure(
          'private_api_rpc_fetch_failed',
          'O endpoint privado LIST_CHATS respondeu com erro HTTP.',
          rpcResponse.status,
        );
      }

      const rpcText = await rpcResponse.text();
      if (looksLikeGoogleVerificationHtml(rpcText)) {
        return listFailure(
          'google_verification_required',
          'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
          rpcResponse.status,
        );
      }
      const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
      if (decoded.parseableFrameCount === 0) {
        return listFailure(
          'private_api_wire_format_changed',
          'O endpoint privado LIST_CHATS respondeu em um formato que nao conseguimos decodificar.',
          rpcResponse.status,
          summarizeDecodeDiagnostics(decoded),
        );
      }
      const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.LIST_CHATS);
      if (payload.ok) groups.push(listChatsFromPayload(payload));
    }

    const chats = mergeListChats(groups);
    return {
      ok: true,
      chats,
      count: chats.length,
      transport: {
        source: 'extension-background-fetch',
        appStatus: app.response.status,
        rpcStatuses: statuses,
      },
      adapterPlan: privateApiAdapterPlan(),
    };
  } catch (err) {
    return listFailure(
      'private_api_request_failed',
      err instanceof Error ? err.message : String(err),
    );
  }
};

export const checkGeminiPrivateSession = async ({
  fetchImpl = fetch as FetchLike,
}: CheckGeminiPrivateSessionInput = {}): Promise<GeminiPrivateApiSessionStatusResult> => {
  try {
    const app = await fetchGeminiAppSession(fetchImpl);
    if (!app.ok) {
      return sessionFailure(
        'private_api_app_fetch_failed',
        'Nao consegui carregar a pagina autenticada do Gemini.',
        app.response.status,
      );
    }
    if (looksLikeGoogleVerificationHtml(app.html)) {
      return sessionFailure(
        'google_verification_required',
        'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        app.response.status,
      );
    }
    if (!app.session.at) {
      return sessionFailure(
        'private_api_token_missing',
        'A sessao do navegador nao trouxe o token privado do Gemini.',
      );
    }
    return {
      ok: true,
      authenticated: true,
      transport: {
        source: 'extension-background-fetch',
        appStatus: app.response.status,
      },
      adapterPlan: privateApiAdapterPlan(),
    };
  } catch (err) {
    return sessionFailure(
      'private_api_request_failed',
      err instanceof Error ? err.message : String(err),
    );
  }
};
