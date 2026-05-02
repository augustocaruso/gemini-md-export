// Service worker mínimo da extensão MV3.
// Nesta primeira etapa ele existe principalmente para firmar a arquitetura
// de extensão e servir de ponto de integração futura com helper local,
// native messaging ou automações.

const EXTENSION_PROTOCOL_VERSION = Number('__EXTENSION_PROTOCOL_VERSION__');
const PENDING_GEMINI_TABS_RELOAD_KEY = 'gemini-md-export.pendingGeminiTabsReload';
const TAB_CLAIMS_STORAGE_KEY = 'gemini-md-export.tabClaims.v1';
const TAB_GROUP_NONE = -1;
const TAB_CLAIM_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

const clampText = (value, maxLength) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const sanitizeClaimLabel = (value) => clampText(value, 16) || 'GME';

const sanitizeClaimColor = (value) => {
  const color = String(value || '').toLowerCase();
  return TAB_CLAIM_COLORS.has(color) ? color : 'green';
};

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

const storageSetKey = (key, value) =>
  new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.set({ [key]: value }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });

const storageSet = (value) => storageSetKey(PENDING_GEMINI_TABS_RELOAD_KEY, value);

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

const getTrackedTabClaims = async () => {
  const value = await storageGet(TAB_CLAIMS_STORAGE_KEY);
  return value && typeof value === 'object' ? value : {};
};

const setTrackedTabClaims = (claims) => storageSetKey(TAB_CLAIMS_STORAGE_KEY, claims || {});

const chromeGetTab = (tabId) =>
  new Promise((resolve) => {
    if (!chrome.tabs?.get || !Number.isInteger(tabId)) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });

const chromeGroupTab = (tabId) =>
  new Promise((resolve) => {
    if (!chrome.tabs?.group || !Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'tabs-group-api-unavailable' });
      return;
    }
    chrome.tabs.group({ tabIds: [tabId] }, (groupId) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: Number.isInteger(groupId), groupId });
    });
  });

const chromeUpdateTabGroup = (groupId, updateProperties) =>
  new Promise((resolve) => {
    if (!chrome.tabGroups?.update || !Number.isInteger(groupId)) {
      resolve({ ok: false, reason: 'tab-groups-api-unavailable' });
      return;
    }
    chrome.tabGroups.update(groupId, updateProperties, (group) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, group });
    });
  });

const chromeUngroupTab = (tabId) =>
  new Promise((resolve) => {
    if (!chrome.tabs?.ungroup || !Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'tabs-ungroup-api-unavailable' });
      return;
    }
    chrome.tabs.ungroup(tabId, () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true });
    });
  });

const setActionBadge = (tabId, text, color = '#188038') =>
  new Promise((resolve) => {
    if (!chrome.action?.setBadgeText || !Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'action-badge-api-unavailable' });
      return;
    }
    chrome.action.setBadgeText({ tabId, text }, () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      if (!chrome.action?.setBadgeBackgroundColor || !text) {
        resolve({ ok: true });
        return;
      }
      chrome.action.setBadgeBackgroundColor({ tabId, color }, () => {
        resolve({ ok: !chrome.runtime.lastError });
      });
    });
  });

const clearActionBadge = (tabId) => setActionBadge(tabId, '');

const cleanupStaleTabClaimVisuals = async (reason = 'stale-claim-cleanup') => {
  const claims = await getTrackedTabClaims();
  const entries = Object.entries(claims || {});
  if (!entries.length) {
    return { ok: true, reason, cleaned: 0 };
  }

  let cleaned = 0;
  for (const [key, claim] of entries) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId)) {
      delete claims[key];
      cleaned += 1;
      continue;
    }

    const tab = await chromeGetTab(tabId);
    if (tab && claim?.mode === 'tab-group' && claim.originalGroupId === TAB_GROUP_NONE) {
      const stillOurGroup =
        Number.isInteger(claim.groupId) &&
        Number.isInteger(tab.groupId) &&
        tab.groupId === claim.groupId;
      if (stillOurGroup) {
        await chromeUngroupTab(tabId);
      }
    }
    if (tab) {
      await clearActionBadge(tabId);
    }
    delete claims[key];
    cleaned += 1;
  }

  await setTrackedTabClaims(claims);
  return { ok: true, reason, cleaned };
};

const applyTabClaim = async (message, sender = {}) => {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: 'sender-tab-unavailable' };
  }

  const claimId = clampText(message.claimId, 80);
  if (!claimId) {
    return { ok: false, reason: 'claim-id-required', tabId };
  }

  const label = sanitizeClaimLabel(message.label);
  const color = sanitizeClaimColor(message.color);
  const tab = await chromeGetTab(tabId);
  const claims = await getTrackedTabClaims();
  const existing = claims[String(tabId)] || null;
  const currentGroupId =
    Number.isInteger(tab?.groupId) ? tab.groupId : existing?.groupId ?? TAB_GROUP_NONE;

  let visual = {
    mode: 'action-badge',
    tabId,
    groupId: null,
    reason: 'tab-groups-api-unavailable',
  };

  if (chrome.tabs?.group && chrome.tabGroups?.update) {
    const alreadyOurGroup =
      existing?.mode === 'tab-group' &&
      Number.isInteger(existing.groupId) &&
      currentGroupId === existing.groupId;
    if (currentGroupId === TAB_GROUP_NONE || alreadyOurGroup) {
      const grouped = alreadyOurGroup
        ? { ok: true, groupId: existing.groupId }
        : await chromeGroupTab(tabId);
      if (grouped.ok) {
        const updated = await chromeUpdateTabGroup(grouped.groupId, {
          title: label,
          color,
        });
        if (updated.ok) {
          visual = {
            mode: 'tab-group',
            tabId,
            groupId: grouped.groupId,
            color,
            label,
            reason: alreadyOurGroup ? 'updated-existing-claim-group' : 'created-tab-group',
          };
        } else {
          if (!alreadyOurGroup) {
            await chromeUngroupTab(tabId);
          }
          visual = {
            mode: 'action-badge',
            tabId,
            groupId: grouped.groupId,
            reason: updated.reason || 'tab-group-update-failed',
          };
        }
      } else {
        visual = {
          mode: 'action-badge',
          tabId,
          groupId: null,
          reason: grouped.reason || 'tab-group-create-failed',
        };
      }
    } else {
      visual = {
        mode: 'action-badge',
        tabId,
        groupId: currentGroupId,
        reason: 'tab-already-in-user-group',
      };
    }
  }

  await setActionBadge(tabId, 'GME');

  claims[String(tabId)] = {
    claimId,
    sessionId: clampText(message.sessionId, 120) || null,
    label,
    color,
    mode: visual.mode,
    groupId: visual.mode === 'tab-group' ? visual.groupId : null,
    originalGroupId:
      existing?.claimId === claimId
        ? existing.originalGroupId ?? TAB_GROUP_NONE
        : currentGroupId,
    appliedAt: new Date().toISOString(),
    expiresAt: message.expiresAt || null,
  };
  await setTrackedTabClaims(claims);

  return {
    ok: true,
    tabId,
    claimId,
    sessionId: claims[String(tabId)].sessionId,
    label,
    color,
    visual,
  };
};

const releaseTabClaim = async (message, sender = {}) => {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: 'sender-tab-unavailable' };
  }

  const claims = await getTrackedTabClaims();
  const key = String(tabId);
  const existing = claims[key] || null;
  const requestedClaimId = clampText(message.claimId, 80);

  if (existing?.claimId && requestedClaimId && existing.claimId !== requestedClaimId) {
    return {
      ok: false,
      reason: 'claim-id-mismatch',
      tabId,
      activeClaimId: existing.claimId,
      requestedClaimId,
    };
  }

  let visual = { mode: existing?.mode || 'none', tabId, released: false };
  if (existing?.mode === 'tab-group' && existing.originalGroupId === TAB_GROUP_NONE) {
    const ungrouped = await chromeUngroupTab(tabId);
    visual = {
      mode: 'tab-group',
      tabId,
      groupId: existing.groupId ?? null,
      released: ungrouped.ok,
      reason: ungrouped.reason || 'ungrouped',
    };
  }

  await clearActionBadge(tabId);
  delete claims[key];
  await setTrackedTabClaims(claims);

  return {
    ok: true,
    tabId,
    claimId: existing?.claimId || requestedClaimId || null,
    visual,
  };
};

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[gemini-md-export/ext]', 'instalada', {
    reason: details.reason,
    previousVersion: details.previousVersion || null,
  });
  cleanupStaleTabClaimVisuals(`extension-${details.reason}`).finally(() => {
    setTimeout(() => {
      reloadGeminiTabs(`extension-${details.reason}`);
    }, 500);
  });
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
  await cleanupStaleTabClaimVisuals(pending.reason || 'extension-self-reload');
  setTimeout(() => {
    reloadGeminiTabs(pending.reason || 'extension-self-reload');
  }, 500);
};

setTimeout(() => {
  consumePendingGeminiTabsReload();
}, 250);

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  getTrackedTabClaims().then((claims) => {
    if (!claims[String(tabId)]) return;
    delete claims[String(tabId)];
    setTrackedTabClaims(claims);
  });
});

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
    }).then(() => cleanupStaleTabClaimVisuals(message.reason || 'self-reload')).then(() => {
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

  if (message?.type === 'gemini-md-export/claim-tab') {
    applyTabClaim(message, sender).then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/release-tab-claim') {
    releaseTabClaim(message, sender).then(sendResponse);
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
