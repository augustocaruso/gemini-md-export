# gemini-md-export

Exporta conversas do [Gemini web](https://gemini.google.com/app) para arquivos
Markdown com frontmatter YAML, prontos para entrar em um vault do Obsidian.

O caminho principal hoje é:

- extensão MV3 no Chrome/Edge/Chromium;
- servidor MCP local que conversa com a extensão;
- instaladores macOS/Windows via GitHub;
- integração opcional com Gemini CLI e Claude Desktop.

O projeto não usa API oficial do Gemini, cookies ou automação de login. Ele lê
apenas o DOM já renderizado em uma aba do Gemini aberta pelo usuário.

## Roadmap

As próximas frentes de estabilidade, modo proxy, limpeza de processos antigos e
performance do export total ficam em [ROADMAP.md](ROADMAP.md).

## Instalação Rápida no macOS

Pré-requisitos:

- macOS;
- Chrome, Edge ou Brave;
- Node.js 20+ (`brew install node`);
- Gemini CLI opcional, mas recomendado.

No Terminal, rode:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/augustocaruso/gemini-md-export/main/scripts/install-macos.sh)"
```

Esse comando baixa o projeto, roda `npm install`/`npm run build`, instala em
`~/Library/Application Support/GeminiMdExport`, cria o atalho visível
`~/GeminiMdExport-extension` apontando para a cópia da extensão do navegador
baixada junto com a extensão do Gemini CLI, tenta registrar a extensão do
Gemini CLI pelo GitHub com
`gemini extensions install https://www.github.com/augustocaruso/gemini-md-export.git --ref=gemini-cli-extension --auto-update`,
configura Claude Desktop quando detectado e abre a página de extensões do
navegador.

O passo que continua manual por restrição do Chrome/Edge/Brave é carregar ou
recarregar a extensão unpacked:

1. Abra `chrome://extensions`, `edge://extensions` ou `brave://extensions`.
2. Ative **Developer mode**.
3. Clique em **Load unpacked** / **Carregar sem compactação**.
4. Selecione o atalho visível `~/GeminiMdExport-extension`.
5. Se a extensão já estava carregada, clique no ícone circular de reload no
   card dela.

Se preferir colar o caminho completo no seletor de arquivos, pressione
`Cmd+Shift+G` e cole:

```text
~/.gemini/extensions/gemini-md-export/browser-extension
```

Depois feche e reabra o Gemini CLI, abra uma conversa em
`https://gemini.google.com/app/<id>` e procure o botão circular de download no
canto superior direito.

## Instalação Rápida no Windows

Pré-requisitos:

- Windows 10 ou 11;
- Chrome ou Edge;
- Node.js 20+ instalado com a opção **Add to PATH** marcada.

No PowerShell, rode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; iex ((New-Object Net.WebClient).DownloadString('https://www.github.com/augustocaruso/gemini-md-export/releases/latest/download/update-windows.ps1'))"
```

Esse comando baixa o updater publicado na última release oficial; o updater
consulta a API do GitHub, baixa o pacote precompilado mais recente, extrai em
uma pasta temporária, valida o pacote, instala/atualiza o MCP e a extensão,
sincroniza cópias unpacked já carregadas no navegador quando possível e apaga
os temporários após sucesso. Se o Chrome não for encontrado, o instalador tenta
abrir Edge/Brave/Dia como fallback para não travar no passo da página de
extensões. O bootstrap baixa só o script pequeno da release; o pacote
precompilado grande é resolvido pelo updater via API do GitHub.

Se o auto-update do Gemini CLI travar com `EBUSY`/`resource busy or locked`,
use o reparo limpo em vez de colar comandos longos de PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/augustocaruso/gemini-md-export/main/scripts/repair-windows-gemini-extension.ps1'))"
```

O passo que continua manual por restrição do Chrome/Edge é carregar ou
recarregar a extensão unpacked:

1. Abra `chrome://extensions` ou `edge://extensions`.
2. Ative **Developer mode**.
3. Clique em **Load unpacked** / **Carregar sem compactação**.
4. Selecione a pasta mostrada pelo instalador, normalmente:
   `%USERPROFILE%\.gemini\extensions\gemini-md-export\browser-extension`.
5. Se a extensão já estava carregada, clique no ícone circular de reload no
   card dela. Depois desse reload, a própria extensão tenta recarregar as abas
   abertas do Gemini automaticamente.

Depois abra uma conversa em `https://gemini.google.com/app/<id>` e procure o
botão circular de download no canto superior direito da conversa.

## Atualização

Quando o exporter já estiver instalado no Gemini CLI como extensão atualizável,
use o fluxo nativo do Gemini CLI:

```text
gemini extensions update gemini-md-export
```

ou:

```text
gemini extensions update --all
```

Depois feche e reabra o Gemini CLI. Como a extensão do navegador fica dentro da
extensão do Gemini CLI, esse update também baixa os novos arquivos do
Chrome/Edge. A partir da versão com auto-reload, a primeira tool MCP que
precisar do navegador confere versão/protocolo da extensão do Chrome e pede
`chrome.runtime.reload()` quando o runtime carregado ainda estiver antigo; a
própria extensão recarrega as abas do Gemini em seguida. O reload manual do
card em `chrome://extensions`/`edge://extensions` continua sendo o fallback
para a primeira migração, mudança de permissões/manifest ou perfil errado.
Na extensão do Gemini CLI, o MCP roda com
`GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED=false`: ele valida versão/protocolo e
recarrega a extensão do navegador quando possível, mas não compete abrindo aba
extra se o hook falhar. No Windows, quem acorda o navegador é o hook
`BeforeTool` da própria extensão, apenas para tools que realmente dependem do
navegador, incluindo `gemini_browser_status`. Antes de abrir qualquer coisa,
ele consulta rapidamente `http://127.0.0.1:47283/agent/clients`; se já houver
aba Gemini conectada, não abre nada, e se o bridge estiver inalcançável não faz
launch cego.

Quando o bridge está ativo e sem clientes, o hook abre
`https://gemini.google.com/app` por um PowerShell temporário oculto, usando
`Start-Process -WindowStyle Minimized`, e tenta restaurar o foco da janela
anterior. Depois espera uma aba Gemini conectar até
`GEMINI_MCP_HOOK_CONNECT_TIMEOUT_MS` (default 12000ms), sempre com hard exit
menor que o timeout do Gemini CLI. O arquivo
`hook-browser-launch.json` funciona como trava: duas chamadas rápidas não
devem abrir duas abas. Não há fallback por `cmd.exe /c start`; spawn direto que
pode focar janela só é permitido com
`GEMINI_MCP_HOOK_ALLOW_FOCUSING_FALLBACK=true`. Quando o hook realmente abre,
espera, pula por bridge morto ou encontra timeout, ele emite uma mensagem curta
no JSON (`systemMessage`) para aparecer no terminal; quando já existe aba
conectada, ele fica silencioso para não poluir chamadas normais.

O MCP também deve ficar silencioso por padrão. Checagens internas de
versão/protocolo, reload e wake do navegador só aparecem no terminal com
`GEMINI_MCP_DEBUG=true` ou `GEMINI_MCP_LOG_LEVEL=info`; no uso normal, as
tools retornam JSON compacto e diagnóstico detalhado fica nos status/relatórios.

Use `GEMINI_MCP_BROWSER=edge` ou `chrome`/`brave`/`dia` para fixar o navegador.
O argumento `--profile-directory` só é enviado quando
`GEMINI_MCP_CHROME_PROFILE_DIRECTORY` é definido explicitamente. Para
diagnosticar sem acionar nenhuma tool, rode
`node scripts/hooks/gemini-md-export-hook.mjs diagnose`; ele imprime
`/healthz`, `/agent/clients`, timeouts efetivos, plano de launch e os arquivos
`hook-last-run.json`/`hook-browser-launch.json`. O prelaunch pode ser
desativado com `GEMINI_MCP_HOOK_LAUNCH_BROWSER=false`; o timeout curto do
bridge é `GEMINI_MCP_HOOK_BRIDGE_TIMEOUT_MS` (default 180ms).

Durante a instalação no Windows, o instalador tenta registrar a extensão pelo
comando oficial `gemini extensions install https://www.github.com/augustocaruso/gemini-md-export.git
--ref=gemini-cli-extension --auto-update`, em vez de apenas copiar arquivos para
`~/.gemini/extensions`. Antes de reinstalar, ele roda
`gemini extensions uninstall gemini-md-export` e remove a pasta antiga
`~/.gemini/extensions/gemini-md-export`, para evitar mistura de instalação
manual antiga com a nova. Isso faz a extensão aparecer como atualizável no
Gemini CLI. Se o binário `gemini` não estiver no PATH, `git` não estiver
instalado ou esse comando falhar, o instalador ainda faz uma cópia manual como
fallback e avisa no resumo.

## Uso

1. Abra uma conversa em `https://gemini.google.com/app/<id>`.
2. Clique no botão circular de download no topo da conversa. Um menu abre com
   duas opções: **Exportar como Markdown** (abre o modal) e **Ignorar esta
   aba** (desliga a bridge MCP só nessa aba — útil quando você quer usar o
   Gemini sem que o exporter envie heartbeat ou apareça em `/agent/clients`).
   A flag de ignorar vale enquanto a aba existir e sobrevive a reload; some ao
   fechar a aba.
3. No modal, selecione conversas do sidebar ou, em páginas `/notebook/...`, as
   conversas do caderno.
4. Use **Puxar mais histórico** se precisar carregar mais itens.
5. Use **Alterar** em **Destino** para escolher uma pasta pelo seletor nativo
   do MCP local. Sem pasta escolhida, o fallback é Downloads.
6. Clique em **Exportar selecionadas**. Atalho: `Ctrl+Shift+E` exporta a
   conversa atual sem passar pelo menu (funciona inclusive em abas ignoradas).

O export gera um arquivo `<chatId>.md` por conversa. Arquivos existentes são
sobrescritos quando a gravação acontece via MCP local.

## Formato do Markdown

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

## MCP e Gemini CLI

O servidor MCP fica em [`src/mcp-server.js`](src/mcp-server.js). Ele roda via
`stdio` para o cliente AI e, no mesmo processo, abre um bridge HTTP local em
`127.0.0.1:47283` para a extensão do navegador.

Se você abrir uma segunda aba do terminal com `gemini`, a nova instância MCP
não tenta disputar essa porta nem deve mostrar erro de bridge ocupado: ela
permanece como servidor MCP por `stdio` e encaminha as tools para a instância
primária que já está conectada à extensão do navegador.

Quando a porta está ocupada, `gemini_browser_status` diferencia modo proxy
saudável de primário antigo/travado ou porta usada por outro serviço. O
diagnóstico inclui PID, versão, protocolo e dono provável da porta quando o
sistema permite descobrir isso.

O manifesto da extensão Gemini CLI não define `cwd` dentro de
`~/.gemini/extensions/gemini-md-export`. Isso é intencional: no Windows, um MCP
rodando com diretório de trabalho dentro da pasta da extensão pode travar o
auto-update com `EBUSY: resource busy or locked, rmdir ...`.

Tools disponíveis:

- `gemini_browser_status`
- `gemini_get_export_dir`
- `gemini_set_export_dir`
- `gemini_list_recent_chats`
- `gemini_list_notebook_chats`
- `gemini_get_current_chat`
- `gemini_download_chat`
- `gemini_download_notebook_chat`
- `gemini_export_recent_chats`
- `gemini_export_job_status`
- `gemini_export_job_cancel`
- `gemini_export_notebook`
- `gemini_cache_status`
- `gemini_clear_cache`
- `gemini_open_chat`
- `gemini_reload_gemini_tabs`
- `gemini_snapshot`

Para listas grandes, `gemini_list_recent_chats` é paginada. Use `limit` como
tamanho da página e avance com `offset` (`0`, `50`, `100`...). O MCP carrega
mais histórico conforme necessário e retorna `pagination` com `nextOffset`,
`loadedCount`, `reachedEnd` e `canLoadMore`. Evite pedir centenas de conversas
em uma única resposta do Gemini CLI; peça páginas de 25-50 itens e continue até
`reachedEnd=true` ou uma página vazia. A listagem paginada tem teto defensivo de
1000 conversas por sessão.

Para importar/exportar o histórico inteiro, use `gemini_export_recent_chats`.
Ela inicia um job em background, percorre o sidebar carregável, grava os
Markdown no diretório configurado e mantém um relatório JSON incremental;
acompanhe com `gemini_export_job_status` pelo `jobId` e cancele com
`gemini_export_job_cancel` se necessário. Esse é o fluxo recomendado para
centenas de conversas, porque a resposta do Gemini CLI fica pequena, o trabalho
pesado acontece no MCP e o relatório parcial preserva o que já foi feito.
Quando `maxChats` é omitido, o job tenta carregar até o fim real do sidebar,
usando o mesmo caminho de lazy-load do modal.

Para evitar arquivos truncados, cada conversa é hidratada até o início antes da
extração. Se a extensão não conseguir provar que chegou ao topo da conversa, o
item falha no relatório em vez de salvar um Markdown incompleto.
Para evitar conteúdo trocado entre chats, a navegação em lote não aceita apenas
"URL nova + algum texto na tela": antes de exportar, a extensão compara uma
assinatura leve dos turns do DOM anterior com a conversa atual. Se a URL mudou
mas o DOM ainda parece ser o chat anterior, o item falha no relatório e nenhum
arquivo é salvo. O MCP também valida `chatId` retornado pela extensão antes de
gravar em disco.

Se você já tem um vault com notas possivelmente afetadas pelo bug antigo de
conteúdo trocado, a extensão Gemini CLI inclui o subagent
`gemini-vault-repair` e o comando `/exporter:repair-vault <caminho-do-vault>`.
Ele roda um scanner local (`scripts/vault-repair-audit.mjs`), acha duplicatas
suspeitas/mismatches, reexporta por `chatId` para staging, cria backup antes de
sobrescrever e bloqueia qualquer nota que pareça ter virado wiki/nota editada.
Essas notas wiki também entram no escopo de reparo: o agente preserva a nota,
faz backup, reexporta o raw correto e cria um caso em `wiki-review/` para
regenerar ou mesclar a wiki a partir da fonte corrigida. Elas não são
sobrescritas automaticamente. O subagent de reparo usa modelo Flash e atua como
verificador operacional: emite relatório preliminar e final; se uma wiki precisa
ser reescrita, ele pede ao agente principal para chamar o subagent escritor de
notas com o case file e o raw corrigido.
Ao regenerar ou consolidar notas wiki, a nota final deve preservar a
proveniência no rodapé: uma seção de fontes Gemini com a união deduplicada de
todos os links `https://gemini.google.com/app/<chatId>` que inspiraram aquela
nota, sem trocar uma lista de múltiplos chats por apenas o último link.

Endpoints locais úteis para diagnóstico quando as tools ainda não carregaram:

- `http://127.0.0.1:47283/healthz`
- `http://127.0.0.1:47283/agent/clients`
- `http://127.0.0.1:47283/agent/recent-chats?limit=50&offset=0`
- `http://127.0.0.1:47283/agent/export-recent-chats`
- `http://127.0.0.1:47283/agent/export-job-status?jobId=<id>`
- `http://127.0.0.1:47283/agent/export-job-cancel?jobId=<id>`
- `http://127.0.0.1:47283/agent/notebook-chats?limit=20`
- `http://127.0.0.1:47283/agent/current-chat`
- `http://127.0.0.1:47283/agent/reload-tabs`

## Build e Release

Comandos principais:

```bash
npm install
npm test
npm run build
npm run mcp
npm run install:macos
npm run release:windows:prebuilt
```

`npm run build` gera:

- `dist/extension` como cópia standalone da extensão unpacked;
- `dist/gemini-cli-extension` para instalação em
  `~/.gemini/extensions/gemini-md-export`, incluindo
  `browser-extension/` para o Chrome/Edge carregar de uma pasta que o
  `gemini extensions update` também atualiza;
- `bridge-version.json`, fonte de verdade para a versão/protocolo esperados
  pelo MCP ao validar a extensão do Chrome;
- `dist/gemini-export.user.js` como artefato legado de debug, fora do fluxo
  recomendado.

`npm run release:windows:prebuilt` gera os assets usados pelo instalador/update
externo do Windows:

- `release/gemini-md-export-windows-prebuilt.zip`;
- `release/update-windows.ps1`;
- um zip versionado para auditoria.

O workflow [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml)
publica esses assets em GitHub Releases quando uma tag `v*` é enviada.

## Instalação Manual de Desenvolvimento

Para testar a extensão sem o instalador:

1. Rode `npm install` e `npm run build`.
2. Abra `chrome://extensions` ou `edge://extensions`. Os launchers gerados usam
   `--new-tab` para tentar abrir essa página como aba na janela existente.
3. Ative **Developer mode**.
4. Clique em **Load unpacked**.
5. Selecione `dist/extension`.
6. Rode `npm run mcp` se quiser testar o bridge local.
7. Recarregue uma aba do Gemini em uma conversa `/app/<id>`.

## Diagnóstico

No Windows, rode [`diagnose-windows-mcp.ps1`](diagnose-windows-mcp.ps1) se o
Gemini CLI mostrar o MCP como desconectado. Ele verifica configuração do Gemini
CLI, paths de `node.exe`/`mcp-server.js`, processos Node, listener da porta
`47283`, `/healthz` e a extensão instalada em
`%USERPROFILE%\.gemini\extensions\gemini-md-export`.

No navegador, a API `window.__geminiMdExportDebug` roda no isolated world do
content script. Se ela não aparecer no console principal, selecione o contexto
do content script no DevTools ou use as tools MCP. Funções úteis:

- `snapshot()`
- `scrapeTurns()`
- `markdown()`
- `openExportModal()`
- `listConversations()`
- `loadMoreConversations()`

## Limitações Conhecidas

- A extensão só enxerga o DOM carregado na aba do Gemini.
- Conversas antigas dependem do histórico realmente carregar no sidebar ou no
  caderno.
- Conversas longas são hidratadas por scroll até o topo antes da extração, mas
  mudanças no DOM do Gemini podem exigir ajuste de seletores.
- Em páginas `/notebook/...`, algumas linhas não expõem URL direta; o exporter
  aprende o mapeamento clicando na linha e voltando ao caderno por histórico.
- LaTeX complexo renderizado por MathJax/KaTeX pode degradar em casos raros.
- Browsers Chromium com UI/arquitetura muito customizada podem falhar mesmo se
  Chrome/Edge funcionarem.

## Documentação Interna

- [`AGENTS.md`](AGENTS.md) e [`CLAUDE.md`](CLAUDE.md): arquitetura, pontos
  frágeis e regras de contribuição.
- [`LEIA-ME.txt`](LEIA-ME.txt): instruções em português para usuário final no
  Windows.
- [`fixtures/README.md`](fixtures/README.md): como lidar com fixtures locais.
