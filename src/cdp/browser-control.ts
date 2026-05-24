export type CdpTargetClassificationKind =
  | 'gemini_chat'
  | 'gemini_home'
  | 'gemini_notebook'
  | 'gemini'
  | 'google_sorry'
  | 'google_login'
  | 'loading'
  | 'other'
  | 'unknown';

export type CdpTargetClassification = Readonly<{
  kind: CdpTargetClassificationKind;
  terminal: boolean;
  url: string | null;
  code?: string;
  hostname?: string;
}>;

export type CdpTarget = Readonly<{
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
  chatId?: string | null;
  classification: CdpTargetClassification;
}>;

export type CdpBrowserSnapshot = Readonly<{
  ok: boolean;
  controlPlane: 'cdp';
  endpoint: string;
  version: Record<string, unknown> | null;
  targets: CdpTarget[];
  geminiTargets: CdpTarget[];
  blocker: CdpBlocker | null;
}>;

export type CdpBlocker = Readonly<{
  code: 'google_verification_required' | 'google_login_required' | 'google_page_blocked';
  kind: CdpTargetClassificationKind;
  url: string;
  message: string;
  nextAction: string;
}>;

export type CdpFetchResponse = Pick<Response, 'ok' | 'status' | 'statusText' | 'json' | 'text'>;

export type CdpFetch = (url: string, init?: RequestInit) => Promise<CdpFetchResponse>;

export type CdpWebSocketLike = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type CdpWebSocketConstructor = new (url: string) => CdpWebSocketLike;

export type CdpRequestOptions = Readonly<{
  endpoint: string;
  fetchImpl?: CdpFetch;
  timeoutMs?: number;
}>;

export type CdpCommandOptions = Readonly<{
  WebSocketImpl?: CdpWebSocketConstructor;
  timeoutMs?: number;
}>;

const GEMINI_CHAT_ID_RE = /^\/app\/([a-f0-9]{12,})(?:[/?#]|$)/i;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const normalizeCdpEndpoint = (endpoint: string): string => {
  const raw = String(endpoint || '').trim();
  if (!raw) return 'http://127.0.0.1:9222';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withProtocol);
  parsed.pathname = trimTrailingSlash(parsed.pathname);
  parsed.search = '';
  parsed.hash = '';
  return trimTrailingSlash(parsed.toString());
};

const fetchJson = async <T>(
  endpoint: string,
  path: string,
  { fetchImpl = fetch as CdpFetch, method = 'GET' }: { fetchImpl?: CdpFetch; method?: string } = {},
): Promise<T> => {
  const response = await fetchImpl(`${normalizeCdpEndpoint(endpoint)}${path}`, { method });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(
      `CDP HTTP ${response.status} ${response.statusText || ''}${body ? `: ${body}` : ''}`.trim(),
    );
    Object.assign(error, { code: 'cdp_http_error', statusCode: response.status });
    throw error;
  }
  return (await response.json()) as T;
};

const chatIdFromGeminiUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'gemini.google.com') return null;
    return parsed.pathname.match(GEMINI_CHAT_ID_RE)?.[1] || null;
  } catch {
    return null;
  }
};

export const classifyCdpTargetUrl = (value: string | null | undefined): CdpTargetClassification => {
  const url = String(value || '').trim();
  if (!url) return { kind: 'unknown', terminal: false, url: null };
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const continueUrl = (parsed.searchParams.get('continue') || '').toLowerCase();

    if (
      hostname.endsWith('google.com') &&
      pathname.startsWith('/sorry') &&
      continueUrl.includes('gemini.google.com')
    ) {
      return {
        kind: 'google_sorry',
        terminal: true,
        url,
        code: 'google_verification_required',
        hostname,
      };
    }

    if (hostname === 'accounts.google.com') {
      return {
        kind: 'google_login',
        terminal: true,
        url,
        code: 'google_login_required',
        hostname,
      };
    }

    if (hostname === 'gemini.google.com') {
      if (GEMINI_CHAT_ID_RE.test(parsed.pathname)) {
        return { kind: 'gemini_chat', terminal: false, url, hostname };
      }
      if (pathname.startsWith('/notebook/')) {
        return { kind: 'gemini_notebook', terminal: false, url, hostname };
      }
      if (pathname === '/app' || pathname === '/app/') {
        return { kind: 'gemini_home', terminal: false, url, hostname };
      }
      return { kind: 'gemini', terminal: false, url, hostname };
    }

    if (/^(about:blank|chrome:\/\/newtab|edge:\/\/newtab|brave:\/\/newtab|dia:\/\/)/i.test(url)) {
      return { kind: 'loading', terminal: false, url };
    }

    return { kind: 'other', terminal: true, url, hostname };
  } catch {
    return { kind: 'unknown', terminal: false, url };
  }
};

const normalizeTarget = (target: Record<string, unknown>): CdpTarget | null => {
  const id = String(target.id || '').trim();
  const type = String(target.type || '').trim();
  const url = String(target.url || '').trim();
  if (!id || type !== 'page') return null;
  const classification = classifyCdpTargetUrl(url);
  return {
    id,
    type,
    title: typeof target.title === 'string' ? target.title : undefined,
    url,
    webSocketDebuggerUrl:
      typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : undefined,
    chatId: chatIdFromGeminiUrl(url),
    classification,
  };
};

export const listCdpTargets = async ({
  endpoint,
  fetchImpl,
}: CdpRequestOptions): Promise<CdpTarget[]> => {
  const rawTargets = await fetchJson<Record<string, unknown>[]>(endpoint, '/json/list', {
    fetchImpl,
  });
  return rawTargets.flatMap((target) => {
    const normalized = normalizeTarget(target);
    return normalized ? [normalized] : [];
  });
};

export const selectCdpTarget = (
  targets: readonly CdpTarget[],
  selector: { targetId?: string | null; chatId?: string | null; url?: string | null } = {},
): CdpTarget | null => {
  const targetId = String(selector.targetId || '').trim();
  if (targetId) return targets.find((target) => target.id === targetId) || null;

  const chatId = String(selector.chatId || '')
    .trim()
    .toLowerCase();
  if (chatId) {
    return targets.find((target) => String(target.chatId || '').toLowerCase() === chatId) || null;
  }

  const url = String(selector.url || '').trim();
  if (url) return targets.find((target) => target.url === url) || null;

  const usable = targets.filter((target) => !target.classification.terminal);
  return (
    usable.find((target) => target.classification.kind === 'gemini_chat') ||
    usable.find((target) => target.classification.kind === 'gemini_notebook') ||
    usable.find((target) => target.classification.kind === 'gemini_home') ||
    usable.find((target) => target.classification.kind === 'gemini') ||
    null
  );
};

const blockerFromTarget = (target: CdpTarget): CdpBlocker | null => {
  if (target.classification.kind === 'google_sorry') {
    return {
      code: 'google_verification_required',
      kind: target.classification.kind,
      url: target.url,
      message: 'O Google abriu uma tela de verificacao antes do Gemini.',
      nextAction: 'Resolva a verificacao no navegador e tente novamente.',
    };
  }
  if (target.classification.kind === 'google_login') {
    return {
      code: 'google_login_required',
      kind: target.classification.kind,
      url: target.url,
      message: 'O navegador esta no login do Google.',
      nextAction: 'Conclua o login no navegador e tente novamente.',
    };
  }
  return null;
};

export const buildCdpBrowserSnapshot = async ({
  endpoint,
  fetchImpl,
}: CdpRequestOptions): Promise<CdpBrowserSnapshot> => {
  const [version, targets] = await Promise.all([
    fetchJson<Record<string, unknown>>(endpoint, '/json/version', { fetchImpl }).catch(() => null),
    listCdpTargets({ endpoint, fetchImpl }),
  ]);
  const geminiTargets = targets.filter((target) => target.classification.kind.startsWith('gemini'));
  const blocker = targets.map(blockerFromTarget).find(Boolean) || null;
  return {
    ok: true,
    controlPlane: 'cdp',
    endpoint: normalizeCdpEndpoint(endpoint),
    version,
    targets,
    geminiTargets,
    blocker,
  };
};

export const activateCdpTarget = async (
  target: Pick<CdpTarget, 'id'>,
  { endpoint, fetchImpl }: CdpRequestOptions,
) => {
  const body = await fetchJson<unknown>(
    endpoint,
    `/json/activate/${encodeURIComponent(target.id)}`,
    { fetchImpl },
  );
  return {
    ok: true,
    targetId: target.id,
    result: body,
  };
};

type PendingCdpCommand = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

const defaultWebSocketConstructor = (): CdpWebSocketConstructor => {
  const ctor = globalThis.WebSocket;
  if (!ctor) {
    const error = new Error('WebSocket nativo indisponivel para CDP.');
    Object.assign(error, { code: 'cdp_websocket_unavailable' });
    throw error;
  }
  return ctor as unknown as CdpWebSocketConstructor;
};

export const sendCdpCommand = async (
  webSocketDebuggerUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  { WebSocketImpl = defaultWebSocketConstructor(), timeoutMs = 10_000 }: CdpCommandOptions = {},
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketDebuggerUrl);
    const pending = new Map<number, PendingCdpCommand>();
    let nextId = 1;
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        reject,
        Object.assign(new Error(`Timeout CDP em ${timeoutMs}ms (${method}).`), {
          code: 'cdp_timeout',
        }),
      );
    }, timeoutMs);

    const finish = (callback: (value: never) => void, value: Error | Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close races
      }
      callback(value as never);
    };

    socket.onopen = () => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: (value) => finish(resolve as never, value), reject });
      socket.send(JSON.stringify({ id, method, params }));
    };

    socket.onmessage = (event) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data || '{}'));
      } catch (err) {
        finish(reject as never, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `CDP command failed: ${method}`);
        Object.assign(error, { code: 'cdp_command_failed', data: message.error });
        finish(reject as never, error);
        return;
      }
      finish(resolve as never, message.result || {});
    };

    socket.onerror = () => {
      const error = new Error(`Falha no WebSocket CDP (${method}).`);
      Object.assign(error, { code: 'cdp_websocket_error' });
      finish(reject as never, error);
    };

    socket.onclose = () => {
      if (!settled) {
        const error = new Error(`Conexao CDP fechou antes da resposta (${method}).`);
        Object.assign(error, { code: 'cdp_connection_closed' });
        finish(reject as never, error);
      }
    };
  });

export const navigateCdpTarget = async (
  target: Pick<CdpTarget, 'id' | 'webSocketDebuggerUrl'>,
  url: string,
  options: CdpCommandOptions = {},
) => {
  if (!target.webSocketDebuggerUrl) {
    const error = new Error('Target CDP nao informou webSocketDebuggerUrl.');
    Object.assign(error, { code: 'cdp_target_missing_websocket' });
    throw error;
  }
  const result = await sendCdpCommand(
    target.webSocketDebuggerUrl,
    'Page.navigate',
    { url },
    options,
  );
  return {
    ok: true,
    targetId: target.id,
    result,
  };
};
