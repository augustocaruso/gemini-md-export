// ==UserScript==
// @name         Gemini Export Probe
// @namespace    https://github.com/local/gemini-md-export
// @version      0.1.0
// @description  Probe mínimo para validar se o Tampermonkey está injetando scripts no Gemini.
// @match        https://gemini.google.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[gemini-probe]';

  const log = (...args) => console.log(LOG_PREFIX, ...args);

  const injectBadge = () => {
    if (!document.body || document.getElementById('gm-probe-badge')) return;

    const badge = document.createElement('div');
    badge.id = 'gm-probe-badge';
    badge.textContent = 'TM OK';
    Object.assign(badge.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      zIndex: '2147483647',
      padding: '8px 10px',
      borderRadius: '999px',
      background: '#0f9d58',
      color: '#fff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '12px',
      fontWeight: '600',
      boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
    });

    document.body.appendChild(badge);
  };

  const installDebugApi = () => {
    window.__geminiProbe = {
      url: location.href,
      readyState: document.readyState,
      title: document.title,
      userQueryCount: document.querySelectorAll('user-query').length,
      modelResponseCount: document.querySelectorAll('model-response').length,
    };
  };

  const boot = () => {
    injectBadge();
    installDebugApi();
    log('probe carregado', window.__geminiProbe);
  };

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
