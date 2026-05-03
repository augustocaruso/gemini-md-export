# Gemini → Markdown Export

Projeto de extensão MV3 + servidor MCP que exporta conversas do Gemini web
(https://gemini.google.com/app/*) como arquivos Markdown para ingestão em vault
do Obsidian. O caminho principal é extensão unpacked + MCP local + instaladores
macOS/Windows via GitHub. O userscript gerado pelo build é legado
de debug e não deve ser apresentado como fluxo recomendado ao usuário final.

## Processo de trabalho

- Para propostas de arquitetura, roadmap, spikes, pesquisas e mudanças de
  direção, o fluxo padrão é: discutir, explorar alternativas, atualizar o
  roadmap e só então implementar depois de aprovação explícita do usuário.
- Pedidos como "investigue", "descubra", "explore", "o que você acha" ou
  "faça acontecer" em contexto de descoberta não autorizam edição de código por
  si só.
- A aprovação precisa ser inequívoca e específica para a proposta atual, por
  exemplo: "aprovado", "implemente", "pode seguir com essa proposta" ou
  equivalente.
- Spikes já feitos sem aprovação explícita podem permanecer no workspace para
  review, mas não devem ser versionados, publicados ou tratados como caminho
  recomendado sem nova aprovação explícita.
- Quando o usuário pedir diretamente uma edição pontual, como "atualize este
  arquivo" ou "corrija este bug", execute o pedido sem ampliar o escopo para
  uma proposta maior.

## Contexto

- Usuário final: um médico que usa Gemini web para conversas de estudo e
  quer transformá-las em notas no Obsidian.
- O script roda no DOM renderizado da página logada — NÃO usa API oficial
  nem cookies, e não deve tentar.
- Chat ID é extraído da URL (`/app/<hex>`, hoje aceito com pelo menos 12
  caracteres hexadecimais; normalmente aparece com 16+) e vira o nome do
  arquivo (`<chatId>.md`).
- O download cai em `~/Downloads`/pasta padrão do navegador por fallback. Na
  extensão com MCP local rodando, o botão **Alterar** do modal abre seletor
  nativo de pasta no macOS (`osascript`) e Windows (`powershell.exe` +
  `IFileOpenDialog` estilo Explorer com owner topmost) via bridge local, e o
  servidor grava os arquivos no diretório escolhido. Na extensão MV3, se o MCP
  não responder, mostrar erro em português simples e manter Downloads como
  fallback; não reintroduzir a janelinha antiga de `showDirectoryPicker()` no
  fluxo principal.
- Baseline de teste manual: Chrome/Edge/Chromium com extensão MV3 unpacked e
  MCP local rodando. Browsers com UI/arquitetura de extensões customizada podem
  falhar mesmo quando o scraper está correto.
- Há um probe legado em `debug/tampermonkey-probe.user.js` apenas para debug de
  injeção antiga; não documentar como instalação recomendada.

## Formato de saída

Frontmatter YAML + corpo Markdown. Exemplo:

```markdown
---
chat_id: b8e7c075effe9457
title: "Mecanismo de ação dos ISRS"
url: https://gemini.google.com/app/b8e7c075effe9457
exported_at: 2026-04-22T18:32:11.245Z
model: "2.5 Pro"
source: gemini-web
tags: [gemini-export]
---

## 🧑 Usuário

Me explica o mecanismo...

---

## 🤖 Gemini

Os ISRS atuam...
```

Separador `---` entre turnos. Headings `## 🧑 Usuário` e `## 🤖 Gemini`.

## Arquitetura

- `src/extract.mjs` — lógica pura de scraping e formatação. Recebe
  `Document`/`Element`, retorna strings. **Testável com jsdom**, sem depender
  de `window`, `location`, `Blob`, `URL.createObjectURL` etc.
- `src/notebook-return-plan.mjs` — política pura para decidir como voltar do
  chat para o caderno sem matar o contexto do lote/comando, e como abrir uma
  conversa de caderno sem trocar isso por navegação direta cedo demais. Hoje o
  padrão é `history-then-spa-link`/`row-only` quando a resposta ainda depende
  do mesmo contexto JS.
- `src/batch-session.mjs` — helpers puros para serializar e retomar sessão de
  exportação em lote via `sessionStorage` da aba. Se navegação do Gemini matar
  o content script no meio do lote, o próximo bootstrap retoma do item pendente.
- `src/userscript-shell.js` — camada de browser/content script (nome histórico):
  captura metadata da URL e título da aba, invoca a lógica pura, dispara download, injeta botão
  no `top-bar-actions` do Gemini (sem FAB fallback), registra hotkey e
  instala a API de debug `__geminiMdExportDebug` para
  inspeção manual no DevTools durante debug. Na extensão MV3 ela roda no
  isolated world do content script, então pode ser necessário selecionar o
  contexto do content script no DevTools ou usar os logs/MCP.
  Importa funções de
  `extract.mjs` via comentário marcador que o build resolve. O bloco
  `==UserScript==` ainda existe porque o build também emite
  `dist/gemini-export.user.js` como artefato legado de debug; não usar isso
  como fluxo principal. O shell também hospeda o modal de exportação em
  lote, a listagem das conversas carregadas no sidebar e a escrita
  sequencial via pasta escolhida pelo bridge MCP, File System Access ou
  Downloads, incluindo tentativa de abrir o
  sidebar quando necessário, observer para sincronizar novas conversas
  carregadas e lazy-load do histórico ao rolar a lista do modal ou acionar
  manualmente "Puxar mais histórico", além da navegação sequencial na aba
  atual para exportar conversas que não são a atual. Em páginas
  `/notebook/...`, a lista do modal vem de
  `project-chat-history project-chat-row` (conversas recentes do caderno) em
  vez do sidebar global; para exportar, o shell tenta extrair `chatId` de
  atributos/links escondidos e do contexto Angular (`__ngContext__`) da linha.
  Quando encontra, navega por `/app/<chatId>`; quando não encontra, clica na
  linha do caderno, aguarda o Gemini abrir `/app/<chatId>`, salva o mapeamento
  linha->URL em `localStorage`, hidrata/exporta a conversa e usa
  `history.back()` para voltar ao caderno entre itens do lote, com fallback
  para link interno/navegação direta quando o browser não volta pela pilha de
  histórico. Durante o lote, o modal pode ser recolhido e substituído por uma
  barra de progresso compacta.
  Convenções visuais do modal (não violar sem justificativa):
  (1) hierarquia clara — única CTA primária verde é "Exportar selecionadas";
  ações utilitárias como "Puxar mais histórico", "Selecionar visíveis",
  "Limpar" e "Alterar" pasta são ghost (`.gm-btn-ghost`).
  (2) Destino é bloco dedicado (`.gm-destination`) com ícone + label
  "DESTINO" + caminho + botão "Alterar", não uma helper text solta.
  (3) Header compacto: título em linha com contador (`N selecionada(s) ·
  M visível(is)` com singular/plural corretos) e close como botão circular
  `×` (`.gm-btn-close`), não botão "Fechar" cheio. (4) Variáveis de tema em
  `--gm-*` devem ser usadas para qualquer cor nova; nunca hardcode. Toolbar,
  bloco de destino e footer usam grid/flex com alinhamento explícito; evitar
  voltar a inline styles soltos para grupos de ação.
  (5) Botão injetado no top-bar do Gemini é **icon-only circular 40x40**,
  background transparente, `color: inherit` pra herdar tema claro/escuro do
  host, ícone SVG do Material Symbols "download" com `fill="currentColor"`.
  Texto "MD" e pill branco saíram porque destoavam do idioma visual (kebab,
  avatar, share) dos outros botões do top-bar. A UI atual usa namespace
  `gm-md-export-modern-*` e o botão recebe assinatura
  `data-gm-md-export-version` + `data-gm-md-export-build-stamp`. Não tocar,
  remover nem substituir nós legados `gm-md-export-*`: se uma cópia antiga do
  exporter ainda estiver viva, disputar o mesmo nó por
  `MutationObserver` pode travar o Gemini. A função de estilo
  `styleAsTopBarIconButton` é aplicada tanto na criação quanto no
  re-parenting do botão atual, protegendo contra estilos de FAB sem brigar
  com versões antigas. O `MutationObserver` da injeção deve sempre passar por
  `scheduleInjectButton()` e nunca reescrever `innerHTML` de botão existente
  em todo tick; isso já causou loop de mutações e travamento do Gemini.
  (6) **Não existe mais FAB fallback**:
  se nada bate, o botão simplesmente não é injetado. A hotkey Ctrl+Shift+E
  e `__geminiMdExportDebug.openExportModal()` ainda funcionam no contexto
  em que a API de debug estiver disponível, evitando poluir a UI com um
  botão flutuante destoante.
  (7) **Injeção dentro do `top-bar-actions` da conversa**: a âncora é o
  custom element `top-bar-actions` do Gemini. **Cuidado crítico**: a
  página tem múltiplas instâncias desse elemento — uma na nav global
  (canto superior esquerdo, colada no sidebar) e outra na conversa
  (canto superior direito, com kebab + avatar). `querySelector` pega o
  primeiro em ordem de documento, que é o errado. A função `findTopBar`
  coleta todos, filtra pelos visíveis (`width/height > 0`) e, quando o
  OneGoogleBar (`#gb` / `.boqOnegoogleliteOgbOneGoogleBar`) está visível,
  escolhe o `top-bar-actions` na mesma faixa vertical e imediatamente à
  esquerda dele. Só se o OGB não estiver disponível ela cai no fallback
  **rightmost** via `getBoundingClientRect().right`. Na estrutura atual do
  Gemini, o botão fica dentro de um slot próprio
  (`#gm-md-export-modern-btn-slot`) inserido em
  `.top-bar-actions .right-section`, antes do container de share/menu; não
  deve ficar como filho direto do custom element `top-bar-actions`, pois isso
  joga o botão para perto do logo "Gemini". Selectors tipo
  `chat-app-top-bar [role="toolbar"]` **foram banidos** porque casavam
  com a nav global. Caçar o kebab por `aria-haspopup="menu"` /
  aria-label "More options" **também foi banido** porque casa com
  kebabs do sidebar/Gems. Se o botão sumir depois de mudança no Gemini,
  rode `__geminiMdExportDebug.findTopBar()` no contexto de debug disponível
  no DevTools: retorna `{ matchedBy, target }` ou `matchedBy: null` se nada
  bateu — aí é hora de adicionar candidato em `TOP_BAR_SELECTORS`.
  `placeInTopBar` é defensivo contra dois modos de falha do `insertBefore`:
  (a) `placement.before` retornado por `.closest(...)` pode não ser filho
  *direto* do `host` (wrapper Angular/Material no meio) — normaliza via
  `directChildOf` antes de inserir; (b) o anchor pode ser substituído pelo
  re-render do Gemini entre detectar e inserir — try/catch silencioso cai
  em `appendChild(host)` em vez de ruidar "NotFoundError: Failed to execute
  'insertBefore'" no console do usuário. Se o botão ficar fora de lugar,
  o próximo tick do `MutationObserver` reposiciona.
  **Carimbo de build**: `scripts/build.mjs` injeta um stamp `YYYYMMDD-HHMM`
  UTC no log de boot (`userscript carregado (v<version> build <stamp>)`; texto
  histórico mantido pelo bundle).
  Quando o usuário reportar bug no console, confirmar que o stamp
  impresso bate com a build atual — se bater, a extensão foi recarregada
  corretamente; se não, o Chrome/Edge ainda está com cache do content
  script antigo (passo manual: `chrome://extensions` → card da extensão →
  ícone circular de reload; depois recarregar a aba do Gemini).
  **Silêncio no console**: o estado "not-found" do `findTopBar` é normal
  durante o boot do Angular e em rotas sem conversa (home, settings,
  `/app` sem id). `injectButton` só emite `console.warn` quando ambos: (i)
  a URL é uma conversa válida (`extractChatId(location.pathname)` é truthy)
  e (ii) o estado continua "not-found" por mais de
  `NOT_FOUND_GRACE_MS = 4000ms`. Isso evita spam em páginas onde a ausência
  é esperada e só grita quando provavelmente o Gemini mudou o DOM do
  top-bar. Não demote essa lógica para um warn genérico sem ajustar os
  dois critérios, senão o console volta a ficar poluído.
  (8) **Stacking + UX de toasts/modal/progress dock**: toast de feedback usa
  `z-index: 10050` — ACIMA do modal (10001 + `backdrop-filter: blur(4px)`)
  e do progress dock (10002). Se baixar pra 10000 como era antes, o blur
  do modal cobre o toast e as mensagens de sucesso/erro ficam ilegíveis.
  `showToast` também reanexa ao fim do `<body>` a cada chamada pra garantir
  ordem de pintura mesmo se outro overlay nasceu depois dele, e seta
  `role="alert"`/`aria-live="assertive"` em erros. Durações fixas em
  `TOAST_DURATIONS` (hoje: error 9000ms, info 5200ms, success 4200ms) porque
  erros tipicamente pedem ação do usuário e o texto é mais denso; valores
  menores deixavam o toast sumir antes de o usuário ler. Toast é clicável
  (`pointer-events: auto; cursor: pointer`) pra fechar manualmente, e cada
  mensagem leva um prefixo de emoji (⚠️/✅/ℹ️) pra identificar severidade
  de relance. Cancelamento do seletor de pasta (tanto bridge MCP quanto
  `showDirectoryPicker` nativo) NÃO dispara toast — é fluxo esperado;
  `pickBridgeOutputDir` retorna `{status: 'picked'|'cancelled'|'error'}` pro
  handler decidir o que comunicar. **Detecção de cancel é locale-aware**:
  osascript emite "User canceled. (-128)" em inglês mas "Cancelado pelo
  usuário. (-128)" em macOS pt-BR — a regex em `chooseExportDirectoryMac`
  e no fallback de `pickBridgeOutputDir` casa pelo código universal `-128`
  antes das palavras em cada idioma (`cancelado`, `canceled`, `annul`,
  `abgebrochen`...), então usuários fora de en-US também veem o cancel
  silencioso. Se essa regex quebrar, o sintoma é toast vermelho "Não
  consegui abrir o seletor" toda vez que o usuário cancela. Mensagens
  devem ser em português simples, sem jargão técnico (nada de
  `AbortError`, `showDirectoryPicker()`, nomes de funções); use "navegador"
  em vez de "browser" e prefira orientar o que fazer em vez de só descrever
  a falha.
  (9) **Scroll da lista de conversas**: `.gm-list` é `flex: 1 1 auto;
  min-height: 160px;` dentro do painel flex — a lista cresce até o
  `max-height` do painel, não mais travada em 360px. `overscroll-behavior:
  contain` evita que o scroll vaze pro DOM do Gemini atrás do modal.
  `renderConversationList` captura `scrollTop` antes de reescrever
  `innerHTML` e restaura depois do reflow (clamp contra encolhimento
  quando o filtro reduz a lista); autoscroll pro fim só dispara quando o
  usuário já estava colado no fundo ou `reachedSidebarEnd` bateu. **Não
  reintroduzir `scroll-behavior: smooth`** no container — fazia o restore
  programático do scrollTop animar visivelmente a cada heartbeat.
  (10b) **Menu do botão (top-bar) com toggle "Ignorar esta aba"**: clicar no
  botão do exporter no top-bar abre um popover DOM próprio, não um popup
  nativo de extensão Chrome. Id `${UI_ID_PREFIX}-menu`, `position: fixed`
  ancorado abaixo/à direita do botão, `z-index: 10004` (acima do dock 10002,
  abaixo do toast 10050; o modal 10001 e o menu são mutuamente exclusivos
  por fluxo). Tema próprio: o menu aplica seu próprio palette
  `--gm-menu-{bg,text,muted,border,divider,hover,focus,shadow,accent,font}`
  via `buildMenuPalette()` no próprio elemento, **sem depender** de o dock/modal
  estarem abertos para herdar `--gm-dock-*`. Antes o menu caía no fallback
  dark do `var()` em tema claro, aparecendo escuro sobre página clara. O
  menu tem dois `menuitem`s: "Exportar como
  Markdown" (chama `safeOpenExportModal`) e "Ignorar esta aba"
  (`menuitemcheckbox` com `aria-checked`). Fechamento por clique fora,
  `Escape`, scroll ou resize. A flag de ignorar é armazenada em
  `sessionStorage['gemini-md-export.ignoreThisTab.v1']` (sobrevive reload
  da própria aba; some quando a aba é fechada, que é o comportamento certo
  para um override pontual). Mudanças disparam o evento
  `gm-md-export:tab-ignored-changed` no `pageWindow`; o listener
  `applyTabIgnoredState` chama `stopExtensionBridge` (limpa o
  `heartbeatTimer` e zera `bridgeState.started`, fazendo o `while` do
  long-poll sair sozinho) ou `installExtensionBridge` na volta. **Não
  precisa endpoint de "disconnect" no MCP**: o cliente desaparece sozinho
  via `BRIDGE_CLIENT_STALE_MS`. A hotkey `Ctrl+Shift+E` continua exportando
  direto e bypassa o menu — em aba ignorada o export ainda funciona, só não
  envia heartbeat/comando.
  (10) **Fluidez da barra de progresso (progress dock)**: o dock fixo no
  rodapé central usa três mecanismos para evitar a sensação de "barra
  travada" durante etapas longas de uma única conversa (hidratação, scroll,
  salvar). Primeiro, um shimmer CSS (`@keyframes gm-dock-shimmer`) varre a
  porção preenchida com gradiente diagonal — feedback visual constante
  mesmo quando `current` não mudou. Segundo, transição da largura usa
  `cubic-bezier(0.22, 0.61, 0.36, 1)` em 420ms (Material easing), bem mais
  suave do que o `.18s ease` antigo. Terceiro, **creep assintótico**:
  `state.progressCreepTimer` é um `setInterval` (240ms) que avança
  `displayPercent` exponencialmente em direção ao próximo milestone, sem
  ultrapassar `PROGRESS_CREEP_MAX_FRACTION = 0.85` do caminho — quando o
  `current` real avança, a barra pula pra base nova e o creep recomeça.
  Quando bate o total, o dock recebe a classe `gm-dock-done` que desliga o
  shimmer (sinal claro de "concluído"). Em `finishExportProgress`, antes
  do fade, força largura 100% + `gm-dock-done` pra evitar o sumiço abrupto
  de meio-caminho. **Não remova o creep** sem repensar o feedback de
  hidratação: o usuário fica olhando 30s+ pra uma barra que aparenta
  congelada, e isso já gerou ticket.
  (11) **Progress dock também aparece para exports do MCP**: quando a
  exportação é disparada pelo `gemini_export { action: "recent" }` ou
  `gemini_export_notebook` (em vez do botão local), o MCP envia o estado
  do job como evento SSE `jobProgress` pelo `/bridge/events` quando o protocolo
  v2 está ativo; se o canal de eventos não estiver conectado, mantém fallback
  pelo campo `jobProgress` do response do `/bridge/heartbeat`. O content
  script consome esse snapshot e reaproveita o mesmo
  dock visual, marcando `state.exportSource = 'mcp'`. Status terminais
  (`completed`, `completed_with_errors`, `failed`, `cancelled`) ficam
  disponíveis por até `TERMINAL_JOB_PROGRESS_TTL_MS` (30s) para garantir que
  a aba veja o "done" mesmo se um heartbeat falhar. Se o usuário acionar o
  export local enquanto o MCP estiver rodando, a GUI vence (`state.exportSource = 'gui'`)
  e o broadcast do MCP fica suprimido até a GUI terminar. A lógica pura do
  snapshot vive em `src/job-progress-broadcast.mjs` com testes em
  `tests/job-progress-broadcast.test.mjs`.
- `src/extension-background.js` — service worker MV3. Além de responder ao
  ping do content script, usa a API `chrome.tabs` para recarregar abas
  `https://gemini.google.com/*` quando a extensão é instalada/recarregada e
  quando recebe a mensagem `gemini-md-export/reload-gemini-tabs`. Também
  responde `GET_EXTENSION_INFO` com versão da extensão, `protocolVersion`,
  `extensionId`, `manifestVersion`, `tabId`/`windowId` e `buildStamp`, e aceita
  `RELOAD_SELF`: responde antes, grava em `chrome.storage.local` um marcador
  de reload pendente, chama `chrome.runtime.reload()` depois de um curto delay e,
  quando o service worker novo sobe, consome o marcador para recarregar as
  abas Gemini. Isso automatiza a parte "recarregar páginas do Gemini" após
  updates; o clique manual no card da extensão unpacked continua necessário em
  migrações que mudam permissões/manifest ou quando a versão carregada ainda
  não tem o protocolo de auto-reload.
- `gemini-cli-extension/` — fonte da extensão do Gemini CLI. Hoje contém
  pelo menos um `GEMINI.md` próprio da extensão; o build gera
  `dist/gemini-cli-extension/gemini-extension.json` + bundle mínimo do MCP
  para instalação em `~/.gemini/extensions/gemini-md-export`. O workflow de
  release também publica esse bundle no branch `gemini-cli-extension`, onde o
  `gemini-extension.json` fica na raiz; os instaladores usam esse branch como
  fonte oficial do Gemini CLI para a extensão aparecer como atualizável. O
  `mcpServers.gemini-md-export` publicado **não deve definir**
  `cwd: "${extensionPath}"`: no Windows, processo MCP com cwd dentro de
  `~/.gemini/extensions/gemini-md-export` impede o Gemini CLI de remover a
  pasta durante auto-update e causa
  `EBUSY: resource busy or locked, rmdir ...`. O MCP também faz
  `process.chdir(homedir())` cedo quando detecta que nasceu dentro dessa pasta
  auto-updatable.
- `src/mcp-server.js` — servidor MCP local via `stdio`. No mesmo processo,
  ele também sobe um bridge HTTP local em `127.0.0.1:47283` para a extensão.
  No protocolo v2, a extensão/content script envia `/bridge/heartbeat` leve
  (liveness, versão/build, tab/window, página mínima e capacidades), abre
  `/bridge/events` como SSE para comandos/progresso do MCP, e envia inventário
  pesado por `/bridge/snapshot` só quando muda ou quando solicitado. O
  long-poll antigo em `/bridge/command` continua como fallback se SSE cair.
  Comandos internos do agente incluem `list-conversations`, `get-current-chat`,
  `get-chat-by-id`, `open-chat`, `cache-status`, `clear-cache`, `snapshot`.
  Em páginas de caderno, a lista visual do modal continua focada no caderno,
  mas o snapshot/bridge envia inventário combinado: sidebar global
  (`source: "sidebar"`) + conversas do caderno (`source: "notebook"`). O
  service worker informa `tabId`, `windowId` e `isActiveTab` periodicamente;
  quando há várias abas Gemini vivas, o MCP prefere a aba ativa antes do
  fallback por heartbeat mais recente. O heartbeat também inclui
  `extensionVersion`, `protocolVersion` e `buildStamp` para verificar
  rapidamente se a extensão recarregada é o build esperado. O MCP acumula
  métricas de payload por cliente (`payloadMetrics.heartbeat` e
  `payloadMetrics.snapshot`, com count/last/avg/max bytes) em
  `bridgeHealth`, `/agent/clients` e nos relatórios de job para descobrir
  quando inventário grande ou heartbeat pesado virou gargalo. `gemini_ready { action: "status" }`
  e `/agent/clients?diagnostics=1` expõem `bridgeHealth` por cliente
  (`healthy`, `degraded`, `stale`, `version_mismatch`,
  `command_channel_stuck`) com ação recomendada antes de pedir reload manual.
  `gemini_ready { action: "status" }` também retorna `extensionReadiness` e `handshake`,
  separando handshake quente/frio/pós-update antes de culpar o DOM do Gemini.
  Para checagem rápida sem snapshot grande, use `gemini_ready { action: "check" }`.
  `gemini_ready { action: "status" }` separa
  service worker (`GET_EXTENSION_INFO`/`source: "service-worker"`), content
  script conectado, aba Gemini, build stamp esperado/em execução, resultado do
  reload automático e diagnóstico do top-bar (`page.topBar`). Só pedir reload
  manual do card da extensão quando `extensionReadiness.reload.manualReloadRequired`
  estiver true ou quando o status provar que o navegador ainda aponta para uma
  pasta/perfil antigo depois do self-heal. Falha de top-bar não bloqueia
  export por hotkey/API de debug se o content script está vivo.
  O content script anuncia `tab-claim-v1`: o MCP pode reivindicar uma aba via
  `gemini_tabs { action: "claim" }` e liberar via `gemini_tabs { action: "release" }`; heartbeats/snapshots
  carregam `tabClaim`, e `requireClient` prefere `claimId`/`tabId`/`clientId`
  explícitos ou a claim da sessão antes de qualquer fallback. Se houver várias
  abas Gemini candidatas e nenhuma claim/seleção explícita, tools
  browser-dependent retornam `ambiguous_gemini_tabs` em vez de escolher pela
  aba ativa. O indicador visual da claim é na barra de abas do navegador: a
  extensão tenta `chrome.tabs.group()` + `chrome.tabGroups.update()` para criar
  um Tab Group com label/cor; se a aba já estiver em grupo do usuário ou a API
  não existir, cai para badge/prefixo de título. **Não implementar isso como
  overlay/borda dentro da página Gemini**: o pedido é sinalizar a aba do
  navegador, não o DOM do app. `gemini_tabs { action: "list" }` e `gemini_tabs { action: "claim" }` podem
  abrir `https://gemini.google.com/app` automaticamente quando não houver aba
  conectada, respeitando cooldown compartilhado de launch para não duplicar
  janelas.
  O content script também anuncia `tab-backpressure-v1`: comandos pesados por aba
  (`list-conversations`, `load-more-conversations`, `get-current-chat`,
  `get-chat-by-id`, `open-chat`) passam por `activeTabOperation`; se outro
  comando pesado chegar durante navegação/hidratação/listagem, a resposta vem
  com `busy=true`/`code: "tab_operation_in_progress"` em vez de disputar o DOM.
  Não remova esse lock para ganhar paralelismo: paralelismo confiável acontece
  por múltiplas abas reivindicadas, não dentro da mesma aba.
  Observers devem passar por `scheduleDomWork` para coalescer top-bar/sidebar/
  modal em um frame e alimentar `metrics.domScheduler`. O modal virtualiza
  listas grandes com `.gm-list.is-virtual`/`MODAL_VIRTUALIZATION_THRESHOLD`;
  não reintroduzir renderização de um nó por conversa para centenas de itens.
  Antes de executar tools que dependem do navegador, o MCP passa por
  `ensureChromeExtensionReady()` em `src/chrome-extension-guard.mjs`: lê
  `bridge-version.json`, chama o comando interno `get-extension-info`, compara
  versão/protocolo, pede `reload-extension-self` quando os arquivos da
  extensão Chrome foram atualizados pelo Gemini CLI mas o runtime do Chrome
  ainda está velho, espera a reconexão e evita loop infinito (default: 1
  tentativa). Se não houver heartbeat, o launcher de
  `src/browser-launch.mjs` tenta abrir `https://gemini.google.com/app` no
  navegador correto: Chrome por padrão, ou o browser fixado por
  `GEMINI_MCP_BROWSER`/`GME_BROWSER` (`chrome`, `edge`, `brave`, `dia`), com
  fallback para outro Chromium conhecido se o preferido não existir. No
  Windows não deve usar `where`/`spawnSync` no caminho de runtime para descobrir
  browser: isso já é um ponto possível de travamento. No bundle do Gemini CLI,
  hooks de runtime ficam desabilitados por padrão (`hooks/hooks.json` publica
  `{ "hooks": {} }`). Não reintroduzir `SessionStart` para aquecer bridge,
  `BeforeTool` para abrir navegador, `AfterTool` para corrigir resposta de
  shell/MCP nem guardrails de desenvolvimento no pacote do usuário final. A CLI
  e o MCP são donos explícitos de bridge/browser wake e devem retornar erros
  acionáveis no próprio comando/tool. No macOS usa `open -g -a`
  para preferir app Chromium em vez do navegador padrão. O argumento de
  perfil só é enviado quando `GEMINI_MCP_CHROME_PROFILE_DIRECTORY` ou
  `GME_CHROME_PROFILE_DIRECTORY` for configurado explicitamente; não passar
  `--profile-directory=Default` por padrão, porque isso pode abrir UI de
  seleção/perfil do Chrome quando a tool tenta acordar o navegador. O launch é
  protegido por cooldown (`GEMINI_MCP_BROWSER_LAUNCH_COOLDOWN_MS`, default
  60000ms) para não abrir uma janela/diálogo novo a cada chamada de tool quando
  a extensão ainda não conectou. O estado ativo fica em `browser-launch.json`;
  `hook-browser-launch.json` é lido apenas como legado para upgrades. Não
  reintroduzir `cmd.exe /c start`, WSH, `where` síncrono ou fallback que foque
  janela. O modo
  `node scripts/hooks/gemini-md-export-hook.mjs diagnose` continua disponível
  só como diagnóstico/no-op de compatibilidade: imprime estado, `/healthz`,
  `/agent/ready`, `/agent/diagnostics` e caminhos dos arquivos de launch, mas
  não faz spawn, não lê stdin de hook e não altera o fluxo.
  `gemini_ready { action: "status" }` deve acordar o navegador pelo MCP/guard,
  não por hook, quando o caller pedir esse comportamento e não houver clientes
  conectados.
  `gemini_chats { action: "list" }` e `/agent/recent-chats` agora priorizam a lista
  trazida pelo heartbeat recente da extensão para responder rápido. Só
  mandam `list-conversations` para abrir/atualizar o sidebar quando o cache
  estiver vazio/velho (default: >10s) ou quando o caller pedir
  `refresh=true`. Também aceitam `refresh=false` para priorizar velocidade
  mesmo com cache velho. Quando já existe cache e mesmo assim o caller pede
  refresh, o MCP aplica um budget curto (default: 2500ms) e cai de volta para
  a lista já conhecida se a aba demorar demais para responder. No lado da
  extensão, o canal SSE de comandos é preferido; se ele cair, o long-poll de
  comandos do bridge usa retry com backoff curto após erro e é rearmado depois
  de heartbeat bem-sucedido, reduzindo latência depois de restart do MCP ou
  falha transitória no localhost. O processo MCP agora
  encerra explicitamente quando o `stdin` do cliente fecha. Quando uma segunda
  aba/janela do Gemini CLI inicia outro MCP e encontra `EADDRINUSE` na porta
  `127.0.0.1:47283`, essa instância não deve logar erro nem morrer: ela entra
  em modo proxy por `stdio` e encaminha `tools/call` para a instância primária
  via `/agent/mcp-tool-call`. O objetivo é permitir múltiplos terminais Gemini
  sem mensagens de bridge/extensão desconectada. `/healthz` do bridge primário
  expõe `pid`, `ppid`, `protocolVersion`, `startedAt`, `uptimeMs`, `cwd`,
  `argv` resumido e `bridgeRole`; em modo proxy, `gemini_ready { action: "status" }`
  também tenta identificar o dono da porta (`Get-NetTCPConnection` no Windows,
  `lsof` no macOS/Linux) e retorna `mcp.proxyState`, `primaryBridge.process` e
  `primaryBridge.portOwner`. `proxy_healthy` não é erro. Se o proxy falhar por
  `primary_incompatible`, `primary_unreachable` ou `port_owned_by_other_service`,
  a mensagem acionável deve citar PID/versão/caminho quando disponíveis e pedir
  para fechar/reiniciar a sessão antiga; não trate automaticamente como zumbi e
  não recomende matar processos sem diagnóstico. Para recuperação controlada,
  o agente deve chamar `gemini_support { action: "processes" }` antes de sugerir
  restart manual. Se houver alvo seguro,
  `gemini_support { action: "cleanup_processes" }` faz dry-run por padrão e só
  encerra com `confirm=true`; ele só pode considerar processos
  cujo comando/caminho pareça `gemini-md-export` ou `mcp-server.js`, nunca o
  processo MCP atual nem o processo pai, e deve retornar exatamente os PIDs
  encerrados e se a sessão assumiu o bridge depois do cleanup.
  O smoke local `node scripts/bridge-smoke.mjs --spawn --json` valida a
  infraestrutura do bridge sem login no Gemini Web: sobe uma bridge isolada em
  porta temporária e testa `/healthz`, `/bridge/snapshot`, `/bridge/events`,
  `/bridge/heartbeat`, `/agent/clients`, `/agent/diagnostics` e
  `gemini_support { action: "processes" }`.
  Para testar a instância atual, use
  `node scripts/bridge-smoke.mjs --bridge-url http://127.0.0.1:47283 --json`.
  Se o smoke isolado passa, mas a extensão real segue lenta/instável, investigue
  perfil do navegador, runtime da extensão Chrome, DOM do Gemini ou vault em vez
  de culpar o protocolo local de imediato.
  `gemini_support { action: "diagnose" }` e `/agent/diagnostics` produzem o relatório de
  campo consolidado: versão do MCP, versão/protocolo/build esperados e
  conectados da extensão, browser configurado, processos, dono da porta,
  diretório de export, jobs/relatórios recentes e `nextAction` acionável.
  Use isso antes de sugerir reinstalação.
  O MCP público expõe apenas 7 tools de domínio:
  `gemini_ready`, `gemini_tabs`, `gemini_chats`, `gemini_export`,
  `gemini_job`, `gemini_config` e `gemini_support`. Nomes antigos não entram
  mais em `tools/list`; chamada direta retorna `code: "tool_renamed"` com o
  replacement exato. Use `detail: "full"` só para diagnóstico; o padrão deve
  ser compacto.
  `gemini_chats { action: "list" }` é paginada: `limit` é tamanho de página
  (recomendado 25-50 para listas grandes) e `offset` pula itens já vistos
  (`0`, `50`, `100`...). Para centenas de conversas, o agente deve avançar
  por páginas usando `pagination.nextOffset` e parar quando
  `pagination.reachedEnd=true`, `pagination.canLoadMore=false` ou a página
  vier vazia. O MCP carrega mais histórico até `offset + limit` conforme
  necessário, com teto defensivo de 1000 conversas carregáveis para não
  travar o navegador nem estourar contexto na listagem paginada.
  Para o pedido de usuário "importar/exportar todo o histórico", não listar
  centenas de conversas no chat: usar `gemini_export { action: "recent" }`, que inicia
  um job em background no próprio MCP, percorre o sidebar carregável, grava os
  `.md` localmente e mantém um relatório JSON incremental; acompanhar com
  `gemini_job { action: "status" }` pelo `jobId` e cancelar com
  `gemini_job { action: "cancel" }` quando o usuário pedir. Quando `maxChats` é
  omitido, o job usa o mesmo caminho de lazy-load do modal e tenta carregar até
  `reachedSidebarEnd=true`; `maxChats` só deve ser passado quando o usuário
  pedir export parcial. Esse job retorna só progresso, contagens, erros
  recentes e caminho do relatório para evitar timeout e excesso de contexto no
  Gemini CLI. Quando o vault já estava sincronizado e o usuário pedir sync
  incremental, usar `gemini_export { action: "sync" }`: ele lê/grava
  `.gemini-md-export/sync-state.json`, lista o Gemini Web do topo até uma
  fronteira conhecida (`topChatId` ou sequência de chats já presentes no
  vault) e baixa só conversas novas. Não listar o histórico inteiro no chat. O
  comando Gemini CLI `/sync` é o atalho humano para esse fluxo: sem argumento,
  usa o vault já conhecido pelo contexto/GEMINI.md principal; com argumento,
  usa esse caminho como override de `vaultDir`/`outputDir`.
  MCP bloqueia dois jobs simultâneos de histórico recente na
  mesma aba; se já houver um rodando, consultar/cancelar o job existente antes
  de iniciar outro. Se um job longo for interrompido, o agente deve chamar
  `gemini_export { action: "recent" }` ou `gemini_export { action: "missing" }`
  novamente com `resumeReportFile` apontando para o JSON incremental anterior, em vez de
  reiniciar do zero. O resume reaproveita o mesmo relatório, pula chatIds já
  concluídos/saltados, preserva `webConversationCount`, `existingVaultCount` e
  `missingCount` no relatório, e retenta apenas itens faltantes ou falhos. O
  lazy-load do histórico usa batch adaptativo por padrão (`adaptiveLoad=true`);
  só desligue isso para diagnóstico. O relatório JSON inclui `metrics` com
  `phaseTimings` (`loadSidebarMs`, `refreshSidebarMs`, `scanVaultMs`,
  `exportConversationsMs`, `writeReportMs`), `lazyLoad`, `payloads`, `assets`
  e métricas por conversa (`openConversationMs`, `hydrateDomMs`,
  `extractMarkdownMs`, `fetchAssetsMs`, `saveFilesMs`). Use esses campos antes
  de culpar MCP/Chrome/Gemini de forma genérica. O status e o relatório também
  expõem `progressMessage`, `decisionSummary` e `nextAction`: para
  "importar todo o histórico para o vault", o agente deve resumir
  `geminiWebSeen`, `existingInVault`, `missingInVault`, `downloadedNow`,
  `mediaWarnings`, `failed`, `reportFile`, `fullHistoryVerified` e o comando
  exato `nextAction.command.text` quando houver retomada. Não despejar listas
  grandes de conversas no chat; a lista completa fica no relatório. O bridge de assets mantém
  cache em memória por URL com TTL, limita concorrência global, deduplica
  fetches simultâneos e aplica backoff por host com falha repetida; falha de
  mídia deve ficar como warning rastreável e não travar o job principal.
  Integridade vence velocidade: antes de exportar uma conversa depois de
  navegação SPA, o content script compara uma assinatura leve dos turns do DOM
  anterior com a página atual. URL nova com DOM antigo não libera export; o item
  deve falhar no relatório em vez de salvar conteúdo do chat anterior com
  `chatId` novo. O MCP também valida o `chatId` do payload antes de escrever
  arquivo. Não remova essa barreira para ganhar performance.
  O MCP deve ser silencioso em uso normal: logs detalhados de guard/reload/wake
  só aparecem com `GEMINI_MCP_DEBUG=true` ou `GEMINI_MCP_LOG_LEVEL=info`; erros
  acionáveis vão na resposta da tool/status e relatórios de job, não em spam de
  terminal.
  A extensão Gemini CLI também publica o subagent
  `agents/gemini-vault-repair.md` e o comando
  `commands/exporter/repair-vault.toml`. Use esse subagent quando o usuário
  quiser reparar notas já salvas com conteúdo possivelmente trocado: ele deve
  preferir `scripts/vault-repair.mjs`, que roda o auditor, reexporta cada raw
  export pelo `chatId`, compara apenas o corpo Markdown, preserva o YAML
  original byte-for-byte e só troca o corpo quando houver contaminação real.
  Diferença só em YAML/frontmatter não é divergência de conteúdo, porque esses
  metadados podem ter sido enriquecidos manualmente no vault. O runner cria
  backup antes de sobrescrever e nunca sobrescreve nota com sinais de
  wiki/edição humana automaticamente. Se um raw contaminado virou wiki, a wiki
  também precisa reparo: preservar, backupear, reexportar raw correto e criar
  caso `wiki-review/<chatId>.json` para regenerar/mesclar de forma deliberada.
  Esse subagent deve usar modelo Flash e emitir relatório
  preliminar e final; se precisar reescrever uma wiki, ele pede ao agente
  principal para chamar o subagent escritor/arquitetura de notas com o case file
  e o raw corrigido. Toda wiki regenerada, reescrita ou consolidada deve
  terminar com uma seção de fontes Gemini contendo a união deduplicada de todos
  os links `https://gemini.google.com/app/<chatId>` que inspiraram a nota; nunca
  substituir uma lista multi-chat por só o último chat. O build deve copiar
  `agents/`, `commands/` e `scripts/` para `dist/gemini-cli-extension/`;
  subagents não entram em `gemini-extension.json`.
  Downloads resolvem uma conversa por `index` 1-based,
  `chatId` ou, em cadernos, `title`; pedem o Markdown à extensão e gravam
  localmente no diretório padrão configurado, sobrescrevendo arquivos
  existentes com o export mais novo.
  Para a UI da extensão, o bridge também expõe `/bridge/pick-directory`
  (abre seletor nativo de pasta no macOS/Windows; no Windows usa o diálogo
  moderno do Explorer via `IFileOpenDialog` e um owner topmost para aparecer
  à frente do browser; em outras plataformas ainda não implementado) e
  `/bridge/save-files` (grava Markdown no diretório
  escolhido, com overwrite explícito). Esses endpoints de escrita aceitam
  apenas requests originados de `https://gemini.google.com` quando chamados
  pelo browser; chamadas locais sem `Origin` seguem úteis para debug.
  Para inspeção local quando a sessão do cliente AI ainda não carregou as
  tools MCP, o bridge expõe endpoints sem CORS aberto: `/agent/clients`,
  `/agent/tabs`, `/agent/claim-tab`, `/agent/release-tab`,
  `/agent/diagnostics`,
  `/agent/recent-chats?limit=50&offset=0`,
  `/agent/export-recent-chats`,
  `/agent/export-job-status?jobId=<id>`,
  `/agent/export-job-cancel?jobId=<id>`, `/agent/notebook-chats?limit=20`,
  `/agent/current-chat`, `/agent/download-chat?index=7`,
  `/agent/download-notebook-chat?index=1`, `/agent/export-notebook`,
  `/agent/export-dir`, `/agent/set-export-dir`, `/agent/cache-status`,
  `/agent/clear-cache`, `/agent/open-chat` e `/agent/reload-tabs`.
- `scripts/build.mjs` — gera `dist/gemini-export.user.js` concatenando o
  shell com o conteúdo de `extract.mjs` inlined, além de `dist/extension/*`
  para instalação como extensão desempacotada e `dist/gemini-cli-extension/*`
  como bundle da extensão do Gemini CLI. O build valida que
  `bridge-version.json.extensionVersion` bate com `package.json`, injeta
  `protocolVersion` no content/background e copia `bridge-version.json`,
  `src/chrome-extension-guard.mjs` e `src/browser-launch.mjs` para o bundle
  Gemini CLI.
- `scripts/install-windows-launcher.cjs` — launcher empacotável para Windows.
  Em modo normal, delega para `scripts/install-windows.mjs` na pasta real do
  projeto. Em modo `pkg`, lê `release-manifest.json` embutido, extrai o payload
  para `%TEMP%` e só então executa o instalador real chamando `node.exe`
  explicitamente. **Não usar `import()` dinâmico do `.mjs` dentro do `pkg`**:
  isso quebrou em Windows real com `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
  O launcher agora depende do Node instalado no sistema e faz spawn do
  instalador ESM, evitando esse crash.
- `scripts/build-release-windows.mjs` — gera o instalador standalone de
  Windows. Roda `npm test`, monta um bundle temporário **mínimo** em
  `release/*.bundle` (sem docs/tests/userscript completo), injeta manifesto dos
  arquivos embutidos e empacota tudo com `@yao-pkg/pkg` + compressão Brotli em
  um único `.exe` em `release/`.
- `scripts/build-release-windows-prebuilt.mjs` — gera um pacote Windows
  **precompilado e leve** em `release/*.zip`. Ele inclui `install-windows.cmd`,
  `dist/extension`, `dist/gemini-cli-extension`, `scripts/install-windows.mjs`,
  `scripts/update-windows.ps1`, `scripts/repair-windows-gemini-extension.ps1`,
  `LEIA-ME.txt` e o diagnóstico, sem empacotar runtime do Node. Também grava assets estáveis
  `release/gemini-md-export-windows-prebuilt.zip` e
  `release/update-windows.ps1`/`release/repair-windows-gemini-extension.ps1`
  para GitHub Releases.
- `scripts/publish-gemini-cli-extension-branch.mjs` — publica
  `dist/gemini-cli-extension` no branch `gemini-cli-extension` com
  `gemini-extension.json` na raiz. O bundle também contém
  `browser-extension/` com a MV3 unpacked; assim `gemini extensions update
  gemini-md-export` baixa MCP e extensão de navegador juntos, restando ao
  usuário apenas recarregar manualmente o card do Chrome/Edge. Esse branch é o alvo de
  `gemini extensions install https://www.github.com/augustocaruso/gemini-md-export.git
  --ref=gemini-cli-extension --auto-update`; não instalar a extensão CLI a partir de
  `dist/gemini-cli-extension` local com `--auto-update`, porque o Gemini CLI
  atual responde `--ref and --auto-update are not applicable for local
  extensions` e a extensão fica `not updatable`.
- `scripts/install-macos.sh` — instalador assistido para macOS. É pensado para
  rodar por comando único via `bash -c "$(curl -fsSL .../install-macos.sh)"`.
  Baixa o tarball do branch `main` do GitHub, roda `npm install` e
  `npm run build`, instala em
  `~/Library/Application Support/GeminiMdExport`, copia `dist/extension` e
  `dist/gemini-cli-extension`, cria o atalho visível
  `~/GeminiMdExport-extension` apontando para
  `~/.gemini/extensions/gemini-md-export/browser-extension` quando o Gemini CLI
  está instalado, driblando o `~/Library` escondido no Finder e permitindo que
  o update nativo do Gemini CLI baixe também os arquivos da extensão Chrome,
  ajusta o bundle local para Claude/fallback, tenta registrar a extensão pelo
  comando oficial `gemini extensions install https://www.github.com/augustocaruso/gemini-md-export.git
  --ref=gemini-cli-extension --auto-update --consent`, sempre rodando antes
  `gemini extensions uninstall gemini-md-export` e removendo
  `~/.gemini/extensions/gemini-md-export` para não misturar instalação antiga
  manual com a nova, copia para `~/.gemini/extensions/gemini-md-export` como
  fallback se o Gemini CLI não estiver no PATH ou falhar, configura Claude
  Desktop quando detectado, gera
  launchers `.command`, escreve `INSTALL-SUMMARY.txt` e abre a página de
  extensões do navegador. O carregamento/reload da extensão unpacked continua
  manual por restrição do Chrome/Edge/Brave.
- `scripts/update-windows.ps1` — updater Windows pensado para ser executado por
  comando único externo via `WebClient.DownloadString(raw.githubusercontent...)`.
  Quando `-ZipUrl`/`GME_RELEASE_ZIP_URL` não é passado, consulta a API
  `repos/<repo>/releases/latest`, procura o asset estável
  `gemini-md-export-windows-prebuilt.zip` e só cai para
  `/releases/latest/download/...` como fallback. Baixa com headers explícitos,
  tenta `Invoke-WebRequest` e depois `WebClient`, extrai em `%TEMP%`, valida
  `package.json`, manifest da extensão MV3 e `gemini-extension.json`, roda o
  instalador com `GEMINI_INSTALL_PREBUILT_PAYLOAD=1`, apaga temporários em
  sucesso e preserva temp/log em falha. Aceita override por `GME_RELEASE_REPO`,
  `GME_RELEASE_ZIP_URL`, `GME_BROWSER` e flags (`-Repo`, `-ZipUrl`,
  `-Browser`, `-KeepTemp`, `-DryRun`).
- `scripts/repair-windows-gemini-extension.ps1` — reparo limpo para quando o
  auto-update do Gemini CLI fica preso em versão antiga ou falha com
  `EBUSY: resource busy or locked, rmdir ...`. Ele substitui comandos inline
  frágeis: resolve `gemini`, encerra só processos `node.exe`/`gemini.exe` que
  pertencem ao exporter, roda `gemini extensions uninstall`, remove/renomeia
  a pasta `~\.gemini\extensions\gemini-md-export` com retries, remove override
  legado de `mcpServers.gemini-md-export` no settings e reinstala a extensão
  pelo GitHub com `--ref=gemini-cli-extension --auto-update --consent`,
  validando que o manifesto instalado não tem `cwd`.
- `scripts/install-windows.mjs` + `install-windows.cmd` — instalador assistido
  para Windows. Automatiza `npm install`, `npm run build`, localização de
  instalação anterior por configs legadas do Gemini CLI/Claude Desktop ou pela pasta
  default, criação/atualização de uma instalação estável, cópia de
  `dist\extension` para compatibilidade legada, launchers/templates MCP na
  pasta instalada, e configuração do Claude Desktop/Gemini CLI quando
  detectados/solicitados. Antes de substituir uma instalação existente, salva
  backup curto em `backups\<timestamp>` e mantém os 5 backups mais recentes.
  Para Gemini CLI, tenta usar o fluxo oficial
  `gemini extensions uninstall gemini-md-export` (ignora falha) +
  `gemini extensions install https://www.github.com/augustocaruso/gemini-md-export.git
  --ref=gemini-cli-extension --auto-update --consent` para registrar a extensão como
  gerenciável/atualizável pelo Gemini CLI. Depois do uninstall e antes do novo
  install, remove explicitamente
  `%USERPROFILE%\.gemini\extensions\gemini-md-export`; isso limpa cópias
  manuais/fallback que o comando oficial pode não conhecer. Se o binário
  `gemini`/`git` não estiver no PATH ou o comando oficial falhar, cai para a
  cópia manual em `%USERPROFILE%\.gemini\extensions\gemini-md-export` e grava
  `method: manual-copy-fallback` no manifesto, deixando claro que a extensão
  pode aparecer como "not updatable". Se `settings.json` ainda contiver
  `mcpServers.gemini-md-export`, remove a entrada para ela não sobrescrever a
  config/contexto da extensão; se `mcp.allowed` existir, inclui
  `gemini-md-export`, e se `mcp.excluded` contiver o servidor, remove. Não
  pedir mais ao usuário para carregar `%LOCALAPPDATA%\GeminiMdExport\extension`
  como caminho principal: o caminho recomendado para Chrome/Edge é
  `%USERPROFILE%\.gemini\extensions\gemini-md-export\browser-extension`.
  O instalador tenta transformar a subpasta legada `extension` em junction para
  esse caminho, para instalações antigas passarem a receber os arquivos baixados
  por `gemini extensions update` depois de recarregar o card do navegador. Não
  duplica mais outra cópia do runtime em `src\`; o MCP local instalado aponta
  para `gemini-cli-extension\src\mcp-server.js`. Quando o bundle já traz
  `dist/gemini-cli-extension/src/mcp-server.js`, o `.cmd` marca
  `GEMINI_INSTALL_PREBUILT_PAYLOAD=1` e pula `npm install`/`npm run build`.
  cria pasta fixa de export por padrão; só define `GEMINI_MCP_EXPORT_DIR` no
  manifesto instalado se chamado com `--export-dir`. Também varre perfis
  Chrome/Edge/Brave/Dia em
  busca de extensões unpacked já carregadas cujo manifest seja
  "Gemini Chat -> Markdown Export" e sincroniza essas pastas com
  `dist\extension`, porque o browser pode continuar apontando para uma cópia
  antiga carregada manualmente. Não tenta burlar a restrição do Chrome/Edge:
  carregar a pasta `extension` instalada como unpacked extension continua
  sendo passo manual. O `.mjs` emite progresso em 10 passos numerados
  (`[N/10] ...`), gera `INSTALL-SUMMARY.txt`, `INSTALL-MANIFEST.json` e um
  ponteiro temporário `%TEMP%\gemini-md-export-last-install.env` para o
  `.cmd` exibir a pasta real da extensão mesmo em upgrades fora do default. O
  instalador também gera launchers `refresh-browser-extension.cmd` (abre a
  página de extensões via `cmd /c start` no executável real do browser
  escolhido usando `--new-tab`, para preferir uma aba na janela existente; se
  o browser escolhido não for encontrado, cai para outro instalado entre
  Chrome/Edge/Brave/Dia, e relembra qual card/pasta recarregar) e
  `restart-gemini-cli.cmd` (encerra MCPs antigos do
  exporter e abre uma nova janela `gemini` se o binário estiver no PATH),
  para tornar updates menos manuais. O
  `.cmd` imprime banner, detecta Node.js, mostra causas comuns de falha e
  resumo com path do `INSTALL-SUMMARY.txt` no fim. **Guarda explícito contra rodar de dentro
  do zip**: o `.cmd` detecta se `%~dp0` aponta para
  `\AppData\Local\Temp\` (padrão de preview de zip do Explorer/Outlook/
  OneDrive) ou se falta qualquer sibling esperado (`scripts\install-windows.mjs`,
  `package.json`, `src\mcp-server.js`) e aborta com mensagem pedindo
  "Extrair tudo..." antes, porque esse foi o erro real de instalação em
  prod (`MODULE_NOT_FOUND` apontando para o temp path do zip montado).
  **`spawnSync` + `.cmd` no Windows**: Node.js 24+ bloqueia `spawnSync` de
  `.cmd`/`.bat` com `shell: false` (CVE-2024-27980). `npm` no Windows é
  `npm.cmd`, então o helper `run()` do instalador detecta `.cmd`/`.bat`
  no nome do comando e ativa `shell: true` só nesse caso. **Não volte para
  `shell: false` sem essa detecção**, senão o instalador falha com
  `spawnSync npm.cmd EINVAL` em Node recente.
- `LEIA-ME.txt` (na raiz) — instruções em português para o usuário final
  não-técnico receber o comando de update, zip distribuído ou instalador,
  contendo pré-requisitos (Node.js 20+), passo-a-passo da instalação, teste
  rápido, seção "se der erro" acionável, reinstalação e desinstalação.
- `fixtures/*.html` — snippets reais de DOM capturados do Gemini. **Não há
  fixtures versionadas por default** (podem conter conteúdo pessoal); o
  usuário captura conforme precisa testar casos específicos.
- `tests/*.test.mjs` — testes com `node --test` builtin e jsdom.

## Pontos frágeis conhecidos

1. **Labels de acessibilidade**: Gemini injeta "Você disse"/"O Gemini disse"
   (e equivalentes em inglês) como nós de texto. Remover por match exato de
   conteúdo textual, não por classe — mais robusto a mudanças de CSS.
2. **Seletores de turno**: hoje `user-query, model-response`. Pode mudar
   sem aviso. Se quebrar, o fluxo de debug é: usuário abre DevTools, seleciona
   o contexto do content script da extensão se necessário, copia
   `window.__geminiMdExportDebug.snapshot()`, verifica a contagem dos seletores, copia
   outerHTML do nó de turno, salva em `fixtures/`, adapta seletor + teste.
3. **Contexto de execução MV3**: a API de debug roda no isolated world do
   content script. Se `window.__geminiMdExportDebug` não aparecer no console
   principal, selecionar o contexto do content script no DevTools ou usar logs
   e tools MCP. Não diagnosticar isso como falha do scraper antes de confirmar
   contexto e build stamp.
4. **Compatibilidade entre browsers**: sucesso no Chrome não garante
   sucesso em browsers Chromium alternativos. Se o problema só reproduz em
   um browser específico, priorizar validar no Chrome e na extensão MV3
   antes de alterar o código do scraper.
5. **Lista do modal depende do sidebar**: a exportação em lote só consegue
   listar as conversas que o Gemini já carregou na barra lateral. O shell
   tenta abrir o sidebar, observar novas conversas e acionar lazy-load, mas
   chats muito antigos ainda dependem do histórico realmente existir no DOM.
   A tool `gemini_chats { action: "download" }` usa o mesmo inventário do sidebar: por
   `index`, a posição é 1-based na lista recente carregada; por `chatId`,
   o chat também precisa estar nessa lista.
   Já a tool `gemini_chats { action: "list" }` não fica mais limitada ao inventário
   inicial: se o agente pedir, por exemplo, `limit=50&offset=100` e o sidebar
   tiver só 13 carregadas, o MCP manda a aba puxar mais histórico em rodadas
   até alcançar `offset + limit` ou `reachedSidebarEnd=true`, e devolve só a
   página solicitada. Esse caminho do MCP usa pacing mais agressivo do que o
   botão manual do modal (timeouts e pausas menores entre scrolls) para
   reduzir respostas de 20s+ quando o agente pede listas maiores, mas ainda
   faz uma confirmação final um pouco mais lenta antes de cravar o fim da
   lista. Para centenas de conversas, nunca pedir "todas" em uma chamada:
   iterar páginas de 25-50 itens usando `pagination.nextOffset`.
   Para exportar/importar o histórico inteiro, o fluxo preferido é
   `gemini_export { action: "recent" }`: ele roda em background, continua exportando
   enquanto o MCP estiver vivo e deve ser acompanhado com
   `gemini_job { action: "status" }`. O relatório JSON é atualizado durante o job,
   então uma interrupção ainda deixa rastro do que já foi salvo; se o usuário
   pedir para parar, usar `gemini_job { action: "cancel" }`, que para antes da próxima
   conversa e preserva os arquivos já gravados. Sem `maxChats`, esse job não
   usa o teto de paginação de 1000: continua mandando a aba puxar mais histórico
   em lotes até o próprio Gemini sinalizar fim do sidebar, igual ao modal. Isso
   evita que uma chamada longa do Gemini CLI precise ficar aberta enquanto
   centenas de conversas são hidratadas, navegadas e gravadas.
   Em páginas de caderno, não trocar `collectBridgeConversationLinks()` por
   `collectConversationLinks()`: a primeira combina sidebar + caderno para o
   MCP, enquanto a segunda é a lista visual do modal. Se `gemini_chats { action: "list" }`
   parar de ver conversas fora do caderno, primeiro conferir no resultado da
   tool `refreshed`, `refreshError`, `snapshot.sidebarOpen`,
   `snapshot.bridgeConversationCount` e `client.buildStamp`.
6. **Cadernos Gemini Notebook**: em `/notebook/...`, o DOM expõe a lista em
   `project-chat-history project-chat-row`, com título em
   `[data-test-id="chat-title"]`. Algumas linhas não expõem URL `/app/<id>`
   como atributo direto; o shell tenta extrair IDs de atributos e do
   `__ngContext__` Angular com busca limitada/cacheada. Se não achar, a
   exportação depende da navegação SPA do Gemini: clicar na linha deve abrir
   uma rota `/app/<chatId>`; o shell aprende e persiste esse mapeamento em
   `localStorage`. Export individual ainda pode usar navegação direta quando
   necessário, mas export em lote de caderno e comandos MCP com resposta
   pendente devem **preservar contexto**: o shell prioriza `history.back()`
   para retornar e o clique na linha visível do notebook para abrir a conversa.
   Se o histórico falhar, ele ainda tenta um link interno para a URL do
   caderno, mas sem cair em `location.href`/hard reload durante o lote. As
   políticas puras `buildNotebookReturnPlan()` e
   `buildNotebookConversationPlan()` cobrem isso e têm teste dedicado. Se o
   Gemini ainda reinicializar o content script no meio do lote, a sessão do
   batch fica em `sessionStorage` e o bootstrap retoma do item pendente. O
   indicador de fim da lista fica em rodapé próprio abaixo da área rolável;
   aparece após uma tentativa de lazy-load sem novos itens e usa texto
   específico para caderno/sidebar. **Cuidado crítico no caderno**: o
   scroller real do histórico é `.project-chat-history-container` ou
   `infinite-scroller.project-chat-history-scroller`, não o wrapper
   `<project-chat-history>`. `document.querySelector` com selector
   comma-separated pegava o wrapper (primeiro no DOM) e `scrollTop =
   scrollHeight` nele era no-op — lazy-load não disparava e o rodapé
   alternava "Role até o fim..." mesmo no fundo da lista. `findNotebookHistoryScroller()`
   itera `NOTEBOOK_SCROLLER_SELECTORS` e escolhe o primeiro com overflow
   real (`scrollHeight > clientHeight + 8`); devolve também o `wrapper`
   estável para o `MutationObserver`. Além disso, `loadMoreConversations`
   só marca `reachedSidebarEnd = true` quando `isAtBottom(scroller)` for
   verdadeiro depois do attempt — sem isso, um scroll no-op virava "fim"
   falso.
7. **LaTeX**: renderizado via KaTeX/MathJax. `innerText` geralmente retorna
   o LaTeX original dos atributos `aria-label`/`annotation`, mas fórmulas
   complexas podem degradar. Caso cliente médico tenha problema com isso,
   adicionar passe específico que lê `[data-math]` ou `annotation[encoding]`.
8. **Lazy load da conversa**: o DOM só contém turnos renderizados. Antes de
   exportar, o shell tenta hidratar conversas longas com estratégia semelhante
   ao SaveChat: encontra o scroller real do chat
   (`#chat-history[data-test-id="chat-history-container"]`,
   `infinite-scroller.chat-history`, `.chat-history-scroll-container` ou
   fallback), mas **só aceita o candidato como host se ele tiver overflow
   real** (`scrollHeight > clientHeight + 8`). Não voltar a escolher o
   primeiro seletor encontrado sem esse teste: um wrapper não rolável faz a
   hidratação concluir cedo e gera Markdown truncado. Depois de escolher o
   scroller, seta o scroll no topo e aguarda mudança por contagem de
   `div.conversation-container` **ou** pela assinatura textual do primeiro
   turno, porque loaders virtuais podem trocar blocos sem aumentar a contagem.
   Só exporta quando `reachedTop=true` e `timedOut=false`; se não conseguir
   provar que chegou ao início, o export falha em vez de gravar arquivo
   truncado. `__geminiMdExportDebug.hydrateCurrentConversation()` expõe essa
   hidratação para diagnóstico. O MCP aguarda comandos por 180s por padrão, mas
   a hidratação deve parar antes quando o topo estabiliza.
   Performance do export total: `gemini_export { action: "recent" }` carrega o sidebar
   em rodadas adaptativas e registra `loadMoreTrace`/`metrics.lazyLoad` para
   mostrar crescimento, timeouts, batch size e rodadas sem avanço. Durante o
   batch, não retornar para a conversa original entre cada item; isso evitaria
   duas navegações por chat e degrada muito centenas de exports.
9. **Chat ID da URL ≠ chat ID do gemini-webapi**: a URL pública usa um ID
   hexadecimal em `/app/<hex>` (normalmente 16+ chars; o scraper aceita 12+
   para tolerar variações); o `gemini-webapi` usa formato `c_<alfanum>`.
   São o mesmo chat no backend mas representações distintas. Preservar o hex
   da URL no frontmatter; não tentar converter.

## Regras de contribuição

- **Nunca adicionar dependências de runtime.** O bundle da extensão e o MCP
  instalado devem continuar leves e autossuficientes; dependências de runtime
  novas exigem justificativa explícita.
- Dependências de dev (testes, build) em `package.json`, tudo bem, mas
  mantenha mínimas. Hoje: apenas `jsdom`.
- Toda mudança em `src/extract.mjs` deve ter teste correspondente em
  `tests/`. Mudanças no shell que mexam em injeção de botão,
  `MutationObserver`, IDs de UI ou top-bar também precisam de teste em
  `tests/content-script.test.mjs`. Mudanças em lote/retomada de notebook
  também precisam de teste em `tests/notebook-return-plan.test.mjs` e/ou
  `tests/batch-session.test.mjs`.
- Commits em português com Conventional Commits
  (ex: `fix: remover labels de acessibilidade do turno do usuário`).
- Mudanças cirúrgicas. Não refatorar áreas não pedidas. Se vir algo ruim
  fora do escopo imediato, aponte mas não mexa.
- Sempre rodar `npm test` antes de considerar uma mudança pronta.
- **Documentação viva**: toda mudança que altere comportamento observável,
  fluxo de uso, arquitetura, pontos frágeis ou ambiente de desenvolvimento
  DEVE atualizar, no mesmo commit, os arquivos relevantes (`AGENTS.md`,
  `CLAUDE.md`, `README.md`, `fixtures/README.md`). `AGENTS.md` e `CLAUDE.md`
  são espelhos — diferentes agentes leem arquivos diferentes (Codex/OpenAI
  lê `AGENTS.md`, Claude lê `CLAUDE.md`), então toda edição em um replica
  no outro no mesmo commit. Se um ponto frágil foi resolvido,
  remova da lista. Se um novo apareceu, adicione. Doc desatualizada conta
  como bug — não feche a task sem sincronizar.

## Ambiente de desenvolvimento (macOS)

- Node é instalado via Homebrew (`brew install node`). Binários ficam em
  `/opt/homebrew/bin/{node,npm}`. Se `npm` não está no PATH, ou o shell
  ainda não carregou o profile do brew, ou o usuário precisa adicionar
  `eval "$(/opt/homebrew/bin/brew shellenv)"` ao `~/.zshrc`.
- Versão atual verificada: Node 25, npm 11 (qualquer Node ≥20 serve).
- Para instalar em macOS de forma assistida, usar:
  `bash -c "$(curl -fsSL https://raw.githubusercontent.com/augustocaruso/gemini-md-export/main/scripts/install-macos.sh)"`.
  Variáveis úteis: `GME_INSTALL_DIR`, `GME_EXPORT_DIR`, `GME_BROWSER`
  (`chrome`/`edge`/`brave`), `GME_CONFIGURE_GEMINI`, `GME_CONFIGURE_CLAUDE`,
  `GME_EXTENSION_LINK` (atalho visível; vazio desativa),
  `GME_GEMINI_EXTENSION_SOURCE`, `GME_GEMINI_EXTENSION_REF`, `GME_KEEP_TEMP`.

## Ambiente de instalação (Windows)

- Requer Node.js ≥20 instalado e disponível no PATH.
- O instalador assistido é `install-windows.cmd` ou `npm run install:windows`.
- Caminho recomendado para usuário final: comando PowerShell externo que baixa
  `update-windows.ps1` do `main` via `raw.githubusercontent.com`; o script então
  consulta a API de releases do GitHub e baixa o zip da última release. Esse
  caminho evita depender do redirect `/releases/latest/download` no PowerShell:
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; iex ((New-Object Net.WebClient).DownloadString('https://www.github.com/augustocaruso/gemini-md-export/releases/latest/download/update-windows.ps1'))"`.
- Para distribuir/atualizar releases, use `npm run release:windows:prebuilt`;
  ele gera `release/gemini-md-export-windows-prebuilt.zip`,
  `release/update-windows.ps1` e um zip versionado. O workflow
  `.github/workflows/release-windows.yml` publica esses assets quando uma tag
  `v*` é enviada.
- `npm run release:windows` ainda gera o `.exe` standalone, mas esse caminho é
  secundário porque o `.exe` foi menos confiável no ambiente real e ainda
  depende de Node.js instalado para o MCP final.
- Por padrão instala os arquivos em `%LOCALAPPDATA%\GeminiMdExport`; a extensão
  fica na subpasta `extension`. Se já houver config do Gemini CLI ou Claude
  Desktop apontando para outra instalação, o instalador reaproveita esse
  caminho como alvo de upgrade, salvo quando `--install-dir` é passado. O
  runtime MCP local agora reaproveita `gemini-cli-extension\src\mcp-server.js`
  em vez de duplicar outra cópia solta em `src\`.
- O instalador pode configurar Claude Desktop em
  `%APPDATA%\Claude\claude_desktop_config.json`; antes de alterar um arquivo
  existente, cria backup `.bak-<timestamp>`.
- O instalador pode configurar Gemini CLI em
  `%USERPROFILE%\.gemini\settings.json`; antes de alterar um arquivo existente,
  cria backup `.bak-<timestamp>`, respeita/ajusta `mcp.allowed` e
  `mcp.excluded`, remove override legado de `mcpServers.gemini-md-export` e
  instala a extensão em `%USERPROFILE%\.gemini\extensions\gemini-md-export`.
- Há um script de diagnóstico Windows em `diagnose-windows-mcp.ps1`. Ele
  checa a config do Gemini CLI, a extensão instalada em
  `%USERPROFILE%\.gemini\extensions\gemini-md-export`, paths do
  `node.exe`/`mcp-server.js`, processos `node.exe`, listener da porta `47283`,
  `/healthz` do bridge e imprime o comando manual equivalente da config
  efetiva.
- A extensão MV3 ainda precisa ser carregada manualmente em
  `chrome://extensions`/`edge://extensions` com **Developer mode** e
  **Load unpacked**, apontando para a pasta `extension` exibida no final do
  instalador. Em upgrades, o launcher `refresh-browser-extension.cmd`
  acelera a volta para essa página e relembra o card correto, mas o clique
  no reload do card continua sendo manual. Depois que a extensão recarrega, o
  service worker tenta recarregar automaticamente as abas abertas do Gemini.
- O launcher `open-gemini.cmd` abre `https://gemini.google.com/app`. O teste
  manual do botão precisa de uma conversa `/app/<id>`; abrir só a home do
  Gemini pode parecer "página errada" porque o top-bar da conversa ainda não
  existe.
- Na extensão MV3, o botão **Alterar** do destino não cai mais em
  `showDirectoryPicker()` quando o MCP local falha. Esse fallback abria a
  janelinha velha do browser no Windows e confundia o debug. Se o MCP não
  responder, mostrar erro e manter Downloads como fallback.
- No Gemini CLI, o launcher `restart-gemini-cli.cmd` ajuda no refresh do
  update, mas não consegue “assumir” uma sessão interativa já aberta; se o
  usuário mantiver uma sessão antiga viva, o comportamento pode continuar
  confuso até ela ser fechada.

## Fluxo de desenvolvimento

1. `npm install` uma vez.
2. Editar `src/extract.mjs`, `src/userscript-shell.js`, MCP ou scripts.
3. `npm test` — roda `npm run build` e depois os testes; deve passar.
4. `npm run build` — opcional quando quiser apenas regenerar `dist/`.
5. Para extensão: carregar `dist/extension/` como unpacked extension.
6. Para MCP local: `npm run mcp` ou configurar `src/mcp-server.js` no cliente
   MCP via `stdio`.
7. Para instalação assistida em macOS: `npm run install:macos` ou o comando
   `curl | bash` documentado no README.
8. Para instalação assistida em Windows: `install-windows.cmd` ou
   `npm run install:windows`.
9. Se mudou content script ou comandos do bridge, recarregar a extensão
   desempacotada no browser.
10. Recarregar aba do Gemini, testar manualmente.
11. Se falhar no navegador, abrir o Console e usar
   `window.__geminiMdExportDebug.snapshot()` / `markdown()` no contexto do
   content script, ou consultar as tools/endpoints MCP.

## Como adicionar uma fixture nova (quando algo quebrar)

1. No browser, na conversa que reproduz o bug:
   `copy(document.querySelector('model-response').outerHTML)` (ou
   `user-query`) no DevTools Console.
2. Colar em `fixtures/<nome-descritivo>.html`.
3. Em `tests/extract.test.mjs`, adicionar caso que carrega a fixture e
   asserta a saída esperada.
4. Ajustar `src/extract.mjs` até o teste passar.
