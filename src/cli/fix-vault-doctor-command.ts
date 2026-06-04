import { loadMarkdownDbFixVaultRecords } from '../mcp/markdown-db-vault-adapter.js';
import { buildAuthStatusToolCall, extractAuthStatusResult } from './auth-status-command.js';
import { resolveGeminiMdExportVaultDir } from './config-store.js';
import {
  buildFixVaultPreflightReport,
  fixVaultPreflightPlainLabel,
} from './fix-vault-preflight.js';

type Parsed = Readonly<{
  flags: Record<string, any>;
  positionals: string[];
}>;

type Streams = Readonly<{
  stdout?: Pick<NodeJS.WritableStream, 'write'>;
}>;

type Dependencies = Readonly<{
  requestJson: (
    bridgeUrl: string,
    pathname: '/agent/mcp-tool-call',
    options: any,
  ) => Promise<unknown>;
  checkMarkdownDb?: (
    vaultDir: string | undefined,
  ) => Promise<{ ok: boolean; message?: string; code?: string }>;
}>;

const checkMarkdownDbAvailable = async (vaultDir: string | undefined) => {
  try {
    if (!vaultDir)
      return { ok: false, code: 'vault_dir_missing', message: 'Vault nao configurado.' };
    await loadMarkdownDbFixVaultRecords({ vaultDir });
    return { ok: true, message: 'MarkdownDB disponivel.' };
  } catch (err: any) {
    return {
      ok: false,
      code: err?.code || 'markdown_db_unavailable',
      message: err?.message || 'MarkdownDB indisponivel.',
    };
  }
};

const writeResult = (streams: Streams, flags: Record<string, any>, result: any, label: string) => {
  const stdout = streams.stdout || process.stdout;
  if (flags.format === 'json') stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    stdout.write(`${label}\n`);
    if (flags.resultJson === true) stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
  }
};

export const runFixVaultDoctorCommand = async ({
  parsed,
  streams = {},
  dependencies,
}: {
  parsed: Parsed;
  streams?: Streams;
  dependencies: Dependencies;
}) => {
  const positionalVault =
    parsed.positionals[0] === 'doctor' ? parsed.positionals[1] : parsed.positionals[0];
  const vaultDirResolution = resolveGeminiMdExportVaultDir({
    explicitVaultDir: parsed.flags.vaultDir || positionalVault,
  });
  const flags: Record<string, any> = {
    ...parsed.flags,
    vaultDir: vaultDirResolution.vaultDir || parsed.flags.vaultDir || positionalVault,
  };
  const checkMarkdownDb = dependencies.checkMarkdownDb || checkMarkdownDbAvailable;
  const report = await buildFixVaultPreflightReport({
    flags,
    deps: {
      checkMarkdownDb: () => checkMarkdownDb(flags.vaultDir),
      checkAuthStatus: async (effectiveFlags) =>
        extractAuthStatusResult(
          await dependencies.requestJson(
            effectiveFlags.bridgeUrl || flags.bridgeUrl,
            '/agent/mcp-tool-call',
            {
              method: 'POST',
              timeoutMs: Math.max(5000, Number(effectiveFlags.waitMs || 45_000)) + 15_000,
              body: buildAuthStatusToolCall(effectiveFlags),
            },
          ),
        ),
    },
  });
  writeResult(streams, flags, report, fixVaultPreflightPlainLabel(report));
  return { exitCode: report.ok ? 0 : 4, result: report };
};
