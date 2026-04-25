// Service worker mínimo da extensão MV3.
// Nesta primeira etapa ele existe principalmente para firmar a arquitetura
// de extensão e servir de ponto de integração futura com helper local,
// native messaging ou automações.

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[gemini-md-export/ext]', 'instalada', {
    reason: details.reason,
    previousVersion: details.previousVersion || null,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'gemini-md-export/ping') {
    const tab = sender.tab || null;
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      buildStamp: '__BUILD_STAMP__',
      tabId: tab?.id ?? null,
      windowId: tab?.windowId ?? null,
      isActiveTab: tab?.active ?? null,
    });
    return;
  }

  if (message?.type === 'gemini-md-export/todo-helper') {
    sendResponse({
      ok: false,
      reason: 'helper-not-implemented-yet',
    });
  }
});
