# Roadmap

Este roadmap registra as próximas frentes de estabilidade e performance do
Gemini Markdown Export. A ordem abaixo prioriza confiabilidade operacional antes
de acelerar exportações grandes.

## Governança

- Ordem do arquivo: versões implementadas em ordem crescente, depois propostas e
  pesquisas futuras.
- Propostas de arquitetura, pesquisa ou spike não autorizam implementação por
  si só.
- Uma proposta só deve virar mudança de código/release depois de aprovação
  explícita do usuário para aquela proposta específica.
- Spikes já feitos sem aprovação explícita podem ficar no workspace para review,
  mas devem ser marcados como spike não aprovado e não devem ser versionados ou
  publicados como release sem nova aprovação.
- Fluxo de trabalho padrão: discutir, explorar alternativas, atualizar roadmap
  e só então implementar após aprovação explícita.

## v0.2.1 — Ciclo de vida do MCP e modo proxy

Status: implementado na versão `0.2.1`.

Objetivo: impedir que processos antigos do MCP segurem a porta `127.0.0.1:47283`
e confundam sessões novas do Gemini CLI.

### Entregas

- Expandir `/healthz` com diagnóstico do processo primário: `pid`, `ppid`,
  versão, protocolo, uptime, `startedAt`, `cwd`, `argv` resumido e `bridgeRole`.
- Melhorar `gemini_browser_status` em modo proxy para diferenciar:
  - proxy saudável para um primário compatível;
  - primário antigo ou incompatível;
  - porta ocupada por outro serviço;
  - porta ocupada sem resposta de `/healthz`.
- Identificar o PID dono da porta quando possível:
  - Windows: PowerShell com `Get-NetTCPConnection` e processo associado;
  - macOS/Linux: `lsof -iTCP:<porta> -sTCP:LISTEN`.
- Retornar mensagens acionáveis em português com PID, versão, comando sugerido
  e quando reiniciar o Gemini CLI.
- Evitar que o agente recomende matar processos sem antes distinguir primário
  saudável, primário antigo e processo desconhecido.

### Critérios de aceite

- Uma segunda sessão com primário saudável deve continuar em proxy sem tratar
  isso como erro.
- Uma segunda sessão com primário incompatível deve retornar erro claro com a
  versão esperada, versão real e PID provável.
- Porta ocupada por processo desconhecido deve orientar alterar porta ou fechar
  o processo dono, sem chamar isso de bug da extensão.
- Testes cobrindo EADDRINUSE saudável, incompatível, inacessível e processo
  desconhecido.

## v0.2.2 — Limpeza controlada e UX de recuperação

Status: implementado na versão `0.2.2`.

Objetivo: permitir recuperar ambientes Windows/macOS bagunçados sem pedir que o
usuário mate processos às cegas.

### Entregas

- Criar `gemini_mcp_diagnose_processes` para listar processos MCP/exporter
  relevantes, porta usada, versão detectada e estado de saúde.
- Criar `gemini_mcp_cleanup_stale_processes` com critérios estritos:
  - só considerar processos cujo comando/caminho pareça `gemini-md-export` ou
    `mcp-server.js`;
  - nunca encerrar o processo atual;
  - exigir primário incompatível, travado ou sem resposta;
  - retornar exatamente o que foi encerrado e por quê.
- Atualizar `AGENTS.md` e `gemini-cli-extension/GEMINI.md`:
  - antes de pedir restart manual, rodar diagnóstico;
  - antes de pedir reload manual do Chrome, tentar `gemini_browser_status`;
  - antes de encerrar processos, confirmar que são MCPs antigos do exporter.
- Melhorar textos de recuperação:
  - "modo proxy saudável" não é erro;
  - "primário antigo/travado" é erro recuperável;
  - "porta ocupada por outro app" é problema de ambiente.

### Critérios de aceite

- Cleanup não mata processo fora do escopo do exporter.
- Diagnóstico funciona sem privilégios administrativos quando possível.
- Quando cleanup não puder agir com segurança, a resposta explica o próximo
  passo manual com PID e comando/plataforma.

## v0.3.0 — Performance e robustez do export total

Status: implementado na versão `0.3.0`.

Objetivo: acelerar e tornar retomável o fluxo "importar todo o histórico" sem
sacrificar integridade.

### Entregas

- Lazy-load adaptativo do sidebar:
  - batches maiores quando o DOM responde rápido;
  - batches menores quando o Gemini fica lento;
  - aviso explícito quando o fim do histórico não foi confirmado.
- Checkpoints de job mais fortes:
  - retomar `gemini_export_recent_chats` e `gemini_export_missing_chats` a
    partir do relatório JSON;
  - evitar repetir chats já exportados no mesmo job;
  - preservar contadores `webConversationCount`, `existingVaultCount` e
    `missingCount`.
- Robustez de assets:
  - cache por URL durante o job;
  - timeout e concorrência controlados;
  - asset não pode travar export principal.

### Critérios de aceite

- Export total interrompido consegue retomar sem rebaixar arquivos já salvos.
- Relatório final deixa claro se o histórico inteiro foi verificado ou se houve
  truncamento.
- Falhas de mídia aparecem como warnings rastreáveis, não como travamento do job.

## v0.3.1 — Hardening operacional e prova em campo

Status: implementado na versão `0.3.1`.

Objetivo: transformar os ganhos da `0.3.0` em confiança operacional,
especialmente no Windows, sem adicionar comportamento grande novo.

### Entregas

- Criar smoke tests automatizados para o bridge:
  - `/bridge/events`;
  - `/bridge/snapshot`;
  - `/healthz`;
  - modo proxy quando a porta principal já está ocupada;
  - porta alternativa em ambiente de teste.
  - Primeiro incremento: `npm run smoke:bridge` sobe uma bridge isolada em
    porta temporária e valida `/healthz`, `/bridge/snapshot`, `/bridge/events`,
    `/bridge/heartbeat`, `/agent/clients` e diagnóstico de processos sem login
    no Gemini Web.
- Adicionar um comando/fluxo de diagnóstico de campo que reúna em uma saída:
  - versão do MCP;
  - versão/protocolo/build da extensão Chrome conectada;
  - browser detectado;
  - processos MCP/exporter ativos;
  - porta `127.0.0.1:47283`;
  - diretório de export configurado;
  - último job e último relatório JSON, quando houver.
  - Primeiro incremento: `gemini_diagnose_environment` e `/agent/diagnostics`
    consolidam esses sinais e retornam `nextAction` acionável.
- Revisar instaladores e scripts de recuperação para apontarem primeiro para:
  - `gemini_browser_status`;
  - `gemini_mcp_diagnose_processes`;
  - `gemini_mcp_cleanup_stale_processes`;
  - reload automático da extensão/abas quando suportado.
- Criar checklist curto de validação no Windows:
  - instalar/atualizar;
  - abrir Gemini Web;
  - listar 20 conversas;
  - configurar vault;
  - exportar missing em lote pequeno;
  - retomar por `resumeReportFile`.

### Critérios de aceite

- O diagnóstico deve diferenciar claramente extensão antiga, MCP antigo,
  bridge indisponível, Chrome sem aba Gemini e porta ocupada por outro app.
- Os smoke tests devem rodar no CI ou em script local sem exigir login no
  Gemini Web.
- Um usuário no Windows deve receber uma próxima ação concreta antes de qualquer
  pedido de reinstalação manual.

## v0.3.2 — Medição e performance do export total

Status: implementada na versão `0.7.1`.

Objetivo: reduzir lentidão real do fluxo "importar todo o histórico" com
medição, limites adaptativos e menos trabalho repetido.

### Entregas

- Instrumentar o relatório JSON do job com métricas por etapa:
  - tempo de carregar sidebar (`loadSidebarMs`);
  - tempo de refresh do sidebar (`refreshSidebarMs`);
  - tempo de cruzar vault (`scanVaultMs`);
  - tempo total de exportação (`exportConversationsMs`);
  - tempo de abrir conversa (`openConversationMs`);
  - tempo de hidratar DOM (`hydrateDomMs`);
  - tempo de extrair Markdown (`extractMarkdownMs`);
  - tempo de salvar arquivo (`saveFilesMs`);
  - tempo de baixar assets (`fetchAssetsMs`);
  - retries/timeouts/warnings por conversa em `metrics.conversations`.
- Medir tamanho médio e máximo dos payloads de heartbeat/snapshot em cenários
  com centenas de conversas (`payloadMetrics` por cliente e por relatório).
- Ajustar o heartbeat para payload incremental quando fizer sentido:
  - heartbeat leve com capability `heartbeat-incremental-v1`;
  - inventário completo permanece em `/bridge/snapshot`;
  - compatibilidade preservada no protocolo 2.
- Melhorar política de concorrência de assets:
  - limite global de fetches simultâneos no bridge;
  - backoff por host após falhas repetidas;
  - cache por URL com TTL;
  - falha de mídia como warning rastreável no relatório, sem bloquear o
    Markdown principal.
- Revisar o lazy-load adaptativo com métricas reais:
  - crescer batch apenas quando houve avanço estável;
  - reduzir agressivamente quando o DOM não cresce ou o comando expira;
  - registrar no relatório quando o fim do histórico não foi provado.

### Critérios de aceite

- O relatório deve permitir identificar se o gargalo foi navegador, bridge,
  assets, escrita em disco ou rolagem do Gemini.
- Exportações retomadas não devem repetir trabalho já salvo, exceto quando o
  usuário pedir reexport explícito.
- Em rede ruim ou Gemini lento, o job deve degradar para mais warnings/retries,
  não para travamento silencioso.

## v0.4.0 — UX guiada para importação completa

Status: implementada.

Objetivo: fazer o fluxo que o usuário realmente quer ficar explícito para o
agente e para a extensão: listar todo o Gemini Web, cruzar com o vault, baixar
somente o que falta e retomar quando interromper.

### Entregas

- Tornar `gemini_export_missing_chats` o caminho recomendado para "importar
  todo o histórico para o vault".
- Adicionar mensagens de progresso mais humanas:
  - "listando histórico do Gemini";
  - "cruzando com o vault";
  - "baixando somente o que falta";
  - "retomando do relatório anterior";
  - "histórico inteiro verificado" ou "não consegui confirmar o fim".
- Adicionar resumo final orientado a decisão:
  - `decisionSummary.totals.geminiWebSeen`;
  - `decisionSummary.totals.existingInVault`;
  - `decisionSummary.totals.downloadedNow`;
  - `decisionSummary.totals.mediaWarnings`;
  - `decisionSummary.totals.failed`;
  - `decisionSummary.reportFile`;
  - `decisionSummary.resumeCommand`.
- Evitar listagens gigantes no chat:
  - mostrar amostra curta;
  - salvar lista completa no relatório;
  - usar paginação só quando o usuário pedir inspeção.
- Melhorar a UX da extensão Chrome quando o MCP estiver ausente:
  - explicar em português simples que vai cair em Downloads;
  - apontar como configurar destino;
  - nunca esconder que assets podem ter ficado como placeholders.

### Critérios de aceite

- Quando o usuário pedir "importar todo o histórico", o agente não deve tentar
  baixar tudo cegamente nem listar centenas de conversas no chat.
- O fluxo padrão deve ser: inventário completo, cruzamento com vault, download
  apenas dos faltantes, relatório incremental e retomada por `resumeReportFile`.
- Ao final, o usuário deve saber se acabou de verdade ou se precisa retomar.

## v0.4.1 — Resiliência da extensão Chrome

Status: implementada.

Objetivo: reduzir casos em que a extensão fica carregada, mas antiga, lenta ou
sem responder ao MCP.

### Entregas

- Expor no diagnóstico a diferença entre:
  - service worker vivo;
  - content script injetado;
  - aba Gemini conectada;
  - build stamp esperado;
  - build stamp em execução.
  - entregue via `gemini_browser_status.extensionReadiness` e
    `gemini_diagnose_environment.extension.readiness`.
- Tornar o reload automático mais visível no status:
  - quando tentou;
  - quando funcionou;
  - quando o Chrome ainda manteve versão antiga;
  - quando exige clique manual no card da extensão unpacked.
  - entregue via `extensionReadiness.reload.*`.
- Adicionar timeout/recuperação para ping da extensão:
  - retry curto;
  - erro acionável;
  - sugestão de reload somente depois da tentativa automática.
  - entregue no content script com retry curto e métricas
    `metrics.extensionPing`.
- Melhorar diagnóstico do top-bar:
  - separar ausência normal em home/settings de quebra real em conversa;
  - incluir candidatos DOM quando a URL for conversa válida;
  - manter o console silencioso fora de falha real.
  - entregue em `page.topBar` e no warning único após o grace period.
- Criar smoke manual documentado para DevTools:
  - build stamp;
  - `__geminiMdExportDebug.findTopBar()`;
  - abertura do modal;
  - seletor de pasta;
  - save via bridge;
  - fallback para Downloads.
  - entregue no README/contexto da extensão Gemini CLI.

### Critérios de aceite

- O agente deve tentar reload/self-heal antes de pedir ação manual ao usuário.
- Se a extensão carregada for antiga, o erro deve dizer versão esperada, versão
  em execução e qual passo falta.
- Falhas de top-bar não devem impedir export via hotkey/API de debug quando o
  content script está funcional.

## v0.4.2 — Estabilidade e performance direta da extensão

Status: implementada.

Objetivo: melhorar diretamente a experiência da extensão Chrome durante uso real
no Gemini Web: menos travamentos, menos trabalho repetido no DOM, exportações
mais previsíveis e listas grandes usáveis.

### Entregas

- Reduzir custo dos observers no content script:
  - auditar todos os `MutationObserver`;
  - coalescer ticks com scheduler único;
  - evitar reprocessar botão/top-bar/lista quando nada relevante mudou;
  - registrar métricas leves de quantos ticks foram ignorados/processados.
  - entregue via `scheduleDomWork`, `metrics.domScheduler` e coalescing de
    top-bar/sidebar/modal.
- Backpressure no canal bridge/extensão:
  - impedir múltiplos comandos pesados simultâneos na mesma aba;
  - rejeitar/adiar comando novo quando já houver export/listagem em andamento;
  - mensagens claras: "já existe um job rodando" ou "aguardando a aba terminar".
  - entregue via `tab-backpressure-v1`, `activeTabOperation` e resposta
    `busy=true` para comandos concorrentes.
- Cache incremental do sidebar/modal:
  - não reconstruir a lista inteira a cada heartbeat quando só chegaram poucos
    itens;
  - preservar seleção, filtro e scroll sem redesenho completo;
  - manter deduplicação por `chatId`/URL/título com fonte (`sidebar`/`notebook`).
  - entregue mantendo cache incremental e render estável por janela virtual.
- Virtualização simples da lista do modal:
  - renderizar apenas a janela visível quando houver centenas de conversas;
  - preservar navegação por teclado/seleção;
  - evitar `innerHTML` gigante a cada atualização.
  - entregue com `MODAL_VIRTUALIZATION_THRESHOLD` e classe `.gm-list.is-virtual`.
- Progress dock orientado por fases reais:
  - diferenciar navegação, hidratação, escrita e retorno;
  - mostrar quando o job está retomando relatório anterior;
  - evitar sensação de travamento em conversas longas.
  - entregue via `progress.phase` no dock/status.

### Critérios de aceite

- Em histórico grande, abrir/filtrar/selecionar no modal não deve congelar a
  página por redesenho completo da lista.
- Um job em andamento deve impedir comandos concorrentes perigosos na mesma aba.
- O usuário deve enxergar a fase real do trabalho no export local/MCP.

## v0.4.3 — Afinidade confiável entre agente e aba Gemini

Status: implementado em v0.4.3.

Objetivo: permitir várias instâncias de MCP/CLI/agente usando várias abas do
Gemini Web de forma previsível, sem depender da aba ativa, do último heartbeat
ou de escolha implícita da bridge.

### Problema

Hoje a bridge recebe heartbeats de várias abas Gemini e tende a preferir a aba
ativa ou mais recente. Isso é aceitável para uso simples, mas vira bagunça
quando há múltiplas sessões Gemini CLI, múltiplos agentes ou múltiplas abas
Gemini abertas. Um agente pode listar/exportar a aba errada sem perceber.

### Entregas

- Modelo de identidade de aba:
  - `clientId` estável por content script;
  - `tabId`/`windowId` vindos do service worker quando disponíveis;
  - URL, `chatId`, notebook/project id, título e `isActiveTab`;
  - `lastSeenAt`, `lastHeartbeatAt`, `buildStamp` e saúde do canal.
- Modelo de sessão/claim:
  - cada MCP/CLI/agente recebe ou informa um `sessionId`;
  - uma sessão pode fazer claim de uma aba Gemini específica;
  - a claim tem TTL/lease renovável;
  - job em execução mantém a claim até terminar/cancelar;
  - claims expiradas são liberadas automaticamente.
- Roteamento explícito:
  - tools e endpoints aceitam `clientId`, `tabId` ou `claimId`;
  - se a sessão já tem claim, ela vence fallback por aba ativa;
  - se não há claim e existem várias abas candidatas, retornar erro
    acionável pedindo escolher/listar abas em vez de adivinhar;
  - fallback por aba ativa só é permitido quando há uma única candidata ou
    quando o caller pede explicitamente.
- Novas capacidades operacionais:
  - listar abas Gemini conectadas com estado/URL/chat atual;
  - reivindicar aba por `clientId`/`tabId`/chat atual;
  - liberar claim;
  - mostrar claim atual;
  - trocar claim de sessão com confirmação quando houver job em andamento.
- Indicador visual na aba reivindicada:
  - usar a barra de abas do navegador, não o DOM da página Gemini;
  - caminho principal: `chrome.tabs.group()` + `chrome.tabGroups.update()`
    para criar/atualizar um Tab Group colorido com label curto (`GME ...`);
  - fallback quando a aba já está em grupo do usuário ou a API não está
    disponível: badge da extensão e prefixo curto no título da aba;
  - cor/label diferente por sessão quando houver múltiplas claims;
  - não alterar grupo de abas já criado pelo usuário;
  - desaparecer quando a claim expirar/liberar.
- Abertura automática:
  - `gemini_list_tabs`, `gemini_claim_tab` e o guard das tools
    browser-dependent tentam abrir `https://gemini.google.com/app` quando não
    existe aba conectada;
  - o hook Windows e o MCP compartilham cooldown para evitar abrir abas
    duplicadas enquanto uma tentativa já está em andamento.
- Integração com jobs:
  - `gemini_export_recent_chats`, `gemini_export_missing_chats`,
    `gemini_reexport_chats` e notebook exports prendem a aba por claim;
  - status do job mostra `clientId`, `tabId`, `claimId` e sessão dona;
  - cancelamento libera a claim;
  - retomada por relatório tenta voltar para a mesma aba, mas pede escolha se
    ela não estiver conectada.
- Preparação para CLI:
  - CLI futura deve poder usar `--tab`, `--claim`, `tabs list`, `tabs claim`,
    `tabs release`;
  - MCP continua usando o mesmo modelo, sem lógica paralela.

### Critérios de aceite

- Com duas abas Gemini abertas, o agente não deve exportar nada sem saber qual
  aba está usando.
- Duas sessões diferentes devem conseguir usar duas abas diferentes ao mesmo
  tempo sem roubar comandos uma da outra.
- Uma sessão com claim não deve ser redirecionada para a aba ativa por engano.
- Sem aba conectada, o agente deve tentar abrir uma aba Gemini antes de pedir
  intervenção manual.
- O indicador visual não deve ser overlay dentro da página; deve usar Tab Group
  nativo quando possível.
- O usuário deve conseguir ver visualmente qual aba está "presa" ao exporter.
- Se a aba reivindicada fecha ou fica stale, a próxima tool deve retornar erro
  claro e pedir escolher outra aba, não cair silenciosamente em outra.

## v0.4.4 — Interação DOM mais rápida e previsível

Status: implementada em `0.4.6`.

Objetivo: acelerar e endurecer o caminho crítico entre agente e aba Gemini, sem
contar com cache como solução principal. Esta fase mira duas fontes de latência
percebida: o handshake inicial Chrome/extensão/aba e o trabalho do content
script dentro da página, como abrir sidebar, encontrar o scroller certo,
carregar mais histórico, navegar por conversas, aguardar a SPA estabilizar e
extrair Markdown sem disputar o DOM.

### Problema

O bridge/MCP aquecido responde em milissegundos, mas o primeiro contato com
Chrome/extensão pode ficar lento quando o service worker MV3 precisa acordar,
o content script precisa reconectar, a versão precisa ser validada ou um
self-heal pós-update precisa recarregar a extensão. Depois disso, comandos que
interagem com a página dependem do tempo do Angular/Gemini, de lazy-load do
sidebar, de renderização parcial e de navegação SPA. Quando essa camada usa
esperas fixas, múltiplas microchamadas ou escolhe o container de scroll errado,
a experiência parece lenta mesmo com a bridge saudável.

### Entregas

- Handshake Chrome/extensão mais rápido:
  - separar caminho frio, caminho quente e caminho pós-update nos status;
  - criar uma checagem leve de readiness que valide bridge, extensão, aba,
    versão/protocolo/build e canal de comando sem trazer snapshot grande;
  - usar `/bridge/events` conectado como sinal forte de prontidão quando
    disponível;
  - evitar reload/self-heal quando o runtime já está compatível;
  - demover clientes sem `tabId`, sem versão ou incompatíveis para diagnóstico
    sem poluir seleção/ambiguidade de abas;
  - expor métricas `bridgeReadyMs`, `extensionInfoMs`, `reloadMs`,
    `firstHeartbeatMs`, `firstSnapshotMs` e `commandChannelReadyMs`.
- Pré-aquecimento controlado:
  - permitir warmup leve no primeiro status/hook antes de comandos pesados;
  - não abrir ou focar navegador quando já houver aba conectada;
  - respeitar cooldown para evitar várias tentativas simultâneas;
  - registrar se a lentidão veio de acordar Chrome, acordar service worker,
    recarregar extensão ou esperar heartbeat da aba.
- Waiters por estado real:
  - substituir sleeps fixos por predicados observáveis;
  - esperar explicitamente sidebar aberto, lista crescida, spinner ausente,
    URL estabilizada, assinatura de DOM nova e rows estáveis;
  - retornar erro de fase quando o estado esperado não aparece.
- Scroll adaptativo do histórico:
  - ranquear candidatos de scroller por overflow real, presença de rows,
    posição visual e crescimento após scroll;
  - rolar em passos adaptativos em vez de repetir o mesmo movimento;
  - parar cedo após ciclos sem crescimento;
  - registrar quando o fim do histórico foi provado ou apenas inferido.
- Operações DOM compostas por intenção:
  - preferir comandos grandes dentro da aba, como "liste N", "carregue até N",
    "abra e exporte estes ids";
  - reduzir round-trips MCP/bridge durante uma mesma operação DOM;
  - devolver relatório compacto com fases e decisões tomadas.
- Fila serial por aba como contrato central:
  - listar, scrollar, abrir chat, exportar e voltar passam por uma fila única;
  - comandos concorrentes recebem `busy`/posição de fila quando seguro;
  - cancelamento limpa a operação ativa sem deixar a aba em estado ambíguo.
- Estabilização de lista e conversa:
  - considerar sidebar pronto somente quando container, contagem de rows e
    primeira/última conversa ficarem estáveis por alguns frames;
  - expandir assinatura leve de DOM para navegação e listagem;
  - manter a regra de integridade: URL nova com DOM antigo nunca libera export.
- Menos layout thrash:
  - separar fases de leitura e escrita no DOM;
  - evitar loops que misturam `querySelectorAll`, `getBoundingClientRect`,
    scroll e mutação no mesmo ciclo;
  - usar snapshots de DOM em lote para decidir antes de tocar a página.
- Navegação rápida quando segura:
  - usar URL direta `/app/<chatId>` quando o `chatId` já é confiável;
  - reservar clique em row para cadernos/notebooks ou casos sem id explícito;
  - medir e reportar `directNavigation` versus `rowClickNavigation`.
- Timeouts por fase:
  - substituir timeout global por orçamentos de `openSidebar`, `findScroller`,
    `loadMore`, `routeSettle`, `hydrateConversation`, `extractMarkdown` e
    `returnToNotebook`;
  - permitir retry local de fases idempotentes;
  - retornar mensagens acionáveis em português simples.
- Métricas de fase para performance real:
  - expor tempos por fase em `snapshot`, status de job e relatório;
  - incluir tentativas de scroll, crescimento observado, scroller escolhido,
    motivo de parada e tempo até estabilidade;
  - usar esses dados para decidir se futuras otimizações devem mexer no DOM,
    no transporte da bridge ou no Gemini CLI.

### Critérios de aceite

- `gemini_list_recent_chats` com `refresh=true` deve carregar uma página nova
  sem depender de sleeps fixos e deve explicar a fase exata quando falhar.
- O primeiro status após Chrome já aberto deve conseguir diferenciar handshake
  quente, handshake frio e self-heal pós-update, com tempos separados.
- Quando a extensão já está compatível, o guard não deve gastar dezenas de
  segundos tentando reload desnecessário.
- Em histórico grande, o lazy-load deve crescer enquanto houver evidência de
  novos itens e parar com motivo claro quando não houver.
- Uma operação pesada por aba não deve ser interrompida por outra operação DOM
  da mesma aba.
- Export após navegação SPA continua protegido contra conteúdo trocado.
- O relatório/status deve mostrar se a demora veio de sidebar, scroll,
  navegação, hidratação ou extração.

## v0.4.5 — Sincronização incremental do vault

Status: implementada em `0.4.6`.

Objetivo: transformar "sincronizar com o Gemini Web" em um fluxo sem atrito:
quando o vault já estava 100% sincronizado e novas conversas foram criadas
depois, o exporter deve identificar apenas as conversas novas, baixá-las e
atualizar o estado local sem listar centenas de chats nem exigir decisão manual.

### Problema

Hoje o fluxo principal já sabe cruzar Gemini Web com vault, mas o usuário pensa
em termos de produto: "atualize meu vault". Se cada sincronização precisar
percorrer todo o histórico, listar conversas no chat ou perguntar o que baixar,
o fluxo fica lento e inseguro. A sincronização precisa parar em uma fronteira
conhecida, não em uma quantidade arbitrária.

### Entregas

- Estado local de sincronização:
  - criar/usar arquivo como `.gemini-md-export/sync-state.json` no vault;
  - guardar `lastFullSyncAt`, `lastSuccessfulSyncAt`, `topChatId`,
    `boundaryChatIds`, versão/protocolo do exporter e último relatório;
  - atualizar o estado apenas quando a sincronização terminar com fronteira
    comprovada ou histórico completo verificado.
- Índice local do vault:
  - escanear arquivos existentes por nome, frontmatter e links Gemini;
  - montar índice por `chatId` antes de baixar;
  - tolerar arquivos movidos/renomeados sem criar duplicatas;
  - preservar frontmatter/manual edits de notas já existentes.
- Fronteira confiável:
  - listar Gemini Web do topo para baixo;
  - parar quando encontrar o `topChatId` anterior ou uma sequência suficiente
    de conversas já conhecidas;
  - se a fronteira não aparecer, continuar até provar fim do histórico ou
    retornar estado "baixei novas, mas não provei sincronização completa".
- Download incremental:
  - colocar somente `chatId`s ausentes na fila;
  - pular existentes silenciosamente;
  - sobrescrever apenas quando o usuário pedir reexport;
  - relatório incremental permite retomar sem baixar de novo o que já salvou.
- UX de comando/progresso:
  - criar tool/endpoint `gemini_sync_vault` ou consolidar semântica em
    `gemini_export_missing_chats` com modo `sync`;
  - mensagens orientadas ao usuário: "verificando desde a última
    sincronização", "encontrei N conversas novas", "baixando N novas",
    "vault atualizado";
  - nunca despejar a lista inteira no chat;
  - resumo final com novas baixadas, já existentes, falhas, warnings de mídia,
    fronteira encontrada e caminho do relatório.
- Retomada e consistência:
  - se cair no meio, retomar pelo relatório anterior;
  - não avançar `topChatId`/fronteira quando houve falha crítica;
  - registrar quando o sync foi parcial, completo ou inconclusivo.
- Preparação para CLI:
  - a futura CLI deve expor isso como `gemini-md-export sync`;
  - MCP, CLI e UI devem compartilhar a mesma semântica de sync incremental.

### Critérios de aceite

- Se o vault estava totalmente sincronizado e surgiram 7 conversas novas, o
  usuário deve poder pedir "sincronizar" e obter apenas essas 7 conversas.
- O fluxo não deve exigir que o agente liste centenas de conversas no chat.
- O exporter deve provar que encontrou uma fronteira conhecida ou declarar que
  a sincronização ficou parcial/inconclusiva.
- Repetir o sync logo em seguida deve resultar em "nenhuma conversa nova" sem
  percorrer o histórico inteiro.
- Arquivos existentes no vault não devem ser sobrescritos sem pedido explícito.

## v0.4.6 — Observabilidade e recuperação assistida

Status: primeiro incremento implementado em `0.4.6`.

Objetivo: reduzir o tempo entre "travou" e "sabemos onde travou". Esta fase não
substitui as melhorias diretas da `v0.4.2` nem o roteamento confiável da
`v0.4.3`, nem a otimização DOM da `v0.4.4`, nem o sync incremental da
`v0.4.5`; ela melhora diagnóstico, suporte, reprodução e retomada segura antes
da migração CLI-first.

### Entregas

- Flight recorder local:
  - log circular JSONL com eventos operacionais recentes;
  - sem conteúdo dos chats por padrão;
  - eventos de bridge start/stop, modo proxy, reload de extensão, heartbeat
    atrasado, comando enviado, timeout, queda de SSE/long-poll, mudança de fase
    de job, warning de asset e falha de escrita;
  - limite de tamanho e rotação para não crescer sem controle.
- Support bundle seguro:
  - script/comando que gera um `.zip` ou pasta de diagnóstico;
  - inclui `/agent/diagnostics`, `/healthz`, versão/protocolo/build, processos,
    dono da porta, config relevante sem segredos, últimos eventos do flight
    recorder e último relatório de job;
  - exclui Markdown/conteúdo dos chats por padrão;
  - só inclui raw exports quando o usuário pedir explicitamente.
- Safe mode para máquinas lentas/instáveis:
  - preset conservador para Windows ou PCs ruins;
  - batches menores;
  - concorrência de assets menor;
  - timeouts maiores;
  - menos tentativas agressivas de reload;
  - mensagens de progresso mais explícitas;
  - retomada por relatório sempre orientada.
- Journal granular de job:
  - registrar por conversa as fases `queued`, `opened`, `hydrated`,
    `extracted`, `media`, `saved`, `verified`, `failed`;
  - permitir identificar com precisão onde caiu;
  - evitar trabalho repetido quando uma etapa já foi comprovadamente concluída.
- Testes de fault injection:
  - extensão desconecta no meio do job;
  - service worker para de responder;
  - `/bridge/events` cai e precisa voltar por heartbeat/long-poll;
  - asset timeout;
  - URL nova com DOM antigo;
  - porta ocupada;
  - primário antigo/incompatível;
  - scroll do Gemini não cresce.
- Fixtures reais sanitizadas:
  - snapshots de DOM do Gemini para sidebar, top-bar, conversa e notebook;
  - sem dados pessoais;
  - usadas para proteger scraping/injeção contra mudanças silenciosas do Gemini.

### Critérios de aceite

- Ao receber um relato "ficou lento/travou", o agente deve conseguir pedir um
  bundle seguro e dizer a fase provável da falha sem acesso ao PC.
- O bundle não deve vazar conteúdo de chats por padrão.
- Safe mode deve sacrificar velocidade para reduzir timeouts em Windows lento.
- Fault injection deve cobrir pelo menos uma falha de transporte, uma falha de
  DOM, uma falha de asset e uma falha de processo/porta.

## v0.4.7 — Readiness semântica no hook do Gemini CLI

Status: implementada em `0.4.7`.

Objetivo: trocar a decisão "há clients conectados?" por "há uma aba Gemini
realmente pronta para uso?", sem perder compatibilidade durante updates.

### Entregas

- O hook `BeforeTool` consulta primeiro
  `/agent/ready?wakeBrowser=false&selfHeal=false`.
- `/agent/clients` permanece como fallback para bridges antigos e endpoint de
  inspeção manual.
- O hook só pula launch quando `ready=true`; quando existe cliente conectado mas
  não pronto por versão/protocolo/canal de comando, ele não abre uma aba extra e
  deixa o MCP retornar o erro acionável.
- Depois de abrir o navegador, o hook aguarda `/agent/ready` retornar
  `ready=true`, não apenas qualquer heartbeat bruto.
- `/agent/ready` passa a incluir `blockingIssue` para explicar o motivo de não
  estar pronto (`no_connected_clients`, `extension_version_mismatch`,
  `no_selectable_gemini_tab`, `command_channel_not_ready`).

### Critérios de aceite

- Uma aba Gemini pronta continua silenciosa e não dispara launch.
- Sem aba conectada, o hook ainda abre `https://gemini.google.com/app` no
  Windows pelo launcher minimizado.
- Cliente conectado mas não pronto não gera aba duplicada.
- Bridges antigos ainda funcionam via fallback para `/agent/clients`.

## v0.5.0 — Streamline MCP com Gemini CLI Agent Skills

Status: implementado.

Objetivo: reduzir contexto permanente do agente e tornar os fluxos longos mais
confiáveis por progressive disclosure: MCP público pequeno, `GEMINI.md` curto e
playbooks em skills da extensão Gemini CLI.

### Entregas

- Publicar somente 7 tools MCP:
  - `gemini_ready`;
  - `gemini_tabs`;
  - `gemini_chats`;
  - `gemini_export`;
  - `gemini_job`;
  - `gemini_config`;
  - `gemini_support`.
- Manter os handlers antigos apenas como implementação interna.
- Remover nomes antigos de `tools/list`; chamadas diretas aos nomes antigos
  retornam `code: "tool_renamed"` com `{ tool, arguments }` exato.
- Respostas compactas por padrão: `ok`, `ready/status`, ids, contagens,
  `progressMessage`, `nextAction`, paths e warnings essenciais.
- `detail: "full"` libera diagnóstico rico quando necessário.
- Preservar endpoints HTTP `/agent/*` para debug manual/local.
- Reescrever `gemini-cli-extension/GEMINI.md` como roteador curto:
  - qual tool chamar;
  - quando ativar skill;
  - guardrails: sem APIs privadas/cookies, sem despejar histórico inteiro no
    chat, sem reload manual antes do self-heal.
- Adicionar skills empacotadas em `gemini-cli-extension/skills/`:
  - `gemini-vault-sync`;
  - `gemini-vault-repair`;
  - `gemini-mcp-diagnostics`;
  - `gemini-tabs-and-browser`.
- Adicionar comando top-level `/sync` para o humano disparar sync completo do
  vault conhecido sem precisar lembrar a chamada MCP.
- Copiar `skills/` no build para `dist/gemini-cli-extension/skills/`.
- Atualizar hooks para os 7 nomes novos, com pré-launch action-aware.
- Atualizar runner de reparo, smoke tests e docs operacionais para as tools
  novas.
- Atualizar a skill Codex `gemini-cli-extension-autoupdate` para documentar
  skills de extensões Gemini CLI como mecanismo oficial de playbooks.

### Critérios de aceite

- `tools/list` retorna exatamente os 7 nomes públicos.
- Nomes antigos não executam e retornam migração explícita.
- `GEMINI.md` permanece pequeno e referencia skills em vez de embutir
  playbooks.
- Build contém `skills/<name>/SKILL.md` com frontmatter.
- Export/sync/repair/status continuam passando pelos handlers já testados.
- Hook do navegador acorda o Chrome apenas para ações que dependem do browser.

## v0.5.1 — CLI/TUI de exportação sobre a bridge local

Status: implementada; validação visual no Gemini CLI real ainda recomendada
antes de release amplo.

Objetivo: conciliar UX humana no Gemini CLI com saída estável para agentes.
O mesmo binário fala direto com a bridge local, sem passar pelo MCP, e escolhe
automaticamente a melhor apresentação.

Nota: o rascunho técnico no workspace foi mantido e agora está sendo fechado em
ordem como a próxima etapa do roadmap. Ele ainda não deve ser publicado como
release até os critérios abaixo ficarem verdes.

### Decisão

- TUI/barra de progresso para humanos quando houver TTY/pty.
- Modo `--plain` para agente: progresso em linhas estáveis e `RESULT_JSON`
  final curto.
- Modo `--json` para automação que só precisa do resultado final.
- Modo `--jsonl` para automação que precisa consumir progresso evento a evento.
- Sem dependências externas de TUI: o Gemini CLI já pode fornecer pty via
  `tools.shell.enableInteractiveShell`; quando não fornece, o binário cai para
  modo de linhas sem ANSI.
- MCP continua existindo como fallback e interface curta de status/config.

### Rascunho técnico atual

- `bin/gemini-md-export.mjs` como script Node executado pelo Node já disponível
  no ambiente; não há runtime Node empacotado.
- Subcomandos iniciais `sync`, `doctor`, `job status` e `job cancel`.
- Contrato de ajuda implementado para `help`, `--help`, `<comando> --help`,
  `--version`, exemplos, formatos de saída e exit codes.
- Painel TUI com fase, barra, conversa atual, contadores, warnings e
  relatório.
- Saídas `--plain`, `--json` e `--jsonl` para compatibilizar humano, agente e
  automação.
- Build copia `bin/` para `dist/gemini-cli-extension/`.
- Testes cobrem bundle e contratos básicos de saída.

### Pendências de validação

- Validar no Gemini CLI real como a TUI se comporta com e sem shell interativo
  configurado.

## v0.6.0 — CLI-first sobre a bridge local

Status: implementada.

Objetivo: tornar a CLI a interface operacional principal para agentes e
usuários avançados, usando a bridge local existente como camada de integração
com a extensão Chrome e o Gemini Web.

### Arquitetura desejada

```text
Agente ou terminal humano
  -> gemini-md-export CLI
  -> bridge local HTTP/SSE
  -> extensão Chrome
  -> Gemini Web
```

O ponto central: a CLI é uma interface para a bridge. Ela não substitui a
extensão nem o bridge local, porque o conteúdo ainda vem do DOM do Gemini Web
logado no navegador. O que sai do caminho crítico é o MCP como superfície
primária para jobs longos.

### Estado Implementado

- A CLI fala direto com `/agent/*` e não chama MCP para jobs longos.
- `src/bridge-server.js` é o entrypoint próprio da bridge local. Ele reutiliza o
  core atual em modo `--bridge-only`, mas não abre servidor MCP por `stdio`.
- `src/mcp-server.js --bridge-only` continua disponível como compatibilidade de
  baixo nível.
- A CLI inicia automaticamente a bridge em modo `bridge-only` quando ela está
  indisponível, preservando `--no-start-bridge` para diagnósticos controlados.
- Quando um MCP encontra a bridge já ativa, ele entra em proxy e encaminha
  chamadas para `/agent/mcp-tool-call`; isso faz o MCP operar como cliente fino
  da bridge quando há um primário `bridge-only`.

### Separação MCP/Bridge

Papéis implementados:

```text
bridge daemon/processo local
  -> HTTP/SSE para extensão Chrome
  -> endpoints /agent/* para CLI e MCP

CLI
  -> cliente principal da bridge para jobs longos

MCP
  -> cliente fino/opcional da bridge para readiness, status, tabs, config e
     compatibilidade
```

Essa separação evita que MCP seja o único dono do ciclo de vida da bridge. O MCP
ainda existe para compatibilidade/discovery, mas a CLI consegue manter a bridge
disponível sem passar por MCP.

### Entregas

- Criar contrato de ajuda da CLI antes dos comandos operacionais:
  - `help`;
  - `--help`;
  - `<comando> --help`;
  - `--version`;
  - exemplos curtos;
  - formatos de saída;
  - tabela de exit codes.
- Criar `bin/gemini-md-export` com subcomandos estáveis:
  - `doctor`;
  - `browser status`;
  - `export recent`;
  - `export missing`;
  - `export resume`;
  - `job status`;
  - `job cancel`;
  - `export-dir get/set`;
  - `cleanup stale-processes`;
  - `repair-vault`.
- Saída humana por padrão, com TUI/progresso bonito quando o terminal for
  interativo:
  - painel de status do job;
  - barras por fase;
  - conversa atual;
  - contadores de vistos/existentes/baixados/falhados;
  - warnings de mídia;
  - caminho do relatório;
  - comando de retomada.
- Modo `--plain` com texto estável, sem ANSI nem redesenho de terminal, para
  agentes/LLMs lerem bem quando não precisarem de parsing rígido.
- Bloco final `RESULT_JSON` curto em saídas humanas/plain, com campos
  essenciais para automação:
  - `status`;
  - `jobId`;
  - `reportFile`;
  - `resumeCommand`;
  - `webConversationCount`;
  - `existingVaultCount`;
  - `downloadedCount`;
  - `warningCount`;
  - `failedCount`;
  - `fullHistoryVerified`.
- `--json` para resultado final estruturado puro, sem texto humano.
- `--jsonl` reservado para integrações que realmente precisam consumir
  progresso evento a evento.
- Exit codes estáveis:
  - sucesso completo;
  - sucesso com warnings;
  - ação manual necessária;
  - bridge indisponível;
  - extensão antiga/incompatível;
  - job falhou;
  - uso inválido.
- Jobs longos devem gravar relatório incremental com caminho explícito para
  retomada. O progresso visual da TUI e o `RESULT_JSON` final vêm do mesmo
  estado persistido pela bridge.
- Separar a bridge em entrypoint/processo próprio antes de tornar a CLI o
  caminho recomendado.
- Preservar um modo `bridge-only` testado para ambientes onde a bridge deve
  ficar viva sem depender do MCP do Gemini CLI.
- Permitir que a CLI acorde a bridge local em modo `bridge-only` antes de
  chamar `/agent/*`, sem passar por MCP.
- Transformar o MCP em cliente fino da bridge, preservando as 7 tools públicas e
  os erros de migração dos nomes antigos.
- Atualizar `gemini-cli-extension/GEMINI.md`, comandos e skill para orientar:
  - usar CLI para exportações longas;
  - usar MCP apenas quando a tool nativa for indispensável ou legado;
  - nunca despejar centenas de conversas no chat quando houver relatório.
- Manter compatibilidade com o bridge atual, sem exigir login/API oficial do
  Gemini.

### Critérios de aceite

- Um agente consegue executar "importar todo o histórico" somente com CLI +
  skill/contexto, sem chamar tool MCP.
- O mesmo comando pode ser copiado e rodado por um humano no terminal.
- `gemini-md-export --help` e `<comando> --help` dão contexto suficiente para um
  agente usar a CLI sem depender de playbook longo.
- Em terminal interativo, o usuário vê uma UI de progresso legível dentro do
  Gemini CLI.
- Em execução por agente, `--plain` + `RESULT_JSON` final dá contexto humano e
  contrato mínimo sem obrigar o LLM a interpretar TUI/ANSI.
- A saída `--jsonl` continua disponível para automação que precise acompanhar
  progresso sem timeout de tool call.
- Retomada por relatório funciona igual ou melhor que no MCP.
- Erros comuns geram mensagens e exit codes acionáveis, sem stack trace como
  resposta principal.
- A bridge continua disponível para a extensão/CLI mesmo quando MCP estiver
  desabilitado, em proxy ou não carregado pelo Gemini CLI.

## v0.7.0 — MCP opcional/legado

Status: implementada na versão `0.7.0`.

Objetivo: reduzir o MCP a uma camada opcional de compatibilidade, mantendo a
CLI como caminho recomendado para operações reais.

### Decisão consolidada

A arquitetura `CLI-first` não elimina a necessidade de skills. Ela redistribui
responsabilidades para reduzir contexto permanente e deixar cada superfície
fazer o que faz melhor:

- CLI/TUI é o caminho de execução e UX para jobs longos:
  - `sync`;
  - `export missing`;
  - `export recent`;
  - `export resume`;
  - `export reexport`;
  - `export notebook`;
  - `doctor`;
  - `repair-vault`.
- `gemini-md-export --help` e `<comando> --help` viram a fonte da verdade para
  sintaxe, flags, formatos de saída e exit codes.
- Bridge local continua sendo a integração com Chrome/Gemini Web: HTTP/SSE,
  abas conectadas, escrita no vault, jobs e progresso.
- MCP fino fica como plano de controle e compatibilidade:
  - readiness/status;
  - tabs/claim/reload;
  - config;
  - suporte/diagnóstico;
  - mensagens de migração para comandos CLI.
- Skills continuam como playbooks enxutos de julgamento operacional:
  - quando usar `/sync` ou `gemini-md-export sync`;
  - quando retomar por relatório em vez de recomeçar;
  - como lidar com aba errada/múltiplas abas;
  - como diagnosticar bridge/extensão lenta;
  - como fazer repair sem sobrescrever trabalho manual.

Regra principal: o MCP não deve chamar a CLI por baixo para executar jobs
longos. Quando a operação real for export/sync/repair prolongado, o agente deve
usar a CLI diretamente; o MCP só orienta, diagnostica ou retorna migração
acionável.

### Entregas

- Marcar no contexto do agente que jobs longos devem usar CLI.
- Manter MCP apenas para:
  - compatibilidade com instalações antigas;
  - discovery/status simples;
  - tabs/claim/reload;
  - config;
  - suporte/diagnóstico;
  - ambientes onde o agente não tenha shell disponível.
- Transformar tools MCP de export/sync/repair longo em orientação CLI-first:
  - retornar `code: "use_cli"` ou equivalente;
  - incluir comando exato em `{ command, args, cwd }`;
  - incluir `nextAction` curto em português;
  - preservar `detail: "full"` para diagnóstico, não para despejar listas
    enormes no contexto.
- Remover duplicação de lógica entre MCP e CLI:
  - ambos chamam os mesmos helpers/core;
  - nenhuma regra de exportação vive só no MCP.
- Revisar skills empacotadas para remover detalhes que agora pertencem ao
  `--help` da CLI e manter somente playbooks:
  - `gemini-vault-sync`;
  - `gemini-vault-repair`;
  - `gemini-mcp-diagnostics`;
  - `gemini-tabs-and-browser`.
- Atualizar `/sync` para apontar explicitamente para o fluxo CLI-first quando
  shell estiver disponível, usando o vault conhecido do `GEMINI.md` principal.
- Atualizar instaladores para instalar/validar CLI + extensão Chrome + bridge.
- Criar aviso de depreciação suave para tools MCP de exportação longa, apontando
  o comando CLI equivalente.
- Atualizar `README.md` para apresentar CLI/bridge como caminho recomendado e
  MCP como plano fino de controle/diagnóstico.
- Definir ciclo de vida da bridge iniciada pela CLI:
  - bridge iniciada sob demanda pela CLI usa `exit-when-idle` por padrão;
  - não encerra enquanto houver job ativo;
  - não encerra enquanto houver heartbeat recente da extensão Chrome;
  - não encerra enquanto houver request/long-poll/SSE ativo;
  - encerra após janela de inatividade configurável, por exemplo 10-15 minutos;
  - expor flags `--keep-alive-ms`, `--exit-when-idle` e `--no-exit-when-idle`
    no entrypoint da bridge/CLI;
  - preservar compatibilidade: bridge iniciada pelo MCP pode manter o
    comportamento atual, a menos que uma flag de idle seja definida.

### Critérios de aceite

- O MCP pode ser desligado sem quebrar o fluxo principal CLI + bridge.
- A documentação principal não apresenta MCP como caminho recomendado para
  export total.
- Skills não repetem manual de comandos da CLI; elas apontam para `--help` e
  focam em decisão operacional.
- `gemini-md-export --help` é suficiente para um agente descobrir sintaxe e
  opções sem depender de contexto permanente grande.
- Uma chamada MCP de export/sync longo não inicia job escondido: ela retorna o
  comando CLI recomendado e o motivo.
- O usuário ainda consegue recuperar ambientes antigos sem reinstalação brusca.
- Uma bridge iniciada automaticamente pela CLI não fica zumbi indefinidamente:
  após concluir jobs e passar a janela de idle sem clientes/requests, ela
  encerra sozinha.
- Uma bridge com job ativo, heartbeat recente ou request/stream ativo não deve
  encerrar por idle.

## v0.7.1 — Hook slimming e browser wake pela CLI

Status: implementada.

Objetivo: simplificar a estratégia de hooks depois da migração CLI-first,
deixando hooks como preparação leve da sessão e segurança de desenvolvimento,
enquanto a CLI assume a responsabilidade completa por abrir Gemini Web quando
um comando real precisa do navegador.

### Decisão consolidada

O comportamento deve ser fácil de explicar e igual para humano e agente:

```text
Gemini CLI session start
  -> hook inicia/aquece bridge local, se necessário
  -> não abre Chrome/Gemini

Humano/agente roda gemini-md-export sync/export...
  -> CLI garante bridge
  -> CLI abre Chrome/Gemini em background se nenhuma aba estiver conectada
  -> CLI espera extensão conectar
  -> CLI executa job e mostra TUI/RESULT_JSON
```

Isso evita depender de um hook invisível para a experiência funcionar. O usuário
que roda a CLI diretamente fora do Gemini CLI deve ter a mesma automação de
bridge/browser que o agente tem.

### Entregas

- Adicionar hook `SessionStart` mínimo para warmup da bridge:
  - consultar `/healthz`;
  - se a bridge não responder, iniciar `src/bridge-server.js --exit-when-idle`;
  - usar timeout curto;
  - não abrir Chrome;
  - ficar silencioso em sucesso/no-op;
  - emitir `systemMessage` apenas quando houver problema útil.
- Mover browser wake para a CLI:
  - antes de `sync`, `export recent`, `export missing`, `export resume`,
    `export reexport` e `export notebook`, a CLI chama `/agent/ready`;
  - se não houver aba Gemini conectada, a CLI abre
    `https://gemini.google.com/app` em background;
  - aguarda conexão da extensão por timeout configurável;
  - respeita flags `--no-wake`, `--ready-wait-ms`, `--no-self-heal` e
    `--no-reload`;
  - registra mensagens claras no modo humano/plain.
- Reduzir o `BeforeTool` browser hook:
  - remover `gemini_export` do prelaunch, porque no MCP ele só retorna
    `code: "use_cli"`;
  - não acordar navegador para `gemini_job`, `gemini_config get_export_dir` ou
    suporte/diagnóstico passivo;
  - manter wake apenas para tools MCP que realmente leem/alteram a aba:
    `gemini_tabs`, `gemini_chats`, `gemini_ready status` e ações explícitas de
    snapshot/cache quando necessário;
  - continuar falhando aberto quando a bridge não estiver pronta.
- Manter scope guard como hook separado de segurança de desenvolvimento:
  - sem browser launch;
  - sem consulta à bridge;
  - bloqueando apenas paths proibidos como cookies, APIs privadas,
    `chrome.debugger`, screenshots/capture fallback e permissões perigosas.
- Migrar auditoria de mídia para a CLI/resultado:
  - `RESULT_JSON` deve expor `mediaWarnings`/`warningCount`/`failedCount`;
  - a CLI deve usar exit code de warning quando mídia falhar sem bloquear o
    Markdown principal;
  - `AfterTool` de mídia pode ficar restrito a chamadas MCP pequenas ou ser
    removido se ficar redundante.
- Atualizar docs e skills para explicar:
  - hook inicial só aquece bridge;
  - CLI é dona de abrir Chrome/Gemini em background;
  - hooks não executam sync/export por baixo.

### Critérios de aceite

- Iniciar uma sessão Gemini CLI com a extensão instalada deixa a bridge pronta
  ou em processo de warmup sem abrir Chrome.
- Rodar `gemini-md-export sync ...` diretamente em um terminal humano abre
  Gemini Web em background quando necessário e prossegue sem depender de hook.
- Chamar `gemini_export` MCP não abre Chrome; retorna `use_cli` rapidamente.
- `BeforeTool` não adiciona latência perceptível a status/config/suporte
  passivos.
- Scope guard continua bloqueando caminhos proibidos em tarefas de
  desenvolvimento.
- Testes cobrem SessionStart bridge warmup, CLI browser wake e ausência de
  prelaunch para `gemini_export`.

## Pesquisa futura — Transporte da bridge local

Status: investigação condicionada.

Objetivo: decidir com dados se o transporte atual da bridge local continua
suficiente ou se WebSocket vale o custo.

### Perguntas

- A latência percebida vem do transporte da bridge, do DOM do Gemini, do
  service worker MV3, da escrita em disco ou do download de assets?
- Há perda de ordering/comandos duplicados com HTTP/SSE em jobs longos?
- WebSocket melhoraria reconexão em service worker MV3 ou aumentaria
  fragilidade por ciclo de vida do Chrome?

### Critério de decisão

Só migrar para WebSocket se os dados da `v0.3.2` mostrarem que o transporte é
gargalo real ou fonte recorrente de ordering/timeout que HTTP/SSE não resolve
com backoff, snapshot e comandos idempotentes. A decisão é independente da
migração CLI-first: a CLI pode continuar usando a mesma bridge local.

## Roadmap R2 — Extensão mais confiável, menos fricção

Status: proposta para aprovação. Não implementar sem aprovação explícita da fase
ou spike correspondente.

Nota de nomenclatura: `R2` significa segunda versão deste roadmap/proposta de
direção. Não significa "versão 2.0 da extensão" nem implica que a extensão já
tenha atingido uma `v1` de produto.

As entregas abaixo usam versões planejadas da extensão a partir de `v0.8.0`.
Essas versões são rótulos de release pretendidos, não fases abstratas.

Objetivo: parar de tratar timeouts/reloads/claims como falhas isoladas e atacar
a causa estrutural: a extensão atual opera com permissões conservadoras demais
para o nível de confiabilidade esperado. O R2 deve aumentar capacidade
operacional de forma progressiva, com cada permissão justificada por um ganho
mensurável e com rollback claro.

### Princípios

- Confiabilidade primeiro: contagem/exportação deve funcionar sem o usuário
  precisar descobrir estado interno de Chrome, service worker, bridge ou aba.
- Permissão mínima, mas não permissão fraca: pedir poderes novos quando eles
  reduzem atrito real e são usados de forma auditável.
- Nada de fallback MCP ruidoso para fluxo normal: CLI/TUI continua sendo o
  caminho usuário-final; MCP fica diagnóstico/controle explícito.
- Toda mudança de permissão exige:
  - texto de motivo no roadmap/README;
  - teste de build/manifest;
  - checklist manual Chrome/Edge;
  - plano de rollback.
- `debugger` e `<all_urls>` continuam fora do caminho principal até prova
  contrária. Se entrarem, entram por spike isolado e opt-in.

### Hipótese central

Hoje a extensão depende de uma sequência frágil:

```text
CLI -> bridge HTTP localhost -> extensão MV3/service worker -> content script
   -> DOM vivo do Gemini -> heartbeat/SSE/snapshot/comando
```

Quando uma peça está velha, dormindo ou não injetada, o usuário vê timeout. O R2
deve encurtar ou fortalecer esse caminho:

- `scripting`: reparar/injetar content script em abas Gemini já abertas;
- `nativeMessaging`: trocar ou complementar localhost por canal nativo
  extension <-> host local;
- `offscreen`: manter tarefas de coordenação do lado da extensão quando o MV3
  service worker dormir atrapalhar;
- `WebSocket`: alternativa de transporte se HTTP/SSE provar perda de ordering,
  evento ou comando em jobs longos;
- `debugger`: diagnóstico e controle profundo de aba via Chrome DevTools
  Protocol, condicional e opt-in, não caminho padrão.

## v0.8.0 — Self-heal com `scripting`

Status: implementada na versão `0.8.0`.

Objetivo: a extensão conseguir reparar abas Gemini já abertas depois de update,
reload, content script stale ou ausência de heartbeat, sem depender de o usuário
recarregar manualmente a página.

### Permissão nova

- `scripting`.

### Entregas

- Adicionar `scripting` ao manifest gerado por `scripts/build.mjs`.
- Criar no service worker uma rotina `ensureContentScript(tabId)`:
  - localizar abas `https://gemini.google.com/*`;
  - enviar ping para content script;
  - se não responder, executar `chrome.scripting.executeScript` com
    `content.js` na aba;
  - aguardar heartbeat/snapshot curto;
  - retornar diagnóstico compacto.
- Integrar self-heal em:
  - reload/update da extensão;
  - `/agent/ready`;
  - claim/list/count/export antes de abrir nova aba;
  - comando CLI `browser status`.
- Diferenciar estados:
  - aba inexistente;
  - content script ausente;
  - content script antigo/build mismatch;
  - content script vivo, mas canal de comandos parado;
  - DOM Gemini não pronto.
- Evitar loop:
  - cooldown por tabId/buildStamp;
  - limite de tentativas por readiness;
  - não reinjetar enquanto uma operação pesada da aba está ativa.
- Expor logs úteis:
  - `selfHeal.injected: true/false`;
  - `selfHeal.reason`;
  - `buildStampBefore/After`;
  - `heartbeatAfterMs`.

### Critérios de aceite

- Depois de atualizar a extensão, uma aba Gemini já aberta volta a responder sem
  reload manual na maioria dos casos.
- A CLI não abre aba nova se já há aba Gemini recuperável.
- `quantos chats` não deve falhar por content script ausente/stale sem ao menos
  tentar reinjeção por `scripting`.
- Testes de fonte garantem presença de `scripting`, `executeScript` e cooldown.
- Teste manual: abrir Gemini, atualizar extensão, rodar `chats count --plain` e
  confirmar que a aba antiga é reaproveitada.

## v0.8.1 — Spike de `nativeMessaging`

Status: implementada na versão `0.8.1` como spike de infraestrutura.

Objetivo: avaliar se um host nativo registrado no Chrome/Edge reduz a fragilidade
do transporte local em comparação com HTTP/SSE em `127.0.0.1`.

### Permissão nova

- `nativeMessaging`.

### Perguntas do spike

- O canal native messaging reduz timeouts de conexão inicial?
- Ele elimina conflito de porta `47283` ou apenas troca por problemas de
  registro do host nativo?
- Funciona de forma aceitável em macOS e Windows com instalação via Gemini CLI?
- O host consegue reaproveitar o mesmo código do MCP/bridge sem duplicação?
- Como ficam logs, diagnóstico, updates e rollback?

### Protótipo

- Criar host nativo mínimo `gemini-md-export-native-host`:
  - protocolo JSON length-prefixed do Chrome;
  - comandos: `ping`, `healthz`, `ready`, `startBridge`, `proxyHttp`;
  - sem exportação real no primeiro spike.
- Criar instaladores/registro:
  - macOS: manifest em NativeMessagingHosts;
  - Windows: registry key + manifest.
- Criar fallback:
  - se native host não existir, usar bridge HTTP atual;
  - nunca quebrar instalações antigas.
- Medir:
  - tempo de conexão inicial;
  - taxa de falha em update/reload;
  - qualidade das mensagens de erro.

### Critérios de decisão

Adotar native messaging se pelo menos dois forem verdade:

- reduz timeouts iniciais de readiness em cenário real;
- elimina conflitos recorrentes de porta/processo;
- simplifica o lifecycle da bridge para usuário final;
- permite diagnóstico melhor sem despejar JSON no agente.

Rejeitar ou adiar se:

- instalação/registro ficar mais frágil que localhost;
- troubleshooting em Windows piorar;
- exigir permissões/processos persistentes demais sem ganho claro.

## v0.8.2 — Native host como transporte primário

Status: implementada na versão `0.8.2` com native proxy preferencial e fallback
HTTP/SSE.

Objetivo: tornar native messaging o caminho preferencial extension <-> processo
local, mantendo HTTP/SSE como fallback compatível.

### Entregas

- Definir protocolo `native-bridge-v1`:
  - request/response com `id`;
  - eventos de progresso;
  - cancelamento;
  - heartbeat;
  - erro estruturado.
- Reusar o core existente:
  - `mcp-server.js` e `bridge-server.js` não devem divergir em regra de
    negócio;
  - comandos browser-dependent continuam passando pelo content script.
- Atualizar CLI:
  - detectar native host disponível;
  - usar host para health/readiness quando possível;
  - cair para HTTP quando host não estiver registrado.
- Atualizar diagnóstico:
  - mostrar `transport: native|http`;
  - mostrar caminho do host/manifest;
  - mostrar erro de registro quando houver.
- Atualizar instaladores:
  - instalar/validar host nativo;
  - reparar registro;
  - remover host antigo no uninstall/repair.

### Critérios de aceite

- Fluxos `chats count`, `export recent`, `sync` e `browser status` funcionam
  com native host e com fallback HTTP.
- Sem porta ocupada para o caminho native.
- Mensagens de erro de registro são claras e curtas.
- Usuário consegue voltar para HTTP sem reinstalar tudo.

## v0.8.3 — Avaliar `offscreen`

Status: implementada na versão `0.8.3` como fundação diagnosticável sob demanda.

Objetivo: usar um documento offscreen como contexto extension-side mais estável
para tarefas de coordenação que não pertencem ao content script nem ao service
worker efêmero.

### Permissão nova

- `offscreen`.

### Possíveis usos

- Manter fila/coordenação de mensagens enquanto service worker acorda/dorme.
- Fazer ponte com native messaging ou WebSocket se o service worker se mostrar
  instável para conexões longas.
- Persistir estado operacional leve durante exportações longas.

### Restrições

- Offscreen document não deve virar UI invisível opaca.
- Não mover scraping para offscreen; scraping continua no DOM visível do Gemini.
- Criar apenas quando necessário e fechar quando idle.

### Critérios de aceite

- Evidência antes/depois mostrando menos perda de comando/heartbeat.
- Sem aumento perceptível de consumo quando idle.
- Diagnóstico mostra se offscreen está ativo e por quê.

## v0.8.4 — Hotfix de reload pós-update

Status: implementada como correção da `0.8.3`.

Problema observado: depois do reload manual do card da extensão, o Dia podia
manter a aba Gemini rodando um content script antigo (`0.7.15`) enquanto o
service worker e os arquivos unpacked já estavam em `0.8.3`. O self-heal por
`scripting` tentava reinjetar, mas isso não substituía de forma confiável o
runtime antigo já vivo na aba.

Correção:

- após `runtime.onInstalled` e após `RELOAD_SELF`, recarregar as abas Gemini
  antes de tentar o self-heal por `scripting`;
- aguardar um curto intervalo para a página subir novamente;
- só então confirmar/reinjetar o content script atual se necessário.

Critério de aceite: depois de atualizar/recarregar a extensão unpacked, a aba
Gemini deve anunciar a mesma versão/build esperados pela bridge, sem exigir que
o usuário descubra manualmente que precisa recarregar a página.

## v0.8.5 — Hotfix de contagem e saída humana

Status: implementada como correção da `0.8.4`.

Problemas observados:

- `chats count` podia promover `browser_dom_count_match` para total confirmado
  mesmo quando `load-more-conversations` falhava porque a aba estava ocupada
  com outro comando pesado. Sintoma: resposta falsa como "13 chats ao todo".
- `tabs list`, `tabs claim` e `chats count --plain` ainda imprimiam
  `RESULT_JSON`, poluindo a tela do usuário em fluxos simples.

Correção:

- quando a falha de carregamento indica `tab_operation_in_progress`/aba
  ocupada, a contagem por DOM concordante fica bloqueada e a CLI deve retornar
  contagem parcial/falha curta;
- `tabs` e `chats count` em `--plain` passam a imprimir texto humano sem
  `RESULT_JSON`; quem precisar parsear dados deve usar `--json` ou
  `--result-json` explicitamente.

## v0.9.0 — Spike condicional de `debugger`/CDP

Status: possibilidade técnica de alto poder, no mesmo bloco de avaliação de
transporte/diagnóstico que WebSocket. Não implementar no fluxo principal sem
aprovação explícita separada.

Objetivo: descobrir se `chrome.debugger`/Chrome DevTools Protocol resolveria
problemas que `scripting` + native messaging + offscreen não resolvem.

### Benefícios possíveis para este projeto

- Inspeção mais forte de aba:
  - saber se a aba carregou, navegou, travou ou está em lifecycle estranho;
  - coletar sinais de rede/console/runtime sem depender do content script.
- Automação de recuperação:
  - recarregar/navegar/avaliar script via CDP em casos em que content script
    não entra;
  - detectar frame/contexto correto do Gemini com mais precisão.
- Instrumentação:
  - observar eventos de rede, WebSocket/fetch do próprio Gemini e erros de
    runtime;
  - medir carregamento real da página.
- Debug de campo:
  - gerar um diagnóstico muito mais rico quando o DOM muda ou a página fica
    presa.

### Custos e riscos

- Permissão assustadora: Chrome mostra "Access the page debugger backend".
- Pode conflitar com DevTools aberto ou outras ferramentas de debug.
- Aumenta muito a responsabilidade de privacidade: CDP pode observar tráfego,
  runtime e estado da página.
- Maior risco de parecer automação invasiva do Gemini, mesmo sem usar APIs
  privadas.
- Pode quebrar com mudanças de política do Chrome/loja/perfil corporativo.

### Regra de uso

Se aprovado, `debugger` deve começar como modo diagnóstico opt-in:

- desabilitado por padrão;
- ativado por flag/env/config local;
- escopo limitado a `https://gemini.google.com/*`;
- nunca usar para roubar cookies/tokens ou chamar APIs privadas;
- nunca usar `<all_urls>` junto;
- logs sanitizados.

### Critérios de decisão

Só promover além de spike se:

- `scripting` e native messaging não resolverem readiness/recovery;
- CDP provar ganho claro em reproduções reais;
- o usuário aceitar explicitamente o tradeoff de permissão.

## v0.10.0 — Spike condicional de WebSocket

Status: não recomendado como primeiro passo.

Resposta curta: não precisamos implementar WebSocket agora para começar o R2.
Ele fica no roadmap como possibilidade condicionada, ao lado do spike de
`debugger`/CDP, para quando os dados mostrarem que o gargalo é transporte,
conexão persistente ou diagnóstico profundo de aba.

Observação: WebSocket e `debugger` resolvem classes diferentes de problema.
WebSocket é transporte; `debugger` é inspeção/controle da aba. Eles ficam juntos
no roadmap porque ambos são opções mais poderosas, com mais custo operacional,
que só devem entrar depois de medir o que `scripting` e native messaging não
resolverem.

### Por quê

O problema atual parece mais ligado a lifecycle/injeção/permissão:

- content script stale ou ausente;
- service worker MV3 acordando/dormindo;
- bridge/aba sem canal de comandos pronto;
- update/reload de extensão;
- aba existente não reaproveitada.

WebSocket troca o transporte, mas não injeta content script, não repara aba
stale e não registra host nativo. Portanto, WebSocket antes de `scripting` seria
provavelmente mais um remendo.

### Quando WebSocket pode entrar

- Se o transporte HTTP/SSE continuar gerando ordering ruim, timeout de comando
  entregue ou perda de evento depois de `scripting`.
- Se native messaging for rejeitado e ainda precisarmos de canal bidirecional
  mais simples que SSE + POST.
- Se o service worker/content script conseguir manter conexão de forma estável
  no Chrome alvo.

### Critérios de aceite para spike WebSocket

- Comparar HTTP/SSE vs WebSocket em:
  - reconexão depois de reload da extensão;
  - comandos longos;
  - progresso de job;
  - aba navegando entre chats;
  - perda/duplicação de mensagens.
- Manter fallback HTTP/SSE.
- Não introduzir servidor persistente extra se native messaging resolver melhor.

## Ordem recomendada de implementação

1. `v0.8.0 scripting self-heal`.
2. Medir campo real: count/export após update/reload, aba existente, múltiplas
   abas, service worker cold.
3. `v0.8.1 nativeMessaging spike`.
4. Decidir, com dados, entre:
   - native host como transporte primário (`v0.8.2`);
   - manter HTTP/SSE com melhorias;
   - WebSocket spike (`v0.10.0`) se transporte for gargalo comprovado;
   - debugger/CDP (`v0.9.0`) se o problema for diagnóstico/controle profundo da
     aba, e não apenas transporte.
5. `v0.8.3 offscreen` apenas se service worker continuar atrapalhando.
6. Promover qualquer spike perigoso só com aceite explícito de permissão,
   privacidade e rollback.

## Próximo passo proposto

Implementar primeiro apenas `v0.8.0 scripting self-heal`.

Escopo inicial:

- adicionar permissão `scripting`;
- implementar ping/reinject em abas Gemini;
- integrar em `/agent/ready` e CLI readiness;
- testes de manifest/fonte;
- release menor com nota clara de nova permissão.

Fora do primeiro PR/release:

- native messaging;
- offscreen;
- debugger;
- WebSocket;
- mudanças em exportação Markdown.
