#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47283';
const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;

const parseArgs = (argv) => {
  const args = {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    outputDir: '',
    json: false,
    keepOutput: false,
    limit: 10,
    timeoutMs: 15_000,
    refresh: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Valor ausente para ${arg}`);
      return argv[index];
    };
    if (arg === '--bridge-url') args.bridgeUrl = value().replace(/\/+$/, '');
    else if (arg === '--output-dir') args.outputDir = value();
    else if (arg === '--json') args.json = true;
    else if (arg === '--keep-output') args.keepOutput = true;
    else if (arg === '--limit') args.limit = Math.max(1, Math.min(50, Number(value()) || 10));
    else if (arg === '--timeout-ms') args.timeoutMs = Math.max(1000, Number(value()) || 15_000);
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Uso:
  node scripts/smoke-export-integrity.mjs [--bridge-url ${DEFAULT_BRIDGE_URL}] [--output-dir <dir>] [--json]

Valida um export real sem chatId fixo: readiness da bridge, primeira conversa exportavel,
arquivo Markdown salvo, frontmatter, URL, turn_count e integridade sanitizada.
`);
      process.exit(0);
    } else {
      throw new Error(`Opcao desconhecida: ${arg}`);
    }
  }
  return args;
};

const parseChatId = (value) => {
  const text = String(value || '').trim();
  const route = text.match(/\/app\/([a-f0-9]{12,})(?:[/?#]|$)/i)?.[1];
  const prefixed = text.match(/^c_([a-f0-9]{12,})$/i)?.[1];
  const raw = CHAT_ID_RE.test(text) ? text : '';
  return (route || prefixed || raw || '').toLowerCase();
};

const fetchJson = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP ${response.status} em ${url}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

const get = (bridgeUrl, pathname, params, timeoutMs) => {
  const url = new URL(pathname, bridgeUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return fetchJson(url.href, timeoutMs);
};

const firstExportableConversation = (conversations = []) =>
  conversations.find((item) => parseChatId(item?.chatId || item?.url || item?.id));

const parseFrontmatter = (content) => {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  const data = {};
  for (const line of content.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return data;
};

const assistantTurnCount = (content) => (content.match(/^##\s*🤖\s*Gemini\b/gm) || []).length;

const validateSavedMarkdown = ({ filePath, expectedChatId, download }) => {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const frontmatterChatId = parseChatId(frontmatter.chat_id || frontmatter.url);
  const urlChatId = parseChatId(frontmatter.url);
  const filenameChatId = parseChatId(basename(filePath, '.md'));
  const bodyAssistantTurns = assistantTurnCount(content);
  const integrityAssistantTurns = Number(download?.integrity?.assistantTurnCount || 0);
  const issues = [];

  if (!frontmatterChatId) issues.push('frontmatter_chat_id_missing');
  if (frontmatterChatId && frontmatterChatId !== expectedChatId) issues.push('frontmatter_chat_id_mismatch');
  if (urlChatId && urlChatId !== expectedChatId) issues.push('url_chat_id_mismatch');
  if (filenameChatId && filenameChatId !== expectedChatId) issues.push('filename_chat_id_mismatch');
  if (bodyAssistantTurns <= 0) issues.push('assistant_turns_missing');
  if (integrityAssistantTurns > 0 && integrityAssistantTurns !== bodyAssistantTurns) {
    issues.push('integrity_turn_count_mismatch');
  }
  if (/chat-[01]\b/.test(content) || /chat-[01]\b/.test(basename(filePath))) {
    issues.push('synthetic_chat_id_detected');
  }

  return {
    ok: issues.length === 0,
    issues,
    chatId: frontmatterChatId,
    urlChatId,
    filenameChatId,
    assistantTurnCount: bodyAssistantTurns,
    integrity: download?.integrity || null,
  };
};

const failure = (code, message, details = {}) => ({
  ok: false,
  code,
  message,
  ...details,
});

const run = async (args) => {
  const createdOutputDir = !args.outputDir;
  const outputDir = args.outputDir || mkdtempSync(resolve(tmpdir(), 'gemini-md-export-smoke-'));
  try {
    const ready = await get(
      args.bridgeUrl,
      '/agent/ready',
      {
        wakeBrowser: false,
        selfHeal: false,
        allowReload: false,
        waitMs: 2000,
      },
      args.timeoutMs,
    );
    if (ready?.ok !== true && ready?.ready !== true) {
      return failure('bridge_not_ready', 'Bridge/extensao ainda nao estao prontas para exportar.', {
        outputDir,
        ready,
      });
    }

    const recent = await get(
      args.bridgeUrl,
      '/agent/recent-chats',
      {
        limit: args.limit,
        offset: 0,
        refresh: args.refresh,
      },
      args.timeoutMs,
    );
    const conversation = firstExportableConversation(recent?.conversations || []);
    if (!conversation) {
      return failure('no_exportable_chat', 'Nenhuma conversa recente com chatId comprovado foi encontrada.', {
        outputDir,
        pagination: recent?.pagination || null,
        knownLoadedCount: recent?.knownLoadedCount || 0,
      });
    }

    const chatId = parseChatId(conversation.chatId || conversation.url || conversation.id);
    const download = await get(
      args.bridgeUrl,
      '/agent/download-chat',
      {
        chatId,
        outputDir,
        returnToOriginal: true,
        hydrationTimeoutMs: 45_000,
        exportCommandTimeoutMs: 90_000,
      },
      Math.max(args.timeoutMs, 90_000),
    );
    const filePath = download?.filePath;
    if (!filePath) {
      return failure('export_failed', 'A bridge nao retornou o arquivo salvo pelo export.', {
        outputDir,
        chatId,
        download,
      });
    }

    const validation = validateSavedMarkdown({
      filePath,
      expectedChatId: chatId,
      download,
    });
    if (!validation.ok) {
      return failure('validation_failed', 'O arquivo exportado nao passou na validacao de integridade.', {
        outputDir,
        chatId,
        filePath,
        validation,
      });
    }

    return {
      ok: true,
      outputDir,
      chatId,
      filePath,
      validation,
    };
  } finally {
    if (createdOutputDir && !args.keepOutput) {
      try {
        rmSync(outputDir, { recursive: true, force: true });
      } catch {
        // smoke output cleanup is best effort
      }
    }
  }
};

let parsedArgs = { json: false };

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  parsedArgs = args;
  const result = await run(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Smoke export-integrity: OK (${result.chatId})\n`);
    process.stdout.write(`Arquivo validado: ${result.filePath}\n`);
  } else {
    process.stderr.write(`Smoke export-integrity: FALHOU (${result.code})\n`);
    process.stderr.write(`${result.message}\n`);
  }
  process.exit(result.ok ? 0 : 1);
};

main().catch((err) => {
  const result = failure('smoke_error', err.message, {
    status: err.status || null,
    data: err.data || null,
  });
  if (parsedArgs.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(`Smoke export-integrity: FALHOU (${result.code})\n`);
    process.stderr.write(`${result.message}\n`);
  }
  process.exit(1);
});
