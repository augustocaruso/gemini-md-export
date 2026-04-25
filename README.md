# gemini-md-export

Exporta conversas do [Gemini web](https://gemini.google.com/app) para arquivos
Markdown com frontmatter YAML, prontos para entrar em um vault do Obsidian.

O caminho principal hoje é:

- extensão MV3 no Chrome/Edge/Chromium;
- servidor MCP local que conversa com a extensão;
- updater Windows via GitHub Releases;
- integração opcional com Gemini CLI e Claude Desktop.

O projeto não usa API oficial do Gemini, cookies ou automação de login. Ele lê
apenas o DOM já renderizado em uma aba do Gemini aberta pelo usuário.

## Instalação Rápida no Windows

Pré-requisitos:

- Windows 10 ou 11;
- Chrome ou Edge;
- Node.js 20+ instalado com a opção **Add to PATH** marcada.

No PowerShell, rode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/augustocaruso/gemini-md-export/releases/latest/download/update-windows.ps1 | iex"
```

Esse comando baixa a última release, extrai em uma pasta temporária, valida o
pacote, instala/atualiza o MCP e a extensão, sincroniza cópias unpacked já
carregadas no navegador quando possível e apaga os temporários após sucesso.

O passo que continua manual por restrição do Chrome/Edge é carregar ou
recarregar a extensão unpacked:

1. Abra `chrome://extensions` ou `edge://extensions`.
2. Ative **Developer mode**.
3. Clique em **Load unpacked** / **Carregar sem compactação**.
4. Selecione a pasta mostrada pelo instalador, normalmente:
   `%LOCALAPPDATA%\GeminiMdExport\extension`.
5. Se a extensão já estava carregada, clique no ícone circular de reload no
   card dela. Depois desse reload, a própria extensão tenta recarregar as abas
   abertas do Gemini automaticamente.

Depois abra uma conversa em `https://gemini.google.com/app/<id>` e procure o
botão circular de download no canto superior direito da conversa.

## Atualização pelo Gemini CLI

Quando o exporter já estiver instalado no Gemini CLI, você também pode atualizar
por dentro dele:

```text
/exporter:update
```

Esse comando chama a tool MCP `gemini_exporter_update`, que inicia o updater em
um processo separado. Depois que ele terminar, feche e reabra o Gemini CLI para
carregar a nova versão. No navegador, recarregue o card da extensão em
`chrome://extensions`/`edge://extensions`; as abas do Gemini são recarregadas
automaticamente depois que a extensão volta.

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
- `gemini_exporter_update`
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
`reachedEnd=true` ou uma página vazia. O teto defensivo atual é 1000 conversas
carregáveis por sessão.

Para importar/exportar o histórico inteiro, use `gemini_export_recent_chats`.
Ela inicia um job em background, percorre o sidebar carregável, grava os
Markdown no diretório configurado e mantém um relatório JSON incremental;
acompanhe com `gemini_export_job_status` pelo `jobId` e cancele com
`gemini_export_job_cancel` se necessário. Esse é o fluxo recomendado para
centenas de conversas, porque a resposta do Gemini CLI fica pequena, o trabalho
pesado acontece no MCP e o relatório parcial preserva o que já foi feito.

Endpoints locais úteis para diagnóstico quando as tools ainda não carregaram:

- `http://127.0.0.1:47283/healthz`
- `http://127.0.0.1:47283/agent/clients`
- `http://127.0.0.1:47283/agent/recent-chats?limit=50&offset=0`
- `http://127.0.0.1:47283/agent/export-recent-chats?maxChats=1000`
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
npm run release:windows:prebuilt
```

`npm run build` gera:

- `dist/extension` para carregar como extensão unpacked;
- `dist/gemini-cli-extension` para instalação em
  `~/.gemini/extensions/gemini-md-export`;
- `dist/gemini-export.user.js` como artefato legado de debug, fora do fluxo
  recomendado.

`npm run release:windows:prebuilt` gera os assets usados pelo updater:

- `release/gemini-md-export-windows-prebuilt.zip`;
- `release/update-windows.ps1`;
- um zip versionado para auditoria.

O workflow [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml)
publica esses assets em GitHub Releases quando uma tag `v*` é enviada.

## Instalação Manual de Desenvolvimento

Para testar a extensão sem o instalador:

1. Rode `npm install` e `npm run build`.
2. Abra `chrome://extensions` ou `edge://extensions`.
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
