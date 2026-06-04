import { runFixVaultSmokeCommand } from './fix-vault-smoke-command.js';
import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';
export const buildFixVaultCliHelp = ({ commonOptions = [], } = {}) => [
    'gemini-md-export fix-vault',
    '',
    'Uso:',
    '  gemini-md-export fix-vault doctor [vaultDir] [opcoes]',
    '  gemini-md-export fix-vault smoke [vaultDir] [opcoes]',
    '  gemini-md-export fix-vault <vaultDir> [--takeout <takeout.zip|Minhaatividade.html|MyActivity.json>] [--report <report.json>]',
    '',
    'Corrige o back catalog em um unico fluxo: audita integridade, normaliza o',
    'YAML canonico dos chats, reexporta chats/assets suspeitos pela API privada',
    'e preenche datas com Takeout primeiro e My Activity para o que sobrar.',
    '',
    'Opcoes:',
    '  --takeout <file>       Usa arquivo offline do Google Takeout/My Activity (.zip, .html ou .json).',
    '  --use-my-activity      Usa My Activity pela extensao para datas remanescentes. Default.',
    '  --no-my-activity       Nao tenta My Activity; usa apenas Takeout e normalizacao local.',
    '  --report <file.json>   Grava relatorio combinado do fix-vault.',
    '  --limit <n>            Limita quantidade de chats no backfill de metadados.',
    '  --no-open-if-missing   Nao abre/recarrega My Activity automaticamente.',
    '',
    ...commonOptions,
].join('\n');
export const normalizeFixVaultCliParsed = (parsed) => ({
    ...parsed,
    flags: applyPrivateApiSessionDefaults(parsed.flags),
});
export const runFixVaultCliCommand = ({ parsed, streams, runDoctor, runDefault, }) => {
    const normalized = normalizeFixVaultCliParsed(parsed);
    const subcommand = normalized.positionals[0];
    if (subcommand === 'doctor')
        return runDoctor(normalized, streams);
    if (subcommand === 'smoke') {
        return runFixVaultSmokeCommand({
            parsed: normalized,
            streams,
            dependencies: {
                runDoctor: (nextParsed, nextStreams) => runDoctor(normalizeFixVaultCliParsed(nextParsed), nextStreams),
                runFixVault: (nextParsed, nextStreams) => runDefault(normalizeFixVaultCliParsed(nextParsed), nextStreams),
            },
        });
    }
    return runDefault(normalized, streams);
};
