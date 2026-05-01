export const DEFAULT_CHROME_GUARD_CONFIG = Object.freeze({
  profileDirectory: null,
  launchIfClosed: true,
  initialConnectTimeoutMs: 20_000,
  reloadTimeoutMs: 75_000,
  maxReloadAttempts: 1,
  pollIntervalMs: 500,
  useExtensionsReloaderFallback: false,
});

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeUserError = (message, code, data = {}) => {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
};

const normalizeConfig = (config = {}) => ({
  ...DEFAULT_CHROME_GUARD_CONFIG,
  ...Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== null),
  ),
});

const clientBuildStamp = (client) => client?.buildStamp || client?.page?.buildStamp || null;

const clientMatchesExpected = (client, expected) =>
  !!client &&
  (!expected ||
    (isProtocolMatch(client.protocolVersion, expected.protocolVersion) &&
      isVersionMatch(client.extensionVersion, expected.extensionVersion) &&
      isBuildStampMatch(clientBuildStamp(client), expected.buildStamp)));

const selectClient = (clients, preferredClientId, previousClient = null, expected = null) => {
  const liveClients = Array.isArray(clients) ? clients : [];
  const matchingExpected = expected
    ? liveClients.filter((client) => clientMatchesExpected(client, expected))
    : [];
  if (preferredClientId) {
    const exact = liveClients.find((client) => client.clientId === preferredClientId);
    if (exact && clientMatchesExpected(exact, expected)) return exact;
  }
  if (previousClient?.tabId !== undefined && previousClient?.tabId !== null) {
    const sameTab = matchingExpected.find((client) => client.tabId === previousClient.tabId);
    if (sameTab) return sameTab;
  }
  if (previousClient?.windowId !== undefined && previousClient?.windowId !== null) {
    const sameWindowActive = matchingExpected.find(
      (client) => client.windowId === previousClient.windowId && client.isActiveTab === true,
    );
    if (sameWindowActive) return sameWindowActive;
  }
  if (matchingExpected[0]) return matchingExpected[0];

  if (preferredClientId) {
    const exact = liveClients.find((client) => client.clientId === preferredClientId);
    if (exact) return exact;
  }
  if (previousClient?.tabId !== undefined && previousClient?.tabId !== null) {
    const sameTab = liveClients.find((client) => client.tabId === previousClient.tabId);
    if (sameTab) return sameTab;
  }
  if (previousClient?.windowId !== undefined && previousClient?.windowId !== null) {
    const sameWindowActive = liveClients.find(
      (client) => client.windowId === previousClient.windowId && client.isActiveTab === true,
    );
    if (sameWindowActive) return sameWindowActive;
  }
  return liveClients[0] || null;
};

const isVersionMatch = (actual, expected) => String(actual || '') === String(expected || '');

const isProtocolMatch = (actual, expected) => Number(actual) === Number(expected);

const isBuildStampMatch = (actual, expected) =>
  !expected || String(actual || '') === String(expected || '');

const mismatchFor = (info, expected) => {
  if (!info) return { kind: 'unreachable' };
  if (!isProtocolMatch(info.protocolVersion, expected.protocolVersion)) {
    return {
      kind: 'protocol',
      actual: info.protocolVersion ?? null,
      expected: expected.protocolVersion,
    };
  }
  if (!isVersionMatch(info.extensionVersion, expected.extensionVersion)) {
    return {
      kind: 'version',
      actual: info.extensionVersion ?? null,
      expected: expected.extensionVersion,
    };
  }
  if (!isBuildStampMatch(info.buildStamp, expected.buildStamp)) {
    return {
      kind: 'build',
      actual: info.buildStamp ?? null,
      expected: expected.buildStamp,
    };
  }
  return null;
};

const formatMismatchError = (mismatch, { afterReload = false } = {}) => {
  if (mismatch.kind === 'protocol') {
    return makeUserError(
      `O protocolo da extensão do Chrome está incompatível. Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. O MCP tenta reload automático quando permitido; se continuar assim, confirme se a extensão unpacked aponta para a pasta browser-extension atualizada pelo Gemini CLI.`,
      'chrome_extension_protocol_mismatch',
      mismatch,
    );
  }

  if (mismatch.kind === 'version') {
    const prefix = afterReload
      ? 'A extensão do Chrome ainda está antiga depois do reload.'
      : 'A extensão do Chrome está antiga.';
    return makeUserError(
      `${prefix} Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. Verifique se o Chrome está carregando a extensão a partir da mesma pasta browser-extension atualizada pelo Gemini CLI.`,
      'chrome_extension_version_mismatch',
      mismatch,
    );
  }

  if (mismatch.kind === 'build') {
    const prefix = afterReload
      ? 'A extensão do Chrome/Dia ainda está com build antigo depois do reload.'
      : 'A extensão do Chrome/Dia está com build antigo.';
    return makeUserError(
      `${prefix} Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. O MCP tentou/permite reload automático; se continuar, confirme se a extensão unpacked aponta para a pasta browser-extension atualizada.`,
      'chrome_extension_build_mismatch',
      mismatch,
    );
  }

  return makeUserError(
    'A extensão do Chrome não está acessível. Abra Chrome/Edge com o perfil correto, confirme que a extensão unpacked está ativa e abra https://gemini.google.com/app.',
    'chrome_extension_unreachable',
    mismatch,
  );
};

const probeExtensionInfo = async (deps, state) => {
  const startedAt = Date.now();
  state.metrics = state.metrics || {};
  state.metrics.extensionInfoAttempts = (state.metrics.extensionInfoAttempts || 0) + 1;
  const client = selectClient(
    deps.getLiveClients(),
    state.preferredClientId,
    state.previousClient,
    deps.expected,
  );
  if (!client) {
    state.metrics.extensionInfoMs =
      (state.metrics.extensionInfoMs || 0) + Math.max(0, Date.now() - startedAt);
    return null;
  }

  try {
    const info = await deps.getChromeExtensionInfo(client);
    if (!info?.ok) {
      if (client.extensionVersion || client.protocolVersion !== undefined) {
        state.previousClient = client;
        return {
          client,
          info: {
            ok: true,
            extensionVersion: client.extensionVersion || null,
            protocolVersion: client.protocolVersion ?? null,
            buildStamp: client.buildStamp || client.page?.buildStamp || null,
            source: 'heartbeat-fallback',
          },
        };
      }
      return null;
    }
    state.previousClient = client;
    return { client, info };
  } catch (err) {
    state.lastProbeError = err?.message || String(err);
    if (client.extensionVersion || client.protocolVersion !== undefined) {
      state.previousClient = client;
      return {
        client,
        info: {
          ok: true,
          extensionVersion: client.extensionVersion || null,
          protocolVersion: client.protocolVersion ?? null,
          buildStamp: client.buildStamp || client.page?.buildStamp || null,
          source: 'heartbeat-fallback',
        },
      };
    }
    return null;
  } finally {
    state.metrics.extensionInfoMs =
      (state.metrics.extensionInfoMs || 0) + Math.max(0, Date.now() - startedAt);
  }
};

const waitForExtensionInfo = async (deps, state, timeoutMs, pollIntervalMs) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const probe = await probeExtensionInfo(deps, state);
    if (probe) return probe;
    await deps.sleep(pollIntervalMs);
  }
  return null;
};

const waitForMatchingExtensionInfo = async (deps, state, expected, timeoutMs, pollIntervalMs) => {
  const startedAt = Date.now();
  let lastProbe = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const probe = await probeExtensionInfo(deps, state);
    if (probe) {
      lastProbe = probe;
      if (!mismatchFor(probe.info, expected)) return probe;
    }
    await deps.sleep(pollIntervalMs);
  }
  return lastProbe;
};

export const ensureChromeExtensionReady = async (deps, options = {}) => {
  const config = normalizeConfig({ ...deps.config, ...options.config });
  const expected = deps.expected;
  const state = {
    preferredClientId: options.clientId || options.preferredClientId || null,
    previousClient: null,
    lastProbeError: null,
    metrics: {
      totalMs: 0,
      extensionInfoMs: 0,
      extensionInfoAttempts: 0,
      initialWaitMs: 0,
      launchMs: 0,
      launchWaitMs: 0,
      reloadMs: 0,
      reloadWaitMs: 0,
    },
  };
  const guardStartedAt = Date.now();
  const sleep = deps.sleep || sleepDefault;
  deps.sleep = sleep;
  const log = (event, data = {}) => {
    deps.log?.('[chrome-extension-guard]', event, JSON.stringify(data));
  };

  log('checking', {
    expectedExtensionVersion: expected.extensionVersion,
    expectedProtocolVersion: expected.protocolVersion,
    expectedBuildStamp: expected.buildStamp || null,
    preferredClientId: state.preferredClientId,
  });

  let launchedChrome = false;
  let launchResult = null;
  let reloadAttempts = 0;
  let probe = await probeExtensionInfo(deps, state);

  if (!probe && config.initialConnectTimeoutMs > 0) {
    log('waiting-initial-client', {
      timeoutMs: config.initialConnectTimeoutMs,
    });
    const initialWaitStartedAt = Date.now();
    probe = await waitForExtensionInfo(
      deps,
      state,
      config.initialConnectTimeoutMs,
      config.pollIntervalMs,
    );
    state.metrics.initialWaitMs += Math.max(0, Date.now() - initialWaitStartedAt);
  }

  if (!probe && (options.allowLaunchChrome ?? config.launchIfClosed)) {
    const launchStartedAt = Date.now();
    launchResult = await deps.launchChromeForGemini?.({
      profileDirectory: config.profileDirectory,
    });
    state.metrics.launchMs += Math.max(0, Date.now() - launchStartedAt);
    launchedChrome = !!launchResult?.attempted;
    log('launch-attempted', {
      attempted: launchedChrome,
      supported: launchResult?.supported ?? null,
      method: launchResult?.method ?? null,
      browserName: launchResult?.browserName ?? null,
      fallbackFrom: launchResult?.fallbackFrom ?? null,
      reason: launchResult?.reason ?? null,
      error: launchResult?.error ?? null,
    });
    const launchWaitStartedAt = Date.now();
    probe = await waitForExtensionInfo(deps, state, config.reloadTimeoutMs, config.pollIntervalMs);
    state.metrics.launchWaitMs += Math.max(0, Date.now() - launchWaitStartedAt);
  }

  if (!probe) {
    if (launchResult?.reason === 'browser-not-found') {
      throw makeUserError(
        'A extensão do Chrome não está acessível e não encontrei Chrome/Edge/Brave/Dia para abrir automaticamente. Abra o navegador onde a extensão unpacked está instalada, confirme o perfil correto e acesse https://gemini.google.com/app.',
        'chrome_extension_browser_not_found',
        {
          launchedChrome,
          launchResult,
          lastProbeError: state.lastProbeError,
        },
      );
    }
    throw makeUserError(
      'A extensão do Chrome não está acessível. Tentei localizar uma aba do Gemini conectada, mas a extensão não respondeu. Abra Chrome/Edge com o perfil correto, confirme que a extensão unpacked está ativa e abra https://gemini.google.com/app.',
      'chrome_extension_unreachable',
      {
        launchedChrome,
        launchResult,
        lastProbeError: state.lastProbeError,
      },
    );
  }

  while (true) {
    const mismatch = mismatchFor(probe.info, expected);
    log('version-check', {
      actualExtensionVersion: probe.info.extensionVersion ?? null,
      expectedExtensionVersion: expected.extensionVersion,
      actualProtocolVersion: probe.info.protocolVersion ?? null,
      expectedProtocolVersion: expected.protocolVersion,
      actualBuildStamp: probe.info.buildStamp ?? null,
      expectedBuildStamp: expected.buildStamp || null,
      mismatch: mismatch?.kind || null,
      reloadAttempts,
    });

    if (!mismatch) {
      state.metrics.totalMs = Math.max(0, Date.now() - guardStartedAt);
      return {
        client: probe.client,
        info: probe.info,
        launchedChrome,
        reloadAttempts,
        timings: { ...state.metrics },
      };
    }

    const allowReload = options.allowReload ?? true;
    if (!allowReload || reloadAttempts >= config.maxReloadAttempts) {
      throw formatMismatchError(mismatch, { afterReload: reloadAttempts > 0 });
    }

    reloadAttempts += 1;
    log('reload-requested', {
      reloadAttempts,
      reason: mismatch.kind,
    });

    const reloadStartedAt = Date.now();
    const reloadResult = await deps.reloadChromeExtension(probe.client, {
      reason: `${mismatch.kind}_mismatch`,
      expectedExtensionVersion: expected.extensionVersion,
      expectedProtocolVersion: expected.protocolVersion,
      expectedBuildStamp: expected.buildStamp || null,
    });
    state.metrics.reloadMs += Math.max(0, Date.now() - reloadStartedAt);

    if (!reloadResult?.ok) {
      throw makeUserError(
        `Não consegui pedir reload automático da extensão do Chrome. Antes de repetir a exportação, cheque gemini_ready { action: "status" } e gemini_tabs { action: "reload" }; reload manual do card em chrome://extensions fica como fallback. Detalhe: ${reloadResult?.error || reloadResult?.reason || 'sem resposta'}`,
        'chrome_extension_reload_failed',
        {
          reloadResult,
          mismatch,
        },
      );
    }

    await sleep(config.pollIntervalMs);
    const reloadWaitStartedAt = Date.now();
    probe = await waitForMatchingExtensionInfo(
      deps,
      state,
      expected,
      config.reloadTimeoutMs,
      config.pollIntervalMs,
    );
    state.metrics.reloadWaitMs += Math.max(0, Date.now() - reloadWaitStartedAt);
    if (!probe) {
      throw makeUserError(
        'Pedi reload automático da extensão do Chrome, mas ela não voltou a conectar. Rode gemini_ready { action: "status" } para ver os clientes atuais e tente gemini_tabs { action: "reload" } se houver abas conectadas. Reload manual do card da extensão em chrome://extensions só deve ser necessário se houve mudança de permissões/manifest ou se o navegador está apontando para uma pasta antiga.',
        'chrome_extension_reload_timeout',
        {
          reloadAttempts,
          launchedChrome,
          lastProbeError: state.lastProbeError,
        },
      );
    }
  }
};
