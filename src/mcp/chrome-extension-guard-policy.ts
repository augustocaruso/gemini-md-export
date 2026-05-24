export type ChromeExtensionExpectedInfo = Readonly<{
  extensionVersion: string;
  protocolVersion: number;
  buildStamp?: string | null;
}>;

export type ChromeExtensionInfo = Readonly<{
  extensionVersion?: string | null;
  protocolVersion?: number | string | null;
  buildStamp?: string | null;
  source?: string | null;
}>;

export type ChromeExtensionClient = Readonly<{
  extensionVersion?: string | null;
  protocolVersion?: number | string | null;
  buildStamp?: string | null;
  lastHeartbeatAt?: number | string | null;
  page?: Readonly<{
    buildStamp?: string | null;
  }> | null;
  bridgeHealth?: Readonly<{
    status?: string | null;
    blockingIssue?: string | null;
    heartbeatAgeMs?: number | null;
    lastHeartbeatAt?: number | string | null;
  }> | null;
}>;

export type ChromeExtensionMismatch =
  | Readonly<{ kind: 'unreachable' }>
  | Readonly<{ kind: 'protocol'; actual: number | string | null; expected: number }>
  | Readonly<{ kind: 'version'; actual: string | null; expected: string }>
  | Readonly<{ kind: 'build'; actual: string | null; expected: string }>;

export type ChromeExtensionPolicyError = Readonly<{
  code: string;
  message: string;
  data: Record<string, unknown>;
}>;

export const DEFAULT_SELF_RELOAD_HEARTBEAT_FRESH_MS = 45_000;

const clientBuildStamp = (client?: ChromeExtensionClient | null): string | null =>
  client?.buildStamp || client?.page?.buildStamp || null;

const isVersionMatch = (actual: unknown, expected: unknown): boolean =>
  String(actual || '') === String(expected || '');

const isProtocolMatch = (actual: unknown, expected: unknown): boolean =>
  Number(actual) === Number(expected);

const isBuildStampMatch = (actual: unknown, expected: unknown): boolean =>
  !expected || String(actual || '') === String(expected || '');

export const clientMatchesExpected = (
  client: ChromeExtensionClient | null | undefined,
  expected: ChromeExtensionExpectedInfo | null | undefined,
): boolean =>
  !!client &&
  (!expected ||
    (isProtocolMatch(client.protocolVersion, expected.protocolVersion) &&
      isVersionMatch(client.extensionVersion, expected.extensionVersion) &&
      isBuildStampMatch(clientBuildStamp(client), expected.buildStamp)));

export const mismatchFor = (
  info: ChromeExtensionInfo | null | undefined,
  expected: ChromeExtensionExpectedInfo,
): ChromeExtensionMismatch | null => {
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
      expected: String(expected.buildStamp),
    };
  }
  return null;
};

export const formatMismatchPolicyError = (
  mismatch: ChromeExtensionMismatch,
  options: Readonly<{ afterReload?: boolean }> = {},
): ChromeExtensionPolicyError => {
  if (mismatch.kind === 'protocol') {
    return {
      code: 'chrome_extension_protocol_mismatch',
      message: `O protocolo da extensão do Chrome está incompatível. Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. O MCP tenta reload automático quando permitido; se continuar assim, confirme se a extensão unpacked aponta para a pasta browser-extension atualizada pelo Gemini CLI.`,
      data: { ...mismatch },
    };
  }

  if (mismatch.kind === 'version') {
    const prefix = options.afterReload
      ? 'A extensão do Chrome ainda está antiga depois do reload.'
      : 'A extensão do Chrome está antiga.';
    return {
      code: 'chrome_extension_version_mismatch',
      message: `${prefix} Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. Verifique se o Chrome está carregando a extensão a partir da mesma pasta browser-extension atualizada pelo Gemini CLI.`,
      data: { ...mismatch },
    };
  }

  if (mismatch.kind === 'build') {
    const prefix = options.afterReload
      ? 'A extensão do Chrome/Dia ainda está com build antigo depois do reload.'
      : 'A extensão do Chrome/Dia está com build antigo.';
    return {
      code: 'chrome_extension_build_mismatch',
      message: `${prefix} Esperado ${mismatch.expected}, recebido ${mismatch.actual ?? 'desconhecido'}. O MCP tentou/permite reload automático; se continuar, confirme se a extensão unpacked aponta para a pasta browser-extension atualizada.`,
      data: { ...mismatch },
    };
  }

  return {
    code: 'chrome_extension_unreachable',
    message:
      'A extensão do Chrome não está acessível. Abra Chrome/Edge com o perfil correto, confirme que a extensão unpacked está ativa e abra https://gemini.google.com/app.',
    data: { ...mismatch },
  };
};

const timestampMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const hasRecentHeartbeat = (
  client: ChromeExtensionClient | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean => {
  const bridgeAge = client?.bridgeHealth?.heartbeatAgeMs;
  if (typeof bridgeAge === 'number' && Number.isFinite(bridgeAge)) return bridgeAge <= maxAgeMs;
  const bridgeHeartbeatAt = timestampMs(client?.bridgeHealth?.lastHeartbeatAt);
  if (bridgeHeartbeatAt !== null) return now - bridgeHeartbeatAt <= maxAgeMs;
  const lastHeartbeatAt = timestampMs(client?.lastHeartbeatAt);
  return lastHeartbeatAt !== null && now - lastHeartbeatAt <= maxAgeMs;
};

const healthAlreadyStale = (client: ChromeExtensionClient | null | undefined): boolean =>
  client?.bridgeHealth?.status === 'stale' ||
  client?.bridgeHealth?.blockingIssue === 'stale_client' ||
  client?.bridgeHealth?.heartbeatAgeMs === null;

export const getSelfReloadBlocker = (
  probe: Readonly<{
    client?: ChromeExtensionClient | null;
    info?: ChromeExtensionInfo | null;
    mismatch?: ChromeExtensionMismatch | null;
    now?: number;
    heartbeatFreshMs?: number;
  }>,
): ChromeExtensionPolicyError | null => {
  if (!probe.mismatch) return null;
  if (probe.info?.source !== 'heartbeat-fallback') return null;

  const now = Number(probe.now ?? Date.now());
  const heartbeatFreshMs = Number(probe.heartbeatFreshMs ?? DEFAULT_SELF_RELOAD_HEARTBEAT_FRESH_MS);
  if (
    probe.client &&
    hasRecentHeartbeat(probe.client, now, heartbeatFreshMs) &&
    !healthAlreadyStale(probe.client)
  ) {
    return null;
  }

  const mismatchLabel =
    probe.mismatch.kind === 'build'
      ? 'build antigo'
      : probe.mismatch.kind === 'version'
        ? 'versão antiga'
        : probe.mismatch.kind === 'protocol'
          ? 'protocolo incompatível'
          : 'runtime inacessível';

  return {
    code:
      probe.mismatch.kind === 'build'
        ? 'chrome_extension_stale_build_no_heartbeat'
        : 'chrome_extension_runtime_stale',
    message: `A extensão do Chrome/Dia está com ${mismatchLabel}, mas o cliente conectado está sem heartbeat. Não dá para pedir self-reload de forma confiável por essa aba; recarregue a extensão do navegador uma vez e depois rode o comando de novo para retomar pela aba existente.`,
    data: {
      mismatch: probe.mismatch,
      infoSource: probe.info?.source || null,
      clientHeartbeatAt: probe.client?.lastHeartbeatAt ?? null,
      bridgeHealth: probe.client?.bridgeHealth ?? null,
    },
  };
};
