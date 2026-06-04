import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
const allowedKeys = new Set(['vaultDir']);
const configRoot = ({ homeDir = homedir(), env = process.env } = {}) => env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : resolve(homeDir, '.config');
export const defaultConfigPath = (options = {}) => options.configPath || resolve(configRoot(options), 'gemini-md-export', 'config.json');
const normalizeConfig = (input) => {
    const record = input && typeof input === 'object' ? input : {};
    for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key))
            throw new Error(`Chave de configuracao desconhecida: ${key}`);
    }
    return {
        vaultDir: typeof record.vaultDir === 'string' && record.vaultDir ? record.vaultDir : undefined,
    };
};
export const loadGeminiMdExportConfig = (options = {}) => {
    const path = defaultConfigPath(options);
    if (!existsSync(path))
        return {};
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf-8')));
};
export const saveGeminiMdExportConfig = ({ config, options = {}, }) => {
    const normalized = normalizeConfig(config);
    const configPath = defaultConfigPath(options);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
    return { config: normalized, configPath };
};
export const setGeminiMdExportConfigValue = ({ key, value, options = {}, }) => {
    if (!allowedKeys.has(key))
        throw new Error(`Chave de configuracao desconhecida: ${key}`);
    const config = loadGeminiMdExportConfig(options);
    return saveGeminiMdExportConfig({ config: { ...config, [key]: value }, options });
};
const envVaultDir = (env = process.env) => {
    const candidates = [
        ['GEMINI_MD_EXPORT_VAULT_DIR', env.GEMINI_MD_EXPORT_VAULT_DIR],
        ['GME_VAULT_DIR', env.GME_VAULT_DIR],
    ];
    const candidate = candidates.find(([, value]) => typeof value === 'string' && value.length > 0);
    if (!candidate)
        return null;
    return { source: candidate[0], value: candidate[1] };
};
const medNotesRawDirFromEnv = (env = process.env) => typeof env.MED_RAW_DIR === 'string' && env.MED_RAW_DIR.length > 0
    ? { source: 'mednotes:env:MED_RAW_DIR', value: env.MED_RAW_DIR }
    : null;
const medNotesConfigPath = ({ homeDir = homedir(), env = process.env, } = {}) => {
    if (typeof env.MEDNOTES_CONFIG === 'string' && env.MEDNOTES_CONFIG.length > 0) {
        return resolve(env.MEDNOTES_CONFIG);
    }
    if (typeof env.MEDICAL_NOTES_CONFIG === 'string' && env.MEDICAL_NOTES_CONFIG.length > 0) {
        return resolve(env.MEDICAL_NOTES_CONFIG);
    }
    const medNotesHome = typeof env.MEDNOTES_HOME === 'string' && env.MEDNOTES_HOME.length > 0
        ? env.MEDNOTES_HOME
        : typeof env.MEDICAL_NOTES_WORKBENCH_HOME === 'string' &&
            env.MEDICAL_NOTES_WORKBENCH_HOME.length > 0
            ? env.MEDICAL_NOTES_WORKBENCH_HOME
            : null;
    return medNotesHome
        ? resolve(medNotesHome, 'config.toml')
        : resolve(homeDir, '.gemini', 'medical-notes-workbench', 'config.toml');
};
const tomlStringValue = (raw) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"')) {
        const match = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
        if (!match)
            return null;
        return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const unquoted = trimmed.split('#')[0]?.trim();
    return unquoted || null;
};
const medNotesRawDirFromConfig = (options = {}) => {
    const configPath = medNotesConfigPath(options);
    if (!existsSync(configPath))
        return null;
    const values = new Map();
    let section = '';
    for (const line of readFileSync(configPath, 'utf-8').split(/\r?\n/)) {
        const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);
        if (sectionMatch) {
            section = sectionMatch[1].trim();
            continue;
        }
        const keyMatch = line.match(/^\s*raw_dir\s*=\s*(.+?)\s*$/);
        if (!keyMatch)
            continue;
        const value = tomlStringValue(keyMatch[1]);
        if (value)
            values.set(`${section}.raw_dir`, value);
    }
    const canonical = values.get('paths.raw_dir');
    if (canonical) {
        return { source: 'mednotes:config:[paths].raw_dir', value: canonical };
    }
    const legacy = values.get('chat_processor.raw_dir');
    if (legacy) {
        return { source: 'mednotes:legacy_config:[chat_processor].raw_dir', value: legacy };
    }
    return null;
};
const existingDirectory = (path) => {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
};
const persistVaultDirCommand = 'gemini-md-export config set vaultDir <absolute-path-from-agent-memory>';
const missingVaultDirResolution = (configPath) => ({
    ok: false,
    vaultDir: null,
    source: 'missing',
    configPath,
    requiredInputs: ['vaultDir'],
    blockedReason: 'missing_vault_dir',
    nextAction: {
        code: 'persist_vault_dir_required',
        message: 'Persista o caminho absoluto do vault de chats antes de rodar fix-vault ou export missing.',
        command: persistVaultDirCommand,
    },
});
export const resolveGeminiMdExportVaultDir = ({ explicitVaultDir, options = {}, } = {}) => {
    const configPath = defaultConfigPath(options);
    const envCandidate = envVaultDir(options.env);
    const configured = loadGeminiMdExportConfig(options).vaultDir;
    const medNotesEnvCandidate = medNotesRawDirFromEnv(options.env);
    const medNotesConfigCandidate = medNotesRawDirFromConfig(options);
    const candidate = explicitVaultDir
        ? { source: 'explicit', value: explicitVaultDir }
        : envCandidate
            ? { source: `env:${envCandidate.source}`, value: envCandidate.value }
            : configured
                ? { source: 'config:vaultDir', value: configured }
                : medNotesEnvCandidate || medNotesConfigCandidate;
    if (!candidate)
        return missingVaultDirResolution(configPath);
    const vaultDir = resolve(candidate.value);
    if (!existingDirectory(vaultDir)) {
        return {
            ok: false,
            vaultDir,
            source: candidate.source,
            configPath,
            requiredInputs: ['vaultDir'],
            blockedReason: 'vault_dir_not_found',
            nextAction: {
                code: 'persist_valid_vault_dir_required',
                message: `O vault configurado nao existe ou nao e pasta: ${vaultDir}`,
                command: persistVaultDirCommand,
            },
        };
    }
    return {
        ok: true,
        vaultDir,
        source: candidate.source,
        configPath,
        requiredInputs: [],
        blockedReason: '',
        nextAction: {
            code: 'ready',
            message: 'Vault de chats resolvido.',
            command: '',
        },
    };
};
