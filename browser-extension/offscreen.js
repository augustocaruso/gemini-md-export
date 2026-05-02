const startedAt = Date.now();
let lastMessageAt = 0;
let lastKeepaliveAt = 0;
let keepaliveCount = 0;
const KEEPALIVE_INTERVAL_MS = 20_000;

const status = () => ({
  ok: true,
  source: 'offscreen',
  startedAt,
  uptimeMs: Math.max(0, Date.now() - startedAt),
  lastMessageAt: lastMessageAt || null,
  lastKeepaliveAt: lastKeepaliveAt || null,
  keepaliveCount,
});

const sendKeepalive = () => {
  lastKeepaliveAt = Date.now();
  keepaliveCount += 1;
  chrome.runtime
    .sendMessage({
      type: 'gemini-md-export/offscreen-keepalive',
      ...status(),
    })
    .catch(() => {
      // O service worker pode estar reiniciando; o próximo tick reabre o canal.
    });
};

setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'gemini-md-export/offscreen-ping') return false;
  lastMessageAt = Date.now();
  sendResponse(status());
  return false;
});
