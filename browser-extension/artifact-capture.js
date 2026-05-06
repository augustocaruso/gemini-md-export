(() => {
  const TRUSTED_PARENT_ORIGIN = 'https://gemini.google.com';
  const MAX_SEARCH_DEPTH = 6;
  const MAX_BRANCH_ITEMS = 80;

  const startsWithHtmlMime = (value) => /^text\/html(?:\s*;|$)/i.test(String(value || '').trim());

  const parseMaybeJson = (value) => {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  };

  const normalizePayload = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null;
    const mimeType =
      candidate.mimeType ||
      candidate.mimetype ||
      candidate.contentType ||
      candidate.content_type ||
      candidate.type ||
      '';
    if (!startsWithHtmlMime(mimeType)) return null;

    const body = typeof candidate.body === 'string' ? candidate.body : null;
    const bodyBase64 =
      typeof candidate.bodyBase64 === 'string'
        ? candidate.bodyBase64
        : typeof candidate.body_base64 === 'string'
          ? candidate.body_base64
          : null;
    if (!body && !bodyBase64) return null;

    return {
      body,
      bodyBase64,
      mimeType: String(mimeType),
    };
  };

  const findHtmlPayload = (root) => {
    const seen = new Set();
    const queue = [{ value: parseMaybeJson(root), depth: 0 }];
    while (queue.length > 0) {
      const { value, depth } = queue.shift();
      const payload = normalizePayload(value);
      if (payload) return payload;
      if (!value || typeof value !== 'object' || depth >= MAX_SEARCH_DEPTH || seen.has(value)) {
        continue;
      }
      seen.add(value);
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children.slice(0, MAX_BRANCH_ITEMS)) {
        queue.push({ value: parseMaybeJson(child), depth: depth + 1 });
      }
    }
    return null;
  };

  const sendCapture = (event, payload) => {
    try {
      chrome.runtime.sendMessage({
        type: 'gemini-md-export/artifact-html-payload',
        payload: {
          ...payload,
          sourceOrigin: event.origin,
          locationHref: location.href,
          locationOrigin: location.origin,
          locationPathname: location.pathname,
          title: document.title || '',
          capturedAt: new Date().toISOString(),
        },
      });
    } catch {
      // O frame não deve quebrar se a extensão foi recarregada no meio.
    }
  };

  window.addEventListener(
    'message',
    (event) => {
      if (event.origin !== TRUSTED_PARENT_ORIGIN) return;
      const payload = findHtmlPayload(event.data);
      if (!payload) return;
      sendCapture(event, payload);
    },
    true,
  );
})();
