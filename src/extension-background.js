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
const NATIVE_HOST_NAME = 'com.augustocaruso.gemini_md_export';
const NATIVE_HOST_REQUEST_TIMEOUT_MS = 2500;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_IDLE_CLOSE_MS = 120_000;
const TAB_BROKER_CLIENT_STALE_MS = 45_000;
const CONTENT_SCRIPT_SELF_HEAL_COOLDOWN_MS = 10_000;
const CONTENT_SCRIPT_POST_INJECT_PING_ATTEMPTS = 5;
const CONTENT_SCRIPT_POST_INJECT_PING_DELAY_MS = 180;
const GEMINI_TAB_RELOAD_SETTLE_MS = 900;
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
let lastNativeHostProbe = null;
let lastOffscreenStatus = null;
let offscreenIdleCloseTimer = 0;
const tabBrokerRegistry = new Map();
const tabClaimExpiryTimers = new Map();

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
    nativeHost: lastNativeHostProbe,
    offscreen: lastOffscreenStatus,
    tabBroker: summarizeTabBrokerRegistry({ currentTabId: tab?.id ?? null }),
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

const clearTabClaimExpiryTimer = (tabId) => {
  const key = String(tabId);
  const timer = tabClaimExpiryTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  tabClaimExpiryTimers.delete(key);
};

const releaseTrackedTabClaimByTabId = async (
  tabId,
  { claimId = null, reason = 'background-release' } = {},
) => {
  if (!Number.isInteger(tabId)) return { ok: false, reason: 'tab-id-unavailable', tabId };
  clearTabClaimExpiryTimer(tabId);
  const claims = await getTrackedTabClaims();
  const key = String(tabId);
  const existing = claims[key] || null;
  const requestedClaimId = clampText(claimId, 80);

  if (existing?.claimId && requestedClaimId && existing.claimId !== requestedClaimId) {
    return {
      ok: false,
      reason: 'claim-id-mismatch',
      tabId,
      activeClaimId: existing.claimId,
      requestedClaimId,
    };
  }

  let visual = { mode: existing?.mode || 'none', tabId, released: false, reason };
  if (existing?.mode === 'tab-group' && existing.originalGroupId === TAB_GROUP_NONE) {
    const ungrouped = await chromeUngroupTab(tabId);
    visual = {
      mode: 'tab-group',
      tabId,
      groupId: existing.groupId ?? null,
      released: ungrouped.ok,
      reason: ungrouped.reason || reason,
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

const scheduleTabClaimExpiry = (tabId, claim = {}) => {
  clearTabClaimExpiryTimer(tabId);
  const expiresAt = Date.parse(claim.expiresAt || '');
  if (!Number.isFinite(expiresAt)) return;
  const delayMs = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    tabClaimExpiryTimers.delete(String(tabId));
    releaseTrackedTabClaimByTabId(tabId, {
      claimId: claim.claimId || null,
      reason: 'claim-expired',
    });
  }, delayMs);
  tabClaimExpiryTimers.set(String(tabId), timer);
};

const pruneTabBrokerRegistry = () => {
  const now = Date.now();
  for (const [tabId, entry] of tabBrokerRegistry.entries()) {
    if (now - Number(entry.updatedAtMs || 0) > TAB_BROKER_CLIENT_STALE_MS) {
      tabBrokerRegistry.delete(tabId);
    }
  }
};

const summarizeTabBrokerRegistry = ({ currentTabId = null } = {}) => {
  pruneTabBrokerRegistry();
  const entries = Array.from(tabBrokerRegistry.values()).map((entry, index) => ({
    index: index + 1,
    tabId: entry.tabId,
    windowId: entry.windowId,
    url: entry.url,
    title: entry.title,
    chatId: entry.chatId,
    version: entry.version,
    protocolVersion: entry.protocolVersion,
    buildStamp: entry.buildStamp,
    tabClaim: entry.tabClaim || null,
    activeTabOperation: entry.activeTabOperation || null,
    isActiveTab: entry.isActiveTab === true,
    updatedAt: entry.updatedAt,
    staleAfterMs: TAB_BROKER_CLIENT_STALE_MS,
    current: currentTabId !== null && entry.tabId === currentTabId,
  }));
  return {
    ok: true,
    staleAfterMs: TAB_BROKER_CLIENT_STALE_MS,
    tabCount: entries.length,
    busyTabCount: entries.filter((entry) => entry.activeTabOperation).length,
    claimedTabCount: entries.filter((entry) => entry.tabClaim).length,
    tabs: entries,
  };
};

const updateTabBrokerRegistry = (message = {}, sender = {}) => {
  const status = message.status || {};
  const bridge = status.bridge || {};
  const senderTab = sender.tab || {};
  const tabId = Number(senderTab.id ?? bridge.tabId ?? status.tabId);
  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: 'tab-id-unavailable' };
  }
  const now = Date.now();
  const entry = {
    tabId,
    windowId: Number(senderTab.windowId ?? bridge.windowId ?? status.windowId) || null,
    url: status.url || senderTab.url || null,
    title: status.title || senderTab.title || null,
    chatId: status.chatId || null,
    version: status.version || status.extensionVersion || null,
    protocolVersion: status.protocolVersion ?? null,
    buildStamp: status.buildStamp || null,
    tabClaim: message.tabClaim || status.tabClaim || null,
    activeTabOperation: message.activeTabOperation || status.activeTabOperation || null,
    isActiveTab: senderTab.active ?? bridge.isActiveTab ?? null,
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
    reason: message.reason || 'content-script-update',
  };
  tabBrokerRegistry.set(tabId, entry);
  return { ok: true, entry, broker: summarizeTabBrokerRegistry({ currentTabId: tabId }) };
};

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

const randomRequestId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

const nativeHostRequest = (command, payload = {}, { timeoutMs = NATIVE_HOST_REQUEST_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    if (!chrome.runtime?.connectNative) {
      resolve({ ok: false, code: 'native_messaging_unavailable' });
      return;
    }

    const id = randomRequestId();
    let settled = false;
    let port = null;
    let timer = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port?.disconnect?.();
      } catch {
        // ignore stale native port
      }
      resolve(value);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      finish({
        ok: false,
        code: 'native_host_connect_failed',
        error: err?.message || String(err),
      });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, code: 'native_host_timeout', timeoutMs });
    }, timeoutMs);

    port.onMessage.addListener((message) => {
      if (message?.id !== id) return;
      finish(message || { ok: false, code: 'native_host_empty_response' });
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      finish({
        ok: false,
        code: 'native_host_disconnected',
        error: chrome.runtime.lastError?.message || null,
      });
    });

    try {
      port.postMessage({
        id,
        command,
        payload,
        extension: currentRuntimeInfo(),
      });
    } catch (err) {
      finish({
        ok: false,
        code: 'native_host_post_failed',
        error: err?.message || String(err),
      });
    }
  });

const probeNativeHost = async ({ reason = 'manual', timeoutMs = NATIVE_HOST_REQUEST_TIMEOUT_MS } = {}) => {
  const startedAt = Date.now();
  const result = await nativeHostRequest('ping', {}, { timeoutMs });
  lastNativeHostProbe = {
    ...result,
    hostName: NATIVE_HOST_NAME,
    reason,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  return lastNativeHostProbe;
};

const offscreenReason = () => {
  if (chrome.offscreen?.Reason?.WORKERS) return chrome.offscreen.Reason.WORKERS;
  return 'WORKERS';
};

const hasOffscreenDocument = async () => {
  if (!chrome.offscreen) {
    return { ok: false, exists: false, reason: 'offscreen-api-unavailable' };
  }
  if (chrome.offscreen.hasDocument) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const maybePromise = chrome.offscreen.hasDocument((exists) => {
          if (chrome.runtime.lastError) {
            done({ ok: false, exists: false, reason: chrome.runtime.lastError.message });
            return;
          }
          done({ ok: true, exists: !!exists });
        });
        if (maybePromise?.then) {
          maybePromise.then(
            (exists) => done({ ok: true, exists: !!exists }),
            (err) => done({ ok: false, exists: false, reason: err?.message || String(err) }),
          );
        }
      } catch (err) {
        done({ ok: false, exists: false, reason: err?.message || String(err) });
      }
    });
  }
  return { ok: true, exists: false, reason: 'has-document-unavailable' };
};

const sendOffscreenPing = () =>
  new Promise((resolve) => {
    if (!chrome.runtime?.sendMessage) {
      resolve({ ok: false, reason: 'runtime-message-unavailable' });
      return;
    }
    chrome.runtime.sendMessage({ type: 'gemini-md-export/offscreen-ping' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: 'empty-offscreen-response' });
    });
  });

const clearOffscreenIdleTimer = () => {
  if (!offscreenIdleCloseTimer) return;
  clearTimeout(offscreenIdleCloseTimer);
  offscreenIdleCloseTimer = 0;
};

const scheduleOffscreenIdleClose = ({ reason = 'idle', idleCloseMs = OFFSCREEN_IDLE_CLOSE_MS } = {}) => {
  clearOffscreenIdleTimer();
  const ms = Math.max(0, Number(idleCloseMs) || 0);
  if (!ms) return null;
  const idleCloseAt = new Date(Date.now() + ms).toISOString();
  offscreenIdleCloseTimer = setTimeout(() => {
    offscreenIdleCloseTimer = 0;
    closeOffscreenDocument({ reason: `${reason}-idle` });
  }, ms);
  return idleCloseAt;
};

const ensureOffscreenDocument = async ({
  reason = 'manual',
  idleCloseMs = OFFSCREEN_IDLE_CLOSE_MS,
} = {}) => {
  const startedAt = Date.now();
  const current = await hasOffscreenDocument();
  if (!current.ok) {
    lastOffscreenStatus = {
      ok: false,
      status: 'unavailable',
      reason,
      error: current.reason || null,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    return lastOffscreenStatus;
  }

  let created = false;
  if (!current.exists) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [offscreenReason()],
        justification:
          'Manter um contexto leve de coordenação para diagnosticar native messaging e filas da extensão.',
      });
      created = true;
    } catch (err) {
      lastOffscreenStatus = {
        ok: false,
        status: 'create-failed',
        reason,
        error: err?.message || String(err),
        checkedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
      return lastOffscreenStatus;
    }
  }

  const ping = await sendOffscreenPing();
  const idleCloseAt = scheduleOffscreenIdleClose({ reason, idleCloseMs });
  lastOffscreenStatus = {
    ok: ping.ok === true,
    status: ping.ok === true ? 'ready' : 'ping-failed',
    reason,
    created,
    active: true,
    idleCloseAt,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    document: ping.ok === true ? ping : null,
    lastKeepaliveAt: ping.lastKeepaliveAt || null,
    keepaliveCount: ping.keepaliveCount ?? null,
    error: ping.ok === true ? null : ping.reason || ping.error || null,
  };
  return lastOffscreenStatus;
};

const closeOffscreenDocument = async ({ reason = 'manual' } = {}) => {
  clearOffscreenIdleTimer();
  if (!chrome.offscreen?.closeDocument) {
    return { ok: false, reason: 'offscreen-close-api-unavailable' };
  }
  try {
    await chrome.offscreen.closeDocument();
    lastOffscreenStatus = {
      ok: true,
      status: 'closed',
      reason,
      active: false,
      checkedAt: new Date().toISOString(),
    };
    return lastOffscreenStatus;
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
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

  const trackedClaim = {
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
  claims[String(tabId)] = trackedClaim;
  await setTrackedTabClaims(claims);
  scheduleTabClaimExpiry(tabId, trackedClaim);

  return {
    ok: true,
    tabId,
    claimId,
    sessionId: trackedClaim.sessionId,
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

  return releaseTrackedTabClaimByTabId(tabId, {
    claimId: message.claimId || null,
    reason: message.reason || 'content-script-release',
  });
};

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[gemini-md-export/ext]', 'instalada', {
    reason: details.reason,
    previousVersion: details.previousVersion || null,
  });
  cleanupStaleTabClaimVisuals(`extension-${details.reason}`).finally(() => {
    setTimeout(() => {
      reloadThenSelfHealGeminiTabs({
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

const reloadThenSelfHealGeminiTabs = async ({
  reason = 'extension-runtime-refresh',
  force = true,
  settleMs = GEMINI_TAB_RELOAD_SETTLE_MS,
} = {}) => {
  const reload = await reloadGeminiTabs(reason);
  if (reload?.reloaded > 0 && settleMs > 0) {
    await sleep(settleMs);
  }
  const selfHeal = await selfHealGeminiTabs({
    reason: `${reason}-post-reload`,
    force,
  });
  lastContentScriptSelfHeal = {
    ...selfHeal,
    reload,
    reloaded: reload?.reloaded ?? 0,
    status:
      reload?.ok === false
        ? 'reload-failed'
        : selfHeal?.status || (selfHeal?.ok ? 'ok' : 'partial'),
    ok: reload?.ok !== false && selfHeal?.ok !== false,
  };
  return lastContentScriptSelfHeal;
};

const consumePendingGeminiTabsReload = async () => {
  const pending = await storageGet(PENDING_GEMINI_TABS_RELOAD_KEY);
  if (!pending) return;
  await storageRemove(PENDING_GEMINI_TABS_RELOAD_KEY);
  await cleanupStaleTabClaimVisuals(pending.reason || 'extension-self-reload');
  setTimeout(() => {
    reloadThenSelfHealGeminiTabs({
      reason: pending.reason || 'extension-self-reload',
      force: true,
    });
  }, 500);
};

setTimeout(() => {
  consumePendingGeminiTabsReload();
}, 250);

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  tabBrokerRegistry.delete(tabId);
  clearTabClaimExpiryTimer(tabId);
  getTrackedTabClaims().then((claims) => {
    if (!claims[String(tabId)]) return;
    delete claims[String(tabId)];
    setTrackedTabClaims(claims);
  });
});

chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo = {}, tab = {}) => {
  const existing = tabBrokerRegistry.get(tabId);
  if (!existing) return;
  const now = Date.now();
  tabBrokerRegistry.set(tabId, {
    ...existing,
    url: changeInfo.url || tab.url || existing.url,
    title: tab.title || existing.title,
    isActiveTab: tab.active ?? existing.isActiveTab,
    navigationStatus: changeInfo.status || existing.navigationStatus || null,
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
    reason: changeInfo.status === 'loading' ? 'tab-loading' : 'tab-updated',
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

  if (message?.type === 'gemini-md-export/native-host-health') {
    ensureOffscreenDocument({
      reason: message.reason || 'native-host-health',
      idleCloseMs: message.idleCloseMs || OFFSCREEN_IDLE_CLOSE_MS,
    })
      .then(() =>
        probeNativeHost({
          reason: message.reason || 'content-script',
          timeoutMs: message.timeoutMs || NATIVE_HOST_REQUEST_TIMEOUT_MS,
        }),
      )
      .then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/native-proxy-http') {
    ensureOffscreenDocument({
      reason: message.reason || 'native-proxy-http',
      idleCloseMs: message.idleCloseMs || OFFSCREEN_IDLE_CLOSE_MS,
    })
      .then(() =>
        nativeHostRequest(
          'proxyHttp',
          {
            bridgeUrl: message.bridgeUrl || 'http://127.0.0.1:47283',
            path: message.path || '/',
            method: message.method || 'GET',
            payload: message.payload,
            timeoutMs: message.timeoutMs || 10000,
          },
          {
            timeoutMs: Math.max(
              NATIVE_HOST_REQUEST_TIMEOUT_MS,
              Number(message.timeoutMs || 10000) + 1200,
            ),
          },
        ),
      )
      .then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/offscreen-keepalive') {
    lastOffscreenStatus = {
      ...(lastOffscreenStatus || {}),
      ok: true,
      status: 'keepalive',
      active: true,
      reason: lastOffscreenStatus?.reason || 'offscreen-keepalive',
      checkedAt: new Date().toISOString(),
      startedAt: message.startedAt || null,
      uptimeMs: message.uptimeMs ?? null,
      lastKeepaliveAt: message.lastKeepaliveAt || new Date().toISOString(),
      keepaliveCount: message.keepaliveCount ?? null,
    };
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'gemini-md-export/offscreen-status') {
    const action = message.action || 'ensure';
    if (action === 'close') {
      closeOffscreenDocument({ reason: message.reason || 'content-script' }).then(sendResponse);
      return true;
    }
    ensureOffscreenDocument({
      reason: message.reason || 'content-script',
      idleCloseMs: message.idleCloseMs || OFFSCREEN_IDLE_CLOSE_MS,
    }).then(sendResponse);
    return true;
  }

  if (message?.type === 'gemini-md-export/tab-broker-update') {
    sendResponse(updateTabBrokerRegistry(message, sender));
    return false;
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
