export const WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT = 3;
export const WEB_REPAIR_BLOCKED_EXIT_CODE = 2;
export const WEB_REPAIR_PREFLIGHT_STALL_MS = 90_000;

type WebRepairFailureLike = {
  chatId?: string | null;
  title?: string | null;
  error?: string | null;
};

type WebRepairJobStatusLike = {
  status?: string | null;
  reportFile?: string | null;
  completed?: number | null;
  successCount?: number | null;
  failureCount?: number | null;
  current?: { chatId?: string | null; index?: number | null; title?: string | null } | null;
  failures?: WebRepairFailureLike[] | null;
};

export type WebRepairUnavailable = {
  code: 'gemini_web_chats_unavailable' | 'gemini_web_repair_stalled';
  message: string;
  nextAction: string;
  checkedFailures: number;
  failedChatIds: string[];
};

export const isGeminiWebChatUnavailableFailure = (failure: WebRepairFailureLike): boolean => {
  const error = String(failure?.error || '');
  return (
    /Timeout aguardando chat\b/i.test(error) &&
    /chat=nenhum/i.test(error) &&
    /turns=0/i.test(error)
  );
};

export const webRepairUnavailableFromJobStatus = (
  status: WebRepairJobStatusLike,
): WebRepairUnavailable | null => {
  const successCount = Number(status?.successCount || 0);
  if (successCount > 0) return null;

  const failures = (status?.failures || []).filter(Boolean);
  if (failures.length < WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT) return null;

  const checked = failures.slice(0, WEB_REPAIR_PREFLIGHT_FAILURE_LIMIT);
  if (!checked.every(isGeminiWebChatUnavailableFailure)) return null;

  return {
    code: 'gemini_web_chats_unavailable',
    message:
      'O Gemini Web desta conta nao abriu os primeiros chats que precisavam de reparo.',
    nextAction:
      'Use uma sessao do navegador logada na conta dona desses chats ou repare esses raw exports por outra fonte antes de escrever datas.',
    checkedFailures: checked.length,
    failedChatIds: checked.map((failure) => String(failure.chatId || '')).filter(Boolean),
  };
};

export const webRepairStalledFromJobStatus = (
  status: WebRepairJobStatusLike,
  stalledMs: number,
  stallLimitMs: number = WEB_REPAIR_PREFLIGHT_STALL_MS,
): WebRepairUnavailable | null => {
  const successCount = Number(status?.successCount || 0);
  const failureCount = Number(status?.failureCount || 0);
  const completed = Number(status?.completed || 0);
  if (successCount > 0 || failureCount > 0 || completed > 0) return null;
  if (!status?.current?.chatId) return null;
  if (stalledMs < stallLimitMs) return null;

  const chatId = String(status.current.chatId);
  return {
    code: 'gemini_web_repair_stalled',
    message:
      'O reparo pelo Gemini Web ficou sem progresso no primeiro chat suspeito.',
    nextAction:
      'Verifique se a aba Gemini desta conta consegue abrir esse chat; o fluxo bloqueou antes de escrever datas.',
    checkedFailures: 0,
    failedChatIds: [chatId],
  };
};

export const webRepairExitCodeForStatusCounts = ({
  failed = 0,
  unavailable = null,
}: {
  failed?: number;
  unavailable?: WebRepairUnavailable | null;
}): number => {
  if (unavailable || failed > 0) return WEB_REPAIR_BLOCKED_EXIT_CODE;
  return 0;
};

type WebRepairTargetOptions = {
  claimId?: string | null;
  clientId?: string | null;
  tabId?: number | string | null;
  sessionId?: string | null;
  activateTab?: boolean | null;
};

export const webRepairHasExplicitTarget = (options: WebRepairTargetOptions): boolean =>
  Boolean(options.claimId || options.clientId || options.tabId !== null && options.tabId !== undefined);

export const buildWebRepairExplicitTargetStatus = (options: WebRepairTargetOptions) => ({
  ready: true,
  explicitTarget: {
    claimId: options.claimId || null,
    clientId: options.clientId || null,
    tabId: options.tabId ?? null,
  },
  globalReadinessSkipped: true,
});

export const webRepairTargetRequestArgs = (options: WebRepairTargetOptions) => ({
  claimId: options.claimId || undefined,
  clientId: options.clientId || undefined,
  tabId: options.tabId ?? undefined,
  sessionId: options.sessionId || undefined,
  activateTab: options.activateTab === true,
});

const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

type CallMcpTool = (request: {
  bridgeUrl: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<any>;

const cancelExportJob = async ({
  bridgeUrl,
  jobId,
  callMcpTool,
}: {
  bridgeUrl: string;
  jobId: string;
  callMcpTool: CallMcpTool;
}) => {
  try {
    return await callMcpTool({
      bridgeUrl,
      name: 'gemini_job',
      args: { action: 'cancel', jobId },
    });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
};

const waitForCancelledExportJob = async ({
  bridgeUrl,
  jobId,
  pollMs,
  callMcpTool,
  sleep,
}: {
  bridgeUrl: string;
  jobId: string;
  pollMs: number;
  callMcpTool: CallMcpTool;
  sleep: (ms: number) => Promise<void>;
}) => {
  const deadline = Date.now() + 10000;
  let lastStatus = null;
  while (Date.now() <= deadline) {
    lastStatus = await callMcpTool({
      bridgeUrl,
      name: 'gemini_job',
      args: { action: 'status', jobId },
    });
    if (TERMINAL_JOB_STATUSES.has(lastStatus.status)) return lastStatus;
    await sleep(pollMs);
  }
  return lastStatus;
};

export const pollWebRepairExportJob = async ({
  bridgeUrl,
  jobId,
  pollMs,
  timeoutMs,
  preflightStallMs = WEB_REPAIR_PREFLIGHT_STALL_MS,
  callMcpTool,
  sleep,
}: {
  bridgeUrl: string;
  jobId: string;
  pollMs: number;
  timeoutMs: number;
  preflightStallMs?: number;
  callMcpTool: CallMcpTool;
  sleep: (ms: number) => Promise<void>;
}) => {
  const startedAt = Date.now();
  let status = null;
  let lastProgressKey = '';
  let lastProgressAt = startedAt;

  while (Date.now() - startedAt <= timeoutMs) {
    status = await callMcpTool({
      bridgeUrl,
      name: 'gemini_job',
      args: { action: 'status', jobId },
    });
    if (TERMINAL_JOB_STATUSES.has(status.status)) return status;

    const progressKey = [
      status.completed || 0,
      status.successCount || 0,
      status.failureCount || 0,
      status.current?.index || 0,
      status.current?.chatId || '',
    ].join(':');
    if (progressKey !== lastProgressKey) {
      lastProgressKey = progressKey;
      lastProgressAt = Date.now();
    }

    const unavailable =
      webRepairUnavailableFromJobStatus(status) ||
      webRepairStalledFromJobStatus(status, Date.now() - lastProgressAt, preflightStallMs);
    if (unavailable) {
      const cancelStatus = await cancelExportJob({ bridgeUrl, jobId, callMcpTool });
      const terminalStatus = await waitForCancelledExportJob({
        bridgeUrl,
        jobId,
        pollMs,
        callMcpTool,
        sleep,
      });
      return {
        ...(terminalStatus || status),
        webRepairUnavailable: unavailable,
        cancelStatus,
      };
    }

    await sleep(pollMs);
  }

  throw new Error(`Timeout aguardando job de reexportacao ${jobId}.`);
};
