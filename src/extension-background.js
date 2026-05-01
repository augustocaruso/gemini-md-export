// Service worker mínimo da extensão MV3.
// Nesta primeira etapa ele existe principalmente para firmar a arquitetura
// de extensão e servir de ponto de integração futura com helper local,
// native messaging ou automações.

const EXTENSION_PROTOCOL_VERSION = Number('__EXTENSION_PROTOCOL_VERSION__');
const PENDING_GEMINI_TABS_RELOAD_KEY = 'gemini-md-export.pendingGeminiTabsReload';

const extensionInfo = (sender = {}) => {
  const manifest = chrome.runtime.getManifest();
  const tab = sender.tab || null;
  return {
    ok: true,
    extensionVersion: manifest.version,
    version: manifest.version,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    extensionId: chrome.runtime.id,
    manifestVersion: manifest.manifest_version,
    buildStamp: '__BUILD_STAMP__',
    source: 'service-worker',
    tabId: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    isActiveTab: tab?.active ?? null,
  };
};

const storageGet = (key) =>
  new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(key, (items = {}) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(items[key] || null);
    });
  });

const storageSet = (value) =>
  new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.set({ [PENDING_GEMINI_TABS_RELOAD_KEY]: value }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });

const storageRemove = (key) =>
  new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.remove(key, () => {
      resolve(!chrome.runtime.lastError);
    });
  });

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

const consumePendingGeminiTabsReload = async () => {
  const pending = await storageGet(PENDING_GEMINI_TABS_RELOAD_KEY);
  if (!pending) return;
  await storageRemove(PENDING_GEMINI_TABS_RELOAD_KEY);
  setTimeout(() => {
    reloadGeminiTabs(pending.reason || 'extension-self-reload');
  }, 500);
};

setTimeout(() => {
  consumePendingGeminiTabsReload();
}, 250);

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const fetchAsset = async (source) => {
  const url = new URL(String(source || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('URL de mídia inválida.');
  }

  const isGoogleMediaHost =
    /(?:^|\.)googleusercontent\.com$/i.test(url.hostname) ||
    /(?:^|\.)google\.com$/i.test(url.hostname);

  const fetchWithCredentials = async (credentials) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url.href, {
        credentials,
        cache: 'force-cache',
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        referrer: isGoogleMediaHost ? 'https://gemini.google.com/' : undefined,
        referrerPolicy: isGoogleMediaHost ? 'strict-origin-when-cross-origin' : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let response;
  const credentialModes = isGoogleMediaHost ? ['include', 'omit'] : ['omit'];
  const errors = [];

  for (const credentials of credentialModes) {
    try {
      response = await fetchWithCredentials(credentials);
      break;
    } catch (err) {
      errors.push(`${credentials}: ${err?.message || String(err)}`);
    }
  }
  if (!response) throw new Error(errors.join('; '));

  const blob = await response.blob();
  return {
    ok: true,
    mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
    contentBase64: arrayBufferToBase64(await blob.arrayBuffer()),
  };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'gemini-md-export/ping') {
    sendResponse(extensionInfo(sender));
    return;
  }

  if (message?.type === 'GET_EXTENSION_INFO' || message?.type === 'gemini-md-export/get-info') {
    sendResponse(extensionInfo(sender));
    return;
  }

  if (message?.type === 'RELOAD_SELF' || message?.type === 'gemini-md-export/reload-self') {
    storageSet({
      reason: message.reason || 'self-reload',
      expectedExtensionVersion: message.expectedExtensionVersion || null,
      expectedProtocolVersion: message.expectedProtocolVersion || null,
      expectedBuildStamp: message.expectedBuildStamp || null,
      requestedAt: new Date().toISOString(),
    }).then(() => {
      sendResponse({ ok: true, reloading: true });
      setTimeout(() => {
        chrome.runtime.reload();
      }, 300);
    });
    return true;
  }

  if (message?.type === 'gemini-md-export/reload-gemini-tabs') {
    reloadGeminiTabs(message.reason || 'content-script').then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/fetch-asset') {
    fetchAsset(message.source)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      });
    return true;
  }

  if (message?.type === 'gemini-md-export/todo-helper') {
    sendResponse({
      ok: false,
      reason: 'helper-not-implemented-yet',
    });
  }
});
