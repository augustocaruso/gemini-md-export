export const DEFAULT_CHROME_GUARD_CONFIG = Object.freeze({
  profileDirectory: 'Default',
  launchIfClosed: true,
  reloadTimeoutMs: 15_000,
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

const selectClient = (clients, preferredClientId, previousClient = null) => {
  const liveClients = Array.isArray(clients) ? clients : [];
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
  return null;
};

const formatMismatchError = (mismatch, { afterReload = false } = {}) => {
  if (mismatch.kind === 'protocol') {
    return makeUserError(
      `O protocolo da extensão do Chrome está incompatível. Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. Recarregue manualmente o card da extensão em chrome://extensions; se continuar, reinstale apontando para a pasta browser-extension atualizada pelo Gemini CLI.`,
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

  return makeUserError(
    'A extensão do Chrome não está acessível. Abra Chrome/Edge com o perfil correto, confirme que a extensão unpacked está ativa e abra https://gemini.google.com/app.',
    'chrome_extension_unreachable',
    mismatch,
  );
};

const probeExtensionInfo = async (deps, state) => {
  const client = selectClient(
    deps.getLiveClients(),
    state.preferredClientId,
    state.previousClient,
  );
  if (!client) return null;

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
          source: 'heartbeat-fallback',
        },
      };
    }
    return null;
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

export const ensureChromeExtensionReady = async (deps, options = {}) => {
  const config = normalizeConfig({ ...deps.config, ...options.config });
  const expected = deps.expected;
  const state = {
    preferredClientId: options.clientId || options.preferredClientId || null,
    previousClient: null,
    lastProbeError: null,
  };
  const sleep = deps.sleep || sleepDefault;
  deps.sleep = sleep;
  const log = (event, data = {}) => {
    deps.log?.('[chrome-extension-guard]', event, JSON.stringify(data));
  };

  log('checking', {
    expectedExtensionVersion: expected.extensionVersion,
    expectedProtocolVersion: expected.protocolVersion,
    preferredClientId: state.preferredClientId,
  });

  let launchedChrome = false;
  let reloadAttempts = 0;
  let probe = await probeExtensionInfo(deps, state);

  if (!probe && (options.allowLaunchChrome ?? config.launchIfClosed)) {
    const launchResult = await deps.launchChromeForGemini?.({
      profileDirectory: config.profileDirectory,
    });
    launchedChrome = !!launchResult?.attempted;
    log('launch-attempted', {
      attempted: launchedChrome,
      supported: launchResult?.supported ?? null,
      method: launchResult?.method ?? null,
    });
    probe = await waitForExtensionInfo(deps, state, config.reloadTimeoutMs, config.pollIntervalMs);
  }

  if (!probe) {
    throw makeUserError(
      'A extensão do Chrome não está acessível. Tentei localizar uma aba do Gemini conectada, mas a extensão não respondeu. Abra Chrome/Edge com o perfil correto, confirme que a extensão unpacked está ativa e abra https://gemini.google.com/app.',
      'chrome_extension_unreachable',
      {
        launchedChrome,
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
      mismatch: mismatch?.kind || null,
      reloadAttempts,
    });

    if (!mismatch) {
      return {
        client: probe.client,
        info: probe.info,
        launchedChrome,
        reloadAttempts,
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

    const reloadResult = await deps.reloadChromeExtension(probe.client, {
      reason: `${mismatch.kind}_mismatch`,
      expectedExtensionVersion: expected.extensionVersion,
      expectedProtocolVersion: expected.protocolVersion,
    });

    if (!reloadResult?.ok) {
      throw makeUserError(
        `Não consegui pedir reload da extensão do Chrome. Recarregue manualmente o card em chrome://extensions. Detalhe: ${reloadResult?.error || reloadResult?.reason || 'sem resposta'}`,
        'chrome_extension_reload_failed',
        {
          reloadResult,
          mismatch,
        },
      );
    }

    await sleep(config.pollIntervalMs);
    probe = await waitForExtensionInfo(deps, state, config.reloadTimeoutMs, config.pollIntervalMs);
    if (!probe) {
      throw makeUserError(
        'Pedi reload da extensão do Chrome, mas ela não voltou a conectar. Recarregue manualmente o card da extensão em chrome://extensions e depois recarregue a aba do Gemini. Se houve mudança de permissões no manifest, o reload manual pode ser obrigatório.',
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
