import { loadMarkdownDbFixVaultRecords } from '../mcp/markdown-db-vault-adapter.js';
import { buildAuthStatusToolCall, extractAuthStatusResult } from './auth-status-command.js';
import { resolveGeminiMdExportVaultDir } from './config-store.js';
import { buildFixVaultPreflightReport, fixVaultPreflightPlainLabel, } from './fix-vault-preflight.js';
const checkMarkdownDbAvailable = async (vaultDir) => {
    try {
        if (!vaultDir)
            return { ok: false, code: 'vault_dir_missing', message: 'Vault nao configurado.' };
        await loadMarkdownDbFixVaultRecords({ vaultDir });
        return { ok: true, message: 'MarkdownDB disponivel.' };
    }
    catch (err) {
        return {
            ok: false,
            code: err?.code || 'markdown_db_unavailable',
            message: err?.message || 'MarkdownDB indisponivel.',
        };
    }
};
const writeResult = (streams, flags, result, label) => {
    const stdout = streams.stdout || process.stdout;
    if (flags.format === 'json')
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        stdout.write(`${label}\n`);
        if (flags.resultJson === true)
            stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
    }
};
export const runFixVaultDoctorCommand = async ({ parsed, streams = {}, dependencies, }) => {
    const positionalVault = parsed.positionals[0] === 'doctor' ? parsed.positionals[1] : parsed.positionals[0];
    const vaultDirResolution = resolveGeminiMdExportVaultDir({
        explicitVaultDir: parsed.flags.vaultDir || positionalVault,
    });
    const flags = {
        ...parsed.flags,
        vaultDir: vaultDirResolution.vaultDir || parsed.flags.vaultDir || positionalVault,
    };
    const checkMarkdownDb = dependencies.checkMarkdownDb || checkMarkdownDbAvailable;
    const report = await buildFixVaultPreflightReport({
        flags,
        deps: {
            checkMarkdownDb: () => checkMarkdownDb(flags.vaultDir),
            checkAuthStatus: async (effectiveFlags) => extractAuthStatusResult(await dependencies.requestJson(effectiveFlags.bridgeUrl || flags.bridgeUrl, '/agent/mcp-tool-call', {
                method: 'POST',
                timeoutMs: Math.max(5000, Number(effectiveFlags.waitMs || 45_000)) + 15_000,
                body: buildAuthStatusToolCall(effectiveFlags),
            })),
        },
    });
    writeResult(streams, flags, report, fixVaultPreflightPlainLabel(report));
    return { exitCode: report.ok ? 0 : 4, result: report };
};
