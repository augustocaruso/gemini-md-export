import { canonicalGeminiChatUrl, parseChatId } from '../core/chat-id.js';
import { portableIsoSeconds } from '../core/date.js';
import { assistantTurnCount, sectionsForRole } from '../core/markdown-note.js';
import { hashText } from '../core/text-hash.js';
import type {
  BlockedResult,
  ChatId,
  ChatSnapshot,
  ChatTurn,
  SanitizedEvidence,
} from '../core/types.js';
import { parseFrontmatter } from '../core/yaml.js';

export type BrowserExportPayload = {
  chatId?: unknown;
  title?: unknown;
  url?: unknown;
  filename?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  turns?: unknown;
  metrics?: {
    counters?: {
      turnCount?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export type McpExportValidationInput = {
  expectedChatId?: unknown;
  requestedChatId?: unknown;
};

export type McpExportValidation =
  | {
      ok: true;
      snapshot: ChatSnapshot;
      markdownHash: string;
      assistantTurnCount: number;
      evidence: SanitizedEvidence[];
      warnings: string[];
    }
  | BlockedResult;

export const validateExportTabLease = (tab: unknown) => {
  const value = tab as {
    claimId?: unknown;
    tabId?: unknown;
    url?: unknown;
    visual?: unknown;
  } | null;
  const tabId = Number(value?.tabId);
  const url = stringValue(value?.url);
  const claimId = stringValue(value?.claimId);
  if (!claimId || !Number.isInteger(tabId) || !url.startsWith('https://gemini.google.com/')) {
    throw Object.assign(new Error('claimed_debuggable_tab_required'), {
      code: 'claimed_debuggable_tab_required',
    });
  }
  return { claimId, tabId, url, visual: value?.visual || null };
};

export const exportTabLeaseFromNativeClaimResult = (result: unknown) => {
  const value = result as {
    tab?: Record<string, unknown> | null;
    visual?: unknown;
  } | null;
  return {
    ...(value?.tab || (value as Record<string, unknown> | null) || {}),
    visual: value?.visual || value?.tab?.visual || null,
  };
};

const markdownContentOf = (payload: BrowserExportPayload = {}): string => {
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.contentBase64 === 'string') {
    return Buffer.from(payload.contentBase64, 'base64').toString('utf-8');
  }
  return '';
};

const evidence = (
  kind: string,
  confidence: SanitizedEvidence['confidence'],
  markdown: string,
  warnings: string[] = [],
): SanitizedEvidence => ({
  source: 'chat-dom',
  kind,
  confidence,
  textHash: markdown ? hashText(markdown) : undefined,
  sampleLength: markdown.length,
  warnings,
});

const blocked = (
  code: BlockedResult['code'],
  message: string,
  markdown: string,
  extras: Partial<BlockedResult> = {},
): BlockedResult => ({
  ok: false,
  code,
  message,
  evidence: [evidence(code, 'missing', markdown, [message])],
  ...extras,
});

const stringValue = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

const turnRoleOf = (turn: unknown): ChatTurn['role'] | null => {
  const role = stringValue((turn as { role?: unknown })?.role).toLowerCase();
  if (role === 'user' || role === 'assistant') return role;
  return null;
};

const turnMarkdownOf = (turn: unknown): string => {
  const value = turn as { markdown?: unknown; text?: unknown; content?: unknown };
  return stringValue(value?.markdown || value?.text || value?.content).trim();
};

const turnsFromPayload = (turns: unknown): ChatTurn[] => {
  if (!Array.isArray(turns)) return [];
  return turns
    .map((turn, index): ChatTurn | null => {
      const role = turnRoleOf(turn);
      const markdown = turnMarkdownOf(turn);
      if (!role || !markdown) return null;
      return {
        role,
        markdown,
        textHash: hashText(markdown),
        sourceOrder: index,
        attachments: [],
      };
    })
    .filter((turn): turn is ChatTurn => turn !== null);
};

const turnsFromMarkdownBody = (body: string): ChatTurn[] => {
  const userTurns = sectionsForRole(body, 'user').map(
    (markdown, index): ChatTurn => ({
      role: 'user',
      markdown,
      textHash: hashText(markdown),
      sourceOrder: index * 2,
      attachments: [],
    }),
  );
  const assistantTurns = sectionsForRole(body, 'assistant').map(
    (markdown, index): ChatTurn => ({
      role: 'assistant',
      markdown,
      textHash: hashText(markdown),
      sourceOrder: index * 2 + 1,
      attachments: [],
    }),
  );
  return [...userTurns, ...assistantTurns].sort((a, b) => a.sourceOrder - b.sourceOrder);
};

const parseChatIdFromFilename = (filename: unknown): ChatId | null => {
  const text = stringValue(filename).replace(/\.md$/i, '');
  return parseChatId(text);
};

export const validateMcpExportPayloadBeforeWrite = (
  payload: BrowserExportPayload = {},
  input: McpExportValidationInput = {},
): McpExportValidation => {
  const markdown = markdownContentOf(payload);
  if (!markdown.trim()) {
    return blocked(
      'empty_chat',
      'Exportacao abortada: a extensao nao retornou Markdown para salvar. Nenhum arquivo foi salvo.',
      markdown,
    );
  }

  const parsed = parseFrontmatter(markdown);
  const expectedChatId = parseChatId(input.expectedChatId);
  const requestedChatId = parseChatId(input.requestedChatId);
  const payloadChatId = parseChatId(payload.chatId);
  const frontmatterChatId = parseChatId(parsed.data.chat_id || parsed.data.url);
  const urlChatId = parseChatId(payload.url || parsed.data.url);
  const filenameChatId = parseChatIdFromFilename(payload.filename);
  const observedChatId = payloadChatId || frontmatterChatId || urlChatId || filenameChatId;

  if (!observedChatId) {
    return blocked(
      'identity_unproven',
      'Exportacao abortada: a extensao nao retornou um chatId comprovado. Nenhum arquivo foi salvo.',
      markdown,
      {
        requestedChatId: stringValue(input.expectedChatId || input.requestedChatId) || undefined,
      },
    );
  }

  const expected = expectedChatId || requestedChatId;
  if (expected && expected !== observedChatId) {
    return blocked(
      'chat_id_mismatch',
      `Exportacao abortada: o browser retornou o chat ${observedChatId}, mas o MCP pediu ${expected}. Nenhum arquivo foi salvo.`,
      markdown,
      {
        requestedChatId: expected,
        observedChatId,
      },
    );
  }

  for (const candidate of [frontmatterChatId, urlChatId, filenameChatId].filter(Boolean)) {
    if (candidate !== observedChatId) {
      return blocked(
        'chat_id_mismatch',
        `Exportacao abortada: os metadados retornados pela extensao misturam chats diferentes (${observedChatId} e ${candidate}). Nenhum arquivo foi salvo.`,
        markdown,
        {
          requestedChatId: expected || undefined,
          observedChatId,
        },
      );
    }
  }

  const bodyAssistantTurns = assistantTurnCount(parsed.body);
  const metricTurnCount = Number(payload.metrics?.counters?.turnCount);
  const declaredTurnCount = Number(parsed.data.turn_count);
  const assistantCount =
    bodyAssistantTurns || (Number.isFinite(metricTurnCount) ? metricTurnCount : 0);
  if (assistantCount <= 0) {
    return blocked(
      'empty_chat',
      `Exportacao abortada: a conversa ${observedChatId} nao tem resposta do Gemini no Markdown retornado. Nenhum arquivo foi salvo.`,
      markdown,
      {
        requestedChatId: expected || undefined,
        observedChatId,
      },
    );
  }

  const warnings: string[] = [];
  if (Number.isFinite(declaredTurnCount) && declaredTurnCount !== bodyAssistantTurns) {
    warnings.push('turn_count_frontmatter_differs_from_body');
  }
  if (Number.isFinite(metricTurnCount) && metricTurnCount !== bodyAssistantTurns) {
    warnings.push('turn_count_metric_differs_from_body');
  }

  const turns = turnsFromPayload(payload.turns);
  const snapshotTurns = turns.length > 0 ? turns : turnsFromMarkdownBody(parsed.body);
  const markdownHash = hashText(markdown);
  const sanitizedEvidence = [
    evidence('mcp_export_payload_integrity', 'strong', markdown, warnings),
  ];

  return {
    ok: true,
    snapshot: {
      chatId: observedChatId,
      title: stringValue(payload.title || parsed.data.title || observedChatId),
      url: stringValue(payload.url || parsed.data.url || canonicalGeminiChatUrl(observedChatId)),
      turns: snapshotTurns,
      metadata: {
        model: parsed.data.model ? stringValue(parsed.data.model) : undefined,
        dateCreated: portableIsoSeconds(parsed.data.date_created) || undefined,
        dateLastMessage: portableIsoSeconds(parsed.data.date_last_message) || undefined,
        dateExported:
          portableIsoSeconds(parsed.data.date_exported || parsed.data.exported_at) || undefined,
        assistantTurnCount: bodyAssistantTurns,
      },
      evidence: sanitizedEvidence,
    },
    markdownHash,
    assistantTurnCount: bodyAssistantTurns,
    evidence: sanitizedEvidence,
    warnings,
  };
};
