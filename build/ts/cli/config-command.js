import { loadGeminiMdExportConfig, resolveGeminiMdExportVaultDir, setGeminiMdExportConfigValue, } from './config-store.js';
export const buildConfigHelp = ({ commonOptions = [], outputModes = [], } = {}) => [
    'gemini-md-export config',
    '',
    'Uso:',
    '  gemini-md-export config get [opcoes]',
    '  gemini-md-export config set vaultDir <path> [opcoes]',
    '',
    'Consulta ou salva defaults do produto, como o vault de chats usado por fix-vault.',
    '',
    ...outputModes,
    '',
    ...commonOptions,
].join('\n');
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
export const runConfigCommand = ({ parsed, streams = {}, }) => {
    const action = parsed.positionals[0] || 'get';
    if (action === 'get' || action === 'show') {
        const config = loadGeminiMdExportConfig();
        const vaultDirResolution = resolveGeminiMdExportVaultDir();
        const result = { ok: true, action: 'config_get', config, vaultDirResolution };
        writeResult(streams, parsed.flags, result, vaultDirResolution.ok
            ? `Config: vaultDir=${vaultDirResolution.vaultDir} (${vaultDirResolution.source})`
            : `Config: vaultDir=(nao configurado). Rode: ${vaultDirResolution.nextAction.command}`);
        return { exitCode: 0, result };
    }
    if (action === 'set') {
        const key = parsed.positionals[1];
        const value = parsed.positionals[2];
        if (!key || !value)
            throw Object.assign(new Error('Uso: gemini-md-export config set vaultDir <path>.'), {
                code: 'usage',
            });
        const saved = setGeminiMdExportConfigValue({ key: key, value });
        const result = { ok: true, action: 'config_set', ...saved };
        writeResult(streams, parsed.flags, result, `Config salva: ${key}=${value}`);
        return { exitCode: 0, result };
    }
    throw Object.assign(new Error('Uso: gemini-md-export config get | config set vaultDir <path>.'), {
        code: 'usage',
    });
};
