export const configuredBrowserKey = (env: NodeJS.ProcessEnv = process.env): string =>
  env.GEMINI_MCP_BROWSER || env.GME_BROWSER || 'chrome';

export const diagnoseNativeHostInstall = ({
  diagnoseNativeHost,
  browser,
  packageRoot,
  platform = process.platform,
  home,
  env = process.env,
}: {
  diagnoseNativeHost: (args: Record<string, unknown>) => Record<string, any>;
  browser: string;
  packageRoot: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}) => {
  try {
    return diagnoseNativeHost({
      browser,
      packageRoot,
      platform,
      home,
      env,
    });
  } catch (err) {
    return {
      ok: false,
      status: 'diagnostic-failed',
      error: err instanceof Error ? err.message : String(err),
      nextAction: 'Repare a instalacao do Native Messaging host.',
    };
  }
};

export const enrichNativeBrokerStatusWithInstallDiagnostic = (
  status: Record<string, any>,
  options: {
    diagnoseNativeHost: (args: Record<string, unknown>) => Record<string, any>;
    browser: string;
    packageRoot: string;
    platform?: NodeJS.Platform;
    home?: string;
    env?: NodeJS.ProcessEnv;
  },
) => {
  if (!status?.configured || status.available === true) return status;
  const diagnostic = diagnoseNativeHostInstall(options);
  if (diagnostic?.ok === true) {
    return {
      ...status,
      installDiagnostic: diagnostic,
    };
  }
  const code =
    diagnostic?.status === 'mismatch' && diagnostic.hostExecutableExists === false
      ? 'native_host_manifest_target_missing'
      : status.code || 'native_broker_unavailable';
  const missingPath =
    diagnostic?.actualHostPath && diagnostic.hostExecutableExists === false
      ? ` O manifesto aponta para um arquivo inexistente: ${diagnostic.actualHostPath}.`
      : '';
  return {
    ...status,
    code,
    message:
      `${status.message}${missingPath} ${diagnostic.nextAction || 'Repare o Native Messaging host.'}`.trim(),
    installDiagnostic: diagnostic,
  };
};

export const browserReadyNextAction = ({
  ready,
  blockingIssue,
  connectedClientCount,
  nativeBrokerStatus,
  cdp,
}: {
  ready: boolean;
  blockingIssue?: unknown;
  connectedClientCount?: number;
  nativeBrokerStatus?: Record<string, any> | null;
  cdp?: Record<string, any> | null;
}) => {
  if (ready === true) {
    return {
      code: 'ready',
      message: 'Sessao do navegador pronta.',
    };
  }

  if (
    connectedClientCount === 0 &&
    cdp?.attempted !== true &&
    nativeBrokerStatus?.configured === true &&
    nativeBrokerStatus?.available !== true
  ) {
    if (nativeBrokerStatus.installDiagnostic?.ok === false) {
      return {
        code: nativeBrokerStatus.code || 'native_broker_install_problem',
        message:
          nativeBrokerStatus.message ||
          nativeBrokerStatus.installDiagnostic.nextAction ||
          'Repare o Native Messaging host.',
      };
    }
    return {
      code: 'extension_control_channel_unavailable',
      message:
        'Chrome esta aberto, mas nenhum canal de controle da extensao respondeu: content script ausente, native broker ainda nao abriu e CDP nao esta configurado. Recarregue a extensao no Chrome uma vez ou reinicie o Chrome; depois rode o comando de novo para o native broker assumir a recuperacao automatica.',
    };
  }

  if (nativeBrokerStatus?.available !== true && nativeBrokerStatus?.message) {
    return {
      code: nativeBrokerStatus.code || String(blockingIssue || 'browser_not_ready'),
      message: nativeBrokerStatus.message,
    };
  }

  return {
    code: String(blockingIssue || 'browser_not_ready'),
    message: 'Navegador ainda nao esta pronto para operar a extensao.',
  };
};
