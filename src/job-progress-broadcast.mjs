// Snapshot do progresso de jobs do MCP que viaja via /bridge/heartbeat para a
// aba do Gemini. A aba reaproveita esse snapshot pra renderizar o progress
// dock mesmo quando a exportação foi disparada via MCP/CLI, e não pelo botão
// local. Mantém-se puro e sem dependências para facilitar teste.

export const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export const TERMINAL_JOB_PROGRESS_TTL_MS = 30_000;

export const setClientJobProgress = (client, payload, now = Date.now()) => {
  if (!client) return;
  if (!payload) {
    client.jobProgress = null;
    return;
  }
  client.jobProgress = {
    updatedAt: now,
    ...payload,
  };
};

export const buildJobProgressBroadcast = (client, now = Date.now()) => {
  const progress = client?.jobProgress;
  if (!progress) return null;
  if (TERMINAL_JOB_STATUSES.has(progress.status)) {
    const terminalAt = progress._terminalAt || progress.updatedAt || now;
    progress._terminalAt = terminalAt;
    if (now - terminalAt > TERMINAL_JOB_PROGRESS_TTL_MS) {
      client.jobProgress = null;
      return null;
    }
  }
  const broadcast = { ...progress };
  delete broadcast._terminalAt;
  return broadcast;
};
