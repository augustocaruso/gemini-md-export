import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type AnyRecord = Record<string, any>;

type RuntimeFreshnessOptions = {
  packageRoot: string;
  version: string;
  expectedProtocolVersion: number;
};

const bridgeProcessInfo = (health: AnyRecord = {}): AnyRecord => {
  const processInfo = health.process && typeof health.process === 'object' ? health.process : {};
  return {
    pid: health.pid ?? processInfo.pid ?? null,
    root: processInfo.root || null,
    startedAt: processInfo.startedAt || health.startedAt || null,
  };
};

const runtimeFreshnessFilesForRoot = (root: string): string[] => [
  resolve(root, 'bridge-version.json'),
  resolve(root, 'package.json'),
  resolve(root, 'bin', 'gemini-md-export.mjs'),
  resolve(root, 'src', 'mcp-server.js'),
  resolve(root, 'build', 'ts', 'mcp', 'export-job-recording.js'),
  resolve(root, 'build', 'ts', 'mcp', 'export-job-reports.js'),
  resolve(root, 'build', 'ts', 'mcp', 'export-job-date-summary.js'),
];

const newestRuntimeFileForRoot = (root: string | null): AnyRecord | null => {
  if (!root) return null;
  let newest: AnyRecord | null = null;
  for (const file of runtimeFreshnessFilesForRoot(root)) {
    try {
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = {
          path: file,
          mtimeMs: stat.mtimeMs,
          mtime: stat.mtime.toISOString(),
        };
      }
    } catch {
      // Freshness is a guardrail; version/protocol checks still handle hard mismatches.
    }
  }
  return newest;
};

export const bridgeRuntimeFilesMismatch = (
  health: AnyRecord = {},
  options: RuntimeFreshnessOptions,
): AnyRecord | null => {
  const processInfo = bridgeProcessInfo(health);
  const processStartedMs = Date.parse(processInfo.startedAt || health.startedAt || '');
  if (!Number.isFinite(processStartedMs)) return null;
  const root = processInfo.root || options.packageRoot;
  const newest = newestRuntimeFileForRoot(root);
  if (!newest) return null;
  if (newest.mtimeMs <= processStartedMs + 1500) return null;
  return {
    kind: 'runtime-files',
    actualVersion: health.version || null,
    expectedVersion: options.version,
    actualProtocolVersion: health.protocolVersion ?? null,
    expectedProtocolVersion: options.expectedProtocolVersion,
    processStartedAt: new Date(processStartedMs).toISOString(),
    newestRuntimeFile: newest.path,
    newestRuntimeFileMtime: newest.mtime,
    process: processInfo,
  };
};

export const staleBridgeMessage = (
  mismatch: AnyRecord,
  { safe = false, version }: { safe?: boolean; version: string },
): string => {
  const processInfo = mismatch?.process || {};
  const pid = processInfo.pid ? ` PID ${processInfo.pid}` : '';
  const path = processInfo.root || processInfo.path || processInfo.commandLine || null;
  const location = path ? `\nProcesso: ${path}` : '';
  const restartSuffix = safe
    ? ''
    : '\nNão encontrei um alvo seguro para reiniciar automaticamente.';
  if (mismatch?.kind === 'name') {
    return `A porta da bridge respondeu como ${mismatch.actualName || 'outro serviço'}, não como gemini-md-export.${location}`;
  }
  if (mismatch?.kind === 'protocol') {
    return (
      `Bridge local desatualizada${pid}: protocolo ${mismatch.actualProtocolVersion ?? '?'}; ` +
      `esta CLI espera protocolo ${mismatch.expectedProtocolVersion ?? '?'}.${location}${restartSuffix}`
    );
  }
  if (mismatch?.kind === 'browser-build') {
    return (
      `Bridge local desatualizada${pid}: build da extensão ${mismatch.actualBuildStamp ?? '?'}; ` +
      `esta CLI espera ${mismatch.expectedBuildStamp ?? '?'}.${location}${restartSuffix}`
    );
  }
  if (mismatch?.kind === 'runtime-files') {
    return (
      `Bridge local desatualizada${pid}: arquivos instalados mudaram depois que o processo iniciou.` +
      `${location}\nProcesso iniciou: ${mismatch.processStartedAt || '?'}\n` +
      `Arquivo mais novo: ${mismatch.newestRuntimeFile || '?'} (${mismatch.newestRuntimeFileMtime || '?'})${restartSuffix}`
    );
  }
  return (
    `Bridge local desatualizada${pid}: ${mismatch?.actualVersion || '?'} -> ${mismatch?.expectedVersion || version}.` +
    `${location}${restartSuffix}`
  );
};

export const bridgeMismatchStatusDetail = (mismatch: AnyRecord, version: string): string => {
  if (mismatch?.kind === 'browser-build') {
    return `Bridge antiga detectada: build ${mismatch.actualBuildStamp || '?'} -> ${mismatch.expectedBuildStamp || '?'}`;
  }
  if (mismatch?.kind === 'runtime-files') {
    return 'Bridge antiga detectada: arquivos instalados mudaram depois do start.';
  }
  return `Bridge antiga detectada: ${mismatch?.actualVersion || '?'} -> ${mismatch?.expectedVersion || version}`;
};

export const bridgeMismatchIntervalMessage = (
  mismatch: AnyRecord,
  elapsedText: string,
  version: string,
): string =>
  `${bridgeMismatchStatusDetail(mismatch, version).replace(/\.$/, '')}; ${elapsedText} decorridos.`;
