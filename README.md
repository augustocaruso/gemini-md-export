# gemini-md-export

Ferramenta para exportar conversas do [Gemini web](https://gemini.google.com)
como arquivos Markdown, com frontmatter YAML preservando `chat_id`, URL
original, timestamp e outros metadados — pronta para ingestão em vault do
Obsidian. O caminho principal é uma extensão MV3 + servidor MCP local,
instalados/atualizados pelo pacote Windows ou pelo updater via GitHub Releases.

## Instalação da extensão

1. Rode o build localmente:
   ```bash
   npm install
   npm run build
   ```
2. Abra `chrome://extensions` ou equivalente no seu browser Chromium.
3. Ative `Developer mode`.
4. Clique em `Load unpacked`.
5. Selecione a pasta [dist/extension](/Users/augustocaruso/Documents/gemini-md-export/dist/extension).

## Instalação assistida no Windows

Para um computador Windows, o caminho mais simples é copiar/clonar a pasta do
projeto e dar duplo clique em [install-windows.cmd](/Users/augustocaruso/Documents/gemini-md-export/install-windows.cmd).
O instalador faz o máximo que o browser permite:

- Verifica Node.js 20+.
- Roda `npm install` e `npm run build`.
- Localiza uma instalação anterior por configs legadas do Gemini CLI/Claude Desktop
  ou pelo default `%LOCALAPPDATA%\GeminiMdExport`.
- Substitui a extensão e o MCP na pasta instalada, mantendo backup curto em
  `backups\...`.
- Procura extensões unpacked já carregadas em perfis Chrome/Edge/Brave/Dia e
  sincroniza a pasta que o browser realmente está usando, para evitar o caso
  em que o instalador atualiza uma cópia mas o navegador continua carregando
  outra.
- Deixa a extensão pronta na subpasta `extension` da instalação escolhida.
- Gera launchers e templates MCP, incluindo `start-mcp.cmd`,
  `open-gemini.cmd`, `refresh-browser-extension.cmd`, `restart-gemini-cli.cmd`,
  `mcp-config.claude.json` e um bundle `gemini-cli-extension` com
  `gemini-extension.json` + `GEMINI.md` próprios.
- Configura automaticamente o Claude Desktop se a pasta/config dele já existir.
- Configura automaticamente o Gemini CLI se `~\.gemini` ou o binário `gemini`
  for detectado; instala a extensão local em
  `~\.gemini\extensions\gemini-md-export`, ajusta `mcp.allowed`/`mcp.excluded`
  se existirem e remove eventual override legado de `mcpServers` no
  `settings.json`, para não sombrear o `GEMINI.md` da extensão.
- Abre a tela de extensões do browser para o passo manual obrigatório.

O único passo que ainda precisa ser manual, por segurança do Chrome/Edge, é:
ativar **Developer mode**, clicar **Load unpacked** e selecionar a pasta
`extension` mostrada pelo instalador. Normalmente ela fica em
`%LOCALAPPDATA%\GeminiMdExport\extension`, mas em upgrades o instalador pode
reusar um caminho anterior detectado nas configs. Se a extensão já estiver
carregada, clique no ícone de reload do card dela após rodar o instalador ou
use `refresh-browser-extension.cmd` na pasta instalada, que abre a página de
extensões no navegador certo e relembra o card/pasta esperados.
No Windows, o instalador agora tenta abrir a página de extensões usando o
executável real do browser escolhido, em vez de depender do protocolo cru do
sistema que às vezes cai na Microsoft Store.
Para o teste manual, use uma conversa em `https://gemini.google.com/app/...`;
abrir só a home do Gemini pode parecer "página errada", porque o botão de
export fica na tela de conversa e não na landing page.

Para o Gemini CLI, upgrades também ficam mais cômodos: a pasta instalada agora
inclui `restart-gemini-cli.cmd`, que encerra MCPs antigos do exporter e abre
uma nova janela `gemini` quando o binário estiver no `PATH`. Isso não substitui
o restart da sessão antiga, mas reduz bastante o vai-e-volta manual no update.

## Update por GitHub Releases

Depois que o repositório público estiver publicado, o caminho recomendado para
o usuário final é um único comando PowerShell. Ele baixa o updater da última
release, baixa o pacote precompilado, extrai em `%TEMP%`, valida o payload, roda
o instalador a partir da pasta correta e apaga os temporários depois de instalar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/augustocaruso/gemini-md-export/releases/latest/download/update-windows.ps1 | iex"
```

Se o exporter já estiver instalado no Gemini CLI, também dá para pedir pelo
atalho `/exporter:update`. A extensão chama a tool MCP `gemini_exporter_update`,
que dispara o mesmo updater em um processo separado para não sobrescrever o MCP
que está em uso. Depois do update, feche e reabra o Gemini CLI; no navegador,
clique no reload do card da extensão unpacked se ela já estava carregada.

O comando aceita override sem editar arquivo:

```powershell
$env:GME_RELEASE_REPO="outro-dono/outro-repo"
$env:GME_BROWSER="edge"
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/outro-dono/outro-repo/releases/latest/download/update-windows.ps1 | iex"
```

## Instalador Standalone `.exe`

Se você quer um pacote bem menor e aceita depender do Node já instalado no
Windows, o caminho mais honesto agora é o bundle precompilado:

```bash
npm run release:windows:prebuilt
```

Ele gera um `.zip` pequeno em `release/` com `install-windows.cmd`,
`dist/extension`, `dist/gemini-cli-extension`, `scripts/update-windows.ps1` e o
instalador já preparado para detectar esse layout prebuilt. Também grava os
assets estáveis `release/gemini-md-export-windows-prebuilt.zip` e
`release/update-windows.ps1`, pensados para upload em GitHub Releases. Nesse
modo, o instalador não roda `npm install` nem `npm run build`; ele só usa o
`node.exe` do sistema para executar o instalador e copiar os artefatos prontos.

O projeto agora também consegue gerar um instalador Windows de arquivo único:

```bash
npm run release:windows
```

Esse comando roda `npm test`, monta um bundle temporário com o payload do
instalador e empacota tudo em um único `.exe` standalone em `release/`.

O artefato final sai com nome como:
`gemini-md-export-windows-v0.1.16-YYYYMMDD-HHMM.exe`

O launcher se autoextrai para `%TEMP%` e roda um payload **precompilado mínimo**,
sem empacotar a pasta inteira do projeto nem rodar `npm install`/`npm run build`
no destino.

Importante: isso reduz o tamanho e acelera a instalação, mas ainda não elimina
o pré-requisito de Node.js no Windows, porque o MCP instalado continua rodando
via `node.exe` no sistema. O launcher standalone também chama `node.exe`
explicitamente para executar o instalador ESM extraído; isso evita o crash de
`pkg` com `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.

Por padrão, o instalador não cria pasta fixa de export. O MCP usa Downloads
como fallback e o botão **Alterar** no modal permite escolher outra pasta via
MCP local. Na extensão MV3, se o MCP estiver indisponível, o script não abre
mais o seletor velho do browser; ele mostra erro e mantém Downloads como
fallback. Use `--export-dir` apenas se quiser travar um destino padrão.

Opções úteis:

```powershell
npm run install:windows -- --configure-claude
npm run install:windows -- --export-dir "C:\Users\Nome\Documents\GeminiExports"
npm run install:windows -- --install-dir "D:\Apps\GeminiMdExport"
npm run install:windows -- --browser edge --open-browser
npm run install:windows -- --browser dia --open-browser
```

Se o Gemini CLI no Windows ficar marcando o MCP como disconnected, rode
[diagnose-windows-mcp.ps1](/Users/augustocaruso/Documents/gemini-md-export/diagnose-windows-mcp.ps1)
em um PowerShell. Ele checa `~\.gemini\settings.json`, paths de
`node.exe`/`mcp-server.js`, a extensão instalada em
`~\.gemini\extensions\gemini-md-export`, processos `node.exe`, listener da
porta `47283`, `/healthz` do bridge e imprime o comando manual equivalente da
config efetiva.

## Extensão do Gemini CLI

O build agora também gera um pacote de extensão do Gemini CLI em
[dist/gemini-cli-extension](/Users/augustocaruso/Documents/gemini-md-export/dist/gemini-cli-extension).
Esse bundle inclui:

- `gemini-extension.json`
- `GEMINI.md` próprio da extensão
- `src/mcp-server.js` e módulos auxiliares

Isso permite que o Gemini CLI carregue o contexto operacional do exporter sem
depender do `cwd` do projeto nem poluir o `~/.gemini/GEMINI.md` global.
No Windows, o instalador copia esse bundle tanto para a instalação local quanto
para `~/.gemini/extensions/gemini-md-export`.

## Servidor MCP

O projeto agora inclui um servidor MCP local em
[src/mcp-server.js](/Users/augustocaruso/Documents/gemini-md-export/src/mcp-server.js).
Ele sobe via `stdio` para o cliente AI e, no mesmo processo, abre um bridge
HTTP local em `127.0.0.1:47283` para a extensão.
Quando o cliente MCP fecha o `stdin`, o processo agora encerra junto em vez de
ficar zumbi mantendo a porta do bridge ocupada. Se outra instância já estiver
segurando a `47283`, o servidor registra erro claro de porta em uso e sai com
falha, em vez de parecer um "disconnect" misterioso no Gemini CLI.
Quando a extensão está ativa e o MCP está rodando, o modal também consegue
abrir o seletor nativo de pasta no macOS ou Windows e gravar os arquivos nessa
pasta via bridge local. No Windows, o seletor usa o diálogo moderno do
Explorer e tenta abrir em primeiro plano; se nenhuma pasta for escolhida, o
fallback continua sendo a pasta padrão de downloads do navegador.
Para inspeção por agentes locais quando a tool MCP ainda não foi carregada na
sessão, o bridge também expõe endpoints sem CORS aberto:
`/agent/clients`, `/agent/recent-chats?limit=10`,
`/agent/notebook-chats?limit=20`, `/agent/current-chat`,
`/agent/download-chat?index=7`, `/agent/download-notebook-chat?index=1`,
`/agent/export-notebook`, `/agent/export-dir`, `/agent/set-export-dir`,
`/agent/cache-status`, `/agent/clear-cache` e `/agent/open-chat`.

Para rodar manualmente:

```bash
npm run mcp
```

As tools expostas são:

- `gemini_browser_status`
- `gemini_get_export_dir`
- `gemini_set_export_dir`
- `gemini_list_recent_chats`
- `gemini_list_notebook_chats`
- `gemini_get_current_chat`
- `gemini_download_chat`
- `gemini_download_notebook_chat`
- `gemini_export_notebook`
- `gemini_cache_status`
- `gemini_clear_cache`
- `gemini_open_chat`
- `gemini_snapshot`

`gemini_list_recent_chats` e `/agent/recent-chats` agora respondem primeiro
com a lista recente já trazida pelo heartbeat da extensão quando ela estiver
fresca, o que deixa o agente bem mais rápido no caminho comum. Se precisar
forçar uma atualização visual do sidebar antes da resposta, use `refresh=true`
na tool ou no endpoint HTTP. Se quiser máxima velocidade mesmo com cache velho,
use `refresh=false`. Mesmo com `refresh=true`, quando já existe cache o MCP usa
um budget curto antes de cair de volta para a lista já conhecida, para não
deixar o agente pendurado em abas lentas ou em background. No lado da extensão,
o long-poll de comandos também usa retry curto e é reativado após heartbeat
bem-sucedido, reduzindo a latência depois de restart do MCP ou falhas
transitórias no bridge local. Se o agente pedir mais conversas do que o sidebar
tem carregado no momento, o MCP agora tenta puxar mais histórico automaticamente
na aba até atingir o limite pedido ou detectar `reachedSidebarEnd=true`. Esse
auto-load do MCP usa pacing mais agressivo do que o botão manual do modal, com
pausas mais curtas entre scrolls/observações, para evitar respostas de 20s+
quando o agente pede listas maiores, mas ainda faz uma última confirmação um
pouco mais lenta antes de cravar o fim da lista.

## Uso

1. Abra uma conversa em `https://gemini.google.com/app/<id>`.
2. Clique no botão circular de download no topo da conversa, ao lado das ações
   do Gemini, para abrir o modal de exportação em lote.
3. Busque, use **Puxar mais histórico** quando precisar trazer chats antigos
   do sidebar, e selecione as conversas desejadas.
4. Clique em **Alterar** no bloco **Destino** se quiser escolher outra pasta.
   Na extensão com o MCP rodando, isso abre o seletor nativo do macOS/Windows
   e salva via bridge local. Sem pasta escolhida, o fallback é a pasta padrão
   de downloads do navegador.
5. Ao iniciar o lote, o modal some e fica só uma barra de progresso discreta
   até o fim da exportação.
6. Pressione **Ctrl+Shift+E** se quiser exportar só a conversa atual com o
   fluxo rápido.
7. O lote tenta voltar para a conversa original quando terminar.
8. Se algo falhar, abra o DevTools Console e rode
   `window.__geminiMdExportDebug.snapshot()` para inspecionar URL, chat id,
   quantidade de turnos detectados e contagem dos seletores atuais. Na
   extensão MV3, se a API não aparecer no contexto principal da página,
   selecione o contexto do content script no DevTools ou use as tools MCP.

Depois de um upgrade no Windows, o fluxo mais rápido é rodar o comando
PowerShell da seção "Update por GitHub Releases" ou, se o Gemini CLI já estiver
com a extensão ativa, usar `/exporter:update`. Ao terminar, recarregue a
extensão em `chrome://extensions` e reabra o Gemini CLI se ele estiver em uso.

O botão e o modal atuais usam ids `gm-md-export-modern-*` e carregam versão +
carimbo de build no DOM. Se aparecer UI antiga junto da nova, desative cópias
antigas do exporter no navegador antes de investigar o scraper.

Em páginas de caderno (`/notebook/...`), o modal lista as conversas recentes
do próprio caderno a partir de `project-chat-history`. Ao exportar uma linha
do caderno, o script tenta extrair o `chatId` da própria linha/estado Angular.
Quando consegue, aprende a URL `/app/<chatId>`, mas em lote de caderno ainda
prioriza clicar de novo na linha visível do notebook para não matar o contexto
JS do batch com uma navegação direta cedo demais. Se não consegue, clica na
linha, espera o Gemini abrir a rota e grava esse mapeamento em cache local
para as próximas listagens. No lote de caderno, antes de cada item o script
prioriza `history.back()` para voltar ao caderno sem matar o contexto JS do
batch; se isso falhar, ele ainda tenta um link interno para a URL do caderno,
mas evita `location.href`/hard reload durante o lote. Navegação direta fica
reservada a fluxos em que recarregar a página não quebraria a resposta.
Se o Gemini ainda reinicializar o content script no meio dessa navegação, a
sessão do lote fica em `sessionStorage` da aba e o bootstrap tenta retomar do
item pendente automaticamente.

## Compatibilidade

- Alvo principal: extensão MV3 desempacotada em Chrome/Edge/Chromium, com
  servidor MCP local.
- O script pode não se comportar corretamente em browsers Chromium com UI
  customizada ou suporte parcial a extensões.
- Se funcionar no Chrome e falhar só em outro browser, trate primeiro como
  limitação do ambiente antes de mexer no scraper.
- Na extensão MV3, a escolha de pasta preferencial usa o MCP local:
  `/bridge/pick-directory` abre o seletor nativo do macOS/Windows e
  `/bridge/save-files` grava os Markdown no diretório escolhido. Em outras
  plataformas, use `GEMINI_MCP_EXPORT_DIR` ou o fallback de downloads.
- Quando a extensão salva via MCP, arquivos com o mesmo nome são substituídos
  pelo export mais novo. Se o MCP estiver indisponível e o script cair no
  download nativo do browser, o browser pode aplicar sua própria política de
  conflito e não garantir overwrite.

## Formato do arquivo

```markdown
---
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
exported_at: 2026-04-22T18:32:11.245Z
model: "2.5 Pro"
source: gemini-web
tags: [gemini-export]
---

## 🧑 Usuário

...pergunta...

---

## 🤖 Gemini

...resposta...
```

## Desenvolvimento

```bash
npm install     # uma vez
npm test        # roda build + testes, incluindo injeção do content script
npm run build   # gera dist/extension e dist/gemini-cli-extension
npm run mcp     # sobe o servidor MCP/bridge local
npm run install:windows # instalador assistido para Windows
```

No Windows, o diagnóstico rápido de desconexão do Gemini CLI fica em
[diagnose-windows-mcp.ps1](/Users/augustocaruso/Documents/gemini-md-export/diagnose-windows-mcp.ps1).

O teste `tests/content-script.test.mjs` executa o content script em `jsdom`
com uma top-bar simulada do Gemini e valida que o botão aparece sem criar loop
de `MutationObserver`. Os testes `tests/notebook-return-plan.test.mjs` e
`tests/batch-session.test.mjs` cobrem a política de retorno/abertura do
caderno e a serialização/retomada do batch via `sessionStorage`.

Depois de alterar o content script ou comandos do bridge, recarregue a extensão
desempacotada em `chrome://extensions` e recarregue a aba do Gemini.

Ver [`CLAUDE.md`](./CLAUDE.md) para arquitetura, pontos frágeis conhecidos
e regras de contribuição.

## Debug no browser

- A extensão MV3 usa o scraper/shell como content script e um service worker
  mínimo como base para integrações locais.
- Quando a extensão está ativa numa aba do Gemini, o content script envia
  heartbeat para o bridge local do MCP server e aceita comandos do agente
  via long-poll. Se houver várias abas Gemini vivas, o MCP prefere a aba
  ativa informada pela extensão antes de cair no fallback de heartbeat mais
  recente. O status inclui `buildStamp` para confirmar que o navegador recarregou
  o build esperado.
- A API `window.__geminiMdExportDebug` roda no isolated world do content
  script; se não aparecer no console principal, selecione o contexto do content
  script no DevTools ou use os logs/MCP.
  - `snapshot()` para resumo do estado atual do DOM.
  - `scrapeTurns()` para ver quantos turnos estão sendo encontrados.
  - `markdown()` para inspecionar o Markdown gerado sem baixar arquivo.
  - `exportNow()` para disparar a exportação manualmente pelo console.
  - `openExportModal()` para abrir o modal pelo console.
  - `listConversations()` para ver as conversas carregadas na lista atual
    (sidebar global ou caderno).
  - `loadMoreConversations()` para forçar uma nova tentativa de puxar mais
    histórico do sidebar ou do caderno.
- Se houver dúvida se o problema é do script ou do browser/manager, use
  [debug/tampermonkey-probe.user.js](/Users/augustocaruso/Documents/gemini-md-export/debug/tampermonkey-probe.user.js).
  Esse probe é legado e não faz parte do fluxo recomendado.

## Limitações

- Antes de exportar, o content script tenta hidratar conversas longas usando
  a mesma estratégia observada no SaveChat: encontra o scroller real do chat
  (`#chat-history`/`infinite-scroller`), joga o scroll para o topo, espera o
  número de containers de conversa estabilizar e só então extrai o DOM.
- O modal lista as conversas atualmente carregadas na barra lateral do
  Gemini. Se chats antigos não aparecerem, o usuário precisa expandir a
  lista/histórico do Gemini. O modal tenta abrir o sidebar, acompanha novas
  conversas em tempo real e rolar até o fim da lista ou clicar em
  **Puxar mais histórico** dispara novas tentativas de lazy-load.
- Em páginas de caderno, a lista vem de `project-chat-history project-chat-row`
  em vez do sidebar global. O shell tenta extrair `chatId` de atributos e do
  contexto Angular (`__ngContext__`) da linha; se não encontrar, usa o clique
  da própria linha, aguarda a rota `/app/` carregar, salva o mapeamento em
  `localStorage` e usa `history.back()` para retornar ao caderno durante lotes,
  com fallback para link interno/navegação direta se o browser não voltar.
  O indicador de fim fica em rodapé próprio abaixo da área rolável e marca fim
  após uma tentativa curta sem novos itens, com texto próprio para caderno ou
  sidebar.
- Para agentes/MCP, uma página de caderno envia duas visões ao mesmo tempo:
  `modalConversations` com a lista visual do caderno e `conversations` com
  sidebar global + caderno. Assim `gemini_list_recent_chats` continua vendo
  conversas fora do caderno enquanto `gemini_list_notebook_chats` lista só o
  caderno. Antes de responder, `gemini_list_recent_chats` tenta pedir uma
  atualização fresca à aba e abrir o sidebar se necessário.
- Durante a exportação em lote, o modal é recolhido e o script mostra só uma
  barra de progresso compacta e fixa.
- O export em lote navega sequencialmente pelas conversas selecionadas na aba
  atual para capturar o conteúdo completo de cada chat.
- As tools MCP refletem a aba do Gemini que estiver conectada/ativa na
  extensão. Se não houver aba viva, o agente não consegue ler o DOM.
- Se o cliente AI ainda não tiver carregado as tools MCP, um agente local pode
  consultar `http://127.0.0.1:47283/agent/recent-chats?limit=10` para ver as
  conversas carregadas no sidebar pela extensão,
  `/agent/notebook-chats?limit=20` para ver conversas do caderno,
  `/agent/current-chat` para pedir o Markdown da conversa aberta,
  `/agent/download-chat?index=7` para salvar uma conversa visível do sidebar,
  ou `/agent/download-notebook-chat?index=1` para salvar conversa de caderno.
- `gemini_download_chat` aceita `index` 1-based da lista recente ou `chatId`,
  navega a aba do Gemini até a conversa, exporta o Markdown e grava o arquivo
  localmente. Por padrão, salva em `~/Downloads` e tenta voltar para a conversa
  original. Se o arquivo já existir, o MCP sobrescreve pelo export mais novo.
  Conversas longas têm timeout padrão de 180 segundos no MCP, mas a hidratação
  costuma parar antes quando o topo estabiliza.
- `gemini_export_notebook` exporta em lote as conversas carregadas no caderno;
  `gemini_get_export_dir`/`gemini_set_export_dir` controlam o destino padrão
  do MCP; `gemini_cache_status`/`gemini_clear_cache` inspecionam e limpam o
  cache aprendido de URLs de caderno; `gemini_open_chat` navega a aba para um
  chat por `chatId`, URL, índice ou título.
- LaTeX complexo (MathJax/KaTeX) pode degradar em casos raros.
- Seletores de DOM do Gemini podem mudar sem aviso. Se quebrar, ver a seção
  "Como adicionar uma fixture nova" em `CLAUDE.md`.
