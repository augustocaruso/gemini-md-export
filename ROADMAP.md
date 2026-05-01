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

## Backlog técnico

- Considerar WebSocket somente se SSE + POST ainda deixar latência/ordering como
  gargalo real.
- Medir payload médio de heartbeat/snapshot em cenários com centenas de chats.
- Adicionar smoke automatizado de `/bridge/events`, `/bridge/snapshot` e modo
  proxy em porta alternativa.
- Revisar instaladores para apontar o usuário ao diagnóstico novo antes de
  sugerir reinstalação.
