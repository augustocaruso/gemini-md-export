import {
  evaluateLocalExtensionSync,
  type LocalExtensionSyncResult,
  resolveSourceExtensionDir,
  syncLoadedUnpackedExtension,
} from './local-extension-sync.js';

type LoadedExtension = Readonly<{
  id?: string | null;
  locationKind?: string | null;
  path?: string | null;
}>;

type LocalDoctorReport = Readonly<{
  browser?: string | null;
  profileDirectory?: string | null;
  loadedExtension?: {
    extension?: LoadedExtension | null;
  } | null;
}>;

type ActiveJobProbe = Readonly<{
  ok: boolean;
  activeJobCount?: number;
  error?: string | null;
}>;

export type LocalExtensionReloadPreflightInput = Readonly<{
  allowReload?: boolean;
  packageRoot: string;
}>;

export type LocalExtensionReloadPreflightPorts = Readonly<{
  fetchActiveJobCount: () => Promise<ActiveJobProbe>;
  buildLocalDoctorReport: () => LocalDoctorReport;
}>;

type SyncResultWithContext = LocalExtensionSyncResult &
  Readonly<{
    browser?: string | null;
    profileDirectory?: string | null;
    extensionId?: string | null;
  }>;

export type LocalExtensionReloadPreflightResult =
  | SyncResultWithContext
  | Readonly<{
      ok: false;
      status: 'active-job-probe-failed';
      shouldReloadExistingTabs: true;
      error: string | null;
      activeJobCount: 0;
      sourceDir: string | null;
      targetDir: string | null;
    }>;

const issueCode = (issue: unknown): string => {
  if (!issue) return '';
  if (typeof issue === 'string') return issue;
  if (typeof issue !== 'object') return String(issue);
  const record = issue as Record<string, unknown>;
  return String(record.code || record.reason || record.type || record.message || '').trim();
};

export const readyHasExtensionMismatchClients = (ready: unknown): boolean => {
  const record = ready && typeof ready === 'object' ? (ready as Record<string, unknown>) : {};
  const extensionReadiness =
    record.extensionReadiness && typeof record.extensionReadiness === 'object'
      ? (record.extensionReadiness as Record<string, unknown>)
      : {};
  const clients = [
    ...(Array.isArray(record.connectedClients) ? record.connectedClients : []),
    ...(Array.isArray(record.clients) ? record.clients : []),
    ...(Array.isArray(record.diagnosticClients) ? record.diagnosticClients : []),
    ...(Array.isArray(extensionReadiness.connectedClients)
      ? extensionReadiness.connectedClients
      : []),
  ];
  return clients.some((client) => {
    const item = client && typeof client === 'object' ? (client as Record<string, any>) : {};
    const lifecycleCode = issueCode(item.lifecycle?.code);
    const healthIssue = issueCode(item.bridgeHealth?.blockingIssue);
    return (
      lifecycleCode === 'extension_build_mismatch' ||
      lifecycleCode === 'extension_version_mismatch' ||
      healthIssue === 'extension_build_mismatch' ||
      healthIssue === 'extension_version_mismatch'
    );
  });
};

export const runLocalExtensionReloadPreflight = async (
  input: LocalExtensionReloadPreflightInput,
  ports: LocalExtensionReloadPreflightPorts,
): Promise<LocalExtensionReloadPreflightResult> => {
  const local = ports.buildLocalDoctorReport();
  const loadedExtension = local.loadedExtension?.extension || null;
  const sourceDir = resolveSourceExtensionDir(input.packageRoot);
  const preliminary = evaluateLocalExtensionSync({
    allowReload: input.allowReload === true,
    activeJobCount: 0,
    sourceDir,
    loadedExtension,
  });
  if (preliminary.shouldSync !== true) {
    const result = syncLoadedUnpackedExtension({
      allowReload: input.allowReload === true,
      activeJobCount: 0,
      sourceDir,
      loadedExtension,
    });
    return {
      ...result,
      browser: local.browser || null,
      profileDirectory: local.profileDirectory || null,
      extensionId: loadedExtension?.id || null,
    };
  }

  const activeJobs = await ports.fetchActiveJobCount();
  if (activeJobs.ok !== true) {
    return {
      ok: false,
      status: 'active-job-probe-failed',
      shouldReloadExistingTabs: true,
      error: activeJobs.error || null,
      activeJobCount: 0,
      sourceDir,
      targetDir: loadedExtension?.path || null,
    };
  }
  const result = syncLoadedUnpackedExtension({
    allowReload: input.allowReload === true,
    activeJobCount: activeJobs.activeJobCount || 0,
    sourceDir,
    loadedExtension,
  });

  return {
    ...result,
    browser: local.browser || null,
    profileDirectory: local.profileDirectory || null,
    extensionId: loadedExtension?.id || null,
  };
};

export const localExtensionReloadPreflightCliLine = (
  result: LocalExtensionReloadPreflightResult,
): string | null => {
  if (result.status === 'active-job-probe-failed') {
    return `Nao consegui confirmar se ha job ativo; nao vou sincronizar arquivos locais antes do reload. (${result.error || 'erro desconhecido'})`;
  }
  if (result.status === 'synced') {
    return `Extensao unpacked sincronizada antes do reload: ${result.targetDir} (${result.previousBuildStamp || '?'} -> ${result.targetBuildStamp || '?'})`;
  }
  if (result.status === 'blocked-active-job') {
    return 'Job ativo detectado; nao vou sincronizar nem recarregar a extensao agora.';
  }
  return null;
};
