// Service worker mínimo da extensão MV3.
// Nesta primeira etapa ele existe principalmente para firmar a arquitetura
// de extensão e servir de ponto de integração futura com helper local,
// native messaging ou automações.

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[gemini-md-export/ext]', 'instalada', {
    reason: details.reason,
    previousVersion: details.previousVersion || null,
  });
  setTimeout(() => {
    reloadGeminiTabs(`extension-${details.reason}`);
  }, 500);
});

const reloadGeminiTabs = (reason = 'manual') =>
  new Promise((resolve) => {
    if (!chrome.tabs?.query || !chrome.tabs?.reload) {
      resolve({ ok: false, reason: 'tabs-api-unavailable', reloaded: 0 });
      return;
    }

    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs = []) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          reason: chrome.runtime.lastError.message,
          reloaded: 0,
        });
        return;
      }

      let reloaded = 0;
      for (const tab of tabs) {
        if (!Number.isInteger(tab.id)) continue;
        chrome.tabs.reload(tab.id, { bypassCache: true }, () => {
          // Ignora tabs que sumiram no meio do reload.
          void chrome.runtime.lastError;
        });
        reloaded += 1;
      }

      console.log('[gemini-md-export/ext]', 'abas Gemini recarregadas', {
        reason,
        reloaded,
      });
      resolve({ ok: true, reason, reloaded });
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

  if (message?.type === 'gemini-md-export/reload-gemini-tabs') {
    reloadGeminiTabs(message.reason || 'content-script').then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/todo-helper') {
    sendResponse({
      ok: false,
      reason: 'helper-not-implemented-yet',
    });
  }
});
