import {
  runGeminiWebapiPythonListChats,
  runGeminiWebapiPythonSessionStatus,
} from './gemini-webapi-python-adapter.js';

type AnyRecord = Record<string, any>;

export type PrivateInventoryDeps = Readonly<{
  enqueueCommand(
    clientId: string,
    type: string,
    args?: AnyRecord,
    options?: AnyRecord,
  ): Promise<AnyRecord>;
  commandChannelReadyForClient(client: AnyRecord): boolean;
  normalizeConversationChatId(value: unknown): string | null;
  summarizeClient(client: AnyRecord | null): AnyRecord | null;
  getSelectableGeminiClients(): AnyRecord[];
  getCommandReadyGeminiClients?(): AnyRecord[];
  normalizeClientSelector(args: AnyRecord): AnyRecord;
  requireClient(selector: AnyRecord): AnyRecord;
  claimForSession(sessionId?: unknown): unknown;
  nativeBrowserBroker?: {
    privateApiSessionStatus?(payload?: AnyRecord, options?: AnyRecord): Promise<AnyRecord>;
    privateApiListChats?(payload?: AnyRecord, options?: AnyRecord): Promise<AnyRecord>;
  };
}>;

export const privateInventoryLimit = (args: AnyRecord = {}, fallback = 200): number =>
  Math.max(1, Math.min(2000, Number(args.limit || args.maxChats || fallback)));

const allowsDomFallback = (args: AnyRecord = {}): boolean => args.allowDomFallback === true;

const conversationFromChat = (
  chat: AnyRecord = {},
  source = 'private-api',
  deps: Pick<PrivateInventoryDeps, 'normalizeConversationChatId'>,
): AnyRecord | null => {
  const chatId =
    deps.normalizeConversationChatId(chat) ||
    deps.normalizeConversationChatId({
      chatId: chat.chatId || chat.chat_id || chat.privateChatId || chat.private_chat_id,
    });
  if (!chatId) return null;
  return {
    id: chat.privateChatId || chat.private_chat_id || `c_${chatId}`,
    chatId,
    title: chat.title || chatId,
    url: chat.url || `https://gemini.google.com/app/${chatId}`,
    source,
    timestamp: chat.updatedAt || chat.updated_at || null,
    isPinned: chat.isPinned === true || chat.is_pinned === true,
  };
};

const summarizeFailure = (result: AnyRecord = {}): AnyRecord => ({
  ok: result?.ok === true,
  code: result?.code || null,
  message: result?.message || result?.error || null,
  status: result?.status ?? null,
});

const applyPrivateInventoryToClient = (
  client: AnyRecord | null,
  result: AnyRecord,
  args: AnyRecord,
) => {
  if (!client) return;
  const conversations = Array.isArray(result.conversations) ? result.conversations : [];
  const reachedSidebarEnd = conversations.length < privateInventoryLimit(args, args.limit || 200);
  client.conversations = conversations;
  client.lastSnapshotAt = Date.now();
  client.lastSnapshot = {
    ...(client.lastSnapshot || {}),
    conversations,
    reachedSidebarEnd,
    source: result.source || 'private-api',
  };
  client.page = {
    ...(client.page || {}),
    reachedSidebarEnd,
  };
};

const listViaBrowserBackground = async (
  client: AnyRecord,
  args: AnyRecord,
  deps: PrivateInventoryDeps,
): Promise<AnyRecord> => {
  const timeoutMs = Math.max(5000, Number(args.privateInventoryWaitMs || args.waitMs || 30_000));
  const result = await deps.enqueueCommand(
    client.clientId,
    'private-api-list-chats',
    {
      limit: privateInventoryLimit(args, args.limit || 200),
      timeoutMs,
    },
    { timeoutMs },
  );
  if (!result?.ok) return result;
  const conversations = (Array.isArray(result.chats) ? result.chats : [])
    .map((chat: AnyRecord) => conversationFromChat(chat, 'private-api-browser', deps))
    .filter(Boolean);
  return {
    ok: true,
    source: 'browser-background',
    conversations,
    count: conversations.length,
    transport: result.transport || null,
  };
};

const listViaNativeBrowserBroker = async (
  args: AnyRecord,
  deps: PrivateInventoryDeps,
): Promise<AnyRecord | null> => {
  if (!deps.nativeBrowserBroker?.privateApiListChats) return null;
  const timeoutMs = Math.max(5000, Number(args.privateInventoryWaitMs || args.waitMs || 30_000));
  const nativeResponse = await deps.nativeBrowserBroker.privateApiListChats(
    {
      limit: privateInventoryLimit(args, args.limit || 200),
      timeoutMs,
    },
    { allowFallback: true },
  );
  const result = nativeResponse?.ok === true ? nativeResponse.result : nativeResponse;
  if (!result?.ok) return result || { ok: false, code: 'native_private_inventory_failed' };
  const conversations = (Array.isArray(result.chats) ? result.chats : [])
    .map((chat: AnyRecord) => conversationFromChat(chat, 'private-api-browser', deps))
    .filter(Boolean);
  return {
    ok: true,
    source: 'browser-background',
    conversations,
    count: conversations.length,
    transport: result.transport || null,
  };
};

const listViaPythonSidecar = async (
  args: AnyRecord,
  deps: PrivateInventoryDeps,
): Promise<AnyRecord> => {
  const result = await runGeminiWebapiPythonListChats({
    cookiesJson: args.cookiesJson,
    python: args.python,
    timeoutMs: args.privateInventoryWaitMs || args.waitMs || 45_000,
    limit: privateInventoryLimit(args, args.limit || 200),
  });
  if (!result?.ok) return result as AnyRecord;
  const conversations = (Array.isArray(result.chats) ? result.chats : [])
    .map((chat) => conversationFromChat(chat, 'private-api-sidecar', deps))
    .filter(Boolean);
  return {
    ok: true,
    source: 'gemini-webapi-python',
    conversations,
    count: conversations.length,
    transport: result.transport || null,
  };
};

export const listPrivateChatsForClient = async (
  client: AnyRecord | null,
  args: AnyRecord = {},
  deps: PrivateInventoryDeps,
): Promise<AnyRecord | null> => {
  if (args.privateInventory === false) return null;
  const attempts: AnyRecord[] = [];
  try {
    const nativeResult = await listViaNativeBrowserBroker(args, deps);
    if (nativeResult?.ok) {
      applyPrivateInventoryToClient(client, nativeResult, args);
      return { ...nativeResult, attempts };
    }
    if (nativeResult)
      attempts.push({ adapter: 'browserBackground', ...summarizeFailure(nativeResult) });
  } catch (err: any) {
    attempts.push({
      adapter: 'browserBackground',
      ok: false,
      code: err?.code || 'native_private_inventory_failed',
      message: err?.message || String(err),
    });
  }

  if (client?.clientId && deps.commandChannelReadyForClient(client)) {
    try {
      const browserResult = await listViaBrowserBackground(client, args, deps);
      if (browserResult?.ok) {
        applyPrivateInventoryToClient(client, browserResult, args);
        return { ...browserResult, attempts };
      }
      attempts.push({ adapter: 'browserBackground', ...summarizeFailure(browserResult) });
    } catch (err: any) {
      attempts.push({
        adapter: 'browserBackground',
        ok: false,
        code: err?.code || 'private_inventory_browser_failed',
        message: err?.message || String(err),
      });
    }
  }

  try {
    const pythonResult = await listViaPythonSidecar(args, deps);
    if (pythonResult?.ok) {
      applyPrivateInventoryToClient(client, pythonResult, args);
      return { ...pythonResult, attempts };
    }
    attempts.push({ adapter: 'privateApiGeminiWebapi', ...summarizeFailure(pythonResult) });
  } catch (err: any) {
    attempts.push({
      adapter: 'privateApiGeminiWebapi',
      ok: false,
      code: err?.code || 'private_inventory_python_failed',
      message: err?.message || String(err),
    });
  }

  if (allowsDomFallback(args)) return null;
  const last = attempts.at(-1) || {};
  const error = new Error(
    last.message ||
      'Nao consegui listar conversas pela API privada. Fallback DOM exige confirmacao explicita.',
  ) as Error & { code?: string; data?: AnyRecord };
  error.code = last.code || 'private_inventory_unavailable';
  error.data = { attempts };
  throw error;
};

export const privateRecentChatsResponse = (
  client: AnyRecord,
  inventory: AnyRecord,
  args: AnyRecord,
  deps: Pick<PrivateInventoryDeps, 'summarizeClient'>,
): AnyRecord => {
  const limit = Math.max(1, Number(args.limit || 10));
  const offset = Math.max(0, Number(args.offset || 0));
  const targetCount = Math.max(1, Number(args.targetCount || limit));
  const maxLoadTarget = Math.max(targetCount, Number(args.maxLoadTarget || targetCount));
  const countOnly = args.countOnly === true || args.action === 'count';
  const conversations = Array.isArray(inventory.conversations) ? inventory.conversations : [];
  const page = conversations.slice(offset, offset + limit);
  const reachedEnd = conversations.length < privateInventoryLimit(args, targetCount);
  const nextOffset = offset + page.length;
  const countSource = `private_api_${inventory.source || 'unknown'}`;
  return {
    client: deps.summarizeClient(client),
    countStatus: reachedEnd ? 'complete' : 'incomplete',
    countIsTotal: reachedEnd,
    totalKnown: reachedEnd,
    totalCount: reachedEnd ? conversations.length : null,
    countSource,
    countConfidence: reachedEnd ? 'strong' : 'partial',
    countEvidence: inventory.attempts || [],
    knownLoadedCount: conversations.length,
    minimumKnownCount: conversations.length,
    countWarning: reachedEnd
      ? null
      : `Contagem parcial: carreguei pelo menos ${conversations.length} conversa(s) pela API privada, mas ainda nao confirmei o fim do historico.`,
    answer: reachedEnd
      ? `${conversations.length} conversa(s) confirmada(s) pela API privada.`
      : `Pelo menos ${conversations.length} conversa(s) pela API privada; total ainda nao confirmado.`,
    refreshAttempted: false,
    refreshed: false,
    refreshTimedOut: false,
    refreshError: null,
    loadMoreAttempted: false,
    loadMoreLoadedAny: false,
    loadMoreRoundsCompleted: 0,
    loadMoreReachedEnd: reachedEnd,
    loadMoreTimedOut: false,
    loadMoreError: null,
    snapshot: {
      source: inventory.source,
      conversations,
      reachedSidebarEnd: reachedEnd,
    },
    pagination: {
      offset,
      limit,
      returned: page.length,
      loadedCount: conversations.length,
      countIsTotal: reachedEnd,
      totalKnown: reachedEnd,
      totalCount: reachedEnd ? conversations.length : null,
      countSource,
      countConfidence: reachedEnd ? 'strong' : 'partial',
      knownLoadedCount: conversations.length,
      minimumKnownCount: conversations.length,
      countStatus: reachedEnd ? 'complete' : 'incomplete',
      maxLoadTarget,
      nextOffset: page.length > 0 ? nextOffset : null,
      hasMoreLoaded: nextOffset < conversations.length,
      reachedEnd,
      canLoadMore: !reachedEnd && conversations.length < maxLoadTarget,
    },
    conversations: countOnly ? [] : page,
    nextAction: reachedEnd
      ? null
      : {
          code: 'count_incomplete',
          message:
            'A API privada retornou um lote parcial. Use um limite maior ou espere a implementacao de paginacao privada antes de afirmar total absoluto.',
          command: null,
        },
  };
};

export const listPrivateRecentChatsForClient = async (
  client: AnyRecord,
  args: AnyRecord,
  context: AnyRecord,
  deps: PrivateInventoryDeps,
): Promise<AnyRecord | null> => {
  const targetCount = Math.max(1, Number(context.targetCount || args.limit || 10));
  const inventory = await listPrivateChatsForClient(
    client,
    {
      ...args,
      limit: Math.max(targetCount, privateInventoryLimit(args, targetCount)),
    },
    deps,
  );
  if (!inventory?.ok) return null;
  return privateRecentChatsResponse(
    client,
    inventory,
    {
      ...args,
      ...context,
      targetCount,
    },
    deps,
  );
};

export const loadPrivateInventoryForRecentExportJob = async (
  job: AnyRecord,
  client: AnyRecord,
  args: AnyRecord,
  deps: Readonly<{
    inventoryDeps: PrivateInventoryDeps;
    maxRecentChatsLoadTarget: number;
  }>,
): Promise<AnyRecord | null> => {
  const maxTarget = Math.max(1, Number(deps.maxRecentChatsLoadTarget || 1));
  const privateLimit = job.exportAll
    ? maxTarget
    : Math.min(maxTarget, Number(job.startIndex || 1) - 1 + Number(job.maxChats || maxTarget));
  const privateInventory = await listPrivateChatsForClient(
    client,
    {
      ...args,
      limit: privateLimit,
    },
    deps.inventoryDeps,
  );
  if (!privateInventory?.ok) return null;
  job.privateInventory = {
    source: privateInventory.source,
    count: privateInventory.count,
    attempts: privateInventory.attempts || [],
    limit: privateLimit,
  };
  job.loadMoreRoundsCompleted = 0;
  job.loadMoreTimedOut = false;
  job.loadMoreTrace = [];
  return privateInventory;
};

export const localProxySupportActions = [
  'diagnose',
  'processes',
  'cleanup_processes',
  'session_status',
  'browser_side_effects',
  'flight_recorder',
  'bundle',
] as const;

const supportLegacyToolNames: Record<string, string> = {
  browser_side_effects: 'gemini_browser_side_effects',
  bundle: 'gemini_collect_support_bundle',
  cleanup_processes: 'gemini_mcp_cleanup_stale_processes',
  diagnose: 'gemini_diagnose_environment',
  flight_recorder: 'gemini_flight_recorder',
  processes: 'gemini_mcp_diagnose_processes',
  snapshot: 'gemini_snapshot',
};

export const privateSupportLegacyToolName = (action: unknown): string =>
  supportLegacyToolNames[String(action || 'diagnose')] || supportLegacyToolNames.diagnose;

const commandReadyGeminiClients = (deps: PrivateInventoryDeps): AnyRecord[] =>
  typeof deps.getCommandReadyGeminiClients === 'function'
    ? deps
        .getCommandReadyGeminiClients()
        .filter((client) => deps.commandChannelReadyForClient(client))
    : [];

const clientMatchesSessionSelector = (client: AnyRecord, selector: AnyRecord): boolean => {
  if (selector.clientId) return client?.clientId === selector.clientId;
  if (selector.tabId !== null && selector.tabId !== undefined) {
    return String(client?.tabId ?? '') === String(selector.tabId);
  }
  return false;
};

const browserClientForSessionStatus = (args: AnyRecord, deps: PrivateInventoryDeps) => {
  const selector = deps.normalizeClientSelector(args);
  const readyClients = commandReadyGeminiClients(deps);
  if (
    selector.clientId ||
    selector.tabId !== null ||
    selector.claimId ||
    deps.claimForSession(selector.sessionId)
  ) {
    try {
      return deps.requireClient(selector);
    } catch (err) {
      const readyMatch = readyClients.find((client) =>
        clientMatchesSessionSelector(client, selector),
      );
      if (readyMatch) return readyMatch;
      throw err;
    }
  }
  return (
    deps.getSelectableGeminiClients().find((client) => deps.commandChannelReadyForClient(client)) ||
    readyClients[0] ||
    null
  );
};

const disconnectedExtensionRuntimeCodes = new Set([
  'native_broker_unavailable',
  'native_broker_disconnected',
  'native_broker_not_ready',
  'native_private_session_failed',
]);

const browserOnlySessionNextAction = (
  attempts: readonly AnyRecord[],
  browserClient: AnyRecord | null,
) => {
  const nativeRuntimeDisconnected =
    !browserClient &&
    attempts.some(
      (attempt) =>
        attempt.adapter === 'browserBackground' &&
        disconnectedExtensionRuntimeCodes.has(String(attempt.code || '')),
    );

  if (nativeRuntimeDisconnected) {
    return {
      code: 'extension_runtime_not_connected',
      message:
        'Recarregue a extensao e a aba do Gemini no navegador logado; depois rode auth status novamente.',
    };
  }

  return {
    code: 'browser_session_not_connected',
    message: 'Abra o Gemini no navegador logado e aguarde a extensao conectar.',
  };
};

export const checkPrivateSessionStatus = async (
  args: AnyRecord = {},
  deps: PrivateInventoryDeps,
): Promise<AnyRecord> => {
  const attempts: AnyRecord[] = [];
  if (deps.nativeBrowserBroker?.privateApiSessionStatus) {
    try {
      const timeoutMs = Math.max(5000, Number(args.waitMs || 20_000));
      const nativeResponse = await deps.nativeBrowserBroker.privateApiSessionStatus(
        { timeoutMs },
        { allowFallback: true },
      );
      const nativeResult = nativeResponse?.ok === true ? nativeResponse.result : nativeResponse;
      attempts.push({
        adapter: 'browserBackground',
        ...summarizeFailure(nativeResult),
        authenticated: nativeResult?.authenticated === true,
        transport: nativeResult?.transport || null,
      });
      if (nativeResult?.ok && nativeResult.authenticated === true) {
        return {
          ok: true,
          action: 'session_status',
          authenticated: true,
          selectedAdapter: 'browserBackground',
          client: null,
          attempts,
          nextAction: { code: 'ready', message: 'Sessao do navegador pronta para API privada.' },
        };
      }
    } catch (err: any) {
      attempts.push({
        adapter: 'browserBackground',
        ok: false,
        code: err?.code || 'native_private_session_failed',
        message: err?.message || String(err),
      });
    }
  }

  let browserClient: AnyRecord | null = null;
  try {
    browserClient = browserClientForSessionStatus(args, deps);
  } catch (err: any) {
    attempts.push({
      adapter: 'browserBackground',
      ok: false,
      code: err?.code || 'browser_client_unavailable',
      message: err?.message || String(err),
    });
  }

  if (browserClient?.clientId && deps.commandChannelReadyForClient(browserClient)) {
    try {
      const timeoutMs = Math.max(5000, Number(args.waitMs || 20_000));
      const browserResult = await deps.enqueueCommand(
        browserClient.clientId,
        'private-api-session-status',
        { timeoutMs },
        { timeoutMs },
      );
      attempts.push({
        adapter: 'browserBackground',
        ...summarizeFailure(browserResult),
        authenticated: browserResult?.authenticated === true,
      });
      if (browserResult?.ok && browserResult.authenticated === true) {
        return {
          ok: true,
          action: 'session_status',
          authenticated: true,
          selectedAdapter: 'browserBackground',
          client: deps.summarizeClient(browserClient),
          attempts,
          nextAction: { code: 'ready', message: 'Sessao do navegador pronta para API privada.' },
        };
      }
    } catch (err: any) {
      attempts.push({
        adapter: 'browserBackground',
        ok: false,
        code: err?.code || 'private_session_browser_failed',
        message: err?.message || String(err),
      });
    }
  }

  if (args.pythonFallback === false) {
    return {
      ok: false,
      action: 'session_status',
      authenticated: false,
      selectedAdapter: null,
      client: browserClient ? deps.summarizeClient(browserClient) : null,
      attempts,
      nextAction: browserOnlySessionNextAction(attempts, browserClient),
    };
  }

  const pythonResult = await runGeminiWebapiPythonSessionStatus({
    cookiesJson: args.cookiesJson,
    python: args.python,
    timeoutMs: args.waitMs || 45_000,
  });
  const pythonRecord = pythonResult as AnyRecord;
  attempts.push({
    adapter: 'privateApiGeminiWebapi',
    ...summarizeFailure(pythonRecord),
    authenticated: pythonRecord.authenticated === true,
    chatCount: pythonRecord.chatCount ?? null,
  });
  if (pythonResult?.ok && pythonResult.authenticated === true) {
    return {
      ok: true,
      action: 'session_status',
      authenticated: true,
      selectedAdapter: 'privateApiGeminiWebapi',
      client: browserClient ? deps.summarizeClient(browserClient) : null,
      attempts,
      chatCount: pythonResult.chatCount ?? null,
      nextAction: { code: 'ready', message: 'Sidecar Python pronto para API privada.' },
    };
  }

  return {
    ok: false,
    action: 'session_status',
    authenticated: false,
    selectedAdapter: null,
    client: browserClient ? deps.summarizeClient(browserClient) : null,
    attempts,
    nextAction: {
      code: 'login_or_cookie_refresh_required',
      message:
        'Abra o Gemini no navegador logado ou atualize os cookies usados pelo sidecar Python.',
    },
  };
};
