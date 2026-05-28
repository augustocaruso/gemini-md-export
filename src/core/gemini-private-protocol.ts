import { canonicalGeminiChatUrl, parseChatId } from './chat-id.js';
import { hashText } from './text-hash.js';
import type { ChatAttachment, ChatId, ChatSnapshot, ChatTurn, SanitizedEvidence } from './types.js';

export const GEMINI_PRIVATE_BATCH_ENDPOINT =
  'https://gemini.google.com/_/BardChatUi/data/batchexecute';

export const GEMINI_PRIVATE_RPC = {
  LIST_CHATS: 'MaZiqc',
  READ_CHAT: 'hNvQHb',
} as const;

export type GeminiPrivateRpcId = (typeof GEMINI_PRIVATE_RPC)[keyof typeof GEMINI_PRIVATE_RPC];

export type GeminiPrivateSessionFields = Readonly<{
  at: string;
  bl?: string | null;
  fSid?: string | null;
  hl?: string | null;
}>;

export type GeminiPrivateBatchRequest = Readonly<{
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}>;

export type BuildGeminiPrivateBatchRequestInput = Readonly<{
  rpcId: GeminiPrivateRpcId;
  payload: unknown;
  session: GeminiPrivateSessionFields;
  requestId?: number;
  sourcePath?: string;
}>;

export type GeminiBatchRpcPayload = Readonly<{
  ok: boolean;
  rpcId: string;
  body: unknown;
  status: number | null;
  raw: unknown;
}>;

export type GeminiBatchDecodeDiagnostics = Readonly<{
  frames: unknown[];
  parseableFrameCount: number;
  malformedLineCount: number;
  warnings: readonly string[];
}>;

export type NormalizeGeminiPrivateReadChatSnapshotInput = Readonly<{
  requestedChatId: unknown;
  payload: GeminiBatchRpcPayload | unknown;
  title?: string;
  markdownRenderer?: {
    render(input: { format: 'html' | 'markdown' | 'text'; value: string } | unknown): string;
  };
}>;

const PRIVATE_CHAT_ID_RE = /^c_([a-f0-9]{12,})$/i;

export const toGeminiPrivateChatId = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  const prefixed = text.match(PRIVATE_CHAT_ID_RE)?.[1];
  const chatId = parseChatId(prefixed || text);
  return chatId ? `c_${chatId}` : null;
};

const stripGeminiPrivateChatId = (value: unknown): ChatId | null => {
  const text = String(value ?? '').trim();
  const prefixed = text.match(PRIVATE_CHAT_ID_RE)?.[1];
  return parseChatId(prefixed || text);
};

export const buildGeminiPrivateReadChatPayload = (chatId: unknown, limit = 10): unknown[] => {
  const privateChatId = toGeminiPrivateChatId(chatId);
  if (!privateChatId) throw new Error(`invalid_private_chat_id:${String(chatId || '')}`);
  return [privateChatId, limit, null, 1, [1], [4], null, 1];
};

export const buildGeminiPrivateListChatsPayload = ({
  limit = 10,
  cursor = null,
  source = 0,
}: {
  limit?: number;
  cursor?: string | null;
  source?: number;
} = {}): unknown[] => [limit, null, [source, cursor, 1]];

export const buildGeminiPrivateBatchRequest = ({
  rpcId,
  payload,
  session,
  requestId = 1,
  sourcePath = '/app',
}: BuildGeminiPrivateBatchRequestInput): GeminiPrivateBatchRequest => {
  const url = new URL(GEMINI_PRIVATE_BATCH_ENDPOINT);
  url.searchParams.set('rpcids', rpcId);
  url.searchParams.set('hl', session.hl || 'en');
  url.searchParams.set('_reqid', String(requestId));
  url.searchParams.set('rt', 'c');
  url.searchParams.set('source-path', sourcePath);
  if (session.bl) url.searchParams.set('bl', session.bl);
  if (session.fSid) url.searchParams.set('f.sid', session.fSid);

  const body = new URLSearchParams();
  body.set('at', session.at);
  body.set('f.req', JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]));

  return {
    method: 'POST',
    url: url.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
    },
    body: body.toString(),
  };
};

const uniqueWarnings = (warnings: string[]): string[] => [...new Set(warnings)];

export const decodeGeminiBatchExecuteResponseWithDiagnostics = (
  raw: string,
): GeminiBatchDecodeDiagnostics => {
  const frames: unknown[] = [];
  let malformedLineCount = 0;
  const warnings: string[] = [];
  const frameLines = String(raw || '')
    .replace(/^\)\]\}'\s*/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[') || line.startsWith('{'));

  for (const line of frameLines) {
    try {
      frames.push(JSON.parse(line) as unknown);
    } catch {
      malformedLineCount += 1;
      warnings.push('malformed_json_frame');
    }
  }

  if (frameLines.length === 0) warnings.push('no_json_frames');

  return {
    frames,
    parseableFrameCount: frames.length,
    malformedLineCount,
    warnings: uniqueWarnings(warnings),
  };
};

export const decodeGeminiBatchExecuteResponse = (raw: string): unknown[] =>
  decodeGeminiBatchExecuteResponseWithDiagnostics(raw).frames;

const parseRpcBody = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const rpcStatus = (entry: unknown[]): number | null => {
  const status = entry[5];
  if (Array.isArray(status) && Number.isFinite(Number(status[0]))) return Number(status[0]);
  return null;
};

export const extractGeminiBatchRpcPayload = (
  frames: unknown[],
  rpcId: GeminiPrivateRpcId,
): GeminiBatchRpcPayload => {
  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    for (const entry of frame) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== rpcId) continue;
      const body = parseRpcBody(entry[2]);
      return {
        ok: body !== null,
        rpcId,
        body,
        status: rpcStatus(entry),
        raw: entry,
      };
    }
  }
  return { ok: false, rpcId, body: null, status: null, raw: null };
};

const walk = (value: unknown, visit: (value: unknown) => void) => {
  visit(value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) walk(child, visit);
  }
};

export const extractGeminiPrivateListChatIds = (
  payload: GeminiBatchRpcPayload | unknown,
): Array<{ privateChatId: string; chatId: string }> => {
  const body = isBatchPayload(payload) ? payload.body : payload;
  const seen = new Set<string>();
  const output: Array<{ privateChatId: string; chatId: string }> = [];
  walk(body, (item) => {
    if (typeof item !== 'string') return;
    const privateChatId = toGeminiPrivateChatId(item);
    const chatId = stripGeminiPrivateChatId(item);
    if (!privateChatId || !chatId || seen.has(privateChatId)) return;
    seen.add(privateChatId);
    output.push({ privateChatId, chatId });
  });
  return output;
};

const isBatchPayload = (value: unknown): value is GeminiBatchRpcPayload =>
  Boolean(value && typeof value === 'object' && 'body' in value && 'rpcId' in value);

const looksLikeHtmlFragment = (value: string): boolean =>
  /<\/?[a-z][\s\S]*>/i.test(value) && /[<>]/.test(value);

const renderTextLeaf = (
  value: string,
  renderer?: NormalizeGeminiPrivateReadChatSnapshotInput['markdownRenderer'],
): string => {
  const text = value.trim();
  if (!text) return '';
  if (!renderer) return text;
  return renderer.render({
    format: looksLikeHtmlFragment(text) ? 'html' : 'text',
    value: text,
  });
};

const collectTextLeaves = (
  value: unknown,
  output: string[] = [],
  renderer?: NormalizeGeminiPrivateReadChatSnapshotInput['markdownRenderer'],
): string[] => {
  if (typeof value === 'string') {
    const text = renderTextLeaf(value, renderer).trim();
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      collectTextLeaves(child, output, renderer);
    }
  }
  return output;
};

const textAt = (
  value: unknown,
  renderer?: NormalizeGeminiPrivateReadChatSnapshotInput['markdownRenderer'],
): string => collectTextLeaves(value, [], renderer).join('\n\n');

const candidateText = (
  candidate: unknown,
  renderer?: NormalizeGeminiPrivateReadChatSnapshotInput['markdownRenderer'],
): string => (Array.isArray(candidate) ? textAt(candidate[1], renderer) : '');

const artifactAttachments = (candidate: unknown): ChatAttachment[] => {
  if (!Array.isArray(candidate) || candidate[12] === null || candidate[12] === undefined) {
    return [];
  }
  return [
    {
      kind: 'artifact',
      label: 'Gemini artifact',
      assetRefId: `private-api-artifact:${hashText(JSON.stringify(candidate[12]))}`,
    },
  ];
};

const turnPairsFromBody = (
  body: unknown,
  renderer?: NormalizeGeminiPrivateReadChatSnapshotInput['markdownRenderer'],
): Array<{ user: string; assistant: string; attachments: ChatAttachment[] }> => {
  const turns = Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
  const output: Array<{ user: string; assistant: string; attachments: ChatAttachment[] }> = [];
  for (const turn of turns) {
    if (!Array.isArray(turn)) continue;
    const user = textAt(turn[2], renderer);
    const candidate = Array.isArray(turn[3]) ? turn[3][0] : null;
    const assistant = candidateText(candidate, renderer);
    if (!user && !assistant) continue;
    output.push({
      user,
      assistant,
      attachments: artifactAttachments(candidate),
    });
  }
  return output;
};

const snapshotEvidence = (markdown: string, warnings: string[] = []): SanitizedEvidence => ({
  source: 'gemini-private-api',
  kind: 'read_chat_private_api',
  confidence: markdown.trim() ? 'strong' : 'missing',
  textHash: markdown ? hashText(markdown) : undefined,
  sampleLength: markdown.length,
  warnings,
});

export const normalizeGeminiPrivateReadChatSnapshot = ({
  requestedChatId,
  payload,
  title,
  markdownRenderer,
}: NormalizeGeminiPrivateReadChatSnapshotInput): ChatSnapshot => {
  const chatId = stripGeminiPrivateChatId(requestedChatId);
  if (!chatId) throw new Error(`invalid_private_chat_id:${String(requestedChatId || '')}`);
  const body = isBatchPayload(payload) ? payload.body : payload;
  const pairs = turnPairsFromBody(body, markdownRenderer);
  const turns: ChatTurn[] = [];
  pairs.forEach((pair, index) => {
    if (pair.user) {
      turns.push({
        role: 'user',
        markdown: pair.user,
        textHash: hashText(pair.user),
        sourceOrder: index * 2,
        attachments: [],
      });
    }
    if (pair.assistant) {
      turns.push({
        role: 'assistant',
        markdown: pair.assistant,
        textHash: hashText(pair.assistant),
        sourceOrder: index * 2 + 1,
        attachments: pair.attachments,
      });
    }
  });

  const assistantMarkdown = turns
    .filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.markdown)
    .join('\n\n');

  return {
    chatId,
    title: title || String(chatId),
    url: canonicalGeminiChatUrl(chatId),
    turns,
    metadata: {
      assistantTurnCount: turns.filter((turn) => turn.role === 'assistant').length,
    },
    evidence: [snapshotEvidence(assistantMarkdown)],
  };
};
