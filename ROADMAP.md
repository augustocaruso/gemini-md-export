# Roadmap

Este roadmap registra as próximas frentes de estabilidade e performance do
Gemini Markdown Export. A ordem abaixo prioriza confiabilidade operacional antes
de acelerar exportações grandes.

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

## Proposta v0.3.1 — Hardening operacional e prova em campo

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

Status: implementada.

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

## Proposta v0.4.0 — UX guiada para importação completa

Status: proposta.

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
  - total visto no Gemini Web;
  - total já existente no vault;
  - total baixado agora;
  - total com warning de mídia;
  - total falhado;
  - caminho do relatório;
  - comando exato para retomar.
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

## Proposta v0.4.1 — Resiliência da extensão Chrome

Status: proposta.

Objetivo: reduzir casos em que a extensão fica carregada, mas antiga, lenta ou
sem responder ao MCP.

### Entregas

- Expor no diagnóstico a diferença entre:
  - service worker vivo;
  - content script injetado;
  - aba Gemini conectada;
  - build stamp esperado;
  - build stamp em execução.
- Tornar o reload automático mais visível no status:
  - quando tentou;
  - quando funcionou;
  - quando o Chrome ainda manteve versão antiga;
  - quando exige clique manual no card da extensão unpacked.
- Adicionar timeout/recuperação para ping da extensão:
  - retry curto;
  - erro acionável;
  - sugestão de reload somente depois da tentativa automática.
- Melhorar diagnóstico do top-bar:
  - separar ausência normal em home/settings de quebra real em conversa;
  - incluir candidatos DOM quando a URL for conversa válida;
  - manter o console silencioso fora de falha real.
- Criar smoke manual documentado para DevTools:
  - build stamp;
  - `__geminiMdExportDebug.findTopBar()`;
  - abertura do modal;
  - seletor de pasta;
  - save via bridge;
  - fallback para Downloads.

### Critérios de aceite

- O agente deve tentar reload/self-heal antes de pedir ação manual ao usuário.
- Se a extensão carregada for antiga, o erro deve dizer versão esperada, versão
  em execução e qual passo falta.
- Falhas de top-bar não devem impedir export via hotkey/API de debug quando o
  content script está funcional.

## Proposta v0.4.2 — Estabilidade e performance direta da extensão

Status: proposta.

Objetivo: melhorar diretamente a experiência da extensão Chrome durante uso real
no Gemini Web: menos travamentos, menos trabalho repetido no DOM, exportações
mais previsíveis, feedback visual melhor e menor chance de o usuário cair em
Downloads ou placeholders sem perceber.

### Entregas

- Reduzir custo dos observers no content script:
  - auditar todos os `MutationObserver`;
  - coalescer ticks com scheduler único;
  - evitar reprocessar botão/top-bar/lista quando nada relevante mudou;
  - registrar métricas leves de quantos ticks foram ignorados/processados.
- Backpressure no canal bridge/extensão:
  - impedir múltiplos comandos pesados simultâneos na mesma aba;
  - rejeitar/adiar comando novo quando já houver export/listagem em andamento;
  - mensagens claras: "já existe um job rodando" ou "aguardando a aba terminar".
- Cache incremental do sidebar/modal:
  - não reconstruir a lista inteira a cada heartbeat quando só chegaram poucos
    itens;
  - preservar seleção, filtro e scroll sem redesenho completo;
  - manter deduplicação por `chatId`/URL/título com fonte (`sidebar`/`notebook`).
- Virtualização simples da lista do modal:
  - renderizar apenas a janela visível quando houver centenas de conversas;
  - preservar navegação por teclado/seleção;
  - evitar `innerHTML` gigante a cada atualização.
- Safe mode operacional dentro da extensão:
  - preset conservador acionável por job/tool;
  - menor batch de lazy-load;
  - menor concorrência de mídia;
  - timeouts mais longos;
  - menos reloads automáticos agressivos;
  - label visível no progresso quando safe mode estiver ativo.
- Fila de mídia mais robusta:
  - prioridade para Markdown principal antes de assets;
  - limite global de concorrência por job;
  - cancelamento ao cancelar job;
  - retries curtos e idempotentes;
  - warnings rastreáveis sem segurar a conclusão do Markdown.
- Progress dock orientado por fases reais:
  - diferenciar listagem, cruzamento, navegação, hidratação, extração, mídia e
    escrita;
  - mostrar quando o job está retomando relatório anterior;
  - indicar "histórico verificado" versus "fim não confirmado";
  - evitar sensação de travamento em conversas longas.
- Persistência melhor de destino e preferências:
  - lembrar último vault/diretório escolhido por perfil;
  - validar se o destino ainda existe antes de iniciar;
  - quando cair para Downloads, mostrar aviso persistente e caminho esperado.

### Critérios de aceite

- Em histórico grande, abrir/filtrar/selecionar no modal não deve congelar a
  página por redesenho completo da lista.
- Um job em andamento deve impedir comandos concorrentes perigosos na mesma aba.
- Assets lentos não podem atrasar a gravação do Markdown principal.
- O usuário deve enxergar a fase real do trabalho e saber quando o export está
  em safe mode, retomando relatório ou sem fim de histórico confirmado.

## Proposta v0.4.3 — Afinidade confiável entre agente e aba Gemini

Status: proposta.

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
  - overlay/borda discreta dentro do Gemini Web quando a aba está em uso por
    uma sessão do exporter;
  - texto curto: "Gemini Export ativo nesta aba";
  - cor/label diferente por sessão quando houver múltiplas claims;
  - não interferir com clique, scroll, top-bar nem layout do Gemini;
  - desaparecer quando a claim expirar/liberar.
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
- O usuário deve conseguir ver visualmente qual aba está "presa" ao exporter.
- Se a aba reivindicada fecha ou fica stale, a próxima tool deve retornar erro
  claro e pedir escolher outra aba, não cair silenciosamente em outra.

## Proposta v0.4.4 — Observabilidade e recuperação assistida

Status: proposta.

Objetivo: reduzir o tempo entre "travou" e "sabemos onde travou". Esta fase não
substitui as melhorias diretas da `v0.4.2` nem o roteamento confiável da
`v0.4.3`; ela melhora diagnóstico, suporte, reprodução e retomada segura antes
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

## Proposta v0.5.0 — CLI-first sobre a bridge local

Status: proposta.

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

### Entregas

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
- Em terminal interativo, o usuário vê uma UI de progresso legível dentro do
  Gemini CLI.
- Em execução por agente, `--plain` + `RESULT_JSON` final dá contexto humano e
  contrato mínimo sem obrigar o LLM a interpretar TUI/ANSI.
- A saída `--jsonl` continua disponível para automação que precise acompanhar
  progresso sem timeout de tool call.
- Retomada por relatório funciona igual ou melhor que no MCP.
- Erros comuns geram mensagens e exit codes acionáveis, sem stack trace como
  resposta principal.

## Proposta v0.6.0 — MCP opcional/legado

Status: proposta.

Objetivo: reduzir o MCP a uma camada opcional de compatibilidade, mantendo a
CLI como caminho recomendado para operações reais.

### Entregas

- Marcar no contexto do agente que jobs longos devem preferir CLI.
- Manter MCP apenas para:
  - compatibilidade com instalações antigas;
  - discovery/status simples;
  - ambientes onde o agente não tenha shell disponível.
- Remover duplicação de lógica entre MCP e CLI:
  - ambos chamam os mesmos helpers/core;
  - nenhuma regra de exportação vive só no MCP.
- Atualizar instaladores para instalar/validar CLI + extensão Chrome + bridge.
- Criar aviso de depreciação suave para tools MCP de exportação longa, apontando
  o comando CLI equivalente.

### Critérios de aceite

- O MCP pode ser desligado sem quebrar o fluxo principal CLI + bridge.
- A documentação principal não apresenta MCP como caminho recomendado para
  export total.
- O usuário ainda consegue recuperar ambientes antigos sem reinstalação brusca.

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
