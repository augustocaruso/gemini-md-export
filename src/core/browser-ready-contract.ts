type BrowserReadyStatusLike = {
  ready?: boolean;
  blockingIssue?: unknown;
  expectedChromeExtension?: unknown;
  browserWake?: unknown;
  selfHeal?: unknown;
  connectedClients?: unknown;
  clients?: unknown;
};

export const connectedClientsFromReadyStatus = (status: BrowserReadyStatusLike) => {
  if (Array.isArray(status.connectedClients)) return status.connectedClients;
  if (Array.isArray(status.clients)) return status.clients;
  return [];
};

export const browserReadyProblemForRepair = (status: BrowserReadyStatusLike) => ({
  ready: status.ready === true,
  blockingIssue: status.blockingIssue || null,
  expectedChromeExtension: status.expectedChromeExtension || null,
  browserWake: status.browserWake || null,
  selfHeal: status.selfHeal || null,
  connectedClients: connectedClientsFromReadyStatus(status),
});

export const assertBrowserReadyForRepair = (status: BrowserReadyStatusLike) => {
  const clients = connectedClientsFromReadyStatus(status);
  if (status.ready === true && !status.blockingIssue && clients.length > 0) return;
  throw new Error(
    `Browser/MCP nao esta pronto para reexportar: ${JSON.stringify(
      browserReadyProblemForRepair(status),
    )}`,
  );
};
