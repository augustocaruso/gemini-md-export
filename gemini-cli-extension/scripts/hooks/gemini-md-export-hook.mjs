#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const mode = process.argv[2] || '';

const SESSION_CONTEXT = [
  'Gemini MD Export: use the gemini-md-export MCP tools for browser status, listing, downloads, and batch exports.',
  'Treat media as complete only when mediaFailureCount is 0. If a media warning appears and mediaFileCount is 0, investigate before saying images were imported.',
  'Forbidden paths for this project: Gemini cookies, private/internal Gemini APIs, chrome.debugger, captureVisibleTab, screenshot/crop media fallbacks, and new browser permissions.',
].join('\n');

const BLOCK_REASON =
  'Bloqueado pelo gemini-md-export: este caminho esta fora do escopo combinado. Use DOM atual, data/blob, fetch permitido, bridge/background existente ou lightbox controlado; se nao houver bytes legiveis, mantenha um warning honesto.';

const MEDIA_WARNING_RE =
  /\[!warning\]\s*M[ií]dia n[aã]o importada|M[ií]dia n[aã]o exportada|media n(?:ao|ão) importad/i;

const readInput = () => {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch (err) {
    console.error(`[gemini-md-export-hook] failed to read stdin: ${err.message}`);
    return {};
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[gemini-md-export-hook] invalid JSON stdin: ${err.message}`);
    return {};
  }
};

const writeJson = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const silent = () => ({ suppressOutput: true });

const contextOutput = (additionalContext) => ({
  suppressOutput: true,
  hookSpecificOutput: {
    hookEventName: hookEventNameForMode(),
    additionalContext,
  },
});

const hookEventNameForMode = () => {
  if (mode === 'session-start') return 'SessionStart';
  if (mode === 'after-tool') return 'AfterTool';
  if (mode === 'before-tool') return 'BeforeTool';
  return 'Unknown';
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getToolName = (input) =>
  input?.tool_name ||
  input?.toolName ||
  input?.tool?.name ||
  input?.original_request_name ||
  input?.originalRequestName ||
  '';

const getToolInput = (input) =>
  input?.tool_input ||
  input?.toolInput ||
  input?.tool?.input ||
  input?.arguments ||
  input?.args ||
  {};

const getToolResponse = (input) =>
  input?.tool_response ||
  input?.toolResponse ||
  input?.response ||
  input?.result ||
  {};

const collectText = (value, out = []) => {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectText(item, out);
  }
  return out;
};

const parseJsonLikeStrings = (value) => {
  const parsed = [];
  for (const text of collectText(value)) {
    const trimmed = text.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Some tool fields are regular prose. Advisory hooks must fail open.
    }
  }
  return parsed;
};

const responseCandidates = (response) => {
  const candidates = [response];
  if (response?.structuredContent) candidates.push(response.structuredContent);
  if (response?.llmContent) candidates.push(response.llmContent);
  if (response?.returnDisplay) candidates.push(response.returnDisplay);
  if (Array.isArray(response?.content)) {
    for (const item of response.content) {
      if (item?.text) candidates.push(item.text);
    }
  }
  for (const parsed of parseJsonLikeStrings(response)) candidates.push(parsed);
  return candidates;
};

const findFirstNumber = (value, keys) => {
  if (value == null) return null;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumber(item, keys);
      if (found != null) return found;
    }
    return null;
  }

  for (const key of keys) {
    const current = value[key];
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.length;
  }

  for (const item of Object.values(value)) {
    const found = findFirstNumber(item, keys);
    if (found != null) return found;
  }
  return null;
};

const hasMediaWarning = (value) => collectText(value).some((text) => MEDIA_WARNING_RE.test(text));

const hasBrowserBridgeProblem = (value) => {
  const text = collectText(value).join('\n').toLowerCase();
  return (
    text.includes('chrome_extension_') ||
    text.includes('build_mismatch') ||
    text.includes('bridge_unreachable') ||
    text.includes('nenhuma aba do gemini conectada') ||
    text.includes('extensao do navegador') ||
    text.includes('extensao chrome')
  );
};

const analyzeToolResponse = (response) => {
  const candidates = responseCandidates(response);
  let mediaFailureCount = null;
  let mediaFileCount = null;
  let mediaWarning = false;
  let bridgeProblem = false;

  for (const candidate of candidates) {
    if (mediaFailureCount == null) {
      mediaFailureCount = findFirstNumber(candidate, ['mediaFailureCount', 'mediaFailures']);
    }
    if (mediaFileCount == null) {
      mediaFileCount = findFirstNumber(candidate, ['mediaFileCount', 'mediaFiles']);
    }
    mediaWarning = mediaWarning || hasMediaWarning(candidate);
    bridgeProblem = bridgeProblem || hasBrowserBridgeProblem(candidate);
  }

  return {
    mediaFailureCount: mediaFailureCount ?? 0,
    mediaFileCount: mediaFileCount ?? 0,
    mediaWarning,
    bridgeProblem,
  };
};

const afterTool = (input) => {
  const toolName = getToolName(input);
  const response = getToolResponse(input);
  const analysis = analyzeToolResponse(response);

  const notes = [];
  if (analysis.mediaFailureCount > 0) {
    notes.push(
      `A tool ${toolName || 'gemini-md-export'} retornou mediaFailureCount=${analysis.mediaFailureCount}. Nao declare que as imagens foram importadas sem explicar esses warnings e, se fizer sentido, inspecione status/snapshot antes de concluir.`,
    );
  }
  if (analysis.mediaWarning && analysis.mediaFileCount === 0) {
    notes.push(
      `A tool ${toolName || 'gemini-md-export'} gerou warning de midia e mediaFileCount=0. Trate isso como falha real de importacao de imagens, nao como sucesso parcial.`,
    );
  }
  if (analysis.bridgeProblem) {
    notes.push(
      'A resposta sugere problema de bridge/extensao do navegador. Antes de repetir a mesma exportacao, cheque gemini_browser_status e considere update/restart do Gemini CLI ou reload manual do card da extensao.',
    );
  }

  if (notes.length === 0) return silent();
  return contextOutput(notes.join('\n'));
};

const normalizedPayloadText = (input) => {
  const toolName = getToolName(input);
  const toolInput = getToolInput(input);
  const prompt = input?.prompt || input?.user_prompt || input?.message || '';
  return `${toolName}\n${safeStringify(toolInput)}\n${prompt}`.toLowerCase();
};

const forbiddenReason = (input) => {
  const text = normalizedPayloadText(input);

  if (/\bchrome\.debugger\b|chrome-debugger|debugger permission/.test(text)) {
    return BLOCK_REASON;
  }

  if (/capturevisibletab|capture-visible-tab|imageelementscreenshottoasset/.test(text)) {
    return BLOCK_REASON;
  }

  if (
    /(screenshot|captura visual|captura de tela|fallback visual|crop|recorte)/.test(text) &&
    /(gemini|midia|media|imagem|image|export)/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /(cookie|cookies)/.test(text) &&
    /(gemini|googleusercontent|lh3|bard|google)/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /bardfrontendservice|batchexecute|snlm0e|internal api|api interna|private gemini api/.test(text)
  ) {
    return BLOCK_REASON;
  }

  if (
    /["']?(permissions|optional_permissions)["']?\s*:\s*\[[\s\S]{0,500}\b(debugger|downloads|cookies|webrequest|declarativenetrequest)\b/.test(
      text,
    )
  ) {
    return BLOCK_REASON;
  }

  return null;
};

const beforeTool = (input) => {
  const reason = forbiddenReason(input);
  if (!reason) return silent();
  return {
    suppressOutput: true,
    decision: 'deny',
    reason,
  };
};

const run = () => {
  const input = readInput();
  if (mode === 'session-start') return contextOutput(SESSION_CONTEXT);
  if (mode === 'after-tool') return afterTool(input);
  if (mode === 'before-tool') return beforeTool(input);
  return silent();
};

try {
  writeJson(run());
} catch (err) {
  console.error(`[gemini-md-export-hook] unexpected failure: ${err.message}`);
  writeJson(silent());
}
