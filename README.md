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
Se nenhuma aba do Gemini estiver conectada quando uma tool MCP for chamada, o
MCP tenta abrir `https://gemini.google.com/app` no navegador certo: Chrome por
padrão, depois Edge/Brave/Dia como fallback. `gemini_browser_status` também
acorda o navegador quando está sem clientes conectados, porque o Gemini CLI
costuma chamar status antes de escolher a tool de export. Use
`GEMINI_MCP_BROWSER=edge` ou `chrome`/`brave`/`dia` para fixar o navegador. O
MCP só envia `--profile-directory` quando
`GEMINI_MCP_CHROME_PROFILE_DIRECTORY` é definido explicitamente; isso evita a
caixa de seleção/perfil do Chrome em chamadas normais de tool. Para perfis
específicos, use por exemplo `GEMINI_MCP_CHROME_PROFILE_DIRECTORY="Profile 1"`.
No Windows, o launcher não usa mais `where` síncrono no caminho de runtime: ele
tenta primeiro executar diretamente o browser encontrado em caminhos conhecidos
ou configurado por variável de ambiente, observa erro imediato, e só depois cai
para `cmd.exe /c start` como fallback. O resultado aparece em `browserWake`,
incluindo `launch`/`directLaunch`, para diagnosticar falhas reais de abertura.
Além do guard dentro do MCP, o hook `BeforeTool` da extensão do Gemini CLI faz
um pré-aquecimento no Windows: antes de tools do exporter que dependem do
navegador, ele checa rapidamente `http://127.0.0.1:47283/agent/clients`. Se já
houver uma aba Gemini conectada, não abre nada. Se não houver cliente
conectado, tenta abrir `https://gemini.google.com/app` por spawn direto e cai
para `cmd.exe /c start` se o spawn direto falhar. O hook não depende de
PowerShell, respeita cooldown e não deve ficar preso em "executing hook". A leitura do payload do hook é
assíncrona e tem timeout curto (`GEMINI_MCP_HOOK_STDIN_TIMEOUT_MS`, default
120ms), porque uma leitura síncrona de stdin pode travar se o cliente mantiver
o pipe aberto. Para diagnosticar sem acionar nenhuma tool, rode o script do
hook com `diagnose`; ele imprime o bridge, o plano de launch e os arquivos
temporários `hook-last-run.json`/`hook-browser-launch.json`. Isso pode ser
desativado com `GEMINI_MCP_HOOK_LAUNCH_BROWSER=false`.

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
2. Clique no botão circular de download no topo da conversa.
3. No modal, selecione conversas do sidebar ou, em páginas `/notebook/...`, as
   conversas do caderno.
4. Use **Puxar mais histórico** se precisar carregar mais itens.
5. Use **Alterar** em **Destino** para escolher uma pasta pelo seletor nativo
   do MCP local. Sem pasta escolhida, o fallback é Downloads.
6. Clique em **Exportar selecionadas**.

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
