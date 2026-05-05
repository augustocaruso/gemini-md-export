#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  launchGeminiBrowser,
  readBrowserLaunchState,
  writeBrowserLaunchState,
} from '../src/browser-launch.mjs';
import { buildLocalDoctorReport, normalizeBrowserKey } from '../src/browser-diagnostics.mjs';
import {
  createLayeredTimeoutError,
  decorateErrorWithTimeoutContext,
} from '../src/timeout-diagnostics.mjs';
import {
  DEFAULT_PAYLOAD_LEVEL,
  disableTelemetry,
  enableTelemetry,
  previewEnvelope,
  recordCliTelemetry,
  sendTelemetry,
  telemetryStatus,
} from '../src/telemetry.mjs';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47283';
const DEFAULT_POLL_MS = 1200;
const DEFAULT_READY_WAIT_MS = 30_000;
const DEFAULT_READY_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EXISTING_TAB_RECONNECT_GRACE_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_COUNT_LOAD_MORE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_CLEANUP_MS = 45_000;
const DEFAULT_COUNT_STATUS_INTERVAL_MS = 15_000;
const DEFAULT_READY_STATUS_INTERVAL_MS = 15_000;
const DEFAULT_TUI_RENDER_INTERVAL_MS = 250;
const DEFAULT_COUNT_LOAD_MORE_BROWSER_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT_LOAD_MORE_BROWSER_ROUNDS = 12;
const DEFAULT_COUNT_MAX_NO_GROWTH_ROUNDS = 8;
const DEFAULT_BROWSER_LAUNCH_LOCK_GRACE_MS = 2_000;
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

const EXIT = {
  OK: 0,
  WARNINGS: 1,
  MANUAL_ACTION: 2,
  BRIDGE_UNAVAILABLE: 3,
  EXTENSION_UNREADY: 4,
  JOB_FAILED: 5,
  USAGE: 64,
};

const readPackageVersion = () => {
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(packagePath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const VERSION = readPackageVersion();

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearBelow: '\x1b[J',
};

const outputModeHelp = () => [
  'Formatos de saida:',
  '  --tui     UI humana com barra de progresso ANSI. Use em terminal/pty.',
  '  --plain   Linhas humanas estaveis, sem ANSI.',
  '  --json    JSON final puro, sem texto humano.',
  '  --jsonl   Eventos JSONL durante o progresso.',
  '  --result-json  Acrescenta RESULT_JSON nos modos humanos quando necessario.',
];

const exitCodeHelp = () => [
  'Exit codes:',
  '  0   sucesso completo',
  '  1   concluido com warnings',
  '  2   acao manual necessaria ou job cancelado',
  '  3   bridge indisponivel ou timeout local',
  '  4   extensao/aba Gemini nao pronta',
  '  5   job falhou',
  '  64  uso invalido',
];

const commonOptionHelp = () => [
  'Opcoes comuns:',
  '  --bridge-url <url>       Bridge local. Default: http://127.0.0.1:47283.',
  '  --no-start-bridge       Nao iniciar bridge local automaticamente.',
  '  --bridge-start-wait-ms <ms> Quanto esperar a bridge iniciar. Default: 6000.',
  '  --bridge-keep-alive-ms <ms> Quanto a bridge iniciada pela CLI fica viva sem uso.',
  '  --no-exit-when-idle     Bridge iniciada pela CLI nao encerra sozinha por idle.',
  '  --browser <name>         Navegador alvo: chrome, edge, brave ou dia.',
  '  --profile-directory <name> Perfil Chromium. Default: Default.',
  '  --extension-id <id>      ID conhecido da extensao carregada.',
  '  --ready-wait-ms <ms>     Quanto esperar a aba/extensao ficar pronta.',
  '  --client-id <id>         Escolhe uma aba Gemini pelo clientId.',
  '  --tab-id <id>            Escolhe uma aba Gemini pelo tabId do navegador.',
  '  --claim-id <id>          Usa uma claim criada por gemini-md-export tabs claim.',
  '  --session <nome>         Sessao nomeada reutilizavel para claim/export.',
  '  --keep-claim             Nao libera --claim-id automaticamente apos chats/sync/export.',
  '  --no-wake                Nao tentar acordar o navegador.',
  '  --no-self-heal           Nao tentar auto-recuperacao da extensao.',
  '  --no-reload              Nao pedir reload automatico da extensao.',
  '  --no-color               Desliga ANSI.',
  '  --help, -h               Mostra ajuda.',
  '  --version, -v            Mostra versao.',
];

const jobOptionHelp = () => [
  'Opcoes de job:',
  '  --output-dir <path>          Destino dos Markdown/assets.',
  '  --resume-report-file <path>  Retoma relatorio incremental anterior.',
  '  --max-chats <n>              Limita quantidade de conversas.',
  '  --limit <n>                  Alias de --max-chats.',
  '  --batch-size <n>             Tamanho de lote do export.',
  '  --start-index <n>            Primeira posicao para export notebook/recent.',
  '  --chat-id <id>               Chat ID para export selected; pode repetir.',
  '  --selection-file <path>      Manifesto criado por chats list --save-selection.',
  '  --expected-count <n>         Falha antes de iniciar se a selecao tiver outra quantidade.',
  '  --delay-ms <ms>              Pausa entre chats selecionados.',
  '  --max-load-more-rounds <n>   Rodadas maximas para puxar historico.',
  '  --load-more-attempts <n>     Tentativas de scroll por rodada.',
  '  --max-no-growth-rounds <n>   Rodadas sem crescimento antes de desistir.',
  '  --load-more-browser-rounds <n> Rodadas internas no navegador por comando.',
  '  --load-more-browser-timeout-ms <ms> Timeout do carregamento no navegador.',
  '  --load-more-timeout-ms <ms>  Timeout total do comando de carregamento.',
  '  --hydration-timeout-ms <ms>  Limite para hidratar uma conversa gigante.',
  '  --hydration-stall-ms <ms>    Desiste se a conversa nao crescer por esse tempo.',
  '  --hydration-wait-ms <ms>     Espera por cada leva nova de turns.',
  '  --export-browser-timeout-ms <ms> Timeout do comando de export no navegador.',
  '  --refresh                    Forca refresh/carregamento.',
  '  --no-refresh                 Usa cache quando possivel.',
  '  --poll-ms <ms>               Intervalo de polling. Default: 1200.',
  '  --timeout-ms <ms>            Timeout total do job.',
];

const usage = () =>
  [
    `gemini-md-export ${VERSION}`,
    '',
    'Uso:',
    '  gemini-md-export <comando> [opcoes]',
    '  gemini-md-export help [comando]',
    '  gemini-md-export --version',
    '',
    'Comandos:',
    '  sync [vaultDir]       Sincroniza o vault com conversas novas/faltantes.',
    '  doctor                Verifica bridge, extensao Chrome e aba Gemini.',
    '  diagnose page <url>   Diagnostica artefatos/iframes de uma conversa Gemini.',
    '  browser status        Mostra prontidao da bridge/extensao/abas.',
    '  tabs list|claim       Lista/reivindica abas Gemini pela CLI.',
    '  chats count           Conta chats carregaveis sem despejar lista no chat.',
    '  chats list            Lista uma pagina e pode salvar selecao de chatIds.',
    '  export recent         Exporta historico recente carregavel.',
    '  export missing        Exporta apenas chats ausentes no vault.',
    '  export resume         Retoma export por relatorio incremental.',
    '  export selected       Baixa uma selecao explicita de conversas.',
    '  export reexport       Legado: alias antigo de export selected.',
    '  export notebook       Exporta caderno Gemini carregado.',
    '  job list              Lista jobs ativos/recentes.',
    '  job status <jobId>    Consulta progresso de um job.',
    '  job cancel <jobId>    Cancela um job.',
    '  job trace <jobId>     Resume o trace tecnico sanitizado de um job.',
    '  export-dir get|set    Consulta ou altera diretorio de export.',
    '  cleanup stale-processes Diagnostica/limpa processos antigos seguros.',
    '  repair-vault <path>   Executa reparo local de vault.',
    '  telemetry enable|status|preview|send|disable  Telemetria, status e opt-out.',
    '  help [comando]        Mostra ajuda global ou de um comando.',
    '',
    'Exemplos:',
    '  gemini-md-export sync "/path/to/vault" --tui',
    '  gemini-md-export doctor --tui --result-json',
    '  gemini-md-export diagnose page "https://gemini.google.com/app/<chatId>" --tui --result-json',
    '  gemini-md-export tabs list --tui --result-json',
    '  gemini-md-export chats count --tui --result-json',
    '  gemini-md-export chats list --limit 10 --save-selection --tui --result-json',
    '  gemini-md-export export missing "/path/to/vault" --tui',
    '  gemini-md-export job list --active --tui --result-json',
    '  gemini-md-export job status job-123 --json',
    '  gemini-md-export job trace job-123 --tui --result-json',
    '  gemini-md-export export selected --selection-file ~/.gemini-md-export/selections/latest.json --expected-count 10 --tui',
    '  gemini-md-export telemetry status --tui --result-json',
    '',
    'Dentro do Gemini CLI:',
    '  - Use --tui por padrao no shell interativo/node-pty.',
    '  - Dentro do Gemini CLI, --tui usa a TUI ANSI completa; se precisar, GEMINI_MD_EXPORT_TUI_MODE=stream troca para modo compacto.',
    '  - Para export/sync, rode a CLI direto; evite despejar gemini_ready/gemini_tabs no chat.',
    '  - Use --tui --result-json quando precisar ler resultado final; --plain so em shell capturado.',
    '',
    ...outputModeHelp(),
    '',
    ...exitCodeHelp(),
    '',
    'Ajuda por comando:',
    '  gemini-md-export sync --help',
    '  gemini-md-export doctor --help',
    '  gemini-md-export job status --help',
  ].join('\n');

const syncHelp = () =>
  [
    'gemini-md-export sync',
    '',
    'Uso:',
    '  gemini-md-export sync [vaultDir] [opcoes]',
    '',
    'Sincroniza o vault local com o Gemini Web usando a bridge local.',
    'Nao lista centenas de conversas no terminal; acompanha um job e escreve um',
    'relatorio incremental para retomada.',
    '',
    'Opcoes:',
    '  --vault-dir <path>           Vault a sincronizar.',
    '  --output-dir <path>          Destino dos Markdown/assets. Default: vaultDir.',
    '  --resume-report-file <path>  Retoma um relatorio incremental anterior.',
    '  --sync-state-file <path>     Estado incremental customizado.',
    '  --known-boundary-count <n>   Quantidade de itens conhecidos para fronteira incremental.',
    '  --poll-ms <ms>               Intervalo de polling. Default: 1200.',
    '  --timeout-ms <ms>            Timeout total do job.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export sync "/path/to/vault" --tui',
    '  gemini-md-export sync --resume-report-file "/path/to/report.json" --tui',
    '',
    'Contrato para agentes:',
    '  Em Gemini CLI interativo, use --tui --result-json e leia a ultima linha RESULT_JSON {...}.',
    '  Use --plain somente em shell capturado; use --json apenas quando precisar de JSON final puro.',
  ].join('\n');

const doctorHelp = () =>
  [
    'gemini-md-export doctor',
    '',
    'Uso:',
    '  gemini-md-export doctor [opcoes]',
    '',
    'Verifica se bridge, extensao Chrome e uma aba Gemini estao prontas.',
    'Nao acorda o navegador nem faz fallback MCP; o objetivo e diagnostico curto.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export doctor --tui --result-json',
    '  gemini-md-export doctor --json',
  ].join('\n');

const diagnoseHelp = () =>
  [
    'gemini-md-export diagnose page',
    '',
    'Uso:',
    '  gemini-md-export diagnose page <url> [opcoes]',
    '  gemini-md-export diagnose page --url <url> [opcoes]',
    '',
    'Abre/usa a conversa indicada e diagnostica iframes de artefatos interativos',
    'visíveis no DOM do Gemini, sem salvar HTML nem contornar sandbox.',
    '',
    'Opcoes:',
    '  --url <url>              URL https://gemini.google.com/app/<chatId>.',
    '  --artifacts              Alias aceito; artefatos sao o foco deste diagnostico.',
    '  --full                   Inclui amostras curtas de HTML quando o frame for legivel.',
    '  --include-html-sample    Inclui amostra curta do HTML lido pelo probe.',
    '  --include-html           Inclui outerHTML curto dos iframes no DOM pai.',
    '  --no-frame-probe         Nao tenta probe via chrome.scripting nos iframes.',
    '  --no-open-artifacts      Nao clica em botoes candidatos para abrir artefatos.',
    '  --keep-artifact-open     Nao tenta fechar a superficie aberta apos diagnosticar.',
    '  --artifact-open-wait-ms <ms> Tempo para aguardar iframe apos clique.',
    '  --save-html              Salva payloads HTML capturados e gera artifact-<chatId>-manifest.json.',
    '  --output-dir <dir>       Pasta de destino para --save-html.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export diagnose page "https://gemini.google.com/app/46b61afe42a5956d" --tui --result-json',
    '  gemini-md-export diagnose page "https://gemini.google.com/app/46b61afe42a5956d" --save-html --output-dir ~/Downloads --tui --result-json',
    '  gemini-md-export diagnose page --url "https://gemini.google.com/app/46b61afe42a5956d" --json',
  ].join('\n');

const browserHelp = () =>
  [
    'gemini-md-export browser status',
    '',
    'Uso:',
    '  gemini-md-export browser status [opcoes]',
    '',
    'Mostra readiness e clientes Gemini conectados sem iniciar job de export.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const tabsHelp = () =>
  [
    'gemini-md-export tabs',
    '',
    'Uso:',
    '  gemini-md-export tabs list [opcoes]',
    '  gemini-md-export tabs claim [--index <n>|--client-id <id>|--tab-id <id>] [opcoes]',
    '  gemini-md-export tabs release [--claim-id <id>] [opcoes]',
    '  gemini-md-export tabs reload [--claim-id <id>|--client-id <id>|--tab-id <id>] [opcoes]',
    '',
    'Lista e reivindica abas Gemini sem chamar tools MCP ruidosas no chat.',
    '',
    'Opcoes:',
    '  --index <n>             Indice 1-based mostrado por tabs list.',
    '  --label <text>          Rótulo curto do Tab Group/badge.',
    '  --color <name>          Cor do Tab Group quando suportado.',
    '  --ttl-ms <ms>           Tempo da claim. Default: 45 minutos.',
    '  --force                 Troca uma claim existente quando necessario.',
    '  --open-if-missing       Abre Gemini se nenhuma aba estiver conectada.',
    '  --no-open-if-missing    Nao abre Gemini automaticamente.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export tabs list --tui --result-json',
    '  gemini-md-export tabs claim --index 1 --tui --result-json',
    '  gemini-md-export sync "/path/to/vault" --claim-id <claimId> --tui',
  ].join('\n');

const chatsHelp = () =>
  [
    'gemini-md-export chats',
    '',
    'Uso:',
    '  gemini-md-export chats count [opcoes]',
    '  gemini-md-export chats list [--limit <n>] [--offset <n>] [--save-selection] [opcoes]',
    '',
    'Conta ou lista conversas carregaveis no sidebar sem despejar historico inteiro.',
    'A contagem so e total quando a CLI imprimir "Total confirmado".',
    'Se a CLI imprimir "Contagem parcial", responda "pelo menos N" e nao "ao todo".',
    'Para baixar a pagina listada depois, use --save-selection e passe o manifesto',
    'para export selected --selection-file ... --expected-count N.',
    '',
    'Opcoes:',
    '  --limit <n>                  Quantidade de conversas na pagina. Default: 25.',
    '  --offset <n>                 Pula conversas anteriores da lista. Default: 0.',
    '  --save-selection            Salva a pagina listada como manifesto reutilizavel.',
    '  --selection-file <path>      Caminho do manifesto. Default: ~/.gemini-md-export/selections/latest.json.',
    '  --max-load-more-rounds <n>   Rodadas maximas para puxar historico.',
    '  --load-more-attempts <n>     Tentativas de scroll por rodada.',
    '  --max-no-growth-rounds <n>   Rodadas sem crescimento antes de desistir.',
    '  --load-more-browser-rounds <n> Rodadas internas no navegador por comando.',
    '  --load-more-browser-timeout-ms <ms> Timeout do carregamento no navegador.',
    '  --load-more-timeout-ms <ms>  Timeout total do comando de contagem.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export chats count --tui --result-json',
    '  gemini-md-export chats list --limit 10 --save-selection --tui --result-json',
    '  gemini-md-export chats count --json',
  ].join('\n');

const exportHelp = () =>
  [
    'gemini-md-export export',
    '',
    'Uso:',
    '  gemini-md-export export recent [opcoes]',
    '  gemini-md-export export missing <vaultDir> [opcoes]',
    '  gemini-md-export export resume <reportFile> [opcoes]',
    '  gemini-md-export export selected --selection-file <manifest.json> --expected-count <n> [opcoes]',
    '  gemini-md-export export selected --chat-id <id> [opcoes]',
    '  gemini-md-export export reexport --chat-id <id> [opcoes]  (legado)',
    '  gemini-md-export export notebook [opcoes]',
    '',
    'Subcomandos:',
    '  recent   Exporta historico recente carregavel.',
    '  missing  Cruza Gemini Web com o vault e baixa ausentes.',
    '  resume   Retoma a partir de relatorio incremental.',
    '  selected Baixa uma selecao explicita de conversas por chatId/manifesto.',
    '  reexport Legado: alias antigo de selected para staging/reparo.',
    '  notebook Exporta conversas carregadas no caderno Gemini atual.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportRecentHelp = () =>
  [
    'gemini-md-export export recent',
    '',
    'Uso:',
    '  gemini-md-export export recent [opcoes]',
    '',
    'Inicia job de export do historico recente carregavel.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportMissingHelp = () =>
  [
    'gemini-md-export export missing',
    '',
    'Uso:',
    '  gemini-md-export export missing <vaultDir> [opcoes]',
    '',
    'Baixa apenas conversas ausentes no vault informado.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportResumeHelp = () =>
  [
    'gemini-md-export export resume',
    '',
    'Uso:',
    '  gemini-md-export export resume <reportFile> [opcoes]',
    '',
    'Retoma um job anterior usando o relatorio incremental.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportReexportHelp = () =>
  [
    'gemini-md-export export reexport',
    '',
    'Uso:',
    '  gemini-md-export export reexport --selection-file <manifest.json> --expected-count <n> [opcoes]',
    '  gemini-md-export export reexport --chat-id <id> [--chat-id <id>] [opcoes]',
    '  gemini-md-export export reexport <id1> <id2> ... [opcoes]',
    '',
    'Legado: use export selected para baixar conversas selecionadas.',
    'Mantido para scripts de reparo/staging que ainda usam o nome antigo.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportSelectedHelp = () =>
  [
    'gemini-md-export export selected',
    '',
    'Uso:',
    '  gemini-md-export export selected --selection-file <manifest.json> --expected-count <n> [opcoes]',
    '  gemini-md-export export selected --chat-id <id> [--chat-id <id>] [opcoes]',
    '  gemini-md-export export selected <id1> <id2> ... [opcoes]',
    '',
    'Baixa conversas selecionadas em job de background. Para follow-up de "baixe essas",',
    'prefira o manifesto criado por chats list --save-selection para evitar ambiguidade.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportNotebookHelp = () =>
  [
    'gemini-md-export export notebook',
    '',
    'Uso:',
    '  gemini-md-export export notebook [opcoes]',
    '',
    'Exporta conversas carregadas no caderno Gemini da aba reivindicada/atual.',
    '',
    ...outputModeHelp(),
    '',
    ...jobOptionHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const jobHelp = () =>
  [
    'gemini-md-export job',
    '',
    'Uso:',
    '  gemini-md-export job list [opcoes]',
    '  gemini-md-export job status <jobId> [opcoes]',
    '  gemini-md-export job cancel <jobId> [opcoes]',
    '  gemini-md-export job trace <jobId> [opcoes]',
    '',
    'Subcomandos:',
    '  list     Lista jobs ativos/recentes para recuperar jobId perdido.',
    '  status   Consulta progresso/resultado de um job.',
    '  cancel   Solicita cancelamento de um job.',
    '  trace    Resume o trace tecnico sanitizado de um job.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export job list --active --tui --result-json',
    '  gemini-md-export job status job-123 --tui --result-json',
    '  gemini-md-export job cancel job-123 --tui --result-json',
    '  gemini-md-export job trace job-123 --tui --result-json',
  ].join('\n');

const jobListHelp = () =>
  [
    'gemini-md-export job list',
    '',
    'Uso:',
    '  gemini-md-export job list [--active] [--limit <n>] [opcoes]',
    '',
    'Lista jobs ativos ou recentes. Use quando um export longo foi interrompido',
    'e voce precisa descobrir o jobId antes de consultar/cancelar.',
    '',
    'Opcoes:',
    '  --active       Mostra apenas jobs ainda em andamento.',
    '  --limit <n>    Quantidade maxima de jobs. Default: 10.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const jobStatusHelp = () =>
  [
    'gemini-md-export job status',
    '',
    'Uso:',
    '  gemini-md-export job status <jobId> [opcoes]',
    '',
    'Consulta um job sem considerar "running" como erro.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const jobCancelHelp = () =>
  [
    'gemini-md-export job cancel',
    '',
    'Uso:',
    '  gemini-md-export job cancel <jobId> [--wait] [opcoes]',
    '',
    'Solicita cancelamento de um job em andamento. Com --wait, aguarda estado terminal',
    'ou explica que o navegador ainda está dentro da conversa atual.',
    '',
    'Opcoes:',
    '  --wait       Aguarda o job virar cancelled/completed/failed antes de sair.',
    '  --wait-ms <ms> Tempo maximo de espera. Default: cleanup timeout da CLI.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const jobTraceHelp = () =>
  [
    'gemini-md-export job trace',
    '',
    'Uso:',
    '  gemini-md-export job trace <jobId> [opcoes]',
    '',
    'Mostra eventos tecnicos sanitizados do job: fases, timeouts, cleanup de aba e erros.',
    'Nao inclui Markdown, prompts, respostas nem HTML por padrao.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const exportDirHelp = () =>
  [
    'gemini-md-export export-dir',
    '',
    'Uso:',
    '  gemini-md-export export-dir get [opcoes]',
    '  gemini-md-export export-dir set <path> [opcoes]',
    '  gemini-md-export export-dir set --reset [opcoes]',
    '',
    'Consulta ou altera o diretorio local default da bridge.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const cleanupHelp = () =>
  [
    'gemini-md-export cleanup stale-processes',
    '',
    'Uso:',
    '  gemini-md-export cleanup stale-processes [--confirm] [opcoes]',
    '',
    'Por padrao roda dry-run. Use --confirm para encerrar apenas processos que',
    'o diagnostico considera seguros.',
    '',
    'Opcoes:',
    '  --confirm       Executa a limpeza proposta.',
    '  --force         Usa encerramento forçado quando suportado.',
    '  --wait-ms <ms>  Quanto esperar processos encerrarem.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
  ].join('\n');

const repairVaultHelp = () =>
  [
    'gemini-md-export repair-vault',
    '',
    'Uso:',
    '  gemini-md-export repair-vault <vault-or-folder> [opcoes]',
    '',
    'Executa o script local scripts/vault-repair.mjs empacotado na extensao.',
    '',
    'Opcoes:',
    '  --audit-only             Somente auditoria, quando suportado pelo script.',
    '  --include-notes          Inclui notas wiki na auditoria, quando suportado.',
    '  --report <file.json>     Caminho de relatorio, quando suportado.',
    '',
    ...commonOptionHelp(),
  ].join('\n');

const telemetryHelp = () =>
  [
    'gemini-md-export telemetry',
    '',
    'Uso:',
    '  gemini-md-export telemetry enable --endpoint <url> --token <token> [--payload-level diagnostic_redacted|full_logs]',
    '  gemini-md-export telemetry status',
    '  gemini-md-export telemetry preview [--since 7d] [--limit 20]',
    '  gemini-md-export telemetry send [--since 7d] [--limit 20]',
    '  gemini-md-export telemetry disable',
    '',
    'A telemetria pode vir autoativada pelo pacote do mantenedor, e guarda retry local.',
    'Por padrao usa diagnostic_redacted: metadados, status, blockers, contagens,',
    'warnings/erros redigidos e paths compactos. full_logs inclui payload bruto',
    'redigido quando disponivel.',
    '',
    ...outputModeHelp(),
  ].join('\n');

const helpForParsed = (parsed) => {
  const topic = parsed.command === 'help' ? parsed.positionals : [parsed.command, ...parsed.positionals];
  const [command, subcommand] = topic;
  if (!command) return usage();
  if (command === 'sync') return syncHelp();
  if (command === 'doctor') return doctorHelp();
  if (command === 'diagnose') return diagnoseHelp();
  if (command === 'browser') return browserHelp();
  if (command === 'tabs') return tabsHelp();
  if (command === 'chats') return chatsHelp();
  if (command === 'export' && subcommand === 'recent') return exportRecentHelp();
  if (command === 'export' && subcommand === 'missing') return exportMissingHelp();
  if (command === 'export' && subcommand === 'resume') return exportResumeHelp();
  if (command === 'export' && subcommand === 'selected') return exportSelectedHelp();
  if (command === 'export' && subcommand === 'reexport') return exportReexportHelp();
  if (command === 'export' && subcommand === 'notebook') return exportNotebookHelp();
  if (command === 'export') return exportHelp();
  if (command === 'job' && subcommand === 'list') return jobListHelp();
  if (command === 'job' && subcommand === 'status') return jobStatusHelp();
  if (command === 'job' && subcommand === 'cancel') return jobCancelHelp();
  if (command === 'job' && subcommand === 'trace') return jobTraceHelp();
  if (command === 'job') return jobHelp();
  if (command === 'export-dir') return exportDirHelp();
  if (command === 'cleanup') return cleanupHelp();
  if (command === 'repair-vault') return repairVaultHelp();
  if (command === 'telemetry') return telemetryHelp();
  return usage();
};

const parseArgs = (argv) => {
  const firstArgIsHelp = argv[0] === '--help' || argv[0] === '-h';
  const firstArgIsVersion = argv[0] === '--version' || argv[0] === '-v';
  const out = {
    command: firstArgIsHelp ? 'help' : firstArgIsVersion ? 'version' : argv[0] || 'help',
    positionals: [],
    flags: {
      bridgeUrl:
        process.env.GEMINI_MD_EXPORT_BRIDGE_URL ||
        process.env.GEMINI_MCP_BRIDGE_URL ||
        DEFAULT_BRIDGE_URL,
      pollMs: DEFAULT_POLL_MS,
      readyWaitMs: DEFAULT_READY_WAIT_MS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      bridgeStartWaitMs: 6000,
      bridgeKeepAliveMs: 15 * 60_000,
      bridgeExitWhenIdle: true,
      startBridge: true,
      extraRepairArgs: [],
      chatIds: [],
      browser:
        process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER
          ? normalizeBrowserKey(process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER)
          : undefined,
      profileDirectory:
        process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY ||
        process.env.GME_CHROME_PROFILE_DIRECTORY ||
        process.env.GEMINI_MCP_BROWSER_PROFILE_DIRECTORY ||
        process.env.GME_BROWSER_PROFILE_DIRECTORY ||
        undefined,
      color: process.env.NO_COLOR ? false : true,
      wakeBrowser: true,
      selfHeal: true,
      allowReload: true,
      format: 'auto',
      help: firstArgIsHelp,
      version: firstArgIsVersion,
    },
  };

  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (!next) throw new Error(`Faltou valor para ${arg}.`);
      return next;
    };

    if (arg === '--help' || arg === '-h') out.flags.help = true;
    else if (arg === '--version' || arg === '-v') out.flags.version = true;
    else if (arg === '--bridge-url') out.flags.bridgeUrl = value();
    else if (arg === '--endpoint') out.flags.endpoint = value();
    else if (arg === '--token') out.flags.token = value();
    else if (arg === '--payload-level') out.flags.payloadLevel = value();
    else if (arg === '--since') out.flags.since = value();
    else if (arg === '--limit') {
      if (out.command === 'telemetry' || out.command === 'job' || out.command === 'chats') {
        out.flags.limit = Number(value());
      }
      else out.flags.maxChats = Number(value());
    }
    else if (arg === '--offset') out.flags.offset = Number(value());
    else if (arg === '--vault-dir') out.flags.vaultDir = value();
    else if (arg === '--url') out.flags.url = value();
    else if (arg === '--output-dir') out.flags.outputDir = value();
    else if (arg === '--resume-report-file' || arg === '--report-file')
      out.flags.resumeReportFile = value();
    else if (arg === '--sync-state-file') out.flags.syncStateFile = value();
    else if (arg === '--known-boundary-count') out.flags.knownBoundaryCount = Number(value());
    else if (arg === '--max-chats') out.flags.maxChats = Number(value());
    else if (arg === '--batch-size') out.flags.batchSize = Number(value());
    else if (arg === '--max-load-more-rounds') out.flags.maxLoadMoreRounds = Number(value());
    else if (arg === '--load-more-attempts') out.flags.loadMoreAttempts = Number(value());
    else if (arg === '--max-no-growth-rounds') out.flags.maxNoGrowthRounds = Number(value());
    else if (arg === '--load-more-browser-rounds') out.flags.loadMoreBrowserRounds = Number(value());
    else if (arg === '--load-more-browser-timeout-ms')
      out.flags.loadMoreBrowserTimeoutMs = Number(value());
    else if (arg === '--load-more-timeout-ms') out.flags.loadMoreTimeoutMs = Number(value());
    else if (arg === '--hydration-timeout-ms' || arg === '--hydration-max-total-ms')
      out.flags.hydrationMaxTotalMs = Number(value());
    else if (arg === '--hydration-stall-ms') out.flags.hydrationStallTimeoutMs = Number(value());
    else if (arg === '--hydration-wait-ms') out.flags.hydrationLoadWaitMs = Number(value());
    else if (arg === '--hydration-top-settle-ms') out.flags.hydrationTopSettleMs = Number(value());
    else if (arg === '--hydration-max-attempts') out.flags.hydrationMaxAttempts = Number(value());
    else if (arg === '--export-browser-timeout-ms' || arg === '--browser-command-timeout-ms')
      out.flags.exportBrowserTimeoutMs = Number(value());
    else if (arg === '--refresh') out.flags.refresh = true;
    else if (arg === '--no-refresh') out.flags.refresh = false;
    else if (arg === '--active') out.flags.active = true;
    else if (arg === '--poll-ms') out.flags.pollMs = Math.max(250, Number(value()) || DEFAULT_POLL_MS);
    else if (arg === '--bridge-start-wait-ms')
      out.flags.bridgeStartWaitMs = Math.max(500, Number(value()) || 6000);
    else if (arg === '--bridge-keep-alive-ms')
      out.flags.bridgeKeepAliveMs = Math.max(1000, Number(value()) || 15 * 60_000);
    else if (arg === '--ready-wait-ms') out.flags.readyWaitMs = Math.max(0, Number(value()) || 0);
    else if (arg === '--timeout-ms') out.flags.timeoutMs = Math.max(1000, Number(value()) || DEFAULT_TIMEOUT_MS);
    else if (arg === '--browser') out.flags.browser = normalizeBrowserKey(value());
    else if (arg === '--profile-directory') out.flags.profileDirectory = value();
    else if (arg === '--extension-id') out.flags.extensionId = value();
    else if (arg === '--client-id') out.flags.clientId = value();
    else if (arg === '--tab-id') out.flags.tabId = value();
    else if (arg === '--claim-id') out.flags.claimId = value();
    else if (arg === '--session' || arg === '--session-id') out.flags.sessionId = value();
    else if (arg === '--keep-claim' || arg === '--no-auto-release-claim')
      out.flags.autoReleaseClaim = false;
    else if (arg === '--auto-release-claim') out.flags.autoReleaseClaim = true;
    else if (arg === '--index') out.flags.index = Number(value());
    else if (arg === '--label') out.flags.label = value();
    else if (arg === '--color') out.flags.colorName = value();
    else if (arg === '--ttl-ms') out.flags.ttlMs = Number(value());
    else if (arg === '--open-if-missing') out.flags.openIfMissing = true;
    else if (arg === '--no-open-if-missing') out.flags.openIfMissing = false;
    else if (arg === '--start-index') out.flags.startIndex = Number(value());
    else if (arg === '--chat-id') out.flags.chatIds.push(value());
    else if (arg === '--selection-file') out.flags.selectionFile = value();
    else if (arg === '--save-selection') out.flags.saveSelection = true;
    else if (arg === '--expected-count') out.flags.expectedCount = Number(value());
    else if (arg === '--delay-ms') out.flags.delayMs = Number(value());
    else if (arg === '--reset') out.flags.reset = true;
    else if (arg === '--confirm') out.flags.confirm = true;
    else if (arg === '--force') out.flags.force = true;
    else if (arg === '--wait') out.flags.wait = true;
    else if (arg === '--wait-ms') out.flags.waitMs = Number(value());
    else if (arg === '--artifacts') out.flags.artifacts = true;
    else if (arg === '--full') {
      out.flags.detail = 'full';
      out.flags.includeHtmlSample = true;
    }
    else if (arg === '--include-html-sample') out.flags.includeHtmlSample = true;
    else if (arg === '--include-html') out.flags.includeHtml = true;
    else if (arg === '--no-frame-probe') out.flags.includeFrameProbe = false;
    else if (arg === '--open-artifacts') out.flags.openArtifactLaunchers = true;
    else if (arg === '--no-open-artifacts') out.flags.openArtifactLaunchers = false;
    else if (arg === '--keep-artifact-open') out.flags.closeOpenedLaunchers = false;
    else if (arg === '--close-artifact') out.flags.closeOpenedLaunchers = true;
    else if (arg === '--max-open-artifacts') out.flags.maxOpenArtifactLaunchers = Number(value());
    else if (arg === '--artifact-open-wait-ms') out.flags.artifactOpenWaitMs = Number(value());
    else if (arg === '--save-html') out.flags.saveHtml = true;
    else if (arg === '--no-save-html') out.flags.saveHtml = false;
    else if (arg === '--audit-only' || arg === '--include-notes') out.flags.extraRepairArgs.push(arg);
    else if (arg === '--report') {
      const report = value();
      out.flags.report = report;
      out.flags.extraRepairArgs.push(arg, report);
    }
    else if (arg === '--tui') out.flags.format = 'tui';
    else if (arg === '--plain') out.flags.format = 'plain';
    else if (arg === '--json') out.flags.format = 'json';
    else if (arg === '--jsonl') out.flags.format = 'jsonl';
    else if (arg === '--result-json') out.flags.resultJson = true;
    else if (arg === '--no-color') out.flags.color = false;
    else if (arg === '--no-start-bridge') out.flags.startBridge = false;
    else if (arg === '--exit-when-idle') out.flags.bridgeExitWhenIdle = true;
    else if (arg === '--no-exit-when-idle') out.flags.bridgeExitWhenIdle = false;
    else if (arg === '--no-wake') out.flags.wakeBrowser = false;
    else if (arg === '--no-self-heal') out.flags.selfHeal = false;
    else if (arg === '--no-reload') out.flags.allowReload = false;
    else if (arg.startsWith('-')) throw new Error(`Opcao desconhecida: ${arg}`);
    else out.positionals.push(arg);
  }

  return out;
};

const normalizeBridgeUrl = (url) => String(url || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');

const enabledEnvFlag = (value) => /^(1|true|yes|sim)$/i.test(String(value || '').trim());

const nonNegativeIntEnv = (value, fallback, max = 60_000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
};

const appendParams = (path, params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        query.append(key, String(item));
      }
      continue;
    }
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
};

const selectionDir = () => resolve(homedir(), '.gemini-md-export', 'selections');

const defaultSelectionFile = () => resolve(selectionDir(), 'latest.json');

const expandUserPath = (value) => {
  const text = String(value || '');
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return text;
};

const selectionFileForWrite = (flags = {}) => resolve(expandUserPath(flags.selectionFile || defaultSelectionFile()));

const extractChatIdForCli = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const fromUrl = text.match(/\/app\/([a-f0-9]{12,})/i);
  const raw = (fromUrl ? fromUrl[1] : text.replace(/^gemini:/i, '')).trim();
  const match = raw.match(/^[a-f0-9]{12,}$/i);
  return match ? raw.toLowerCase() : null;
};

const splitChatIdArgs = (values = []) =>
  values
    .flatMap((value) => String(value ?? '').split(/[,\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);

const normalizeReexportSelection = ({ chatIds = [], items = [] } = {}) => {
  const rawItems = [
    ...splitChatIdArgs(chatIds).map((chatId) => ({ chatId })),
    ...(Array.isArray(items) ? items : []),
  ];
  const seen = new Set();
  const normalizedItems = [];
  const duplicates = [];
  const invalid = [];

  for (const raw of rawItems) {
    const item = typeof raw === 'string' ? { chatId: raw } : raw || {};
    const chatId = extractChatIdForCli(item.chatId || item.id || item.url);
    if (!chatId) {
      invalid.push(String(item.chatId || item.id || item.url || raw));
      continue;
    }
    if (seen.has(chatId)) {
      duplicates.push(chatId);
      continue;
    }
    seen.add(chatId);
    normalizedItems.push({
      chatId,
      title: item.title || item.label || null,
      url: item.url || `https://gemini.google.com/app/${chatId}`,
      source: item.source || null,
      sourcePath: item.sourcePath || item.path || null,
      listedIndex: item.listedIndex ?? item.index ?? null,
    });
  }

  return {
    inputCount: rawItems.length,
    uniqueCount: normalizedItems.length,
    duplicateCount: duplicates.length,
    duplicates,
    invalid,
    items: normalizedItems,
    chatIds: normalizedItems.map((item) => item.chatId),
  };
};

const readSelectionFile = (filePath) => {
  const resolved = resolve(expandUserPath(filePath || defaultSelectionFile()));
  const json = JSON.parse(readFileSync(resolved, 'utf-8'));
  const items = Array.isArray(json.conversations)
    ? json.conversations
    : Array.isArray(json.items)
      ? json.items
      : [];
  const chatIds = items.length > 0 ? [] : Array.isArray(json.chatIds) ? json.chatIds : [];
  const selection = normalizeReexportSelection({ chatIds, items });
  return {
    filePath: resolved,
    manifest: json,
    ...selection,
  };
};

const writeSelectionFile = (raw = {}, flags = {}) => {
  const filePath = selectionFileForWrite(flags);
  const conversations = Array.isArray(raw.conversations) ? raw.conversations : [];
  const items = conversations.map((conversation, index) => {
    const chatId = extractChatIdForCli(conversation.chatId || conversation.id || conversation.url);
    return {
      index: conversation.index ?? (Number(flags.offset || 0) + index + 1),
      chatId,
      title: conversation.title || null,
      url: conversation.url || (chatId ? `https://gemini.google.com/app/${chatId}` : null),
      source: conversation.source || null,
    };
  }).filter((item) => item.chatId);
  const manifest = {
    kind: 'gemini-md-export-selection',
    version: 1,
    createdAt: new Date().toISOString(),
    source: 'chats list',
    offset: Math.max(0, Number(flags.offset || 0)),
    limit: Math.max(1, Number(flags.limit || flags.maxChats || items.length || 25)),
    expectedCount: items.length,
    chatIds: items.map((item) => item.chatId),
    conversations: items,
    pagination: raw.pagination || null,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    filePath,
    manifest,
  };
};

const validateExpectedCount = (selection, expectedCount) => {
  if (expectedCount === undefined || expectedCount === null || expectedCount === '') return;
  const expected = Number(expectedCount);
  if (!Number.isInteger(expected) || expected <= 0) {
    throw usageError('--expected-count precisa ser um numero inteiro positivo.');
  }
  if (selection.uniqueCount !== expected) {
    const err = usageError(
      `A selecao tem ${selection.uniqueCount} chatId(s) unico(s), mas --expected-count pediu ${expected}. Nao iniciei exportacao.`,
    );
    err.data = {
      expectedCount: expected,
      uniqueCount: selection.uniqueCount,
      inputCount: selection.inputCount,
      duplicateCount: selection.duplicateCount,
      invalid: selection.invalid,
    };
    throw err;
  }
};

const loadMoreParamsFromFlags = (flags = {}) => ({
  maxLoadMoreRounds: flags.maxLoadMoreRounds,
  loadMoreAttempts: flags.loadMoreAttempts,
  maxNoGrowthRounds: flags.maxNoGrowthRounds,
  loadMoreBrowserRounds: flags.loadMoreBrowserRounds,
  loadMoreBrowserTimeoutMs: flags.loadMoreBrowserTimeoutMs,
  loadMoreTimeoutMs: flags.loadMoreTimeoutMs,
});

const hydrationParamsFromFlags = (flags = {}) => ({
  hydrationMaxTotalMs: flags.hydrationMaxTotalMs,
  hydrationStallTimeoutMs: flags.hydrationStallTimeoutMs,
  hydrationLoadWaitMs: flags.hydrationLoadWaitMs,
  hydrationTopSettleMs: flags.hydrationTopSettleMs,
  hydrationMaxAttempts: flags.hydrationMaxAttempts,
  exportBrowserTimeoutMs: flags.exportBrowserTimeoutMs,
});

const normalizeBridgeRequestError = (err) => {
  const message = String(err?.message || '');
  if (
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    /socket hang up|fetch failed|terminated/i.test(message)
  ) {
    const wrapped = new Error('Conexao com a bridge caiu antes da resposta.');
    wrapped.code = 'bridge_connection_lost';
    wrapped.cause = err;
    return wrapped;
  }
  return err;
};

const formatExportJobInProgressMessage = (json = {}) => {
  const data = json.data || {};
  const lines = [
    json.error || `Já existe um job de exportação em andamento${data.jobId ? `: ${data.jobId}` : ''}.`,
    data.jobId ? `jobId: ${data.jobId}` : null,
    data.status ? `status: ${data.status}${data.phase ? `/${data.phase}` : ''}` : null,
    data.statusCliCommand ? `status: ${data.statusCliCommand}` : null,
    data.cancelCliCommand ? `cancelar: ${data.cancelCliCommand}` : null,
    data.reportFile ? `reportFile: ${data.reportFile}` : null,
    data.traceFile ? `traceFile: ${data.traceFile}` : null,
  ].filter(Boolean);
  return lines.join('\n');
};

const requestJson = async (
  bridgeUrl,
  path,
  { timeoutMs = 15000, method = 'GET', layer = 'bridge', operation = null, body = undefined } = {},
) => {
  const url = new URL(path, `${normalizeBridgeUrl(bridgeUrl)}/`);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const operationName = operation || `${method} ${url.pathname}`;
  const bodyText = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = transport(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(bodyText
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bodyText),
              }
            : {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', (err) =>
          finish(
            rejectRequest,
            decorateErrorWithTimeoutContext(normalizeBridgeRequestError(err), {
              layer,
              operation: operationName,
              timeoutMs,
            }),
          ),
        );
        response.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (err) {
            finish(rejectRequest, err);
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const err = new Error(
              json?.code === 'export_job_in_progress'
                ? formatExportJobInProgressMessage(json)
                : json?.error || `HTTP ${response.statusCode}`,
            );
            err.statusCode = response.statusCode;
            err.code = json?.code || null;
            err.data = json?.data || json;
            finish(rejectRequest, err);
            return;
          }
          finish(resolveRequest, json);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      const timeout = createLayeredTimeoutError({
        code: 'bridge_timeout',
        message: `Timeout falando com a bridge em ${timeoutMs}ms (${operationName}).`,
        layer,
        operation: operationName,
        timeoutMs,
      });
      req.destroy(timeout);
    });
    req.on('error', (err) =>
      finish(
        rejectRequest,
        decorateErrorWithTimeoutContext(normalizeBridgeRequestError(err), {
          layer,
          operation: operationName,
          timeoutMs,
        }),
      ),
    );
    req.end(bodyText || undefined);
  });
};

const requestReadyStatus = async (bridgeUrl, flags, { waitMs = 0 } = {}) =>
  requestJson(
    bridgeUrl,
    appendParams('/agent/ready', {
      wakeBrowser: false,
      waitMs,
      selfHeal: flags.selfHeal,
      allowReload: flags.allowReload,
      clientId: flags.clientId,
    }),
    {
      timeoutMs: Math.max(
        nonNegativeIntEnv(
          process.env.GEMINI_MD_EXPORT_READY_REQUEST_TIMEOUT_MS,
          DEFAULT_READY_REQUEST_TIMEOUT_MS,
          5 * 60_000,
        ),
        waitMs + 15_000,
      ),
    },
  );

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');

const firstExistingPath = (candidates) => candidates.find((candidate) => existsSync(candidate)) || null;

const bridgeServerPath = () =>
  firstExistingPath([
    resolve(packageRoot(), 'src', 'bridge-server.js'),
    resolve(packageRoot(), 'src', 'mcp-server.js'),
  ]);

const repairScriptPath = () =>
  firstExistingPath([
    resolve(packageRoot(), 'scripts', 'vault-repair.mjs'),
    resolve(packageRoot(), 'gemini-cli-extension', 'scripts', 'vault-repair.mjs'),
  ]);

const localBridgeAddress = (bridgeUrl) => {
  try {
    const parsed = new URL(normalizeBridgeUrl(bridgeUrl));
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!port) return null;
    return {
      host: parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname.replace(/^\[(.*)]$/, '$1'),
      port,
    };
  } catch {
    return null;
  }
};

const startBridgeOnlyProcess = (flags) => {
  const serverPath = bridgeServerPath();
  const address = localBridgeAddress(flags.bridgeUrl);
  if (!address || !serverPath) return false;
  const serverArgs = serverPath.endsWith('mcp-server.js')
    ? [serverPath, '--bridge-only', '--host', address.host, '--port', String(address.port)]
    : [serverPath, '--host', address.host, '--port', String(address.port)];
  if (flags.bridgeExitWhenIdle !== false) {
    serverArgs.push('--exit-when-idle', '--keep-alive-ms', String(flags.bridgeKeepAliveMs || 15 * 60_000));
  } else {
    serverArgs.push('--no-exit-when-idle');
  }
  const child = spawn(
    process.execPath,
    serverArgs,
    {
      cwd: homedir(),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
      },
    },
  );
  child.unref();
  return true;
};

const ensureBridgeAvailable = async (flags, ui) => {
  try {
    return await requestJson(flags.bridgeUrl, '/healthz', { timeoutMs: 1000 });
  } catch (firstError) {
    if (firstError.statusCode) {
      return { ok: true, legacy: true, statusCode: firstError.statusCode };
    }
    if (!flags.startBridge) throw firstError;
    const address = localBridgeAddress(flags.bridgeUrl);
    if (!address) throw firstError;
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write('Bridge local nao respondeu; iniciando bridge-only...\n');
    }
    if (!startBridgeOnlyProcess(flags)) throw firstError;
    const startedAt = Date.now();
    let lastError = firstError;
    while (Date.now() - startedAt < flags.bridgeStartWaitMs) {
      await sleep(120);
      try {
        return await requestJson(flags.bridgeUrl, '/healthz', { timeoutMs: 1000 });
      } catch (err) {
        lastError = err;
      }
    }
    const err = new Error(`Bridge local nao iniciou em ${flags.bridgeStartWaitMs}ms.`);
    err.code = 'bridge_timeout';
    err.data = { cause: lastError?.message || String(lastError) };
    throw err;
  }
};

const wantsColor = (ui) => ui.color && ui.format !== 'json' && ui.format !== 'jsonl';
const colorize = (ui, color, text) => (wantsColor(ui) ? `${ANSI[color]}${text}${ANSI.reset}` : text);
const bold = (ui, text) => (wantsColor(ui) ? `${ANSI.bold}${text}${ANSI.reset}` : text);
const dim = (ui, text) => (wantsColor(ui) ? `${ANSI.dim}${text}${ANSI.reset}` : text);

const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const firstFiniteNumber = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

const formatDuration = (ms) => {
  const seconds = Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}min ${rest}s` : `${minutes}min`;
};

const supportsTui = (stdout = process.stdout) => stdout.isTTY && process.env.TERM !== 'dumb';

const prefersStreamTui = () => {
  const explicit = String(process.env.GEMINI_MD_EXPORT_TUI_MODE || '').trim().toLowerCase();
  if (['ansi', 'full', 'vt100'].includes(explicit)) return false;
  if (['stream', 'line', 'append', 'compact'].includes(explicit)) return true;
  return false;
};

const selectFormat = (flags, stdout = process.stdout) => {
  if (flags.format === 'tui' && !stdout.isTTY) return 'plain';
  if (flags.format === 'tui' && prefersStreamTui()) return 'tui-stream';
  if (flags.format !== 'auto') return flags.format;
  if (supportsTui(stdout)) return prefersStreamTui() ? 'tui-stream' : 'tui';
  return 'plain';
};

const makeUi = (flags, streams = {}) => {
  const stdout = streams.stdout || process.stdout;
  const format = selectFormat(flags, stdout);
  return {
    format,
    requestedFormat: flags.format,
    tuiFallback: flags.format === 'tui' && format === 'plain',
    tuiFallbackWarned: false,
    color: flags.color,
    stdout,
    stderr: streams.stderr || process.stderr,
    lastLineCount: 0,
    firstRender: true,
    closed: false,
    streamHeaderPrinted: false,
    waitNote: null,
    waitDetail: null,
    waitIssue: null,
  };
};

const warnTuiFallback = (ui) => {
  if (!ui.tuiFallback || ui.tuiFallbackWarned) return;
  ui.tuiFallbackWarned = true;
  ui.stderr.write(
    'Aviso: --tui precisa de terminal interativo (TTY/PTY). Este shell esta capturando a saida; usando --plain.\n',
  );
};

const terminalWidth = (ui) => Math.max(60, Math.min(120, ui.stdout.columns || 88));

const renderedLineCount = (ui, lines = []) => {
  const columns = Math.max(1, Math.floor(Number(ui.stdout.columns) || terminalWidth(ui)));
  return lines.reduce((sum, line) => {
    const plain = stripAnsi(line);
    return (
      sum +
      plain
        .split('\n')
        .reduce((lineSum, part) => lineSum + Math.max(1, Math.ceil(String(part).length / columns)), 0)
    );
  }, 0);
};

const bar = (
  ui,
  current,
  total,
  { width = 28, indeterminate = false, seed = 0, filledChar = '=', emptyChar = '-' } = {},
) => {
  const safeTotal = Math.max(0, Number(total) || 0);
  if (indeterminate || safeTotal <= 0) {
    const size = Math.max(4, Math.floor(width / 4));
    const start = seed % Math.max(1, width - size);
    const chars = Array.from({ length: width }, (_, index) =>
      index >= start && index < start + size ? filledChar : emptyChar,
    );
    return `[${chars.join('')}]`;
  }
  const pct = Math.max(0, Math.min(1, (Number(current) || 0) / safeTotal));
  const filled = Math.round(pct * width);
  return `[${filledChar.repeat(filled)}${emptyChar.repeat(Math.max(0, width - filled))}] ${Math.round(pct * 100)}%`;
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const spinnerFrame = (tick = 0) => SPINNER_FRAMES[Math.abs(Number(tick) || 0) % SPINNER_FRAMES.length];

const pluralizePt = (count, singular, plural = `${singular}s`) =>
  `${count} ${Number(count) === 1 ? singular : plural}`;

const loadedConversationCount = (job = {}, totals = jobTotals(job)) =>
  firstFiniteNumber(
    job.knownLoadedCount,
    job.minimumKnownCount,
    job.loadedCount,
    job.webConversationCount,
    totals.webSeen,
  );

const indeterminateCountText = (job = {}, totals = jobTotals(job)) => {
  const loaded = loadedConversationCount(job, totals);
  if (loaded !== null && loaded > 0) return `${loaded} encontradas`;
  if (job.tuiKind === 'count') return 'procurando conversas';
  return 'trabalhando';
};

const terminalColorForStatus = (status) => {
  if (status === 'completed') return 'green';
  if (status === 'completed_with_errors') return 'yellow';
  if (status === 'failed' || status === 'cancelled') return 'red';
  return 'cyan';
};

const jobTotals = (job = {}) => {
  const decision = job.decisionSummary || {};
  const totals = decision.totals || {};
  const downloaded = Number(totals.downloadedNow ?? job.successCount ?? 0) || 0;
  const failed = Number(totals.failed ?? job.failureCount ?? 0) || 0;
  const skipped = Number(totals.skipped ?? job.skippedCount ?? 0) || 0;
  const warnings = Number(totals.mediaWarnings ?? 0) || 0;
  const webSeen = totals.geminiWebSeen ?? job.webConversationCount ?? job.loadedCount ?? null;
  const existing = totals.existingInVault ?? job.existingVaultCount ?? null;
  const missing = totals.missingInVault ?? job.missingCount ?? null;
  return { downloaded, failed, skipped, warnings, webSeen, existing, missing };
};

const displayProgressPosition = (job = {}, total = 0) => {
  const requested = Math.max(0, Number(total || job.requested || 0));
  const completed = Math.max(0, Number(job.completed || 0));
  const currentIndex = Math.max(0, Number(job.current?.index || job.position || 0));
  if (requested > 0 && !TERMINAL_STATUSES.has(job.status) && job.phase === 'exporting') {
    return Math.min(requested, Math.max(completed + 1, currentIndex, 1));
  }
  return requested > 0 ? Math.min(completed, requested) : completed;
};

const humanStatusLabel = (job = {}) => {
  if (job.status === 'completed') return 'Concluido';
  if (job.status === 'completed_with_errors') return 'Concluido com avisos';
  if (job.status === 'failed') return 'Falhou';
  if (job.status === 'cancelled') return 'Cancelado';
  if (job.phase === 'loading-history') return 'Carregando historico';
  if (job.phase === 'scanning-vault') return 'Comparando vault';
  if (job.phase === 'exporting') return 'Exportando';
  if (job.phase === 'writing-report') return 'Finalizando';
  return 'Preparando';
};

const fitTerminalLine = (ui, text, reserved = 0) => {
  const width = Math.max(24, (Number(ui.stdout.columns) || terminalWidth(ui)) - reserved);
  const value = String(text || '');
  if (stripAnsi(value).length <= width) return value;
  return `${stripAnsi(value).slice(0, Math.max(1, width - 3))}...`;
};

const padAnsiRight = (text, width) => {
  const value = String(text || '');
  const plainLength = stripAnsi(value).length;
  if (plainLength >= width) return stripAnsi(value).slice(0, width);
  return `${value}${' '.repeat(width - plainLength)}`;
};

const panelLines = (ui, title, bodyLines = []) => {
  if (ui.format !== 'tui') return bodyLines;
  const width = Math.max(44, Math.min(92, terminalWidth(ui)));
  const innerWidth = width - 4;
  const cleanTitle = stripAnsi(title).slice(0, Math.max(8, innerWidth - 2));
  const titleChunk = ` ${cleanTitle} `;
  const topFill = '─'.repeat(Math.max(0, width - titleChunk.length - 2));
  return [
    `╭${titleChunk}${topFill}╮`,
    ...bodyLines.map((line) => `│ ${padAnsiRight(fitTerminalLine(ui, line, width - innerWidth), innerWidth)} │`),
    `╰${'─'.repeat(width - 2)}╯`,
  ];
};

const summarizeForResultJson = (job = {}) => {
  const decision = job.decisionSummary || {};
  const totals = jobTotals(job);
  const scope = job.scope
    ? {
        fullHistoryVerified: job.fullHistoryVerified === true,
        fullHistoryRequested: job.fullHistoryRequested === true,
      }
    : {
        fullHistoryVerified: decision.fullHistoryVerified === true,
        fullHistoryRequested: decision.fullHistoryRequested === true,
      };
  const failures = Array.isArray(job.failures)
    ? job.failures
    : Array.isArray(job.recentErrors)
      ? job.recentErrors
      : [];
  return {
    ok: job.status === 'completed',
    status: job.status || null,
    jobId: job.jobId || null,
    reportFile: job.reportFile || decision.reportFile || null,
    traceFile: job.traceFile || job.trace?.filePath || null,
    resumeCommand: decision.resumeCommand || job.resumeCommand || null,
    resumeCommandText: decision.resumeCommand?.text || job.resumeCommand?.text || null,
    webConversationCount: totals.webSeen,
    existingVaultCount: totals.existing,
    missingCount: totals.missing,
    downloadedCount: totals.downloaded,
    skippedCount: totals.skipped,
    warningCount: totals.warnings,
    failedCount: totals.failed,
    failures: failures.slice(-10).map((failure) => ({
      index: failure.index ?? null,
      chatId: failure.chatId || failure.id || null,
      title: failure.title || null,
      error: failure.error || failure.message || null,
    })),
    loadWarning: job.loadWarning || null,
    loadMoreTimedOut: job.loadMoreTimedOut === true,
    loadMoreRoundsCompleted: job.loadMoreRoundsCompleted ?? null,
    fullHistoryVerified: scope.fullHistoryVerified,
    fullHistoryRequested: scope.fullHistoryRequested,
    nextAction: decision.nextAction || job.nextAction || null,
  };
};

const renderLinesForCountWait = (ui, job = {}, tick = 0) => {
  const loaded = firstFiniteNumber(job.knownLoadedCount, job.minimumKnownCount, job.loadedCount);
  const foundText =
    loaded !== null && loaded > 0
      ? `${pluralizePt(loaded, 'conversa')} encontrada${loaded === 1 ? '' : 's'} ate agora`
      : 'Procurando conversas no historico';
  const elapsedText = job.elapsedMs ? `tempo ${formatDuration(job.elapsedMs)}` : null;
  const roundsText =
    firstFiniteNumber(job.loadMoreRoundsCompleted) !== null
      ? `rodadas ${Number(job.loadMoreRoundsCompleted)}`
      : null;
  const details = [elapsedText, roundsText, job.claimLabel ? `aba ${job.claimLabel}` : null]
    .filter(Boolean)
    .join(' | ');
  const lines = [
    `${colorize(ui, 'cyan', spinnerFrame(tick))} Buscando fim do historico`,
    foundText,
    job.progressMessage ? dim(ui, job.progressMessage) : null,
    details ? dim(ui, details) : null,
  ].filter(Boolean);
  return panelLines(ui, 'Gemini Markdown Export · contagem', lines);
};

const renderLinesForReadyWait = (ui, job = {}, tick = 0) => {
  const note = job.waitNote || job.progressMessage || 'Verificando Gemini Web';
  const details = [
    job.elapsedMs ? `tempo ${formatDuration(job.elapsedMs)}` : null,
    job.waitDetail || null,
    job.blockingIssue ? `motivo ${job.blockingIssue}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
  const lines = [
    `${colorize(ui, 'cyan', spinnerFrame(tick))} ${note}`,
    job.progressMessage && job.progressMessage !== note ? dim(ui, job.progressMessage) : null,
    details ? dim(ui, details) : null,
  ].filter(Boolean);
  return panelLines(ui, 'Gemini Markdown Export · preparando', lines);
};

const renderLinesForJob = (ui, job = {}, tick = 0) => {
  if (job.tuiKind === 'count') return renderLinesForCountWait(ui, job, tick);
  if (job.tuiKind === 'ready') return renderLinesForReadyWait(ui, job, tick);
  const width = terminalWidth(ui);
  const totals = jobTotals(job);
  const total = Number(job.requested || job.missingCount || job.webConversationCount || 0);
  const current = displayProgressPosition(job, total);
  const indeterminate = !total || ['queued', 'loading-history', 'scanning-vault'].includes(job.phase);
  const status = colorize(ui, terminalColorForStatus(job.status), humanStatusLabel(job));
  const headline = fitTerminalLine(ui, job.progressMessage || job.decisionSummary?.headline || 'Sincronizando...');
  const currentLabel = job.current?.title || job.current?.chatId || null;
  const countText = total > 0 ? `${Math.min(current, total)}/${total}` : indeterminateCountText(job, totals);
  const statusPrefix = TERMINAL_STATUSES.has(job.status) ? '' : `${colorize(ui, 'cyan', spinnerFrame(tick))} `;
  const progress = bar(ui, current, total, {
    width: Math.max(26, Math.min(54, width - 24)),
    indeterminate,
    seed: tick,
    filledChar: '#',
    emptyChar: '.',
  });
  const summaryParts = [
    `Salvas ${totals.downloaded}`,
    `Puladas ${totals.skipped}`,
    totals.failed ? colorize(ui, 'red', `Falhas ${totals.failed}`) : 'Falhas 0',
    totals.warnings ? colorize(ui, 'yellow', `Avisos ${totals.warnings}`) : null,
  ].filter(Boolean);
  const inventoryParts = [
    totals.webSeen != null ? `encontradas ${totals.webSeen}` : null,
    totals.missing != null ? `faltando ${totals.missing}` : null,
  ].filter(Boolean);
  const lines = [
    `${progress}  ${countText}`,
    `${statusPrefix}${status} - ${headline}`,
    currentLabel && !TERMINAL_STATUSES.has(job.status) ? `Agora: ${fitTerminalLine(ui, currentLabel, 7)}` : null,
    job.jobId && summaryParts.length ? summaryParts.join(' | ') : null,
    job.jobId && inventoryParts.length ? dim(ui, inventoryParts.join(' | ')) : null,
    job.reportFile && TERMINAL_STATUSES.has(job.status)
      ? dim(ui, `Relatorio: ${fitTerminalLine(ui, job.reportFile, 11)}`)
      : null,
  ].filter(Boolean);
  return panelLines(ui, `Gemini Markdown Export · ${stripAnsi(humanStatusLabel(job)).toLowerCase()}`, lines);
};

const renderLinesForJobTrace = (traceResult = {}) => {
  const summary = traceResult.summary || {};
  const trace = traceResult.trace || {};
  const lines = [
    `Trace do job ${traceResult.jobId || '-'}: ${summary.eventCount || 0} evento(s)`,
    `Status: ${traceResult.status || '-'}`,
    `Arquivo: ${trace.filePath || 'nao retido em disco'}`,
  ];
  const byType = summary.byType || {};
  const typeSummary = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([type, count]) => `${type}=${count}`)
    .join(', ');
  if (typeSummary) lines.push(`Tipos: ${typeSummary}`);
  const events = Array.isArray(traceResult.events) ? traceResult.events : [];
  for (const event of events.slice(-12)) {
    const data = event.data || {};
    const suffix = [
      data.phase ? `fase=${data.phase}` : null,
      data.state ? `status=${data.state}` : null,
      data.index ? `#${data.index}` : null,
      data.chatId ? `chat=${data.chatId}` : null,
      data.code ? `code=${data.code}` : null,
      data.layer ? `camada=${data.layer}` : null,
      data.error ? `erro=${data.error}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`- ${event.ts || '-'} ${event.type || 'event'}${suffix ? ` ${suffix}` : ''}`);
  }
  return lines;
};

const renderLinesForJobList = (result = {}) => {
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  if (jobs.length === 0) {
    return [
      result.activeOnly
        ? 'Nenhum job ativo encontrado.'
        : 'Nenhum job recente encontrado.',
    ];
  }
  const lines = [
    `${jobs.length} job(s) ${result.activeOnly ? 'ativo(s)' : 'recente(s)'}; ativos agora: ${result.activeCount ?? '-'}.`,
  ];
  for (const job of jobs) {
    lines.push(`- ${job.jobId || '-'} ${job.status || '-'}${job.phase ? `/${job.phase}` : ''} ${job.type || ''}`.trim());
    lines.push(`  status: gemini-md-export job status ${job.jobId} --tui --result-json`);
    if (!TERMINAL_STATUSES.has(job.status)) {
      lines.push(`  cancelar: gemini-md-export job cancel ${job.jobId} --tui --result-json`);
    }
    if (job.reportFile) lines.push(`  reportFile: ${job.reportFile}`);
    if (job.traceFile) lines.push(`  traceFile: ${job.traceFile}`);
  }
  return lines;
};

const renderTui = (ui, job, tick) => {
  const lines = renderLinesForJob(ui, job, tick);
  if (ui.firstRender) {
    ui.stdout.write(ANSI.hideCursor);
    ui.firstRender = false;
    ui.closed = false;
  } else {
    if (ui.closed) {
      ui.stdout.write(ANSI.hideCursor);
      ui.closed = false;
    }
    if (ui.lastLineCount > 0) {
      ui.stdout.write(`\x1b[${ui.lastLineCount}F${ANSI.clearBelow}`);
    }
  }
  ui.stdout.write(`${lines.join('\n')}\n`);
  ui.lastLineCount = renderedLineCount(ui, lines);
};

const resetTuiFrame = (ui) => {
  ui.lastLineCount = 0;
  ui.firstRender = true;
  ui.closed = false;
};

const closeTui = (ui, { resetFrame = false } = {}) => {
  if (ui.closed) return;
  ui.closed = true;
  if (ui.format === 'tui' && !ui.firstRender) {
    ui.stdout.write(ANSI.showCursor);
  }
  if (resetFrame) resetTuiFrame(ui);
};

const renderPlainProgress = (ui, job, previous = {}) => {
  const key = [
    job.status,
    job.jobId,
    job.phase,
    job.completed,
    job.requested,
    job.loadedCount,
    job.failureCount,
    job.progressMessage,
    job.current?.index,
    job.current?.chatId,
  ].join('|');
  if (previous.key === key) return previous;
  const total = Number(job.requested || job.missingCount || job.webConversationCount || 0);
  const current = displayProgressPosition(job, total);
  const count = total > 0 ? `${Math.min(current, total)}/${total}` : indeterminateCountText(job);
  ui.stdout.write(`[${new Date().toLocaleTimeString()}] ${job.status}/${job.phase}: ${count} - ${job.progressMessage || 'sincronizando'}\n`);
  return { key };
};

const STREAM_TUI_REPEAT_MS = 12_000;

const renderTuiStreamProgress = (ui, job, previous = {}, tick = 0) => {
  if (!ui.streamHeaderPrinted) {
    ui.stdout.write(`${bold(ui, 'Gemini Markdown Export')} ${dim(ui, 'sync')}\n`);
    ui.streamHeaderPrinted = true;
  }
  const total = Number(job.requested || job.missingCount || job.webConversationCount || 0);
  const current = displayProgressPosition(job, total);
  const indeterminate = !total || ['queued', 'loading-history', 'scanning-vault'].includes(job.phase);
  const count = total > 0 ? `${Math.min(current, total)}/${total}` : indeterminateCountText(job);
  const progress = bar(ui, current, total, {
    width: Math.max(18, Math.min(30, Math.floor((Number(ui.stdout.columns) || 88) / 3))),
    indeterminate,
    seed: tick,
  });
  const status = `${job.status || 'running'}${job.phase ? `/${job.phase}` : ''}`;
  const headline = job.progressMessage || job.decisionSummary?.headline || 'sincronizando';
  const currentLabel = job.current?.title || job.current?.chatId || null;
  const key = [
    job.status,
    job.jobId,
    job.phase,
    current,
    total,
    job.loadedCount,
    job.failureCount,
    headline,
    currentLabel,
  ].join('|');
  const now = Date.now();
  if (previous.key === key && now - (previous.lastWriteAt || 0) < STREAM_TUI_REPEAT_MS) return previous;
  const jobPart = job.jobId ? ` ${dim(ui, 'job')} ${job.jobId}` : '';
  const currentPart = currentLabel ? ` ${dim(ui, 'agora')} ${currentLabel}` : '';
  ui.stdout.write(`${progress} ${count} ${colorize(ui, terminalColorForStatus(job.status), status)}${jobPart} - ${headline}${currentPart}\n`);
  return { key, lastWriteAt: now };
};

const withWaitStatus = async (
  ui,
  {
    message,
    intervalMessage,
    intervalMs = DEFAULT_COUNT_STATUS_INTERVAL_MS,
    renderIntervalMs = DEFAULT_TUI_RENDER_INTERVAL_MS,
    statusProbe = null,
    tuiKind = null,
  },
  run,
) => {
  if (ui.format === 'json') return run();
  if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'status', message })}\n`);
    return run();
  }

  const startedAt = Date.now();
  let tick = 0;
  let previousStream = {};
  let latestProbe = {};
  let probeInFlight = null;
  let lastProbeAt = 0;
  const nextMessage = () =>
    typeof intervalMessage === 'function' ? intervalMessage(Date.now() - startedAt) : message;
  const refreshProbe = async () => {
    if (typeof statusProbe !== 'function') return latestProbe;
    if (probeInFlight) return latestProbe;
    const now = Date.now();
    if (lastProbeAt && now - lastProbeAt < Math.max(750, Math.min(3000, intervalMs))) {
      return latestProbe;
    }
    lastProbeAt = now;
    probeInFlight = Promise.resolve()
      .then(() => statusProbe({ elapsedMs: now - startedAt, previous: latestProbe }))
      .then((result) => {
        if (result && typeof result === 'object') latestProbe = { ...latestProbe, ...result };
        return latestProbe;
      })
      .catch(() => latestProbe)
      .finally(() => {
        probeInFlight = null;
      });
    return probeInFlight;
  };
  const waitJob = () => ({
    status: 'running',
    phase: 'loading-history',
    requested: 0,
    completed: 0,
    progressMessage: tick === 0 ? message : nextMessage(),
    elapsedMs: Date.now() - startedAt,
    tuiKind,
    waitNote: ui.waitNote || null,
    waitDetail: ui.waitDetail || null,
    blockingIssue: ui.waitIssue || null,
    ...latestProbe,
  });
  const renderWaitTui = () => {
    renderTui(ui, waitJob(), tick);
  };
  const renderWaitStreamTui = () => {
    previousStream = renderTuiStreamProgress(ui, waitJob(), previousStream, tick);
  };

  await refreshProbe();
  if (ui.format === 'tui') renderWaitTui();
  else if (ui.format === 'tui-stream') renderWaitStreamTui();
  else ui.stdout.write(`${message}\n`);

  const timerMs =
    ui.format === 'tui'
      ? Math.max(100, Number(renderIntervalMs) || DEFAULT_TUI_RENDER_INTERVAL_MS)
      : Math.max(1000, Number(intervalMs) || DEFAULT_COUNT_STATUS_INTERVAL_MS);
  const timer = setInterval(() => {
    tick += 1;
    void refreshProbe();
    if (ui.format === 'tui') renderWaitTui();
    else if (ui.format === 'tui-stream') renderWaitStreamTui();
    else ui.stdout.write(`${nextMessage()}\n`);
  }, timerMs);
  timer.unref?.();

  try {
    return await run();
  } finally {
    clearInterval(timer);
    if (ui.format === 'tui') closeTui(ui);
  }
};

const emitResult = (ui, job) => {
  const result = summarizeForResultJson(job);
  if (ui.format === 'json') {
    ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.format !== 'jsonl') {
    if (result.fullHistoryRequested && !result.fullHistoryVerified) {
      ui.stdout.write(
        `ATENCAO: o fim do historico nao foi confirmado; encontradas=${result.webConversationCount ?? '-'}.\n`,
      );
    }
    if (result.failures.length > 0) {
      ui.stdout.write('Falhas registradas:\n');
      for (const failure of result.failures.slice(0, 5)) {
        ui.stdout.write(
          `- ${failure.chatId || `#${failure.index ?? '?'}`}: ${failure.title || 'sem titulo'} - ${failure.error || 'erro sem detalhe'}\n`,
        );
      }
    }
    ui.stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
  }
  return result;
};

const exitCodeForJob = (job = {}) => {
  if (job.status === 'completed') return EXIT.OK;
  if (job.status === 'completed_with_errors') return EXIT.WARNINGS;
  if (job.status === 'cancelled') return EXIT.MANUAL_ACTION;
  return EXIT.JOB_FAILED;
};

const exitCodeForJobCommand = (subcommand, job = {}) => {
  if (subcommand === 'cancel') {
    if (job.status === 'cancel_requested') return EXIT.MANUAL_ACTION;
    return job.status === 'failed' ? EXIT.JOB_FAILED : EXIT.OK;
  }
  if (!TERMINAL_STATUSES.has(job.status)) return EXIT.OK;
  return exitCodeForJob(job);
};

const shouldWakeBrowserForReady = (ready = {}) => {
  if (ready.ready === true) return false;
  const issue = String(ready.blockingIssue || '');
  if (issue === 'no_connected_clients' || issue === 'no_selectable_gemini_tab') return true;
  const connected = Number(ready.connectedClientCount ?? ready.connectedClients?.length ?? 0);
  const selectable = Number(ready.selectableTabCount ?? 0);
  return connected <= 0 && selectable <= 0;
};

const buildCliLaunchId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const activeBrowserLaunchState = (state, now = Date.now()) =>
  ['launching', 'attempted', 'dry-run'].includes(String(state?.status || '')) &&
  Number(state?.expiresAt || 0) > now;

const shouldWriteInlineStatus = (ui) =>
  ui.format !== 'json' && ui.format !== 'jsonl' && ui.format !== 'tui' && ui.format !== 'tui-stream';

const setWaitNote = (ui, note, { detail = null, issue = null } = {}) => {
  if (!ui) return;
  ui.waitNote = note || null;
  ui.waitDetail = detail || null;
  ui.waitIssue = issue || null;
};

const wakeBrowserFromCli = async (flags, ui, ready) => {
  if (flags.wakeBrowser === false || !shouldWakeBrowserForReady(ready)) {
    return null;
  }

  const now = Date.now();
  const previousState = readBrowserLaunchState();
  if (activeBrowserLaunchState(previousState, now)) {
    setWaitNote(ui, 'Outra chamada ja esta abrindo Gemini Web', {
      issue: ready.blockingIssue || null,
    });
    if (shouldWriteInlineStatus(ui)) {
      ui.stdout.write('Outra chamada ja esta abrindo Gemini Web; aguardando a extensao...\n');
    }
    return {
      attempted: false,
      reused: true,
      reason: 'launch-in-progress',
      previousLaunch: previousState,
    };
  }

  const profileDirectory =
    process.env.GEMINI_MCP_CHROME_PROFILE_DIRECTORY || process.env.GME_CHROME_PROFILE_DIRECTORY || null;
  const launchId = buildCliLaunchId();
  const state = {
    source: 'cli',
    launchId,
    status: 'launching',
    lastAttemptAt: now,
    startedAt: new Date(now).toISOString(),
    expiresAt: now + Number(flags.readyWaitMs || 0) + DEFAULT_BROWSER_LAUNCH_LOCK_GRACE_MS,
    bridgeUrl: normalizeBridgeUrl(flags.bridgeUrl),
    blockingIssue: ready.blockingIssue || null,
  };

  const writeLaunchState = (patch) => {
    try {
      writeBrowserLaunchState({ ...state, ...patch, updatedAt: new Date().toISOString() });
    } catch {
      // Launch state is only coordination/diagnostics; never fail the CLI over it.
    }
  };

  setWaitNote(ui, 'Abrindo Gemini Web em background', {
    issue: ready.blockingIssue || null,
  });
  if (shouldWriteInlineStatus(ui)) {
    ui.stdout.write('Abrindo Gemini Web em background...\n');
  }

  if (enabledEnvFlag(process.env.GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN)) {
    const launch = {
      attempted: true,
      supported: true,
      dryRun: true,
      browserName: process.env.GEMINI_MCP_BROWSER || process.env.GME_BROWSER || 'Chrome',
      reason: 'dry-run',
    };
    writeLaunchState({ status: 'dry-run', launch });
    return launch;
  }

  writeLaunchState({});
  const launch = await launchGeminiBrowser({
    profileDirectory,
    launchObserveMs: nonNegativeIntEnv(process.env.GEMINI_MCP_BROWSER_LAUNCH_OBSERVE_MS, 180, 2000),
  });
  writeLaunchState({
    status: launch.attempted ? 'attempted' : 'skipped',
    launch,
    lastFailureAt: launch.error || launch.reason ? Date.now() : null,
  });
  return launch;
};

const readyWithCliWake = async (bridgeUrl, flags, ui) => {
  let ready = await requestReadyStatus(bridgeUrl, flags, { waitMs: 0 });
  setWaitNote(ui, ready.ready === true ? 'Gemini Web pronto' : 'Verificando Gemini Web', {
    issue: ready.blockingIssue || null,
  });
  let cliBrowserWake = null;
  if (ready.ready !== true) {
    if (shouldWakeBrowserForReady(ready)) {
      const existingTabGraceMs = Math.min(
        Math.max(0, Number(flags.readyWaitMs || 0)),
        nonNegativeIntEnv(
          process.env.GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS,
          DEFAULT_EXISTING_TAB_RECONNECT_GRACE_MS,
          30_000,
        ),
      );
      if (existingTabGraceMs > 0) {
        setWaitNote(ui, 'Aguardando aba Gemini existente reconectar', {
          detail: `limite ${formatDuration(existingTabGraceMs)}`,
          issue: ready.blockingIssue || null,
        });
        if (shouldWriteInlineStatus(ui)) {
          ui.stdout.write(
            `Aguardando aba Gemini existente reconectar (${formatDuration(existingTabGraceMs)})...\n`,
          );
        }
        const reconnected = await requestReadyStatus(bridgeUrl, flags, {
          waitMs: existingTabGraceMs,
        });
        if (reconnected.ready === true || !shouldWakeBrowserForReady(reconnected)) {
          ready = reconnected;
          setWaitNote(ui, ready.ready === true ? 'Gemini Web pronto' : 'Verificando Gemini Web', {
            issue: ready.blockingIssue || null,
          });
        }
      }
    }
    if (ready.ready !== true) {
      cliBrowserWake = await wakeBrowserFromCli(flags, ui, ready);
      if (flags.readyWaitMs > 0) {
        setWaitNote(ui, 'Aguardando a extensao conectar', {
          detail: `limite ${formatDuration(flags.readyWaitMs)}`,
          issue: ready.blockingIssue || null,
        });
        if (shouldWriteInlineStatus(ui)) {
          ui.stdout.write(`Aguardando a extensao conectar (${formatDuration(flags.readyWaitMs)})...\n`);
        }
        ready = await requestReadyStatus(bridgeUrl, flags, { waitMs: flags.readyWaitMs });
        setWaitNote(ui, ready.ready === true ? 'Gemini Web pronto' : 'Extensao ainda nao conectou', {
          issue: ready.blockingIssue || null,
        });
      }
    }
  }
  return {
    ...ready,
    cliBrowserWake,
  };
};

const ensureReady = async (bridgeUrl, flags, ui) => {
  const ready = await withWaitStatus(
    ui,
    {
      message: 'Verificando Gemini Web e extensao do navegador.',
      intervalMs: nonNegativeIntEnv(
        process.env.GEMINI_MD_EXPORT_READY_STATUS_INTERVAL_MS,
        DEFAULT_READY_STATUS_INTERVAL_MS,
        60_000,
      ),
      renderIntervalMs: DEFAULT_TUI_RENDER_INTERVAL_MS,
      tuiKind: 'ready',
      intervalMessage: (elapsedMs) =>
        `Ainda verificando Gemini Web... ${formatDuration(elapsedMs)} decorridos; sem fallback MCP.`,
    },
    () => readyWithCliWake(bridgeUrl, flags, ui),
  );
  if (ready.ready === true) return ready;
  if (ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stderr.write(
      [
        'Gemini Web ainda nao esta pronto.',
        `Motivo: ${ready.blockingIssue || 'desconhecido'}.`,
        ready.extensionReadiness?.nextAction?.message ||
          ready.cliBrowserWake?.reason ||
          ready.cliBrowserWake?.error ||
          '',
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );
  }
  const err = new Error(ready.blockingIssue || 'Gemini Web nao esta pronto.');
  err.code = 'extension_unready';
  err.reported = true;
  err.data = ready;
  throw err;
};

const startSyncJob = async (bridgeUrl, flags) =>
  requestJson(
    bridgeUrl,
    appendParams('/agent/sync-vault', {
      vaultDir: flags.vaultDir,
      outputDir: flags.outputDir || flags.vaultDir,
      resumeReportFile: flags.resumeReportFile,
      syncStateFile: flags.syncStateFile,
      knownBoundaryCount: flags.knownBoundaryCount,
      ...loadMoreParamsFromFlags(flags),
      clientId: flags.clientId,
      tabId: flags.tabId,
      claimId: flags.claimId,
      autoReleaseClaim: flags.autoReleaseClaim,
    }),
    { timeoutMs: 20000 },
  );

const startExportJob = async (bridgeUrl, kind, flags) => {
  const params = {
    outputDir: flags.outputDir,
    resumeReportFile: flags.resumeReportFile,
    maxChats: flags.maxChats,
    limit: flags.maxChats,
    batchSize: flags.batchSize,
    ...loadMoreParamsFromFlags(flags),
    ...hydrationParamsFromFlags(flags),
    refresh: flags.refresh,
    startIndex: flags.startIndex,
    delayMs: flags.delayMs,
    clientId: flags.clientId,
    tabId: flags.tabId,
    claimId: flags.claimId,
    sessionId: flags.sessionId,
    autoReleaseClaim: flags.autoReleaseClaim,
  };
  if (kind === 'recent') {
    return requestJson(bridgeUrl, appendParams('/agent/export-recent-chats', params), { timeoutMs: 20000 });
  }
  if (kind === 'missing') {
    return requestJson(
      bridgeUrl,
      appendParams('/agent/export-missing-chats', {
        ...params,
        vaultDir: flags.vaultDir,
        existingScanDir: flags.vaultDir,
        outputDir: flags.outputDir || flags.vaultDir,
      }),
      { timeoutMs: 20000 },
    );
  }
  if (kind === 'resume') {
    return requestJson(
      bridgeUrl,
      appendParams('/agent/export-recent-chats', {
        ...params,
        resumeReportFile: flags.resumeReportFile,
      }),
      { timeoutMs: 20000 },
    );
  }
  if (kind === 'selected' || kind === 'reexport') {
    return requestJson(
      bridgeUrl,
      '/agent/reexport-chats',
      {
        method: 'POST',
        timeoutMs: 20000,
        operation: 'reexport-chats',
        body: {
          ...params,
          chatIds: flags.chatIds,
          items: flags.selectionItems,
          expectedCount: flags.expectedCount,
          selectionFile: flags.selectionSourceFile,
          selectionManifestKind: flags.selectionManifestKind,
        },
      },
    );
  }
  if (kind === 'notebook') {
    return requestJson(bridgeUrl, appendParams('/agent/export-notebook', params), { timeoutMs: 20000 });
  }
  throw usageError(`Subcomando export desconhecido: ${kind}.`);
};

const fetchJobStatus = async (bridgeUrl, jobId) =>
  requestJson(bridgeUrl, appendParams('/agent/export-job-status', { jobId }), {
    timeoutMs: 20000,
    operation: 'job-status',
  });

const fetchJobList = async (bridgeUrl, flags = {}) =>
  requestJson(
    bridgeUrl,
    appendParams('/agent/export-jobs', {
      active: flags.active === true ? true : undefined,
      limit: flags.limit,
    }),
    {
      timeoutMs: 20000,
      operation: 'job-list',
    },
  );

const cancelJob = async (bridgeUrl, jobId) =>
  requestJson(bridgeUrl, appendParams('/agent/export-job-cancel', { jobId }), {
    timeoutMs: 20000,
    operation: 'job-cancel',
  });

const fetchJobTrace = async (bridgeUrl, jobId) =>
  requestJson(bridgeUrl, appendParams('/agent/export-job-trace', { jobId }), {
    timeoutMs: 20000,
    operation: 'job-trace',
  });

const jobCleanupTimeoutMs = () =>
  nonNegativeIntEnv(
    process.env.GEMINI_MD_EXPORT_JOB_TIMEOUT_CLEANUP_MS,
    DEFAULT_JOB_TIMEOUT_CLEANUP_MS,
    180_000,
  );

const waitForJobTerminalQuietly = async (bridgeUrl, jobId, flags = {}) => {
  const startedAt = Date.now();
  const pollMs = Math.max(250, Math.min(2000, Number(flags.pollMs || DEFAULT_POLL_MS)));
  const timeoutMs = Math.max(1000, Number(flags.waitMs || jobCleanupTimeoutMs()));
  let lastJob = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      lastJob = await fetchJobStatus(bridgeUrl, jobId);
      if (TERMINAL_STATUSES.has(lastJob.status)) return lastJob;
    } catch (err) {
      return {
        ...(lastJob || { jobId }),
        cleanupStatusError: err?.message || String(err),
      };
    }
    await sleep(pollMs);
  }
  return {
    ...(lastJob || { jobId }),
    cleanupTimedOut: true,
    cleanupTimeoutMs: timeoutMs,
  };
};

const cancelJobForTimeoutQuietly = async (flags, job, ui = null) => {
  if (!job?.jobId || TERMINAL_STATUSES.has(job.status)) return job;
  if (ui?.format && ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write('Timeout do job; cancelando no navegador e liberando a aba antes de sair.\n');
  }
  try {
    const cancelled = await cancelJob(flags.bridgeUrl, job.jobId);
    const terminal = await waitForJobTerminalQuietly(flags.bridgeUrl, job.jobId, flags);
    return {
      ...(terminal || cancelled || job),
      timeoutCancel: {
        requested: true,
        status: cancelled?.status || null,
      },
    };
  } catch (err) {
    return {
      ...job,
      timeoutCancel: {
        requested: false,
        error: err?.message || String(err),
        code: err?.code || null,
      },
    };
  }
};

const cancelJobForSignalQuietly = async (flags, job, ui, signal) => {
  if (!job?.jobId || TERMINAL_STATUSES.has(job.status)) return job;
  if (ui?.format && ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write(`Interrupcao recebida (${signal}); cancelando job ${job.jobId} e liberando a aba.\n`);
    if (job.reportFile) ui.stdout.write(`reportFile: ${job.reportFile}\n`);
    if (job.traceFile || job.trace?.filePath) {
      ui.stdout.write(`traceFile: ${job.traceFile || job.trace?.filePath}\n`);
    }
  }
  try {
    const cancelled = await cancelJob(flags.bridgeUrl, job.jobId);
    const terminal = await waitForJobTerminalQuietly(flags.bridgeUrl, job.jobId, flags);
    return {
      ...(terminal || cancelled || job),
      signalCancel: {
        signal,
        requested: true,
        status: cancelled?.status || null,
      },
    };
  } catch (err) {
    return {
      ...job,
      signalCancel: {
        signal,
        requested: false,
        error: err?.message || String(err),
        code: err?.code || null,
      },
    };
  }
};

const installJobSignalCleanup = ({ flags, ui, getJob, reason }) => {
  if (!cliEntrypoint) return () => {};
  let handling = false;
  const listeners = new Map();
  const handler = async (signal) => {
    if (handling) return;
    handling = true;
    let job = null;
    try {
      job = getJob?.() || null;
      const cancelled = await cancelJobForSignalQuietly(flags, job, ui, signal);
      await releaseCliClaimQuietly(flags, `${reason}-${String(signal).toLowerCase()}`, cancelled || job);
      closeTui(ui);
    } catch (err) {
      if (ui?.format === 'json' || ui?.format === 'jsonl') ui.stderr.write(`${err.message}\n`);
      else ui?.stdout?.write(`Falha no cleanup da interrupcao: ${err.message}\n`);
    } finally {
      process.exit(EXIT.MANUAL_ACTION);
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const listener = () => {
      void handler(signal);
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
  };
};

const claimIdFromJob = (job = {}) => {
  const value = job || {};
  return value.tabClaimId || value.tabClaim?.claimId || value.serverClaim?.claimId || value.claim?.claimId || null;
};

const tabIdFromClaimLike = (value = {}) => {
  const source = value || {};
  return (
    source.tabId ??
    source.tabClaim?.tabId ??
    source.serverClaim?.tabId ??
    source.claim?.tabId ??
    null
  );
};

const shouldReleaseCliClaim = (flags = {}, job = null) =>
  flags.autoReleaseClaim !== false && !!(flags.claimId || claimIdFromJob(job));

const releaseCliClaimQuietly = async (flags = {}, reason, job = null) => {
  if (!shouldReleaseCliClaim(flags, job)) return null;
  const claimId = flags.claimId || claimIdFromJob(job);
  if (!claimId) return null;
  const tabId = flags.tabId ?? tabIdFromClaimLike(job);
  try {
    return await requestJson(
      flags.bridgeUrl,
      appendParams('/agent/release-tab', {
        claimId,
        tabId,
        reason,
      }),
      { timeoutMs: 45_000 },
    );
  } catch (err) {
    return {
      ok: false,
      claimId,
      tabId,
      error: err?.message || String(err),
    };
  }
};

const claimCliTabForCount = async (flags = {}, countTimeoutMs) => {
  if (flags.claimId || flags.autoReleaseClaim === false) return null;
  const ttlMs = Math.max(120_000, Math.min(30 * 60_000, countTimeoutMs + 60_000));
  return requestJson(
    flags.bridgeUrl,
    appendParams('/agent/tabs', {
      action: 'claim',
      clientId: flags.clientId,
      tabId: flags.tabId,
      sessionId: flags.sessionId,
      index: flags.index,
      preferRecent: true,
      label: 'GME Count',
      color: 'purple',
      ttlMs,
      openIfMissing: false,
      allowReload: flags.allowReload,
    }),
    { timeoutMs: 20_000 },
  );
};

const writeStructuredResult = (ui, result, { label = null, includeResultJson = true } = {}) => {
  if (ui.format === 'json') {
    ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`);
  } else {
    if (label) ui.stdout.write(`${label}\n`);
    if (includeResultJson) ui.stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
  }
};

const announceJobStarted = (ui, job = {}) => {
  if (!job?.jobId) return;
  if (ui.format === 'json') return;
  if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'job_started', jobId: job.jobId, job })}\n`);
    return;
  }
  if (ui.format === 'tui' || ui.format === 'tui-stream') return;
  ui.stdout.write(`Job iniciado: ${job.jobId}\n`);
  ui.stdout.write(`status: gemini-md-export job status ${job.jobId} --tui --result-json\n`);
  ui.stdout.write(`cancelar: gemini-md-export job cancel ${job.jobId} --tui --result-json\n`);
  if (job.reportFile) ui.stdout.write(`reportFile: ${job.reportFile}\n`);
  if (job.traceFile || job.trace?.filePath) {
    ui.stdout.write(`traceFile: ${job.traceFile || job.trace?.filePath}\n`);
  }
};

const followJob = async (bridgeUrl, initialJob, flags, ui) => {
  let job = initialJob;
  let tick = 0;
  let previousPlain = {};
  let previousStream = {};
  const startedAt = Date.now();
  while (true) {
    if (ui.format === 'tui') {
      renderTui(ui, job, tick);
    } else if (ui.format === 'tui-stream') {
      previousStream = renderTuiStreamProgress(ui, job, previousStream, tick);
    } else if (ui.format === 'plain') {
      previousPlain = renderPlainProgress(ui, job, previousPlain);
    } else if (ui.format === 'jsonl') {
      ui.stdout.write(`${JSON.stringify({ type: 'job_status', job: summarizeForResultJson(job), raw: job })}\n`);
    }

    if (TERMINAL_STATUSES.has(job.status)) return job;
    if (Date.now() - startedAt > flags.timeoutMs) {
      const err = createLayeredTimeoutError({
        code: 'job_timeout',
        message: `Timeout aguardando job ${job.jobId} (camada: job; limite: ${flags.timeoutMs}ms).`,
        layer: 'job',
        operation: 'follow-job',
        timeoutMs: flags.timeoutMs,
        elapsedMs: Date.now() - startedAt,
        jobId: job.jobId,
        traceFile: job.traceFile || job.trace?.filePath || null,
      });
      err.data = {
        ...job,
        timeout: err.data?.timeout || null,
      };
      throw err;
    }
    await sleep(flags.pollMs);
    tick += 1;
    job = await fetchJobStatus(bridgeUrl, job.jobId);
  }
};

const isJobTimeoutError = (err) => err?.code === 'job_timeout';

const attachJobContextToErrorMessage = (err, job = {}) => {
  if (!err || !job) return;
  const extras = [
    job.jobId ? `jobId: ${job.jobId}` : null,
    job.reportFile ? `reportFile: ${job.reportFile}` : null,
    job.traceFile || job.trace?.filePath ? `traceFile: ${job.traceFile || job.trace?.filePath}` : null,
  ].filter(Boolean);
  if (extras.length === 0) return;
  const extraText = extras.join('\n');
  if (!String(err.message || '').includes(extraText)) {
    err.message = `${err.message}\n${extraText}`;
  }
};

const runSync = async (parsed, streams = {}) => {
  const flags = { ...parsed.flags };
  if (!flags.vaultDir && parsed.positionals[0]) flags.vaultDir = parsed.positionals[0];
  if (!flags.vaultDir && !flags.resumeReportFile) {
    throw usageError('Informe vaultDir ou --resume-report-file.');
  }
  const ui = makeUi(flags, streams);
  warnTuiFallback(ui);
  let initialJob = null;
  let finalJob = null;
  let uninstallSignalCleanup = () => {};
  try {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(flags.bridgeUrl)}...\n`);
    }
    await ensureBridgeAvailable(flags, ui);
    await ensureReady(flags.bridgeUrl, flags, ui);
    initialJob = await startSyncJob(flags.bridgeUrl, flags);
    uninstallSignalCleanup = installJobSignalCleanup({
      flags,
      ui,
      getJob: () => finalJob || initialJob,
      reason: 'cli-sync-interrupted',
    });
    announceJobStarted(ui, initialJob);
    finalJob = await followJob(flags.bridgeUrl, initialJob, flags, ui);
    const result = emitResult(ui, finalJob);
    return { exitCode: exitCodeForJob(finalJob), result };
  } catch (err) {
    if (isJobTimeoutError(err)) {
      finalJob = await cancelJobForTimeoutQuietly(flags, err.data || finalJob || initialJob, ui);
      err.data = finalJob;
      attachJobContextToErrorMessage(err, finalJob);
    }
    throw err;
  } finally {
    uninstallSignalCleanup();
    await releaseCliClaimQuietly(flags, 'cli-sync-finished', finalJob || initialJob);
    closeTui(ui);
  }
};

const runDoctor = async (parsed, streams = {}) => {
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  const local = buildLocalDoctorReport({
    browser: parsed.flags.browser,
    profileDirectory: parsed.flags.profileDirectory,
    extensionId: parsed.flags.extensionId,
    packageRoot: packageRoot(),
    version: VERSION,
  });
  let bridge = null;
  let ready = null;
  let bridgeError = null;
  try {
    bridge = await ensureBridgeAvailable(parsed.flags, ui);
    ready = await requestReadyStatus(
      parsed.flags.bridgeUrl,
      {
        ...parsed.flags,
        wakeBrowser: false,
        selfHeal: false,
        allowReload: false,
      },
      { waitMs: 0 },
    );
  } catch (err) {
    bridgeError = err;
  }
  const result = {
    ok: local.ok && ready?.ready === true,
    localOk: local.ok,
    ready: ready?.ready === true,
    browser: local.browser,
    profileDirectory: local.profileDirectory,
    sourceVersion: local.sourceVersion,
    loadedExtension: local.loadedExtension?.extension || null,
    playwrightExtension: local.playwrightExtension?.extension || null,
    nativeHost: local.nativeHost,
    bridge: bridge
      ? {
          ok: true,
          bridgeRole: bridge.bridgeRole || null,
          pid: bridge.pid || null,
          version: bridge.version || null,
          protocolVersion: bridge.protocolVersion || null,
        }
      : {
          ok: false,
          error: bridgeError?.message || null,
        },
    blockingIssue: ready?.blockingIssue || null,
    mode: ready?.mode || null,
    connectedClientCount: ready?.connectedClientCount || 0,
    selectableTabCount: ready?.selectableTabCount || 0,
    commandReadyClientCount: ready?.commandReadyClientCount || 0,
    warnings: local.warnings,
    nextAction:
      ready?.ready === true && local.ok
        ? 'Bridge, extensao, native host e aba Gemini parecem prontos.'
        : local.nextAction ||
          ready?.extensionReadiness?.nextAction?.message ||
          bridgeError?.message ||
          'Verifique a extensao do navegador.',
  };
  if (ui.format === 'json') {
    ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`);
  } else {
    const extension = result.loadedExtension;
    ui.stdout.write(`${result.ok ? 'OK' : 'NAO PRONTO'}: ${result.nextAction}\n`);
    ui.stdout.write(`Browser: ${result.browser} perfil=${result.profileDirectory}\n`);
    ui.stdout.write(
      `Extensao: ${
        extension
          ? `${extension.version || '?'} ${extension.locationKind || 'desconhecida'} id=${extension.id}`
          : 'nao encontrada no perfil'
      }\n`,
    );
    ui.stdout.write(
      `Playwright Extension: ${
        result.playwrightExtension
          ? `${result.playwrightExtension.version || '?'} id=${result.playwrightExtension.id}`
          : 'nao encontrada no perfil'
      }\n`,
    );
    ui.stdout.write(
      `Native host: ${result.nativeHost.status} em ${result.nativeHost.manifestPath}\n`,
    );
    ui.stdout.write(
      `Bridge: ${result.bridge.ok ? 'ok' : `falhou - ${result.bridge.error || 'sem resposta'}`}\n`,
    );
    ui.stdout.write(
      `Gemini Web: ${result.ready ? 'pronto' : `nao pronto${result.blockingIssue ? ` - ${result.blockingIssue}` : ''}`}\n`,
    );
    if (parsed.flags.resultJson === true) ui.stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
  }
  const exitCode = result.ok
    ? EXIT.OK
    : !result.bridge.ok
      ? EXIT.BRIDGE_UNAVAILABLE
      : result.ready && result.warnings.length > 0
        ? EXIT.WARNINGS
        : EXIT.EXTENSION_UNREADY;
  return { exitCode, result };
};

const runBrowser = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  if (subcommand !== 'status') throw usageError('Uso: gemini-md-export browser status.');
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const ready = await readyWithCliWake(parsed.flags.bridgeUrl, parsed.flags, ui);
  let clients = null;
  try {
    clients = await requestJson(parsed.flags.bridgeUrl, '/agent/clients?diagnostics=1', { timeoutMs: 5000 });
  } catch {
    clients = null;
  }
  const result = {
    ok: ready.ready === true,
    ready: ready.ready === true,
    blockingIssue: ready.blockingIssue || null,
    mode: ready.mode || null,
    connectedClientCount: ready.connectedClientCount ?? clients?.connectedClients?.length ?? 0,
    selectableTabCount: ready.selectableTabCount ?? 0,
    commandReadyClientCount: ready.commandReadyClientCount ?? 0,
    bridgeRole: clients?.mcp?.bridgeRole || null,
    connectedClients: clients?.connectedClients || [],
    nextAction:
      ready.ready === true
        ? 'Bridge, extensao e aba Gemini parecem prontos.'
        : ready.extensionReadiness?.nextAction?.message ||
          ready.cliBrowserWake?.reason ||
          ready.cliBrowserWake?.error ||
          'Verifique a extensao Chrome.',
  };
  writeStructuredResult(ui, result, {
    label: `${result.ok ? 'OK' : 'NAO PRONTO'}: ${result.nextAction}`,
  });
  return { exitCode: result.ok ? EXIT.OK : EXIT.EXTENSION_UNREADY, result };
};

const artifactStatusText = (item = {}) => {
  if (item.htmlExtractable) {
    return `HTML extraível (${item.extractionMethod || 'metodo desconhecido'})`;
  }
  if (item.recommendedProbe === 'chrome_scripting_frame') {
    return item.frameProbe?.ok === false
      ? 'frame remoto detectado; probe falhou'
      : 'frame remoto detectado; HTML ainda não confirmado';
  }
  if (item.recommendedProbe === 'live_blob_fetch') return 'blob vivo; precisa tentativa dedicada';
  return 'fallback';
};

const diagnosePlainLabel = (result = {}) => {
  const lines = ['Diagnóstico da página Gemini'];
  if (result.page?.chatId) lines.push(`Chat: ${result.page.chatId}`);
  if (result.page?.title) lines.push(`Título: ${result.page.title}`);
  if (result.page?.url) lines.push(`URL: ${result.page.url}`);
  const summary = result.summary || {};
  lines.push(`Artefatos detectados: ${summary.total ?? result.items?.length ?? 0}`);
  if (summary.launcherCount) {
    lines.push(
      `Botões candidatos: ${summary.launcherCount}` +
        (summary.clickedLauncherCount ? `; abertos: ${summary.clickedLauncherCount}` : ''),
    );
  }
  lines.push(`HTML extraível: ${summary.htmlExtractable ?? 0}`);
  if (result.frameProbe) {
    lines.push(
      `Probe de frames: ${result.frameProbe.ok ? 'ok' : 'falhou'}${
        result.frameProbe.reason ? ` (${result.frameProbe.reason})` : ''
      }`,
    );
  }
  if (result.artifactHtmlSave) {
    const saved = result.artifactHtmlSave;
    lines.push(
      `Captura HTML: ${saved.ok === false ? 'falhou' : 'ok'}; payloads: ${saved.captureCount ?? 0}`,
    );
    if (saved.ok === false) {
      lines.push(`Erro ao salvar HTML: ${saved.error || 'falha desconhecida'}`);
    } else {
      lines.push(`HTML salvo: ${saved.savedCount ?? 0} arquivo(s) em ${saved.outputDir || ''}`);
      if (saved.manifestFile) lines.push(`Manifesto: ${saved.manifestFile}`);
    }
  }
  const items = Array.isArray(result.items) ? result.items : [];
  for (const item of items.slice(0, 8)) {
    lines.push('');
    lines.push(`${item.id || 'artifact'} — ${item.kind || 'iframe'}`);
    if (item.turnIndex) lines.push(`  Turno: ${item.role || 'desconhecido'} #${item.turnIndex}`);
    lines.push(`  Origem: ${item.srcKind || 'desconhecida'}${item.host ? ` (${item.host})` : ''}`);
    if (item.pathname) lines.push(`  Caminho: ${item.pathname}`);
    lines.push(`  Estado: ${artifactStatusText(item)}`);
    lines.push(`  Recomendação: ${item.recommendedExport || 'fallback_warning'}`);
  }
  if (items.length > 8) lines.push(`\n... ${items.length - 8} artefato(s) omitido(s) no resumo.`);
  const launchers = Array.isArray(result.launchers) ? result.launchers : [];
  if (items.length === 0 && launchers.length > 0) {
    lines.push('');
    lines.push('Botões candidatos encontrados:');
    for (const launcher of launchers.slice(0, 5)) {
      lines.push(
        `  ${launcher.id || 'launcher'} — ${launcher.text || launcher.ariaLabel || launcher.dataTestId || 'sem texto'}`,
      );
    }
  }
  if (result.launcherOpen?.close) {
    lines.push(
      `Superfície aberta: ${result.launcherOpen.close.ok ? 'fechada após o diagnóstico' : 'não consegui fechar automaticamente'}`,
    );
  }
  if (result.tabClaimRelease) {
    lines.push(
      `Claim da aba: ${result.tabClaimRelease.ok === false ? 'não consegui liberar automaticamente' : 'liberada'}`,
    );
  }
  if (result.nextAction?.message) {
    lines.push('');
    lines.push(`Próximo passo: ${result.nextAction.message}`);
  }
  return lines.join('\n');
};

const runDiagnose = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  if (subcommand !== 'page') {
    throw usageError('Uso: gemini-md-export diagnose page <url> [opcoes].');
  }
  const targetUrl = parsed.flags.url || parsed.positionals[1];
  if (!targetUrl) throw usageError('Informe a URL da conversa Gemini.');
  const chatIdMatch = String(targetUrl).match(/\/app\/([a-f0-9]{12,})/i);
  if (!/^https:\/\/gemini\.google\.com\/app\//i.test(String(targetUrl)) || !chatIdMatch) {
    throw usageError('A URL precisa ser https://gemini.google.com/app/<chatId>.');
  }

  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  if (ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(parsed.flags.bridgeUrl)}...\n`);
  }
  await ensureBridgeAvailable(parsed.flags, ui);
  if (ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write('Bridge conectada. Verificando Gemini Web...\n');
  }
  await ensureReady(parsed.flags.bridgeUrl, parsed.flags, ui);
  let result = null;
  const diagnoseWaitMs = parsed.flags.waitMs || (parsed.flags.saveHtml === true ? 90_000 : undefined);
  try {
    result = await requestJson(
      parsed.flags.bridgeUrl,
      appendParams('/agent/diagnose-page', {
        url: targetUrl,
        clientId: parsed.flags.clientId,
        tabId: parsed.flags.tabId,
        claimId: parsed.flags.claimId,
        includeFrameProbe: parsed.flags.includeFrameProbe,
        includeHtmlSample: parsed.flags.includeHtmlSample,
        includeHtml: parsed.flags.includeHtml,
        openArtifactLaunchers: parsed.flags.openArtifactLaunchers,
        closeOpenedLaunchers: parsed.flags.closeOpenedLaunchers,
        saveHtml: parsed.flags.saveHtml,
        outputDir: parsed.flags.outputDir,
        maxOpenArtifactLaunchers: parsed.flags.maxOpenArtifactLaunchers,
        artifactOpenWaitMs: parsed.flags.artifactOpenWaitMs,
        releaseClaimOnOperationEnd: parsed.flags.autoReleaseClaim !== false,
        autoReleaseClaim: parsed.flags.autoReleaseClaim,
        waitMs: diagnoseWaitMs,
      }),
      { timeoutMs: Math.max(45_000, Number(diagnoseWaitMs || 0) + 20_000) },
    );
    writeStructuredResult(ui, result, {
      label: diagnosePlainLabel(result),
      includeResultJson: parsed.flags.resultJson === true,
    });
    return { exitCode: result.ok ? EXIT.OK : EXIT.EXTENSION_UNREADY, result };
  } finally {
    if (!result?.tabClaimRelease && parsed.flags.claimId && parsed.flags.autoReleaseClaim !== false) {
      await releaseCliClaimQuietly(parsed.flags, 'cli-diagnose-finished', result);
    }
  }
};

const compactTabForCli = (client = {}, index = null) => ({
  index: client.index ?? index,
  clientId: client.clientId || null,
  tabId: client.tabId ?? null,
  windowId: client.windowId ?? null,
  isActiveTab: client.isActiveTab === true,
  url: client.page?.url || client.url || null,
  title: client.page?.title || client.title || null,
  chatId: client.page?.chatId || client.chatId || null,
  routeKind: client.page?.kind || client.routeKind || null,
  listedConversationCount:
    client.listedConversationCount ??
    client.page?.listedConversationCount ??
    client.sidebarConversationCount ??
    null,
});

const summarizeTabsCliResult = (action, result = {}) => {
  const tabs = Array.isArray(result.tabs)
    ? result.tabs
    : Array.isArray(result.connectedClients)
      ? result.connectedClients
      : [];
  return {
    ok: result.ok !== false,
    action,
    connectedTabCount: result.connectedTabCount ?? tabs.length,
    connectedClientCount: result.connectedClientCount ?? tabs.length,
    tabs: tabs.map((tab, index) => compactTabForCli(tab, index + 1)),
    claim: result.claim || result.claimed || null,
    released: result.released || null,
    reloaded: result.reloaded ?? null,
    browserWake: result.browserWake || null,
    error: result.error || null,
    nextAction:
      action === 'list' && tabs.length > 1
        ? 'Rode gemini-md-export tabs claim --index <n> --tui --result-json e reutilize o claimId no sync/export.'
        : action === 'list' && tabs.length === 1
          ? 'Rode gemini-md-export tabs claim --index 1 --tui --result-json ou passe --client-id diretamente.'
          : null,
  };
};

const tabsPlainLabel = (action, summary = {}) => {
  if (action === 'list') {
    const lines = [`${summary.connectedTabCount} aba(s) Gemini conectada(s).`];
    for (const tab of summary.tabs || []) {
      const title = tab.title ? ` - ${tab.title}` : '';
      const chatInfo = tab.chatId ? ` chatId=${tab.chatId}` : '';
      const countInfo =
        tab.listedConversationCount !== null && tab.listedConversationCount !== undefined
          ? ` conversas_visiveis=${tab.listedConversationCount}`
          : '';
      lines.push(
        `${tab.index}. tabId=${tab.tabId ?? '-'} clientId=${tab.clientId || '-'}${chatInfo}${countInfo}${title}`,
      );
    }
    if (summary.nextAction) lines.push(summary.nextAction);
    return lines.join('\n');
  }

  if (action === 'claim' && summary.claim) {
    return [
      'tabs claim: ok',
      `claimId=${summary.claim.claimId || '-'}`,
      `tabId=${summary.claim.tabId ?? '-'}`,
      `label=${summary.claim.label || '-'}`,
    ].join('\n');
  }

  return summary.ok ? `tabs ${action}: ok` : `tabs ${action}: falhou`;
};

const runTabs = async (parsed, streams = {}) => {
  const action = parsed.positionals[0] || 'list';
  if (!['list', 'claim', 'release', 'reload'].includes(action)) {
    throw usageError('Uso: gemini-md-export tabs list|claim|release|reload.');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const result = await requestJson(
    parsed.flags.bridgeUrl,
    appendParams('/agent/tabs', {
      action,
      clientId: parsed.flags.clientId,
      tabId: parsed.flags.tabId,
      claimId: parsed.flags.claimId,
      sessionId: parsed.flags.sessionId,
      index: parsed.flags.index,
      label: parsed.flags.label,
      color: parsed.flags.colorName,
      ttlMs: parsed.flags.ttlMs,
      force: parsed.flags.force,
      openIfMissing: parsed.flags.openIfMissing,
      waitMs: parsed.flags.waitMs,
      allowReload: parsed.flags.allowReload,
      delayMs: parsed.flags.delayMs,
    }),
    { timeoutMs: action === 'reload' ? 30000 : 20000 },
  );
  const summary = summarizeTabsCliResult(action, result);
  const label = tabsPlainLabel(action, summary);
  writeStructuredResult(ui, summary, {
    label,
    includeResultJson: parsed.flags.resultJson === true,
  });
  return { exitCode: summary.ok ? EXIT.OK : EXIT.EXTENSION_UNREADY, result: summary };
};

const summarizeChatsCountResult = (result = {}) => ({
  ok: result.ok !== false,
  status: result.countStatus || (result.totalKnown ? 'complete' : 'partial'),
  totalKnown: result.totalKnown === true,
  totalCount: result.totalCount ?? null,
  countSource: result.countSource || result.pagination?.countSource || null,
  countConfidence: result.countConfidence || result.pagination?.countConfidence || null,
  knownLoadedCount: result.knownLoadedCount ?? result.pagination?.loadedCount ?? null,
  minimumKnownCount: result.minimumKnownCount ?? result.pagination?.loadedCount ?? null,
  countIsTotal: result.countIsTotal === true,
  reachedEnd: result.pagination?.reachedEnd === true,
  canLoadMore: result.pagination?.canLoadMore === true,
  loadMoreRoundsCompleted: result.loadMoreRoundsCompleted ?? null,
  loadMoreTimedOut: result.loadMoreTimedOut === true,
  loadMoreError: result.loadMoreError || null,
  refreshError: result.refreshError || null,
  warning: result.countWarning || null,
  answer: result.answer || null,
  nextAction: result.nextAction || null,
});

const countRetryReason = (summary = {}) => {
  if (summary.totalKnown) return null;
  if (summary.canLoadMore === false) return null;
  const text = [summary.loadMoreError, summary.refreshError].filter(Boolean).join(' ');
  if (!text) return null;
  if (/tab_operation_in_progress|aba do Gemini.*ocupada|outro comando pesado|tab operation/i.test(text)) {
    return 'aba ocupada';
  }
  if (/Timeout ap[oó]s \d+ms|timeout/i.test(text) && summary.reachedEnd !== true) {
    return 'timeout transitório';
  }
  return null;
};

const chooseClientForCountProbe = (clients = [], selector = {}) => {
  const live = clients.filter(Boolean);
  if (selector.clientId) {
    const matched = live.find((client) => client.clientId === selector.clientId);
    if (matched) return matched;
  }
  if (selector.claimId) {
    const matched = live.find(
      (client) =>
        client.serverClaim?.claimId === selector.claimId ||
        client.tabClaim?.claimId === selector.claimId,
    );
    if (matched) return matched;
  }
  if (selector.tabId !== undefined && selector.tabId !== null) {
    const tabId = Number(selector.tabId);
    const matched = live.find((client) => Number(client.tabId) === tabId);
    if (matched) return matched;
  }
  return (
    live.find((client) => client.isActiveTab === true) ||
    live
      .slice()
      .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))[0] ||
    null
  );
};

const countProbeFromClients = (payload = {}, selector = {}) => {
  const client = chooseClientForCountProbe(payload.connectedClients || [], selector);
  if (!client) return null;
  const loaded = firstFiniteNumber(
    client.sidebarConversationCount,
    client.listedConversationCount,
    client.page?.listedConversationCount,
  );
  const pageListed = firstFiniteNumber(client.page?.listedConversationCount);
  const claimLabel = client.serverClaim?.label || client.tabClaim?.label || null;
  return {
    loadedCount: loaded,
    knownLoadedCount: loaded,
    pageListedConversationCount: pageListed,
    sidebarConversationCount: firstFiniteNumber(client.sidebarConversationCount),
    claimLabel,
  };
};

const probeCountStatusFromBridge = async (bridgeUrl, selector = {}) => {
  const payload = await requestJson(
    bridgeUrl,
    appendParams('/agent/clients', { diagnostics: false }),
    { timeoutMs: 1000 },
  );
  return countProbeFromClients(payload, selector);
};

const summarizeChatsListResult = (raw = {}, flags = {}, selection = null) => {
  const conversations = Array.isArray(raw.conversations) ? raw.conversations : [];
  return {
    ok: raw.ok !== false,
    action: 'list',
    count: conversations.length,
    offset: Math.max(0, Number(flags.offset || 0)),
    limit: Math.max(1, Number(flags.limit || flags.maxChats || 25)),
    countStatus: raw.countStatus || raw.pagination?.countStatus || null,
    totalKnown: raw.totalKnown === true || raw.pagination?.totalKnown === true,
    totalCount: raw.totalCount ?? raw.pagination?.totalCount ?? null,
    minimumKnownCount: raw.minimumKnownCount ?? raw.pagination?.minimumKnownCount ?? null,
    knownLoadedCount: raw.knownLoadedCount ?? raw.pagination?.loadedCount ?? null,
    pagination: raw.pagination || null,
    conversations: conversations.map((conversation, index) => ({
      index: conversation.index ?? Math.max(0, Number(flags.offset || 0)) + index + 1,
      chatId: conversation.chatId || conversation.id || null,
      title: conversation.title || null,
      url: conversation.url || null,
      source: conversation.source || null,
    })),
    selectionFile: selection?.filePath || null,
    expectedCount: selection?.manifest?.expectedCount ?? null,
    nextAction: selection?.filePath
      ? {
          code: 'export_selection',
          message: 'Use o manifesto salvo para baixar exatamente esta lista.',
          command: `gemini-md-export export selected --selection-file ${selection.filePath} --expected-count ${selection.manifest.expectedCount} --tui`,
        }
      : raw.nextAction || null,
  };
};

const chatsListPlainLabel = (result = {}) => {
  const lines = [
    `${result.count} conversa(s) listada(s) a partir do offset ${result.offset}.`,
  ];
  for (const conversation of result.conversations) {
    lines.push(
      `${conversation.index}. ${conversation.title || 'Sem titulo'} (${conversation.chatId || 'sem chatId'})`,
    );
  }
  if (result.selectionFile) {
    lines.push(`selectionFile: ${result.selectionFile}`);
    lines.push(
      `baixar: gemini-md-export export selected --selection-file ${result.selectionFile} --expected-count ${result.expectedCount} --tui`,
    );
  }
  if (!result.totalKnown && result.minimumKnownCount !== null) {
    lines.push(
      `Observacao: historico completo ainda nao confirmado; pelo menos ${result.minimumKnownCount} conversa(s) carregada(s).`,
    );
  }
  return lines.join('\n');
};

const runChats = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0] || 'count';
  if (!['count', 'list'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export chats count|list [opcoes].');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  if (ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(parsed.flags.bridgeUrl)}...\n`);
  }
  await ensureBridgeAvailable(parsed.flags, ui);
  if (ui.format !== 'json' && ui.format !== 'jsonl') {
    ui.stdout.write('Bridge conectada. Verificando Gemini Web...\n');
  }
  await ensureReady(parsed.flags.bridgeUrl, parsed.flags, ui);
  if (subcommand === 'list') {
    const limit = Math.max(1, Math.min(200, Number(parsed.flags.limit || parsed.flags.maxChats || 25)));
    const offset = Math.max(0, Number(parsed.flags.offset || 0));
    const raw = await requestJson(
      parsed.flags.bridgeUrl,
      appendParams('/agent/recent-chats', {
        limit,
        offset,
        preferActive: true,
        refresh: parsed.flags.refresh,
        clientId: parsed.flags.clientId,
        tabId: parsed.flags.tabId,
        claimId: parsed.flags.claimId,
        sessionId: parsed.flags.sessionId,
        autoReleaseClaim: parsed.flags.autoReleaseClaim,
      }),
      { timeoutMs: 30_000 },
    );
    const selection =
      parsed.flags.saveSelection || parsed.flags.selectionFile
        ? writeSelectionFile(raw, { ...parsed.flags, limit, offset })
        : null;
    const result = summarizeChatsListResult(raw, { ...parsed.flags, limit, offset }, selection);
    writeStructuredResult(ui, result, {
      label: chatsListPlainLabel(result),
      includeResultJson: parsed.flags.resultJson === true,
    });
    return { exitCode: result.ok ? EXIT.OK : EXIT.WARNINGS, result };
  }
  const countTimeoutMs = Math.max(
    1000,
    Number(parsed.flags.loadMoreTimeoutMs || DEFAULT_COUNT_LOAD_MORE_TIMEOUT_MS),
  );
  const countLoadMoreParams = loadMoreParamsFromFlags(parsed.flags);
  countLoadMoreParams.maxNoGrowthRounds ??= DEFAULT_COUNT_MAX_NO_GROWTH_ROUNDS;
  countLoadMoreParams.loadMoreBrowserRounds ??= DEFAULT_COUNT_LOAD_MORE_BROWSER_ROUNDS;
  countLoadMoreParams.loadMoreBrowserTimeoutMs ??= DEFAULT_COUNT_LOAD_MORE_BROWSER_TIMEOUT_MS;
  const statusIntervalMs = nonNegativeIntEnv(
    process.env.GEMINI_MD_EXPORT_CLI_STATUS_INTERVAL_MS,
    DEFAULT_COUNT_STATUS_INTERVAL_MS,
    60_000,
  );
  let countClaimResult = null;
  let releaseFlags = { ...parsed.flags };
  try {
    countClaimResult = await claimCliTabForCount(parsed.flags, countTimeoutMs);
    if (countClaimResult?.claim?.claimId) {
      releaseFlags = {
        ...releaseFlags,
        claimId: countClaimResult.claim.claimId,
        tabId: countClaimResult.claim.tabId ?? releaseFlags.tabId,
      };
    }
    const requestClaimId = parsed.flags.claimId || countClaimResult?.claim?.claimId || undefined;
    const requestTabId = parsed.flags.tabId ?? countClaimResult?.claim?.tabId ?? undefined;
    const countStartedAt = Date.now();
    const requestCountUntilSettled = async () => {
      let latestRaw = null;
      let attempt = 0;
      while (true) {
        const elapsedMs = Date.now() - countStartedAt;
        const remainingMs = Math.max(1000, countTimeoutMs - elapsedMs);
        latestRaw = await requestJson(
          parsed.flags.bridgeUrl,
          appendParams('/agent/recent-chats', {
            limit: 1,
            offset: 0,
            countOnly: true,
            untilEnd: true,
            preferActive: true,
            refresh: parsed.flags.refresh,
            ...countLoadMoreParams,
            loadMoreTimeoutMs: remainingMs,
            autoClaim: requestClaimId ? false : undefined,
            autoReleaseClaim: requestClaimId ? false : parsed.flags.autoReleaseClaim,
            clientId: parsed.flags.clientId,
            tabId: requestTabId,
            claimId: requestClaimId,
            sessionId: parsed.flags.sessionId,
          }),
          { timeoutMs: remainingMs + 15_000 },
        );
        const summary = summarizeChatsCountResult(latestRaw);
        const retryReason = countRetryReason(summary);
        if (!retryReason || Date.now() - countStartedAt >= countTimeoutMs) return latestRaw;
        attempt += 1;
        if (ui.format === 'plain') {
          ui.stdout.write(
            `Ainda tentando confirmar o total (${retryReason}; tentativa ${attempt + 1}).\n`,
          );
        } else if (ui.format === 'jsonl') {
          ui.stdout.write(
            `${JSON.stringify({ type: 'count_retry', reason: retryReason, attempt: attempt + 1 })}\n`,
          );
        }
        await sleep(Math.min(2500, Math.max(250, statusIntervalMs)));
      }
    };
    const raw = await withWaitStatus(
      ui,
      {
        message: `Buscando o fim da lista de conversas (limite ${formatDuration(countTimeoutMs)}).`,
        intervalMs: statusIntervalMs,
        renderIntervalMs: DEFAULT_TUI_RENDER_INTERVAL_MS,
        intervalMessage: (elapsedMs) =>
          `Buscando o fim da lista... ${formatDuration(elapsedMs)} decorridos.`,
        tuiKind: 'count',
        statusProbe: () =>
          probeCountStatusFromBridge(parsed.flags.bridgeUrl, {
            clientId: parsed.flags.clientId,
            tabId: requestTabId,
            claimId: requestClaimId,
          }),
      },
      requestCountUntilSettled,
    );
    const result = summarizeChatsCountResult(raw);
    const partialReason = result.loadMoreError || result.refreshError;
    const label = result.totalKnown
      ? `Total confirmado: ${result.totalCount} chat(s).`
      : `Contagem parcial: pelo menos ${result.minimumKnownCount ?? result.knownLoadedCount ?? 0} chat(s).${partialReason ? ` Motivo: ${partialReason}` : ''}`;
    writeStructuredResult(ui, result, {
      label,
      includeResultJson: parsed.flags.resultJson === true,
    });
    return { exitCode: result.totalKnown ? EXIT.OK : EXIT.WARNINGS, result };
  } finally {
    await releaseCliClaimQuietly(releaseFlags, 'cli-chats-count-finished', countClaimResult);
  }
};

const runExport = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  const flags = { ...parsed.flags };
  const isSelectedExport = subcommand === 'selected' || subcommand === 'reexport';
  if (!['recent', 'missing', 'resume', 'selected', 'reexport', 'notebook'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export export recent|missing|resume|selected|reexport|notebook ...');
  }
  if (subcommand === 'missing' && !flags.vaultDir) flags.vaultDir = parsed.positionals[1];
  if (subcommand === 'resume' && !flags.resumeReportFile) flags.resumeReportFile = parsed.positionals[1];
  if (isSelectedExport && parsed.positionals.length > 1) {
    flags.chatIds.push(...splitChatIdArgs(parsed.positionals.slice(1)));
  }
  if (subcommand === 'missing' && !flags.vaultDir) throw usageError('Informe vaultDir para export missing.');
  if (subcommand === 'resume' && !flags.resumeReportFile) {
    throw usageError('Informe reportFile para export resume.');
  }
  if (isSelectedExport) {
    let selectionFromFile = null;
    if (flags.selectionFile) {
      selectionFromFile = readSelectionFile(flags.selectionFile);
      flags.selectionSourceFile = selectionFromFile.filePath;
      flags.selectionManifestKind = selectionFromFile.manifest?.kind || null;
      flags.expectedCount ??= selectionFromFile.manifest?.expectedCount;
    }
    const cliSelection = normalizeReexportSelection({
      chatIds: flags.chatIds,
      items: selectionFromFile?.items || [],
    });
    if (cliSelection.invalid.length > 0) {
      throw usageError(`chatId inválido para export ${subcommand}: ${cliSelection.invalid[0]}`);
    }
    if (cliSelection.uniqueCount === 0) {
      throw usageError(`Informe --selection-file ou ao menos um --chat-id para export ${subcommand}.`);
    }
    validateExpectedCount(cliSelection, flags.expectedCount);
    flags.chatIds = cliSelection.chatIds;
    flags.selectionItems = cliSelection.items;
    flags.reexportInputCount = cliSelection.inputCount;
    flags.reexportUniqueCount = cliSelection.uniqueCount;
    flags.reexportDuplicateCount = cliSelection.duplicateCount;
  }

  const ui = makeUi(flags, streams);
  warnTuiFallback(ui);
  let initialJob = null;
  let finalJob = null;
  let uninstallSignalCleanup = () => {};
  try {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(flags.bridgeUrl)}...\n`);
      if (isSelectedExport) {
        if (subcommand === 'reexport') {
          ui.stdout.write(
            'Aviso: `export reexport` é legado; use `export selected` para baixar conversas selecionadas.\n',
          );
        }
        ui.stdout.write(
          `Selecao para download: ${flags.reexportUniqueCount} chatId(s) unico(s)` +
            (flags.reexportDuplicateCount ? `; ${flags.reexportDuplicateCount} duplicado(s) ignorado(s)` : '') +
            (flags.expectedCount ? `; esperado=${flags.expectedCount}` : '') +
            '.\n',
        );
        if (flags.selectionSourceFile) ui.stdout.write(`selectionFile: ${flags.selectionSourceFile}\n`);
      }
    }
    await ensureBridgeAvailable(flags, ui);
    await ensureReady(flags.bridgeUrl, flags, ui);
    initialJob = await startExportJob(flags.bridgeUrl, isSelectedExport ? 'selected' : subcommand, flags);
    uninstallSignalCleanup = installJobSignalCleanup({
      flags,
      ui,
      getJob: () => finalJob || initialJob,
      reason: `cli-export-${subcommand || 'job'}-interrupted`,
    });
    announceJobStarted(ui, initialJob);
    finalJob = await followJob(flags.bridgeUrl, initialJob, flags, ui);
    const result = emitResult(ui, finalJob);
    return { exitCode: exitCodeForJob(finalJob), result };
  } catch (err) {
    if (isJobTimeoutError(err)) {
      finalJob = await cancelJobForTimeoutQuietly(flags, err.data || finalJob || initialJob, ui);
      err.data = finalJob;
      attachJobContextToErrorMessage(err, finalJob);
    }
    throw err;
  } finally {
    uninstallSignalCleanup();
    await releaseCliClaimQuietly(flags, `cli-export-${subcommand || 'job'}-finished`, finalJob || initialJob);
    closeTui(ui);
  }
};

const runJob = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  const jobId = parsed.positionals[1];
  if (!['list', 'status', 'cancel', 'trace'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export job list|status|cancel|trace.');
  }
  if (subcommand !== 'list' && !jobId) {
    throw usageError('Uso: gemini-md-export job status|cancel|trace <jobId>.');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  if (subcommand === 'list') {
    const result = await fetchJobList(parsed.flags.bridgeUrl, parsed.flags);
    if (ui.format === 'json') {
      ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (ui.format === 'jsonl') {
      ui.stdout.write(`${JSON.stringify({ type: 'job_list', result })}\n`);
    } else {
      for (const line of renderLinesForJobList(result)) ui.stdout.write(`${stripAnsi(line)}\n`);
      ui.stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
    }
    return { exitCode: EXIT.OK, result };
  }
  if (subcommand === 'trace') {
    const trace = await fetchJobTrace(parsed.flags.bridgeUrl, jobId);
    if (ui.format === 'json') {
      ui.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    } else if (ui.format === 'jsonl') {
      ui.stdout.write(`${JSON.stringify({ type: 'job_trace', trace })}\n`);
    } else {
      for (const line of renderLinesForJobTrace(trace)) ui.stdout.write(`${stripAnsi(line)}\n`);
      ui.stdout.write(`RESULT_JSON ${JSON.stringify(trace)}\n`);
    }
    return { exitCode: trace.ok === false ? EXIT.JOB_FAILED : EXIT.OK, result: trace };
  }
  let job = subcommand === 'cancel' ? await cancelJob(parsed.flags.bridgeUrl, jobId) : await fetchJobStatus(parsed.flags.bridgeUrl, jobId);
  if (subcommand === 'cancel' && parsed.flags.wait === true && !TERMINAL_STATUSES.has(job.status)) {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(`Cancelamento solicitado; aguardando o job ${jobId} parar com seguranca...\n`);
    }
    job = await waitForJobTerminalQuietly(parsed.flags.bridgeUrl, jobId, parsed.flags);
    if (!TERMINAL_STATUSES.has(job.status) && ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(
        `O job ainda nao chegou ao estado terminal; provavelmente a aba ainda esta dentro da conversa atual.\n`,
      );
      ui.stdout.write(`status: gemini-md-export job status ${jobId} --tui --result-json\n`);
      ui.stdout.write(`cancelar: gemini-md-export job cancel ${jobId} --wait --tui --result-json\n`);
    }
  }
  if (ui.format === 'json') {
    ui.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
  } else {
    for (const line of renderLinesForJob(ui, job)) ui.stdout.write(`${stripAnsi(line)}\n`);
    emitResult(ui, job);
  }
  return { exitCode: exitCodeForJobCommand(subcommand, job), result: summarizeForResultJson(job) };
};

const runExportDir = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0] || 'get';
  if (!['get', 'set'].includes(subcommand)) throw usageError('Uso: gemini-md-export export-dir get|set.');
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const result =
    subcommand === 'get'
      ? await requestJson(parsed.flags.bridgeUrl, '/agent/export-dir', { timeoutMs: 5000 })
      : await requestJson(
          parsed.flags.bridgeUrl,
          appendParams('/agent/set-export-dir', {
            outputDir: parsed.flags.outputDir || parsed.positionals[1],
            reset: parsed.flags.reset,
          }),
          { timeoutMs: 5000 },
        );
  writeStructuredResult(ui, result, {
    label:
      subcommand === 'get'
        ? `Diretorio de export: ${result.outputDir}`
        : `Diretorio de export atualizado: ${result.outputDir}`,
  });
  return { exitCode: EXIT.OK, result };
};

const runCleanup = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  if (subcommand !== 'stale-processes') {
    throw usageError('Uso: gemini-md-export cleanup stale-processes [--confirm].');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const result = await requestJson(
    parsed.flags.bridgeUrl,
    appendParams('/agent/cleanup-stale-processes', {
      confirm: parsed.flags.confirm,
      dryRun: parsed.flags.confirm ? false : true,
      force: parsed.flags.force,
      waitMs: parsed.flags.waitMs,
    }),
    { timeoutMs: 30000 },
  );
  writeStructuredResult(ui, result, {
    label: result.message || (result.ok ? 'Cleanup concluido.' : 'Cleanup nao executado.'),
  });
  return { exitCode: result.ok || result.dryRun ? EXIT.OK : EXIT.MANUAL_ACTION, result };
};

const runRepairVault = async (parsed, streams = {}) => {
  const vaultDir = parsed.flags.vaultDir || parsed.positionals[0];
  if (!vaultDir) throw usageError('Informe vault-or-folder para repair-vault.');
  const scriptPath = repairScriptPath();
  if (!scriptPath) throw new Error('scripts/vault-repair.mjs nao encontrado no pacote.');
  const args = [scriptPath, ...parsed.flags.extraRepairArgs, vaultDir];
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const child = spawn(process.execPath, args, {
    cwd: packageRoot(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.write(chunk));
  child.stderr.on('data', (chunk) => stderr.write(chunk));
  const exitCode = await new Promise((resolveExit) => {
    child.on('exit', (code) => resolveExit(code ?? EXIT.JOB_FAILED));
  });
  return { exitCode, result: { ok: exitCode === 0, scriptPath, vaultDir } };
};

const runTelemetry = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0] || 'status';
  if (!['enable', 'disable', 'status', 'preview', 'send'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export telemetry enable|disable|status|preview|send.');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  let result;
  if (subcommand === 'enable') {
    result = enableTelemetry({
      endpointUrl: parsed.flags.endpoint,
      authToken: parsed.flags.token,
      payloadLevel: parsed.flags.payloadLevel || DEFAULT_PAYLOAD_LEVEL,
    });
  } else if (subcommand === 'disable') {
    result = disableTelemetry();
  } else if (subcommand === 'status') {
    result = telemetryStatus();
  } else if (subcommand === 'preview') {
    result = previewEnvelope({
      since: parsed.flags.since || '30d',
      limit: parsed.flags.limit || 20,
    });
  } else {
    result = await sendTelemetry({
      since: parsed.flags.since || '30d',
      limit: parsed.flags.limit || 20,
    });
  }

  const label =
    subcommand === 'enable'
      ? `Telemetria ativada: ${result.ready ? 'pronta' : 'pendente'}`
      : subcommand === 'disable'
        ? 'Telemetria desativada.'
        : subcommand === 'status'
          ? `Telemetria: ${result.ready ? 'pronta' : result.enabled ? 'incompleta' : 'desligada'}; outbox=${result.outbox_count}`
          : subcommand === 'preview'
            ? `Preview: ${result.records?.length || 0} run(s).`
            : `Envio: sent=${result.sent || 0} failed=${result.failed || 0} queued=${result.queued || 0}`;
  writeStructuredResult(ui, result, {
    label,
    includeResultJson: parsed.flags.resultJson === true || ui.format === 'plain',
  });
  return {
    exitCode: subcommand === 'send' && result.ok === false ? EXIT.BRIDGE_UNAVAILABLE : EXIT.OK,
    result,
  };
};

const usageError = (message) => {
  const err = new Error(message);
  err.code = 'usage';
  return err;
};

export const main = async (argv = process.argv.slice(2), streams = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.flags.version || parsed.command === 'version') {
    (streams.stdout || process.stdout).write(`gemini-md-export ${VERSION}\n`);
    return { exitCode: EXIT.OK };
  }
  if (parsed.flags.help || parsed.command === 'help') {
    (streams.stdout || process.stdout).write(`${helpForParsed(parsed)}\n`);
    return { exitCode: EXIT.OK };
  }

  const startedAt = Date.now();
  try {
    const outcome = await runParsedCommand(parsed, streams);
    await recordCliTelemetry(parsed, {
      exitCode: outcome.exitCode ?? EXIT.OK,
      result: outcome.result || null,
      durationMs: Date.now() - startedAt,
      version: VERSION,
    });
    return outcome;
  } catch (err) {
    await recordCliTelemetry(parsed, {
      exitCode: exitCodeForError(err),
      error: err,
      durationMs: Date.now() - startedAt,
      version: VERSION,
    });
    throw err;
  }
};

const runParsedCommand = (parsed, streams = {}) => {
  if (parsed.command === 'sync') return runSync(parsed, streams);
  if (parsed.command === 'doctor') return runDoctor(parsed, streams);
  if (parsed.command === 'diagnose') return runDiagnose(parsed, streams);
  if (parsed.command === 'browser') return runBrowser(parsed, streams);
  if (parsed.command === 'tabs') return runTabs(parsed, streams);
  if (parsed.command === 'chats') return runChats(parsed, streams);
  if (parsed.command === 'export') return runExport(parsed, streams);
  if (parsed.command === 'job') return runJob(parsed, streams);
  if (parsed.command === 'export-dir') return runExportDir(parsed, streams);
  if (parsed.command === 'cleanup') return runCleanup(parsed, streams);
  if (parsed.command === 'repair-vault') return runRepairVault(parsed, streams);
  if (parsed.command === 'telemetry') return runTelemetry(parsed, streams);
  throw usageError(`Comando desconhecido: ${parsed.command}.`);
};

const exitCodeForError = (err) =>
  err.code === 'usage'
    ? EXIT.USAGE
    : err.code === 'export_job_in_progress'
      ? EXIT.MANUAL_ACTION
    : err.code === 'extension_unready'
      ? EXIT.EXTENSION_UNREADY
      : err.code === 'bridge_timeout' ||
          err.code === 'bridge_connection_lost' ||
          /fetch failed|ECONNREFUSED|Bridge/i.test(err.message)
        ? EXIT.BRIDGE_UNAVAILABLE
        : EXIT.JOB_FAILED;

const cliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (cliEntrypoint) {
  main()
    .then(({ exitCode = 0 }) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      const code = exitCodeForError(err);
      if (code === EXIT.USAGE) {
        process.stderr.write(`${err.message}\n\n${usage()}\n`);
      } else if (err.reported) {
        // A camada de comando ja imprimiu uma mensagem humana completa.
      } else if (process.env.GEMINI_MD_EXPORT_DEBUG) {
        process.stderr.write(`${err.stack || err.message}\n`);
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      process.exitCode = code;
    });
}
