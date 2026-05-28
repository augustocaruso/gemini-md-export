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

export type ReadGeminiPrivateChatInput = Readonly<{
  chatId: unknown;
  title?: string | null;
  fetchImpl?: FetchLike;
  requestId?: number;
  markdownRenderer?: MarkdownRenderer;
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
        available: true,
        reason: 'dom_export_fallback_available_from_connected_content_script',
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
    const appResponse = await fetchImpl(canonicalGeminiChatUrl(chatId), {
      credentials: 'include',
    });
    if (!appResponse.ok) {
      return failure(
        'private_api_app_fetch_failed',
        'Nao consegui carregar a pagina autenticada do Gemini para obter token de sessao.',
        chatId,
        appResponse.status,
      );
    }

    const session = extractGeminiPrivateSessionFields(await appResponse.text());
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
        appStatus: appResponse.status,
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
