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
Na extensão do Gemini CLI, hooks de runtime ficam desabilitados por padrão:
`hooks/hooks.json` publica `{ "hooks": {} }`. Não há `SessionStart` aquecendo
bridge, `BeforeTool` abrindo navegador nem `AfterTool` tentando orientar o
agente depois de comandos. Isso evita automação invisível acionando em sessões
que não têm relação direta com exportação.

A CLI empacotada é quem acorda o navegador para jobs longos. Antes de
`sync`/`export`, ela garante a bridge, chama `/agent/ready` com
`wakeBrowser=false`, abre `https://gemini.google.com/app` em background quando
não há aba conectada e espera a extensão conectar até `--ready-wait-ms`. Não há
fallback por `cmd.exe /c start`; no Windows o launcher usa PowerShell
minimizado/restauração de foco quando aplicável. O arquivo
`browser-launch.json` serve como diagnóstico/trava de launch; instalações
antigas que ainda tenham `hook-browser-launch.json` continuam legíveis como
fallback de compatibilidade.

O MCP também deve ficar silencioso por padrão. Checagens internas de
versão/protocolo, reload e wake do navegador só aparecem no terminal com
`GEMINI_MCP_DEBUG=true` ou `GEMINI_MCP_LOG_LEVEL=info`; no uso normal, as
tools retornam JSON compacto e diagnóstico detalhado fica nos status/relatórios.
`gemini_ready { action: "status", diagnostic: true }` inclui
`extensionReadiness`, separando service worker, content script, aba Gemini,
build stamp esperado/em execução, resultado do reload automático e diagnóstico
do top-bar. Só peça reload manual do card da extensão unpacked quando
`extensionReadiness.reload.manualReloadRequired=true` ou quando o status indicar
perfil/pasta errados após o self-heal automático.

Use `GEMINI_MCP_BROWSER=edge` ou `chrome`/`brave`/`dia` para fixar o navegador.
O argumento `--profile-directory` só é enviado quando
`GEMINI_MCP_CHROME_PROFILE_DIRECTORY` é definido explicitamente. Para
diagnosticar sem acionar nenhuma tool, rode
`node scripts/hooks/gemini-md-export-hook.mjs diagnose`; ele imprime
`/healthz`, `/agent/ready`, `/agent/diagnostics`, timeouts efetivos e os
arquivos `browser-launch.json`/legados quando existirem. Esse script é apenas
no-op de compatibilidade e diagnóstico manual; não faz spawn, não lê stdin de
hooks e não decide fluxo de exportação.

Smoke manual rápido no DevTools da aba Gemini:

```js
__geminiMdExportDebug.snapshot().bridgeStatus()
__geminiMdExportDebug.findTopBar()
__geminiMdExportDebug.openExportModal()
```

Confira se `buildStamp` bate com o esperado em
`gemini_ready { action: "status", diagnostic: true }`, se
`findTopBar().matchedBy` não é `null` numa conversa e se o modal consegue
trocar destino/salvar via bridge. Se o MCP estiver ausente, o fallback esperado
é Downloads com aviso em português no modal/toast.

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
type: gemini_chat
chat_id: b8e7c075effe9457
title: "Exemplo"
url: https://gemini.google.com/app/b8e7c075effe9457
date_created: 2026-05-10T06:46:09Z
date_last_message: 2026-05-10T07:12:31Z
date_exported: 2026-05-17T18:55:08Z
turn_count: 6
model: "2.5 Pro"
tags: [gemini-export]
---

## 🧑 Usuário

...pergunta...

---

## 🤖 Gemini

...resposta...
```

As datas ficam em UTC com `Z` e precisão de segundos. `turn_count` é o número
de respostas do Gemini, não o total de mensagens. Em exports novos,
`date_exported` sai direto do navegador; `date_created` e
`date_last_message` podem ser preenchidos depois pelo backfill de metadados.

Para normalizar o back catalog antigo, recuperar datas e auditar integridade,
use o fluxo único de correção do vault:

```bash
gemini-md-export fix-vault "/caminho/do/vault" --takeout "/caminho/Minhaatividade.html" --report "/caminho/do/report.json"
```

O Takeout é usado primeiro como evidência offline. O fluxo também usa a
extensão MV3 em `https://myactivity.google.com/product/gemini` para tentar
resolver datas remanescentes. Depois de instalar uma versão que adiciona essa
permissão, recarregue manualmente o card da extensão em
`chrome://extensions`/`edge://extensions` se o navegador ainda estiver com o
runtime antigo. Durante a varredura, a aba My Activity usa o mesmo indicador
visual de claim da extensão (Tab Group/badge) e o mesmo dock de progresso usado
nos exports longos. O relatório não grava prompts, respostas, HTML ou Markdown
cru: somente hashes, tamanhos, scores, contagens, datas e status.

Se o Takeout ainda não chegou, rode o mesmo comando sem `--takeout`:

```bash
gemini-md-export fix-vault "/caminho/do/vault" --report "/caminho/do/report.json"
```

## CLI, MCP e Gemini CLI

O caminho recomendado para export/sync longo é a CLI empacotada:

```bash
gemini-md-export sync "/caminho/do/vault" --plain
gemini-md-export export missing "/caminho/do/vault" --plain
gemini-md-export export resume "/caminho/do/relatorio.json" --plain
```

Em terminal interativo, use `--tui` para ver barra de progresso. Para agentes,
use `--plain`: a saída termina com `RESULT_JSON`, que é curto e parseável.

Telemetria remota por email pode vir autoativada em builds privados pelo
arquivo `telemetry.defaults.json`. Ela usa um receiver separado do Medical
Notes Workbench: Worker `gemini-md-export-telemetry`, token próprio e KV
próprio. O usuário pode inspecionar, reenviar a outbox ou desligar:

```bash
gemini-md-export telemetry status --plain
gemini-md-export telemetry preview --since 7d --plain
gemini-md-export telemetry send --since 7d --plain
gemini-md-export telemetry disable --plain
```

Override manual, quando não houver defaults de distribuição:

```bash
gemini-md-export telemetry enable --endpoint "https://..." --token "..." --payload-level diagnostic_redacted
```

Quando ligada, a CLI registra runs em
`~/.gemini/gemini-md-export/telemetry/runs/`, envia envelopes redigidos em modo
fail-open e guarda retries em `~/.gemini/gemini-md-export/telemetry/outbox/`.
Detalhes para o agente e para o mantenedor ficam em
[`docs/reference/telemetry.md`](docs/reference/telemetry.md).

A CLI fala direto com a bridge HTTP local em `127.0.0.1:47283`. Se a bridge
não estiver no ar, a CLI pode iniciar um processo `bridge-only`; esse processo
usa `exit-when-idle` por padrão e encerra sozinho depois da janela de
inatividade configurável, sem fechar enquanto houver job ativo, heartbeat
recente da extensão ou request/SSE/long-poll aberto.

Se nenhuma aba Gemini estiver conectada, a própria CLI abre Gemini Web em
background e aguarda a extensão do navegador antes de começar o job. Use
`--no-wake` para diagnósticos que não devem abrir navegador.

O servidor MCP fica em [`src/mcp-server.js`](src/mcp-server.js). Ele roda via
`stdio` para o cliente AI e também pode abrir o mesmo bridge HTTP local para a
extensão do navegador. Na arquitetura atual, MCP é plano de controle e
compatibilidade: readiness, tabs, config e diagnóstico. Export/sync longo deve
ser executado pela CLI.

Se você abrir uma segunda aba do terminal com `gemini`, a nova instância MCP
não tenta disputar essa porta nem deve mostrar erro de bridge ocupado: ela
permanece como servidor MCP por `stdio` e encaminha as tools para a instância
primária que já está conectada à extensão do navegador.

Quando a porta está ocupada, `gemini_ready { action: "status" }` diferencia modo proxy
saudável de primário antigo/travado ou porta usada por outro serviço. O
diagnóstico inclui PID, versão, protocolo e dono provável da porta quando o
sistema permite descobrir isso.

Para ambientes com processos antigos acumulados, use
`gemini_support { action: "processes" }` antes de qualquer orientação manual. Se ele
identificar um primário antigo/travado reconhecido como exporter,
`gemini_support { action: "cleanup_processes" }` faz dry-run por padrão e só
encerra o alvo com `confirm=true`; ele nunca encerra o processo MCP atual nem
processo fora do escopo `gemini-md-export`/`mcp-server.js`.

O manifesto da extensão Gemini CLI não define `cwd` dentro de
`~/.gemini/extensions/gemini-md-export`. Isso é intencional: no Windows, um MCP
rodando com diretório de trabalho dentro da pasta da extensão pode travar o
auto-update com `EBUSY: resource busy or locked, rmdir ...`.

Tools públicas disponíveis desde `v0.5.0`:

- `gemini_ready`
- `gemini_tabs`
- `gemini_chats`
- `gemini_export`
- `gemini_job`
- `gemini_config`
- `gemini_support`

Chamadas diretas aos nomes antigos retornam `code: "tool_renamed"` com o
comando novo exato em `replacement`.

Chamadas MCP de export/sync longo retornam `code: "use_cli"` com
`command`, `args` e `cwd` para o agente executar a CLI diretamente. Contagem
total e download/exportação via `gemini_chats` retornam `code: "use_cli_only"`.
O MCP não inicia job longo escondido por baixo da tool.

A extensão Gemini CLI também empacota Agent Skills em
`skills/<nome>/SKILL.md`. O `GEMINI.md` do bundle fica curto e roteia para:

- `gemini-vault-sync` para importação completa, missing chats, sync
  incremental e retomada;
- `gemini-vault-repair` para raw exports contaminados e notas wiki;
- `gemini-mcp-diagnostics` para bridge lento/instável, versão stale e conflitos
  de processo;
- `gemini-tabs-and-browser` para múltiplas abas, claim visual e abertura
  confiável do Gemini Web.

Quando houver mais de uma aba Gemini conectada em fluxo de contagem/exportação,
use a CLI: `gemini-md-export tabs list --plain` e depois
`gemini-md-export tabs claim --index <n> --plain`. Para diagnóstico MCP
deliberado, chame `gemini_tabs { action: "list", intent: "tab_management" }` e
depois `gemini_tabs { action: "claim", intent: "tab_management" }` com
`clientId`, `tabId` ou `index`. A claim prende a sessão MCP/CLI naquela aba;
sem claim ou seletor explícito, tools de listagem e export retornam
`ambiguous_gemini_tabs` em vez de escolher a aba ativa por acidente. O indicador
visual usa Tab Group nativo do Chrome/Edge quando possível, não overlay dentro
da página Gemini. Se a aba já estiver em um grupo do usuário, a extensão
preserva esse grupo e usa badge/prefixo de título como fallback.

Para listas pequenas de diagnóstico, `gemini_chats { action: "list",
intent: "small_page" }` é paginada. Use `limit` como tamanho da página e avance
com `offset` (`0`, `50`, `100`...). Evite pedir centenas de conversas em uma
única resposta do Gemini CLI. Para "quantos chats ao todo" e para exportar,
rode a CLI; se ela falhar por timeout/conexão, responda a falha curta em vez de
trocar para MCP.

Para diagnosticar artefatos interativos renderizados em iframes, use a CLI:

```bash
gemini-md-export diagnose page "https://gemini.google.com/app/<chatId>" --plain
```

Para capturar payloads HTML de mini apps abertos por `postMessage`, use:

```bash
gemini-md-export diagnose page "https://gemini.google.com/app/<chatId>" --save-html --output-dir ~/Downloads --plain
```

Isso grava `artifact-<chatId>-manifest.json` e arquivos
`artifact-<chatId>-turn-<turnIndex>-<hash>.html` na pasta escolhida. O HTML fica
como asset isolado para embed no Obsidian; a nota deve apontar para esse arquivo
via `<iframe>`/link fallback, não colar o HTML dentro do Markdown.

Dentro do Gemini CLI, o bundle também expõe
`/exporter:diagnose-page <url>`. Esse diagnóstico apenas informa se o HTML do
iframe parece legível pela extensão; se o artefato ainda estiver fechado atrás
de um botão, a CLI tenta abrir um candidato forte, diagnosticar o iframe e
fechar a superfície aberta. Por padrão ela não salva o artefato nem tenta
burlar sandbox/cross-origin.

Também não faça cleanup manual com `kill <pid>`/`pkill`/`taskkill` como
fallback de contagem/exportação; diagnóstico e cleanup de processos só entram
quando o usuário pedir diagnóstico explicitamente.
Não rode `cleanup stale-processes` antes de tentar contar/exportar, e não
recomende `kill <pid>` depois de timeout da CLI.
Depois de timeout da CLI, também não pergunte se deve rodar diagnóstico; pare
na falha curta e espere pedido explícito do usuário.

Exports longos gravam relatório JSON incremental. Se
`gemini-md-export export recent`, `export missing` ou `sync` for interrompido,
rode `gemini-md-export export resume "<relatorio.json>" --plain`. O exporter
reutiliza o mesmo arquivo, pula chatIds já concluídos ou já encontrados no
vault e retenta apenas os itens faltantes/falhos. O lazy-load do histórico usa
batches adaptativos e o
bridge de mídia mantém cache por URL para reduzir downloads repetidos de assets.
O relatório também inclui `metrics`: tempos por fase (`loadSidebarMs`,
`refreshSidebarMs`, `scanVaultMs`, `exportConversationsMs`, `writeReportMs`),
métricas por conversa (`openConversationMs`, `hydrateDomMs`,
`extractMarkdownMs`, `fetchAssetsMs`, `saveFilesMs`), payload médio/máximo de
heartbeat/snapshot e contadores de assets/cache/backoff. Use esses campos para
separar gargalo de Gemini lento, bridge, mídia externa, disco ou vault.

No lado da extensão, listas grandes do modal são virtualizadas a partir de
centenas de conversas, então o modal não cria um nó DOM por item visível no
histórico inteiro. O content script também coalesce trabalho de DOM em
`scheduleDomWork` e expõe `metrics.domScheduler` no heartbeat/snapshot. Ele
anuncia `tab-claim-v1` para afinidade confiável entre
sessão/agente e aba. Comandos pesados vindos do MCP usam backpressure por aba
(`tab-backpressure-v1`): se uma
aba já estiver carregando histórico, navegando ou exportando, comandos
concorrentes retornam `busy=true` em vez de disputar o mesmo DOM.

Para importar/exportar o histórico inteiro, use:

```bash
gemini-md-export export recent --plain
```

O comando percorre o sidebar carregável, grava os Markdown no diretório
configurado e mantém um relatório JSON incremental. Esse é o fluxo recomendado
para centenas de conversas, porque o trabalho pesado acontece na CLI/bridge e a
resposta final continua pequena.
Quando `maxChats` é omitido, o job tenta carregar até o fim real do sidebar,
usando o mesmo caminho de lazy-load do modal.

Para importar o histórico inteiro para um vault, prefira
`gemini-md-export export missing "/caminho/do/vault" --plain`: ele lista o
Gemini Web, cruza com os exports raw já existentes no vault e baixa somente o
que falta. O status e o relatório
incluem `progressMessage`, `decisionSummary` e `nextAction`, com totais vistos
no Gemini, já existentes no vault, baixados agora, warnings de mídia, datas
pendentes do Takeout/My Activity, falhas, caminho do relatório e comando pronto
para retomar.

Depois que o vault já foi sincronizado uma vez, use
`gemini-md-export sync "/caminho/do/vault" --plain` para o fluxo incremental
sem atrito. Ele lê/grava
`.gemini-md-export/sync-state.json`, lista o Gemini Web do topo para baixo,
para ao encontrar uma fronteira conhecida (`topChatId` anterior ou sequência de
chats já presentes no vault) e baixa apenas conversas novas. Se a fronteira não
for provada, o relatório marca o sync como parcial/inconclusivo e preserva o
comando de retomada.

No Gemini CLI, o atalho humano é:

```text
/sync
```

Sem argumento, o comando usa o vault já conhecido pelo contexto/GEMINI.md
principal da sessão. Para sobrescrever o destino pontualmente:

```text
/sync /caminho/do/vault
```

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
conteúdo trocado, use `/exporter:fix-vault <caminho-do-vault>`. A extensão
Gemini CLI mantém o subagent `gemini-vault-repair` como subfluxo interno desse
comando. A primeira passada roda um scanner local
(`scripts/vault-repair-audit.mjs`) e usa Takeout como evidência sanitizada. Em
casos que exigem reparo de conteúdo, o subfluxo reexporta por `chatId` para
staging, cria backup antes de sobrescrever e bloqueia qualquer nota que pareça
ter virado wiki/nota editada.
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

Para validar a infraestrutura local sem depender de login no Gemini Web, rode:

```bash
npm run smoke:bridge
```

Esse smoke sobe uma bridge isolada em uma porta temporária e testa
`/healthz`, `/bridge/snapshot`, `/bridge/events`, `/bridge/heartbeat`,
`/agent/ready`, `/agent/clients`, `/agent/diagnostics` e o diagnóstico de processos. Para obter
JSON estruturado:

```bash
node scripts/bridge-smoke.mjs --spawn --json
```

Se você já tem uma bridge rodando e quer testar a instância atual:

```bash
node scripts/bridge-smoke.mjs --bridge-url http://127.0.0.1:47283
```

Use esse smoke antes de culpar Chrome/Gemini quando a extensão parecer lenta:
ele separa problema de infraestrutura local de problema da aba real do Gemini.

Endpoints locais úteis para diagnóstico quando as tools ainda não carregaram:

- `http://127.0.0.1:47283/healthz`
- `http://127.0.0.1:47283/agent/ready`
- `http://127.0.0.1:47283/agent/diagnostics`
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
