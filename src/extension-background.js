// Service worker mínimo da extensão MV3.
// Nesta primeira etapa ele existe principalmente para firmar a arquitetura
// de extensão e servir de ponto de integração futura com helper local,
// native messaging ou automações.

const EXTENSION_PROTOCOL_VERSION = Number('__EXTENSION_PROTOCOL_VERSION__');
const PENDING_GEMINI_TABS_RELOAD_KEY = 'gemini-md-export.pendingGeminiTabsReload';
const TAB_CLAIMS_STORAGE_KEY = 'gemini-md-export.tabClaims.v1';
const TAB_GROUP_NONE = -1;
const GEMINI_TAB_URL_PATTERN = 'https://gemini.google.com/*';
const CONTENT_SCRIPT_FILE = 'content.js';
const CONTENT_SCRIPT_PING_TYPE = 'gemini-md-export/content-ping';
const CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS = 10_000;
const CONTENT_SCRIPT_POST_INJECT_PING_ATTEMPTS = 5;
const CONTENT_SCRIPT_POST_INJECT_PING_DELAY_MS = 180;
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
const contentScriptSelfHealCooldowns = new Map();
let lastContentScriptSelfHeal = null;

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
    selfHeal: lastContentScriptSelfHeal,
  };
};

const currentRuntimeInfo = () => {
  const manifest = chrome.runtime.getManifest();
  return {
    extensionVersion: manifest.version,
    version: manifest.version,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    buildStamp: '__BUILD_STAMP__',
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const chromeQueryGeminiTabs = () =>
  new Promise((resolve) => {
    if (!chrome.tabs?.query) {
      resolve({ ok: false, reason: 'tabs-query-api-unavailable', tabs: [] });
      return;
    }
    chrome.tabs.query({ url: GEMINI_TAB_URL_PATTERN }, (tabs = []) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          reason: chrome.runtime.lastError.message,
          tabs: [],
        });
        return;
      }
      resolve({ ok: true, tabs });
    });
  });

const chromeSendTabMessage = (tabId, message, { timeoutMs = 1500 } = {}) =>
  new Promise((resolve) => {
    if (!chrome.tabs?.sendMessage || !Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'tabs-send-message-api-unavailable' });
      return;
    }

    let settled = false;
    let timer = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      finish({ ok: false, reason: 'content-script-ping-timeout' });
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        finish({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      finish({ ok: true, response: response || null });
    });
  });

const pingContentScript = (tabId, { timeoutMs = 1500 } = {}) =>
  chromeSendTabMessage(
    tabId,
    {
      type: CONTENT_SCRIPT_PING_TYPE,
      expected: currentRuntimeInfo(),
    },
    { timeoutMs },
  );

const contentScriptMatchesCurrentRuntime = (response) => {
  const expected = currentRuntimeInfo();
  return (
    response?.ok === true &&
    Number(response.protocolVersion) === Number(expected.protocolVersion) &&
    String(response.extensionVersion || response.version || '') ===
      String(expected.extensionVersion) &&
    String(response.buildStamp || '') === String(expected.buildStamp || '')
  );
};

const chromeExecuteContentScript = (tabId) =>
  new Promise((resolve) => {
    if (!chrome.scripting?.executeScript || !Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'scripting-api-unavailable' });
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, resultCount: Array.isArray(results) ? results.length : 0 });
      },
    );
  });

const waitForContentScriptAfterInjection = async (tabId) => {
  let lastPing = null;
  for (let attempt = 1; attempt <= CONTENT_SCRIPT_POST_INJECT_PING_ATTEMPTS; attempt += 1) {
    await sleep(CONTENT_SCRIPT_POST_INJECT_PING_DELAY_MS);
    lastPing = await pingContentScript(tabId, { timeoutMs: 1200 });
    if (contentScriptMatchesCurrentRuntime(lastPing.response)) {
      return {
        ok: true,
        attempt,
        ping: lastPing,
      };
    }
  }
  return {
    ok: false,
    attempt: CONTENT_SCRIPT_POST_INJECT_PING_ATTEMPTS,
    ping: lastPing,
  };
};

const ensureContentScriptForTab = async (tab, options = {}) => {
  const tabId = Number(tab?.id);
  const force = options.force === true;
  const reason = options.reason || 'self-heal';
  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: 'tab-id-unavailable', tabId: null };
  }

  const before = await pingContentScript(tabId);
  if (contentScriptMatchesCurrentRuntime(before.response)) {
    return {
      ok: true,
      status: 'already-current',
      reason,
      tabId,
      url: tab.url || null,
      injected: false,
      before: before.response,
    };
  }

  const now = Date.now();
  const cooldown = contentScriptSelfHealCooldowns.get(tabId);
  if (!force && cooldown && now - cooldown.at < CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS) {
    return {
      ok: false,
      status: 'cooldown',
      reason,
      tabId,
      url: tab.url || null,
      injected: false,
      before: before.response || null,
      pingError: before.reason || null,
      cooldownMs: CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS - (now - cooldown.at),
    };
  }

  contentScriptSelfHealCooldowns.set(tabId, {
    at: now,
    reason,
    buildStamp: currentRuntimeInfo().buildStamp,
  });

  const injected = await chromeExecuteContentScript(tabId);
  if (!injected.ok) {
    return {
      ok: false,
      status: 'inject-failed',
      reason,
      tabId,
      url: tab.url || null,
      injected: false,
      before: before.response || null,
      pingError: before.reason || null,
      injectError: injected.reason || null,
    };
  }

  const after = await waitForContentScriptAfterInjection(tabId);
  return {
    ok: after.ok,
    status: after.ok ? 'injected-current' : 'injected-unconfirmed',
    reason,
    tabId,
    url: tab.url || null,
    injected: true,
    before: before.response || null,
    pingError: before.reason || null,
    after: after.ping?.response || null,
    afterError: after.ping?.reason || null,
    attempts: after.attempt,
    buildStampBefore: before.response?.buildStamp || null,
    buildStampAfter: after.ping?.response?.buildStamp || null,
  };
};

const selfHealGeminiTabs = async ({ reason = 'self-heal', force = false } = {}) => {
  const startedAt = Date.now();
  const queried = await chromeQueryGeminiTabs();
  if (!queried.ok) {
    lastContentScriptSelfHeal = {
      ok: false,
      reason,
      status: 'query-failed',
      error: queried.reason || null,
      at: new Date().toISOString(),
    };
    return lastContentScriptSelfHeal;
  }

  const results = [];
  for (const tab of queried.tabs) {
    results.push(await ensureContentScriptForTab(tab, { reason, force }));
  }

  const injected = results.filter((item) => item.injected).length;
  const current = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok && item.status !== 'cooldown').length;
  lastContentScriptSelfHeal = {
    ok: failed === 0,
    reason,
    status: failed === 0 ? 'ok' : 'partial',
    at: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    tabCount: queried.tabs.length,
    current,
    injected,
    failed,
    results,
  };
  console.log('[gemini-md-export/ext]', 'self-heal content script', lastContentScriptSelfHeal);
  return lastContentScriptSelfHeal;
};

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
      selfHealGeminiTabs({
        reason: `extension-${details.reason}`,
        force: true,
      });
    }, 500);
  });
});

chrome.runtime.onStartup?.addListener?.(() => {
  setTimeout(() => {
    selfHealGeminiTabs({
      reason: 'browser-startup',
      force: false,
    });
  }, 800);
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
    selfHealGeminiTabs({
      reason: pending.reason || 'extension-self-reload',
      force: true,
    });
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

  if (message?.type === 'gemini-md-export/self-heal-gemini-tabs') {
    selfHealGeminiTabs({
      reason: message.reason || 'content-script',
      force: message.force === true,
    }).then(sendResponse);
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
