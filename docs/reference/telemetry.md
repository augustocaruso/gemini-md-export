# Telemetria Do Gemini Markdown Export

Esta telemetria é separada da telemetria do Medical Notes Workbench. Os dois
projetos podem enviar para o mesmo email do mantenedor, mas devem usar Workers,
tokens, KV namespaces e defaults diferentes.

## Identidade Do Projeto

- App: `gemini-md-export`
- Envelope: `gemini-md-export.workflow-telemetry-envelope.v1`
- Defaults: `gemini-md-export.telemetry-defaults.v1`
- Worker recomendado: `gemini-md-export-telemetry`
- Endpoint recomendado:
  `https://gemini-md-export-telemetry.<subdominio>.workers.dev/v1/telemetry/workflow-runs`
- Estado local:
  `~/.gemini/gemini-md-export/config.json` e
  `~/.gemini/gemini-md-export/telemetry/`

Não aponte este projeto para `medical-notes-workbench-telemetry`. Se isso
aparecer em `telemetry status`, o status retorna
`endpoint_warning: "endpoint_points_to_med_notes_receiver"`.

## O Que É Enviado

A CLI registra runs locais em `~/.gemini/gemini-md-export/telemetry/runs/` e,
quando a telemetria está ativa, envia envelopes redigidos em modo fail-open.
Falhas de rede, Worker ou Resend não mudam o exit code nem o resultado do
workflow; os envelopes ficam em `telemetry/outbox/` para retry.

O payload padrão é `diagnostic_redacted`:

- workflow, fase, status, exit code e duração;
- contagens compactas;
- warnings/erros redigidos;
- `blocked_reason`, `next_action` e sinais como `partial_count`,
  `full_history_not_verified`, `not_ready` e `load_more_timed_out`;
- paths resumidos/hashes curtos de reports e traces.

`full_logs` existe para instalações de confiança, mas ainda redige emails,
tokens, URLs com query e conteúdo longo.

## Como O Agente Deve Operar

Use sempre a CLI do projeto:

```bash
gemini-md-export telemetry status --plain
gemini-md-export telemetry preview --since 7d --plain
gemini-md-export telemetry send --since 7d --plain
gemini-md-export telemetry disable --plain
```

Ative manualmente só quando o mantenedor fornecer endpoint/token do receiver do
exporter:

```bash
gemini-md-export telemetry enable \
  --endpoint "https://gemini-md-export-telemetry.<subdominio>.workers.dev/v1/telemetry/workflow-runs" \
  --token "<INGEST_TOKEN>" \
  --payload-level diagnostic_redacted \
  --plain
```

Para builds privados, o mantenedor deve criar `.telemetry-defaults.json` na raiz
do repo antes do build. O build copia esse arquivo para o bundle como
`telemetry.defaults.json`, e a instalação do usuário fica autoativada no próximo
update.

## Receiver Separado

O receiver é um Cloudflare Worker dedicado ao exporter. Ele pode reutilizar o
mesmo template genérico de email/digest, mas precisa ser deployado com:

```toml
name = "gemini-md-export-telemetry"

[vars]
PRIMARY_ENVELOPE_SCHEMA = "gemini-md-export.workflow-telemetry-envelope.v1"
DIGEST_WINDOW_MINUTES = "15"
DIGEST_MAX_RECORDS = "100"
```

Secrets do Worker:

- `INGEST_TOKEN`: token conhecido pelo cliente;
- `RESEND_API_KEY`: segredo do Resend, nunca vai para o cliente;
- `TO_EMAIL`: email do mantenedor;
- `FROM_EMAIL`: remetente verificado no Resend.

Use um KV namespace próprio, por exemplo `GEMINI_MD_EXPORT_TELEMETRY_BUFFER`, e
bind como `TELEMETRY_BUFFER`. Não compartilhe o KV com o Med Notes, porque o
objetivo é que os digests e retries fiquem separados por projeto.

## Checklist De Separação

- `gemini-md-export/.telemetry-defaults.json` aponta para
  `gemini-md-export-telemetry`, não para `medical-notes-workbench-telemetry`.
- O token do exporter é diferente do token do Med Notes.
- O Worker do Med Notes aceita só
  `medical-notes-workbench.workflow-telemetry-envelope.v1` por padrão.
- O Worker do exporter usa
  `PRIMARY_ENVELOPE_SCHEMA=gemini-md-export.workflow-telemetry-envelope.v1`.
- Os emails chegam com subject começando por `[gemini-md-export]`.
