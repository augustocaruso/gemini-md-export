# Auditoria de licencas para fontes de inspiracao

Atualizado em: 2026-05-28.

Este documento registra fontes usadas para inspirar o spike de lifecycle, private API,
CDP/browser automation e Markdown rendering. Ele nao substitui revisao juridica, mas e o
gate operacional do projeto: antes de copiar codigo ou adaptar trechos substanciais, a
licenca precisa permitir reuso e as obrigacoes precisam estar rastreadas.

## Decisoes

- Podemos estudar qualquer fonte publica listada aqui para entender arquitetura, fluxos e
  problemas resolvidos.
- Podemos copiar/adaptar codigo de fontes MIT ou Apache-2.0, desde que preservemos aviso de
  copyright/licenca e registremos a origem no changelog/NOTICE quando houver trecho
  substancial.
- Preferencia do projeto: depender de bibliotecas consolidadas quando cabivel; quando a
  implementacao for pequena ou precisar seguir nossos contratos de core/shell/FSM, reimplementar
  a ideia em TypeScript, sem transliterar codigo.
- Dependencias AGPL podem existir apenas em adaptadores de infra/shell explicitamente isolados.
  O core TypeScript nao deve importar, copiar nem derivar codigo AGPL.
- Nao copiar codigo/texto de gist ou repositorio sem licenca explicita. Esses materiais ficam
  apenas como referencia conceitual.

## Fontes auditadas

| Fonte | Licenca observada | Pode copiar codigo? | Uso recomendado |
| --- | --- | --- | --- |
| `amazingpaddy/ai-chat-exporter` | Apache-2.0 | Sim, com obrigacoes Apache-2.0 | Referencia de UX/DOM/Turndown; evitar copiar UI ou scraping diretamente. |
| `teng-lin/notebooklm-py` | MIT | Sim, com aviso MIT | Referencia principal para protocolo privado, autenticacao via sessao e tratamento de bloqueios; reimplementar contratos em TS. |
| `HanaokaYuzu/Gemini-API` (`gemini_webapi`) | AGPL-3.0 | Nao copiar para o core | Dependencia opcional via sidecar Python isolado; usar como adapter de shell para API Gemini Web, com contrato JSON e sem importar no core TS. |
| `pasky/chrome-cdp-skill` | MIT | Sim, com aviso MIT | Referencia para lifecycle de daemon/CDP, session reuse e idle timeout; reimplementar como FSM/adapter. |
| `microsoft/playwright` | Apache-2.0 | Sim, com obrigacoes Apache-2.0 | Referencia de arquitetura/testes/auto-wait; preferir depender de Playwright quando for browser automation. |
| `mixmark-io/turndown` | MIT | Sim; ja usamos como dependencia npm | Dependencia direta para HTML -> Markdown via adapter plugavel. |
| Gist `anuj846k/2d641bf33606bcd13d8d5af311af1832` | Sem licenca explicita encontrada | Nao | Apenas leitura conceitual sobre lifecycle MCP. |

## Obrigacoes praticas

- MIT: manter copyright e texto de permissao em copias/substanciais ou distribuicao relevante.
- Apache-2.0: manter licenca, notices/copyright, marcar arquivos modificados quando copiarmos
  ou derivarmos trechos, e preservar NOTICE se existir.
- Sem licenca: nao usar codigo, nao adaptar texto, nao portar estrutura linha-a-linha.
- AGPL-3.0: se distribuirmos o adapter/dependencia, tratar o boundary explicitamente como
  componente AGPL e manter as obrigacoes de disponibilizacao de fonte/licenca. Nao misturar
  codigo copiado AGPL dentro do core proprietario/TS.

## Politica para este spike

Para o pacote atual, a implementacao deve ser nossa:

- FSM blocker-aware de abas em TypeScript, usando apenas ideias gerais de lifecycle.
- `ChatReadAdapter` privado em TypeScript com protocolo e tipos proprios do `gemini-md-export`.
- Adapter Python opcional para `gemini_webapi`, isolado por subprocesso JSON em `python/` e
  chamado pela camada MCP/infra.
- Asset pipeline e Markdown renderer modelados no core local.
- CDP/native-browser lifecycle inspirado por Playwright e `chrome-cdp-skill`, sem copiar daemon
  ou comandos literalmente.

Se algum trecho concreto for copiado ou adaptado de forma substancial, adicionar uma secao de
atribuicao no arquivo novo ou em um `NOTICE`/documento equivalente antes de merge/release.
