# Fixtures

Snippets reais de DOM capturados do Gemini web, usados pelos testes em
`tests/extract.test.mjs`.

## Quando adicionar uma fixture

Sempre que encontrar um bug de formatação ou um edge case não coberto.
Fluxo:

1. No browser, numa conversa do Gemini que reproduz o caso, abra o
   DevTools (F12) e vá em Console.
2. Antes de copiar HTML, rode `window.__geminiMdExportDebug.snapshot()` para
   confirmar se `user-query` / `model-response` ainda estão sendo detectados.
   Isso ajuda a diferenciar bug de seletor vs. bug de formatação. Na extensão
   MV3, selecione o contexto do content script no DevTools se a API não
   aparecer no console principal. Se o problema estiver na lista do
   modal/lazy-load do sidebar ou caderno, rode também
   `window.__geminiMdExportDebug.loadMoreConversations()`.
3. Copie um turno específico:
   ```js
   copy(document.querySelector('user-query').outerHTML)
   // ou
   copy(document.querySelector('model-response').outerHTML)
   ```
4. Cole em um arquivo `.html` aqui, com nome descritivo:
   - `sample-turn-user.html`
   - `sample-turn-model.html`
   - `sample-turn-model-with-code.html`
   - `sample-turn-model-with-latex.html`
   - `sample-turn-model-long-list.html`
5. Em `tests/extract.test.mjs`, adicione um teste que carrega a fixture
   com `loadFixture('<nome>.html')` e asserta o comportamento esperado.
6. Ajuste `src/extract.mjs` até o teste passar.

## Privacidade

Fixtures podem conter conteúdo pessoal (nomes, dados clínicos). Decida
antes de fazer commit se quer:

- Versionar como está (ok se repo privado e conteúdo não é sensível).
- Anonimizar manualmente antes de commitar.
- Não versionar — descomentar a linha correspondente em `.gitignore`.
