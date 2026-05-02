#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  launchGeminiBrowser,
  readBrowserLaunchState,
  writeBrowserLaunchState,
} from '../src/browser-launch.mjs';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47283';
const DEFAULT_POLL_MS = 1200;
const DEFAULT_READY_WAIT_MS = 30_000;
const DEFAULT_READY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_EXISTING_TAB_RECONNECT_GRACE_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_COUNT_LOAD_MORE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COUNT_STATUS_INTERVAL_MS = 15_000;
const DEFAULT_COUNT_LOAD_MORE_BROWSER_TIMEOUT_MS = 12_000;
const DEFAULT_COUNT_LOAD_MORE_BROWSER_ROUNDS = 8;
const DEFAULT_COUNT_MAX_NO_GROWTH_ROUNDS = 2;
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
  '  --plain   Linhas estaveis + RESULT_JSON final. Melhor para agentes.',
  '  --json    JSON final puro, sem texto humano.',
  '  --jsonl   Eventos JSONL durante o progresso.',
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
  '  --ready-wait-ms <ms>     Quanto esperar a aba/extensao ficar pronta.',
  '  --client-id <id>         Escolhe uma aba Gemini pelo clientId.',
  '  --tab-id <id>            Escolhe uma aba Gemini pelo tabId do navegador.',
  '  --claim-id <id>          Usa uma claim criada por gemini-md-export tabs claim.',
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
  '  --chat-id <id>               Chat ID para export reexport; pode repetir.',
  '  --delay-ms <ms>              Pausa entre chats no reexport.',
  '  --max-load-more-rounds <n>   Rodadas maximas para puxar historico.',
  '  --load-more-attempts <n>     Tentativas de scroll por rodada.',
  '  --max-no-growth-rounds <n>   Rodadas sem crescimento antes de desistir.',
  '  --load-more-browser-rounds <n> Rodadas internas no navegador por comando.',
  '  --load-more-browser-timeout-ms <ms> Timeout do carregamento no navegador.',
  '  --load-more-timeout-ms <ms>  Timeout total do comando de carregamento.',
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
    '  browser status        Mostra prontidao da bridge/extensao/abas.',
    '  tabs list|claim       Lista/reivindica abas Gemini pela CLI.',
    '  chats count           Conta chats carregaveis sem despejar lista no chat.',
    '  export recent         Exporta historico recente carregavel.',
    '  export missing        Exporta apenas chats ausentes no vault.',
    '  export resume         Retoma export por relatorio incremental.',
    '  export reexport       Reexporta chatIds explicitos.',
    '  export notebook       Exporta caderno Gemini carregado.',
    '  job status <jobId>    Consulta progresso de um job.',
    '  job cancel <jobId>    Cancela um job.',
    '  export-dir get|set    Consulta ou altera diretorio de export.',
    '  cleanup stale-processes Diagnostica/limpa processos antigos seguros.',
    '  repair-vault <path>   Executa reparo local de vault.',
    '  help [comando]        Mostra ajuda global ou de um comando.',
    '',
    'Exemplos:',
    '  gemini-md-export sync "/path/to/vault" --tui',
    '  gemini-md-export sync "/path/to/vault" --plain',
    '  gemini-md-export doctor --plain',
    '  gemini-md-export tabs list --plain',
    '  gemini-md-export chats count --plain',
    '  gemini-md-export export missing "/path/to/vault" --plain',
    '  gemini-md-export job status job-123 --json',
    '',
    'Dentro do Gemini CLI:',
    '  - Use TUI se o shell interativo/node-pty estiver ativo.',
    '  - Para export/sync, rode a CLI direto; evite despejar gemini_ready/gemini_tabs no chat.',
    '  - Use --plain quando o agente precisar ler a saida sem ANSI e resumir pelo RESULT_JSON.',
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
    '  gemini-md-export sync "/path/to/vault" --plain',
    '  gemini-md-export sync --resume-report-file "/path/to/report.json" --plain',
    '',
    'Contrato para agentes:',
    '  Use --plain e leia a ultima linha RESULT_JSON {...}.',
    '  Use --json apenas quando precisar de JSON final puro.',
  ].join('\n');

const doctorHelp = () =>
  [
    'gemini-md-export doctor',
    '',
    'Uso:',
    '  gemini-md-export doctor [opcoes]',
    '',
    'Verifica se bridge, extensao Chrome e uma aba Gemini estao prontas.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export doctor --plain',
    '  gemini-md-export doctor --json',
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
    '  gemini-md-export tabs list --plain',
    '  gemini-md-export tabs claim --index 1 --plain',
    '  gemini-md-export sync "/path/to/vault" --claim-id <claimId> --plain',
  ].join('\n');

const chatsHelp = () =>
  [
    'gemini-md-export chats',
    '',
    'Uso:',
    '  gemini-md-export chats count [opcoes]',
    '',
    'Conta conversas carregaveis no sidebar sem imprimir a lista inteira.',
    'A contagem so e total quando RESULT_JSON.totalKnown=true.',
    'Se totalKnown=false, responda "pelo menos N" e nao "ao todo".',
    '',
    'Opcoes:',
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
    '  gemini-md-export chats count --plain',
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
    '  gemini-md-export export reexport --chat-id <id> [opcoes]',
    '  gemini-md-export export notebook [opcoes]',
    '',
    'Subcomandos:',
    '  recent   Exporta historico recente carregavel.',
    '  missing  Cruza Gemini Web com o vault e baixa ausentes.',
    '  resume   Retoma a partir de relatorio incremental.',
    '  reexport Reexporta chatIds explicitos para staging/reparo.',
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
    '  gemini-md-export export reexport --chat-id <id> [--chat-id <id>] [opcoes]',
    '',
    'Reexporta chatIds explicitos em job de background, util para repair/staging.',
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
    '  gemini-md-export job status <jobId> [opcoes]',
    '  gemini-md-export job cancel <jobId> [opcoes]',
    '',
    'Subcomandos:',
    '  status   Consulta progresso/resultado de um job.',
    '  cancel   Solicita cancelamento de um job.',
    '',
    ...outputModeHelp(),
    '',
    ...commonOptionHelp(),
    '',
    'Exemplos:',
    '  gemini-md-export job status job-123 --plain',
    '  gemini-md-export job cancel job-123 --plain',
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
    '  gemini-md-export job cancel <jobId> [opcoes]',
    '',
    'Solicita cancelamento de um job em andamento.',
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

const helpForParsed = (parsed) => {
  const topic = parsed.command === 'help' ? parsed.positionals : [parsed.command, ...parsed.positionals];
  const [command, subcommand] = topic;
  if (!command) return usage();
  if (command === 'sync') return syncHelp();
  if (command === 'doctor') return doctorHelp();
  if (command === 'browser') return browserHelp();
  if (command === 'tabs') return tabsHelp();
  if (command === 'chats') return chatsHelp();
  if (command === 'export' && subcommand === 'recent') return exportRecentHelp();
  if (command === 'export' && subcommand === 'missing') return exportMissingHelp();
  if (command === 'export' && subcommand === 'resume') return exportResumeHelp();
  if (command === 'export' && subcommand === 'reexport') return exportReexportHelp();
  if (command === 'export' && subcommand === 'notebook') return exportNotebookHelp();
  if (command === 'export') return exportHelp();
  if (command === 'job' && subcommand === 'status') return jobStatusHelp();
  if (command === 'job' && subcommand === 'cancel') return jobCancelHelp();
  if (command === 'job') return jobHelp();
  if (command === 'export-dir') return exportDirHelp();
  if (command === 'cleanup') return cleanupHelp();
  if (command === 'repair-vault') return repairVaultHelp();
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
    else if (arg === '--vault-dir') out.flags.vaultDir = value();
    else if (arg === '--output-dir') out.flags.outputDir = value();
    else if (arg === '--resume-report-file' || arg === '--report-file')
      out.flags.resumeReportFile = value();
    else if (arg === '--sync-state-file') out.flags.syncStateFile = value();
    else if (arg === '--known-boundary-count') out.flags.knownBoundaryCount = Number(value());
    else if (arg === '--max-chats' || arg === '--limit') out.flags.maxChats = Number(value());
    else if (arg === '--batch-size') out.flags.batchSize = Number(value());
    else if (arg === '--max-load-more-rounds') out.flags.maxLoadMoreRounds = Number(value());
    else if (arg === '--load-more-attempts') out.flags.loadMoreAttempts = Number(value());
    else if (arg === '--max-no-growth-rounds') out.flags.maxNoGrowthRounds = Number(value());
    else if (arg === '--load-more-browser-rounds') out.flags.loadMoreBrowserRounds = Number(value());
    else if (arg === '--load-more-browser-timeout-ms')
      out.flags.loadMoreBrowserTimeoutMs = Number(value());
    else if (arg === '--load-more-timeout-ms') out.flags.loadMoreTimeoutMs = Number(value());
    else if (arg === '--refresh') out.flags.refresh = true;
    else if (arg === '--no-refresh') out.flags.refresh = false;
    else if (arg === '--poll-ms') out.flags.pollMs = Math.max(250, Number(value()) || DEFAULT_POLL_MS);
    else if (arg === '--bridge-start-wait-ms')
      out.flags.bridgeStartWaitMs = Math.max(500, Number(value()) || 6000);
    else if (arg === '--bridge-keep-alive-ms')
      out.flags.bridgeKeepAliveMs = Math.max(1000, Number(value()) || 15 * 60_000);
    else if (arg === '--ready-wait-ms') out.flags.readyWaitMs = Math.max(0, Number(value()) || 0);
    else if (arg === '--timeout-ms') out.flags.timeoutMs = Math.max(1000, Number(value()) || DEFAULT_TIMEOUT_MS);
    else if (arg === '--client-id') out.flags.clientId = value();
    else if (arg === '--tab-id') out.flags.tabId = value();
    else if (arg === '--claim-id') out.flags.claimId = value();
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
    else if (arg === '--delay-ms') out.flags.delayMs = Number(value());
    else if (arg === '--reset') out.flags.reset = true;
    else if (arg === '--confirm') out.flags.confirm = true;
    else if (arg === '--force') out.flags.force = true;
    else if (arg === '--wait-ms') out.flags.waitMs = Number(value());
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

const loadMoreParamsFromFlags = (flags = {}) => ({
  maxLoadMoreRounds: flags.maxLoadMoreRounds,
  loadMoreAttempts: flags.loadMoreAttempts,
  maxNoGrowthRounds: flags.maxNoGrowthRounds,
  loadMoreBrowserRounds: flags.loadMoreBrowserRounds,
  loadMoreBrowserTimeoutMs: flags.loadMoreBrowserTimeoutMs,
  loadMoreTimeoutMs: flags.loadMoreTimeoutMs,
});

const requestJson = async (bridgeUrl, path, { timeoutMs = 15000, method = 'GET' } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, `${normalizeBridgeUrl(bridgeUrl)}/`), {
      method,
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const err = new Error(json?.error || `HTTP ${response.status}`);
      err.statusCode = response.status;
      err.data = json;
      throw err;
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error(`Timeout falando com a bridge em ${timeoutMs}ms.`);
      timeout.code = 'bridge_timeout';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
    { timeoutMs: Math.max(DEFAULT_READY_REQUEST_TIMEOUT_MS, waitMs + 5000) },
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

const formatDuration = (ms) => {
  const seconds = Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}min ${rest}s` : `${minutes}min`;
};

const supportsTui = (stdout = process.stdout) => stdout.isTTY && process.env.TERM !== 'dumb';

const selectFormat = (flags, stdout = process.stdout) => {
  if (flags.format === 'tui' && !stdout.isTTY) return 'plain';
  if (flags.format !== 'auto') return flags.format;
  if (supportsTui(stdout)) return 'tui';
  return 'plain';
};

const makeUi = (flags, streams = {}) => {
  const stdout = streams.stdout || process.stdout;
  const format = selectFormat(flags, stdout);
  return {
    format,
    requestedFormat: flags.format,
    tuiFallback: flags.format === 'tui' && format !== 'tui',
    tuiFallbackWarned: false,
    color: flags.color,
    stdout,
    stderr: streams.stderr || process.stderr,
    lastLineCount: 0,
    firstRender: true,
    closed: false,
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

const bar = (ui, current, total, { width = 28, indeterminate = false, seed = 0 } = {}) => {
  const safeTotal = Math.max(0, Number(total) || 0);
  if (indeterminate || safeTotal <= 0) {
    const size = Math.max(4, Math.floor(width / 4));
    const start = seed % Math.max(1, width - size);
    const chars = Array.from({ length: width }, (_, index) =>
      index >= start && index < start + size ? '=' : '-',
    );
    return `[${chars.join('')}]`;
  }
  const pct = Math.max(0, Math.min(1, (Number(current) || 0) / safeTotal));
  const filled = Math.round(pct * width);
  return `[${'='.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}] ${Math.round(pct * 100)}%`;
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

const renderLinesForJob = (ui, job = {}, tick = 0) => {
  const width = terminalWidth(ui);
  const totals = jobTotals(job);
  const total = Number(job.requested || job.missingCount || job.webConversationCount || 0);
  const current = Number(job.completed || 0);
  const indeterminate = !total || ['queued', 'loading-history', 'scanning-vault'].includes(job.phase);
  const title = bold(ui, 'Gemini Markdown Export');
  const status = colorize(ui, terminalColorForStatus(job.status), job.status || 'running');
  const phase = job.phase ? `${dim(ui, 'fase')} ${job.phase}` : '';
  const headline = job.progressMessage || job.decisionSummary?.headline || 'Sincronizando...';
  const currentLabel = job.current?.title || job.current?.chatId || null;
  const countText = total > 0 ? `${Math.min(current, total)}/${total}` : `${job.loadedCount || 0} vistas`;
  const progress = bar(ui, current, total, {
    width: Math.max(22, Math.min(42, width - 42)),
    indeterminate,
    seed: tick,
  });
  const warningParts = [];
  if (totals.failed) warningParts.push(`${totals.failed} falha(s)`);
  if (totals.warnings) warningParts.push(`${totals.warnings} warning(s) de midia`);
  const warnings = warningParts.length ? colorize(ui, 'yellow', warningParts.join(' · ')) : 'sem warnings';
  return [
    `${title} ${dim(ui, 'sync')}`,
    `${dim(ui, 'status')} ${status}${phase ? ` · ${phase}` : ''}`,
    `${progress} ${countText}`,
    headline,
    currentLabel ? `${dim(ui, 'agora')} ${currentLabel}` : `${dim(ui, 'agora')} aguardando Gemini Web`,
    `${dim(ui, 'contas')} web=${totals.webSeen ?? '-'} existentes=${totals.existing ?? '-'} faltantes=${totals.missing ?? '-'} baixadas=${totals.downloaded} puladas=${totals.skipped}`,
    `${dim(ui, 'avisos')} ${warnings}`,
    job.reportFile ? `${dim(ui, 'relatorio')} ${job.reportFile}` : `${dim(ui, 'relatorio')} ainda nao gravado`,
  ];
};

const renderTui = (ui, job, tick) => {
  const lines = renderLinesForJob(ui, job, tick);
  if (ui.firstRender) {
    ui.stdout.write(ANSI.hideCursor);
    ui.firstRender = false;
  } else if (ui.lastLineCount > 0) {
    ui.stdout.write(`\x1b[${ui.lastLineCount}F${ANSI.clearBelow}`);
  }
  ui.stdout.write(`${lines.join('\n')}\n`);
  ui.lastLineCount = lines.reduce((sum, line) => sum + Math.max(1, stripAnsi(line).split('\n').length), 0);
};

const closeTui = (ui) => {
  if (ui.closed) return;
  ui.closed = true;
  if (ui.format === 'tui' && !ui.firstRender) {
    ui.stdout.write(ANSI.showCursor);
  }
};

const renderPlainProgress = (ui, job, previous = {}) => {
  const key = [
    job.status,
    job.phase,
    job.completed,
    job.requested,
    job.loadedCount,
    job.failureCount,
    job.progressMessage,
    job.current?.chatId,
  ].join('|');
  if (previous.key === key) return previous;
  const total = Number(job.requested || job.missingCount || job.webConversationCount || 0);
  const current = Number(job.completed || 0);
  const count = total > 0 ? `${Math.min(current, total)}/${total}` : `${job.loadedCount || 0} vistas`;
  ui.stdout.write(`[${new Date().toLocaleTimeString()}] ${job.status}/${job.phase}: ${count} - ${job.progressMessage || 'sincronizando'}\n`);
  return { key };
};

const withWaitStatus = async (
  ui,
  { message, intervalMessage, intervalMs = DEFAULT_COUNT_STATUS_INTERVAL_MS },
  run,
) => {
  if (ui.format === 'json') return run();
  if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'status', message })}\n`);
    return run();
  }

  const startedAt = Date.now();
  let tick = 0;
  const nextMessage = () =>
    typeof intervalMessage === 'function' ? intervalMessage(Date.now() - startedAt) : message;
  const renderWaitTui = () => {
    renderTui(
      ui,
      {
        status: 'running',
        phase: 'loading-history',
        requested: 0,
        completed: 0,
        progressMessage: tick === 0 ? message : nextMessage(),
      },
      tick,
    );
  };

  if (ui.format === 'tui') renderWaitTui();
  else ui.stdout.write(`${message}\n`);

  const timer = setInterval(() => {
    tick += 1;
    if (ui.format === 'tui') renderWaitTui();
    else ui.stdout.write(`${nextMessage()}\n`);
  }, Math.max(1000, Number(intervalMs) || DEFAULT_COUNT_STATUS_INTERVAL_MS));
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
        `ATENCAO: o fim do historico nao foi confirmado; vistas=${result.webConversationCount ?? '-'}.\n`,
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

const wakeBrowserFromCli = async (flags, ui, ready) => {
  if (flags.wakeBrowser === false || !shouldWakeBrowserForReady(ready)) {
    return null;
  }

  const now = Date.now();
  const previousState = readBrowserLaunchState();
  if (activeBrowserLaunchState(previousState, now)) {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
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

  if (ui.format !== 'json' && ui.format !== 'jsonl') {
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
        if (ui.format !== 'json' && ui.format !== 'jsonl') {
          ui.stdout.write(
            `Aguardando aba Gemini existente reconectar (${formatDuration(existingTabGraceMs)})...\n`,
          );
        }
        const reconnected = await requestReadyStatus(bridgeUrl, flags, {
          waitMs: existingTabGraceMs,
        });
        if (reconnected.ready === true || !shouldWakeBrowserForReady(reconnected)) {
          ready = reconnected;
        }
      }
    }
    if (ready.ready !== true) {
      cliBrowserWake = await wakeBrowserFromCli(flags, ui, ready);
      if (flags.readyWaitMs > 0) {
        if (ui.format !== 'json' && ui.format !== 'jsonl') {
          ui.stdout.write(`Aguardando a extensao conectar (${formatDuration(flags.readyWaitMs)})...\n`);
        }
        ready = await requestReadyStatus(bridgeUrl, flags, { waitMs: flags.readyWaitMs });
      }
    }
  }
  return {
    ...ready,
    cliBrowserWake,
  };
};

const ensureReady = async (bridgeUrl, flags, ui) => {
  const ready = await readyWithCliWake(bridgeUrl, flags, ui);
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
    refresh: flags.refresh,
    startIndex: flags.startIndex,
    delayMs: flags.delayMs,
    clientId: flags.clientId,
    tabId: flags.tabId,
    claimId: flags.claimId,
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
  if (kind === 'reexport') {
    return requestJson(
      bridgeUrl,
      appendParams('/agent/reexport-chats', {
        ...params,
        chatId: flags.chatIds,
      }),
      { timeoutMs: 20000 },
    );
  }
  if (kind === 'notebook') {
    return requestJson(bridgeUrl, appendParams('/agent/export-notebook', params), { timeoutMs: 20000 });
  }
  throw usageError(`Subcomando export desconhecido: ${kind}.`);
};

const fetchJobStatus = async (bridgeUrl, jobId) =>
  requestJson(bridgeUrl, appendParams('/agent/export-job-status', { jobId }), { timeoutMs: 20000 });

const cancelJob = async (bridgeUrl, jobId) =>
  requestJson(bridgeUrl, appendParams('/agent/export-job-cancel', { jobId }), { timeoutMs: 20000 });

const claimIdFromJob = (job = {}) => {
  const value = job || {};
  return value.tabClaimId || value.tabClaim?.claimId || value.serverClaim?.claimId || value.claim?.claimId || null;
};

const shouldReleaseCliClaim = (flags = {}, job = null) =>
  flags.autoReleaseClaim !== false && !!(flags.claimId || claimIdFromJob(job));

const releaseCliClaimQuietly = async (flags = {}, reason, job = null) => {
  if (!shouldReleaseCliClaim(flags, job)) return null;
  const claimId = flags.claimId || claimIdFromJob(job);
  if (!claimId) return null;
  try {
    return await requestJson(
      flags.bridgeUrl,
      appendParams('/agent/release-tab', {
        claimId,
        reason,
      }),
      { timeoutMs: 8000 },
    );
  } catch (err) {
    return {
      ok: false,
      claimId,
      error: err?.message || String(err),
    };
  }
};

const writeStructuredResult = (ui, result, { label = null } = {}) => {
  if (ui.format === 'json') {
    ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.format === 'jsonl') {
    ui.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`);
  } else {
    if (label) ui.stdout.write(`${label}\n`);
    ui.stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
  }
};

const followJob = async (bridgeUrl, initialJob, flags, ui) => {
  let job = initialJob;
  let tick = 0;
  let previousPlain = {};
  const startedAt = Date.now();
  while (true) {
    if (ui.format === 'tui') {
      renderTui(ui, job, tick);
    } else if (ui.format === 'plain') {
      previousPlain = renderPlainProgress(ui, job, previousPlain);
    } else if (ui.format === 'jsonl') {
      ui.stdout.write(`${JSON.stringify({ type: 'job_status', job: summarizeForResultJson(job), raw: job })}\n`);
    }

    if (TERMINAL_STATUSES.has(job.status)) return job;
    if (Date.now() - startedAt > flags.timeoutMs) {
      const err = new Error(`Timeout aguardando job ${job.jobId}.`);
      err.code = 'job_timeout';
      err.data = job;
      throw err;
    }
    await sleep(flags.pollMs);
    tick += 1;
    job = await fetchJobStatus(bridgeUrl, job.jobId);
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
  try {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(flags.bridgeUrl)}...\n`);
    }
    await ensureBridgeAvailable(flags, ui);
    await ensureReady(flags.bridgeUrl, flags, ui);
    initialJob = await startSyncJob(flags.bridgeUrl, flags);
    finalJob = await followJob(flags.bridgeUrl, initialJob, flags, ui);
    const result = emitResult(ui, finalJob);
    return { exitCode: exitCodeForJob(finalJob), result };
  } catch (err) {
    throw err;
  } finally {
    await releaseCliClaimQuietly(flags, 'cli-sync-finished', finalJob || initialJob);
    closeTui(ui);
  }
};

const runDoctor = async (parsed, streams = {}) => {
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const ready = await readyWithCliWake(parsed.flags.bridgeUrl, parsed.flags, ui);
  const result = {
    ok: ready.ready === true,
    ready: ready.ready === true,
    blockingIssue: ready.blockingIssue || null,
    mode: ready.mode || null,
    connectedClientCount: ready.connectedClientCount || 0,
    selectableTabCount: ready.selectableTabCount || 0,
    commandReadyClientCount: ready.commandReadyClientCount || 0,
    nextAction:
      ready.ready === true
        ? 'Bridge, extensao e aba Gemini parecem prontos.'
        : ready.extensionReadiness?.nextAction?.message ||
          ready.cliBrowserWake?.reason ||
          ready.cliBrowserWake?.error ||
          'Verifique a extensao Chrome.',
  };
  if (ui.format === 'json') ui.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else ui.stdout.write(`${result.ok ? 'OK' : 'NAO PRONTO'}: ${result.nextAction}\nRESULT_JSON ${JSON.stringify(result)}\n`);
  return { exitCode: result.ok ? EXIT.OK : EXIT.EXTENSION_UNREADY, result };
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
        ? 'Rode gemini-md-export tabs claim --index <n> --plain e reutilize o claimId no sync/export.'
        : action === 'list' && tabs.length === 1
          ? 'Rode gemini-md-export tabs claim --index 1 --plain ou passe --client-id diretamente.'
          : null,
  };
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
  const label =
    action === 'list'
      ? `${summary.connectedTabCount} aba(s) Gemini conectada(s).`
      : summary.ok
        ? `tabs ${action}: ok`
        : `tabs ${action}: falhou`;
  writeStructuredResult(ui, summary, { label });
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

const runChats = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0] || 'count';
  if (subcommand !== 'count') {
    throw usageError('Uso: gemini-md-export chats count [opcoes].');
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
  try {
    const raw = await withWaitStatus(
      ui,
      {
        message: `Carregando historico do Gemini ate confirmar o fim (limite ${formatDuration(countTimeoutMs)}).`,
        intervalMs: statusIntervalMs,
        intervalMessage: (elapsedMs) =>
          `Ainda carregando historico... ${formatDuration(elapsedMs)} decorridos; nao vou abrir outra tool MCP como fallback.`,
      },
      () =>
        requestJson(
          parsed.flags.bridgeUrl,
          appendParams('/agent/recent-chats', {
            limit: 1,
            offset: 0,
            countOnly: true,
            untilEnd: true,
            preferActive: true,
            refresh: parsed.flags.refresh,
            ...countLoadMoreParams,
            loadMoreTimeoutMs: countTimeoutMs,
            autoReleaseClaim: parsed.flags.autoReleaseClaim,
            clientId: parsed.flags.clientId,
            tabId: parsed.flags.tabId,
            claimId: parsed.flags.claimId,
          }),
          { timeoutMs: countTimeoutMs + 15_000 },
        ),
    );
    const result = summarizeChatsCountResult(raw);
    const partialReason = result.loadMoreError || result.refreshError;
    const label = result.totalKnown
      ? `Total confirmado: ${result.totalCount} chat(s).`
      : `Contagem parcial: pelo menos ${result.minimumKnownCount ?? result.knownLoadedCount ?? 0} chat(s).${partialReason ? ` Motivo: ${partialReason}` : ''}`;
    writeStructuredResult(ui, result, { label });
    return { exitCode: result.totalKnown ? EXIT.OK : EXIT.WARNINGS, result };
  } finally {
    await releaseCliClaimQuietly(parsed.flags, 'cli-chats-count-finished');
  }
};

const runExport = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  const flags = { ...parsed.flags };
  if (!['recent', 'missing', 'resume', 'reexport', 'notebook'].includes(subcommand)) {
    throw usageError('Uso: gemini-md-export export recent|missing|resume|reexport|notebook ...');
  }
  if (subcommand === 'missing' && !flags.vaultDir) flags.vaultDir = parsed.positionals[1];
  if (subcommand === 'resume' && !flags.resumeReportFile) flags.resumeReportFile = parsed.positionals[1];
  if (subcommand === 'reexport' && parsed.positionals[1]) {
    flags.chatIds.push(
      ...String(parsed.positionals[1])
        .split(/[,\s]+/)
        .filter(Boolean),
    );
  }
  if (subcommand === 'missing' && !flags.vaultDir) throw usageError('Informe vaultDir para export missing.');
  if (subcommand === 'resume' && !flags.resumeReportFile) {
    throw usageError('Informe reportFile para export resume.');
  }
  if (subcommand === 'reexport' && flags.chatIds.length === 0) {
    throw usageError('Informe ao menos um --chat-id para export reexport.');
  }

  const ui = makeUi(flags, streams);
  warnTuiFallback(ui);
  let initialJob = null;
  let finalJob = null;
  try {
    if (ui.format !== 'json' && ui.format !== 'jsonl') {
      ui.stdout.write(`Conectando na bridge ${normalizeBridgeUrl(flags.bridgeUrl)}...\n`);
    }
    await ensureBridgeAvailable(flags, ui);
    await ensureReady(flags.bridgeUrl, flags, ui);
    initialJob = await startExportJob(flags.bridgeUrl, subcommand, flags);
    finalJob = await followJob(flags.bridgeUrl, initialJob, flags, ui);
    const result = emitResult(ui, finalJob);
    return { exitCode: exitCodeForJob(finalJob), result };
  } catch (err) {
    throw err;
  } finally {
    await releaseCliClaimQuietly(flags, `cli-export-${subcommand || 'job'}-finished`, finalJob || initialJob);
    closeTui(ui);
  }
};

const runJob = async (parsed, streams = {}) => {
  const subcommand = parsed.positionals[0];
  const jobId = parsed.positionals[1];
  if (!['status', 'cancel'].includes(subcommand) || !jobId) {
    throw usageError('Uso: gemini-md-export job status|cancel <jobId>.');
  }
  const ui = makeUi(parsed.flags, streams);
  warnTuiFallback(ui);
  await ensureBridgeAvailable(parsed.flags, ui);
  const job = subcommand === 'cancel' ? await cancelJob(parsed.flags.bridgeUrl, jobId) : await fetchJobStatus(parsed.flags.bridgeUrl, jobId);
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

  if (parsed.command === 'sync') return runSync(parsed, streams);
  if (parsed.command === 'doctor') return runDoctor(parsed, streams);
  if (parsed.command === 'browser') return runBrowser(parsed, streams);
  if (parsed.command === 'tabs') return runTabs(parsed, streams);
  if (parsed.command === 'chats') return runChats(parsed, streams);
  if (parsed.command === 'export') return runExport(parsed, streams);
  if (parsed.command === 'job') return runJob(parsed, streams);
  if (parsed.command === 'export-dir') return runExportDir(parsed, streams);
  if (parsed.command === 'cleanup') return runCleanup(parsed, streams);
  if (parsed.command === 'repair-vault') return runRepairVault(parsed, streams);
  throw usageError(`Comando desconhecido: ${parsed.command}.`);
};

const cliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (cliEntrypoint) {
  main()
    .then(({ exitCode = 0 }) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      const code =
        err.code === 'usage'
          ? EXIT.USAGE
          : err.code === 'extension_unready'
            ? EXIT.EXTENSION_UNREADY
            : err.code === 'bridge_timeout' || /fetch failed|ECONNREFUSED|Bridge/i.test(err.message)
              ? EXIT.BRIDGE_UNAVAILABLE
              : EXIT.JOB_FAILED;
      if (code === EXIT.USAGE) {
        process.stderr.write(`${err.message}\n\n${usage()}\n`);
      } else if (process.env.GEMINI_MD_EXPORT_DEBUG) {
        process.stderr.write(`${err.stack || err.message}\n`);
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      process.exitCode = code;
    });
}
