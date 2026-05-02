const startedAt = Date.now();
let lastMessageAt = 0;

const status = () => ({
  ok: true,
  source: 'offscreen',
  startedAt,
  uptimeMs: Math.max(0, Date.now() - startedAt),
  lastMessageAt: lastMessageAt || null,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'gemini-md-export/offscreen-ping') return false;
  lastMessageAt = Date.now();
  sendResponse(status());
  return false;
});
