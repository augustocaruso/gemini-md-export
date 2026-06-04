import { canonicalGeminiChatUrl, parseChatId } from '../../core/chat-id.js';
import {
  buildGeminiPrivateBatchRequest,
  buildGeminiPrivateListChatsPayload,
  buildGeminiPrivateReadChatPayload,
  decodeGeminiBatchExecuteResponseWithDiagnostics,
  extractGeminiBatchRpcPayload,
  GEMINI_PRIVATE_RPC,
  normalizeGeminiPrivateReadChatSnapshot,
} from '../../core/gemini-private-protocol.js';
import {
  extractGeminiPrivateSessionFields,
  looksLikeGoogleVerificationHtml,
} from '../../core/gemini-private-session.js';
import type { ChatSnapshot } from '../../core/types.js';

declare const buildFrontmatter:
  | undefined
  | ((input: {
      chatId: string;
      title?: string | null;
      url: string;
      turnCount?: number | null;
    }) => string);

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'include';
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

type ContentPrivateReadResult =
  | {
      ok: true;
      snapshot: ChatSnapshot;
      markdown: string;
      chats?: never;
      count?: never;
      transport: { source: 'content-fetch'; appStatus: number; rpcStatus: number | null };
    }
  | {
      ok: false;
      authenticated?: false;
      code: string;
      message: string;
      chatId?: string | null;
      status?: number | null;
    };

type ContentPrivateListChat = Readonly<{
  chatId: string;
  privateChatId: string;
  title: string | null;
  url: string;
  isPinned: boolean;
  updatedAt: string | null;
}>;

type ContentPrivateListResult =
  | {
      ok: true;
      chats: readonly ContentPrivateListChat[];
      count: number;
      transport: {
        source: 'content-fetch';
        appStatus: number;
        rpcStatuses: readonly (number | null)[];
      };
    }
  | ContentPrivateReadResult;

const normalizeContentPrivateTimeoutMs = (value: unknown, fallbackMs: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackMs;
  return Math.max(1, Math.min(120_000, numeric));
};

const timeoutError = (): Error =>
  Object.assign(new Error('Tempo esgotado ao consultar a API privada do Gemini.'), {
    name: 'AbortError',
  });

const contentPrivateWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Ignore abort races.
      }
      reject(timeoutError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

const contentPrivateFetchWithTimeout = async (
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
) => {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  return contentPrivateWithTimeout(
    fetchImpl(url, {
      ...(init || {}),
      ...(controller ? { signal: controller.signal } : {}),
    }),
    timeoutMs,
    () => controller?.abort(),
  );
};

const contentPrivateReadTextWithTimeout = (
  response: Awaited<ReturnType<FetchLike>>,
  timeoutMs: number,
): Promise<string> => contentPrivateWithTimeout(response.text(), timeoutMs);

const contentPrivateRequestFailureMessage = (err: unknown): string => {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'Tempo esgotado ao consultar a API privada do Gemini.';
  }
  return err instanceof Error ? err.message : String(err);
};

const markdownRoleHeading = (role: string): string =>
  role === 'user' ? '## 🧑 Usuário' : '## 🤖 Gemini';

const renderSnapshotMarkdownInContent = (snapshot: ChatSnapshot): string => {
  const frontmatter =
    typeof buildFrontmatter === 'function'
      ? buildFrontmatter({
          chatId: snapshot.chatId,
          title: snapshot.title,
          url: snapshot.url,
          turnCount: snapshot.metadata?.assistantTurnCount,
        })
      : `---\ntype: gemini_chat\nchat_id: ${snapshot.chatId}\ntitle: "${snapshot.title}"\nurl: ${snapshot.url}\ntags: [gemini-export]\n---\n\n`;
  const body = snapshot.turns
    .slice()
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((turn) => `${markdownRoleHeading(turn.role)}\n\n${String(turn.markdown || '').trim()}`)
    .join('\n\n---\n\n');
  return `${frontmatter}${body.trim()}\n`;
};

const fetchAppSessionInContent = async (fetchImpl: FetchLike, timeoutMs: number) => {
  const response = await contentPrivateFetchWithTimeout(
    fetchImpl,
    'https://gemini.google.com/app',
    { credentials: 'include' },
    timeoutMs,
  );
  if (!response.ok) return { ok: false as const, response, html: '', session: null };
  const html = await contentPrivateReadTextWithTimeout(response, timeoutMs);
  return {
    ok: true as const,
    response,
    html,
    session: extractGeminiPrivateSessionFields(html),
  };
};

const contentPrivateTimestampToIso = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length < 1) return null;
  const seconds = Number(value[0]);
  const nanos = Number(value[1] || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date((seconds + nanos / 1_000_000_000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const listChatsFromPayload = (payload: unknown): ContentPrivateListChat[] => {
  const body =
    payload && typeof payload === 'object' && 'body' in payload
      ? (payload as { body?: unknown }).body
      : payload;
  const chatList = Array.isArray(body) && Array.isArray(body[2]) ? body[2] : [];
  return chatList.flatMap((item): ContentPrivateListChat[] => {
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
        updatedAt: contentPrivateTimestampToIso(item[5]),
      },
    ];
  });
};

const mergeContentPrivateChats = (
  groups: readonly ContentPrivateListChat[][],
): ContentPrivateListChat[] => {
  const seen = new Set<string>();
  const chats: ContentPrivateListChat[] = [];
  for (const group of groups) {
    for (const chat of group) {
      if (seen.has(chat.chatId)) continue;
      seen.add(chat.chatId);
      chats.push(chat);
    }
  }
  return chats;
};

export const checkGeminiPrivateSessionFromContent = async ({
  fetchImpl = fetch as FetchLike,
  timeoutMs: rawTimeoutMs,
}: {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<ContentPrivateReadResult> => {
  try {
    const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 20_000);
    const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
    if (!app.ok) {
      return {
        ok: false,
        authenticated: false,
        code: 'private_api_app_fetch_failed',
        message: 'Nao consegui carregar a pagina autenticada do Gemini.',
        status: app.response.status,
      };
    }
    if (looksLikeGoogleVerificationHtml(app.html)) {
      return {
        ok: false,
        authenticated: false,
        code: 'google_verification_required',
        message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        status: app.response.status,
      };
    }
    if (!app.session.at) {
      return {
        ok: false,
        authenticated: false,
        code: 'private_api_token_missing',
        message: 'A sessao do navegador nao trouxe o token privado do Gemini.',
      };
    }
    return {
      ok: true,
      authenticated: true,
      transport: { source: 'content-fetch', appStatus: app.response.status, rpcStatus: null },
    } as ContentPrivateReadResult & { authenticated: true };
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      code: 'private_api_request_failed',
      message: contentPrivateRequestFailureMessage(err),
    };
  }
};

export const readGeminiPrivateChatFromContent = async ({
  chatId: rawChatId,
  title,
  fetchImpl = fetch as FetchLike,
  requestId = Date.now() % 100000,
  timeoutMs: rawTimeoutMs,
}: {
  chatId: unknown;
  title?: string | null;
  fetchImpl?: FetchLike;
  requestId?: number;
  timeoutMs?: number;
}): Promise<ContentPrivateReadResult> => {
  const chatId = parseChatId(rawChatId);
  if (!chatId) {
    return {
      ok: false,
      code: 'invalid_private_chat_id',
      message: 'Identidade de chat invalida para leitura pela API privada.',
      chatId: null,
    };
  }

  try {
    const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 30_000);
    const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
    if (!app.ok) {
      return {
        ok: false,
        code: 'private_api_app_fetch_failed',
        message: 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
        chatId,
        status: app.response.status,
      };
    }
    if (looksLikeGoogleVerificationHtml(app.html)) {
      return {
        ok: false,
        code: 'google_verification_required',
        message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        chatId,
        status: app.response.status,
      };
    }
    if (!app.session.at) {
      return {
        ok: false,
        code: 'private_api_token_missing',
        message: 'A pagina autenticada do Gemini nao trouxe o token necessario para READ_CHAT.',
        chatId,
      };
    }

    const request = buildGeminiPrivateBatchRequest({
      rpcId: GEMINI_PRIVATE_RPC.READ_CHAT,
      payload: buildGeminiPrivateReadChatPayload(chatId),
      session: app.session,
      requestId,
      sourcePath: '/app',
    });
    const rpcResponse = await contentPrivateFetchWithTimeout(
      fetchImpl,
      request.url,
      {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: 'include',
      },
      timeoutMs,
    );
    if (!rpcResponse.ok) {
      return {
        ok: false,
        code: 'private_api_rpc_fetch_failed',
        message: 'O endpoint privado READ_CHAT respondeu com erro HTTP.',
        chatId,
        status: rpcResponse.status,
      };
    }
    const rpcText = await contentPrivateReadTextWithTimeout(rpcResponse, timeoutMs);
    if (looksLikeGoogleVerificationHtml(rpcText)) {
      return {
        ok: false,
        code: 'google_verification_required',
        message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        chatId,
        status: rpcResponse.status,
      };
    }
    const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
    if (decoded.parseableFrameCount === 0) {
      return {
        ok: false,
        code: 'private_api_wire_format_changed',
        message:
          'O endpoint privado READ_CHAT respondeu em um formato que nao conseguimos decodificar.',
        chatId,
        status: rpcResponse.status,
      };
    }
    const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.READ_CHAT);
    if (!payload.ok) {
      return {
        ok: false,
        code: 'private_api_rpc_empty',
        message: 'O endpoint privado READ_CHAT respondeu sem corpo de conversa.',
        chatId,
        status: payload.status,
      };
    }
    const snapshot = normalizeGeminiPrivateReadChatSnapshot({
      requestedChatId: chatId,
      payload,
      title: title || undefined,
    });
    return {
      ok: true,
      snapshot,
      markdown: renderSnapshotMarkdownInContent(snapshot),
      transport: {
        source: 'content-fetch',
        appStatus: app.response.status,
        rpcStatus: payload.status,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'private_api_request_failed',
      message: contentPrivateRequestFailureMessage(err),
      chatId,
    };
  }
};

export const listGeminiPrivateChatsFromContent = async ({
  fetchImpl = fetch as FetchLike,
  requestId = Date.now() % 100000,
  limit = 200,
  timeoutMs: rawTimeoutMs,
}: {
  fetchImpl?: FetchLike;
  requestId?: number;
  limit?: number;
  timeoutMs?: number;
} = {}): Promise<ContentPrivateListResult> => {
  try {
    const timeoutMs = normalizeContentPrivateTimeoutMs(rawTimeoutMs, 30_000);
    const app = await fetchAppSessionInContent(fetchImpl, timeoutMs);
    if (!app.ok) {
      return {
        ok: false,
        code: 'private_api_app_fetch_failed',
        message: 'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
        status: app.response.status,
      };
    }
    if (looksLikeGoogleVerificationHtml(app.html)) {
      return {
        ok: false,
        code: 'google_verification_required',
        message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
        status: app.response.status,
      };
    }
    if (!app.session.at) {
      return {
        ok: false,
        code: 'private_api_token_missing',
        message: 'A pagina autenticada do Gemini nao trouxe o token necessario para LIST_CHATS.',
      };
    }

    const groups: ContentPrivateListChat[][] = [];
    const statuses: (number | null)[] = [];
    for (const source of [1, 0]) {
      const request = buildGeminiPrivateBatchRequest({
        rpcId: GEMINI_PRIVATE_RPC.LIST_CHATS,
        payload: buildGeminiPrivateListChatsPayload({ limit, source }),
        session: app.session,
        requestId: requestId + source,
        sourcePath: '/app',
      });
      const rpcResponse = await contentPrivateFetchWithTimeout(
        fetchImpl,
        request.url,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: 'include',
        },
        timeoutMs,
      );
      statuses.push(rpcResponse.status);
      if (!rpcResponse.ok) {
        return {
          ok: false,
          code: 'private_api_rpc_fetch_failed',
          message: 'O endpoint privado LIST_CHATS respondeu com erro HTTP.',
          status: rpcResponse.status,
        };
      }
      const rpcText = await contentPrivateReadTextWithTimeout(rpcResponse, timeoutMs);
      if (looksLikeGoogleVerificationHtml(rpcText)) {
        return {
          ok: false,
          code: 'google_verification_required',
          message: 'O Google exigiu verificacao antes de liberar o endpoint privado do Gemini.',
          status: rpcResponse.status,
        };
      }
      const decoded = decodeGeminiBatchExecuteResponseWithDiagnostics(rpcText);
      const payload = extractGeminiBatchRpcPayload(decoded.frames, GEMINI_PRIVATE_RPC.LIST_CHATS);
      if (payload.ok) groups.push(listChatsFromPayload(payload));
    }
    const chats = mergeContentPrivateChats(groups);
    return {
      ok: true,
      chats,
      count: chats.length,
      transport: { source: 'content-fetch', appStatus: app.response.status, rpcStatuses: statuses },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'private_api_request_failed',
      message: contentPrivateRequestFailureMessage(err),
    };
  }
};
