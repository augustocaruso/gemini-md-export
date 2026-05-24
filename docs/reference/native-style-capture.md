# Captura de estilo nativo

Este workflow existe para evitar ajuste visual por tentativa e erro. Quando a UI do Gemini/Dia muda, a fonte de verdade passa a ser uma fixture sanitizada de estilos computados, não screenshot nem estimativa manual.

## Camadas

1. **DOM nativo de referência**: elementos reais do Gemini/Dia inspecionados com Playwright.
2. **Fixture sanitizada**: JSON versionado em `tests/fixtures/native-style/`, sem HTML, texto de conversas, URLs privadas ou selectors com dados pessoais.
3. **Validação tipada**: `src/browser/shared/native-style-capture.ts` garante schema, targets obrigatórios e variáveis `--gmn-*`.
4. **Perfil plugável**: `src/browser/shared/native-style-profile.ts` expõe o perfil ativo que o content script aplica na UI.
5. **Runtime**: `src/userscript-shell.ts` só consome `buildGeminiNativeStyleProfile()` e `applyGeminiNativeStyleVars()`.

## Targets obrigatórios

A fixture precisa cobrir estes elementos e estados antes de virar perfil ativo:

- `topbar.iconButton`
- `topbar.tooltip`
- `menu.panel`
- `menu.item`
- `menu.itemChecked`
- `modal.panel`
- `modal.list`
- `modal.checkbox`

Se um desses elementos não existe ou não está visível na página preparada, a captura deve falhar. Não preencha token ausente por chute.

## Capturar

Prepare a página logada do Gemini/Dia com os elementos de referência visíveis: botão do top-bar, tooltip, menu aberto, modal/lista e checkbox. Depois rode:

```bash
npm run capture:native-style -- --out tests/fixtures/native-style/gemini-lr26-dia-native.json --url https://gemini.google.com/app
```

O script abre Playwright em modo visível porque a captura depende do DOM logado e dos overlays reais. Se a página não estiver no estado correto, o comando deve falhar com o target que faltou.

## Validar fixture existente

```bash
npm run capture:native-style -- --fixture tests/fixtures/native-style/gemini-lr26-dia-native.json --check --json
```

Esse modo não abre navegador. Ele sanitiza, valida o schema e gera o perfil em memória. O resultado esperado hoje é `59` tokens.

## Regras de promoção

- Não versionar `outerHTML`, `innerHTML`, texto visível, URL, `href` ou qualquer dado de conversa.
- Toda variável extraída precisa começar com `--gmn-`.
- Atualize `GEMINI_LR26_NATIVE_STYLE_PROFILE.source` para apontar para a captura usada.
- Mantenha `tests/native-style-capture.test.mjs` comparando o perfil gerado da fixture com `GEMINI_LR26_NATIVE_STYLE_PROFILE`.
- Rode pelo menos:

```bash
npm run build:ts
node --test tests/native-style-capture.test.mjs tests/capture-native-style-script.test.mjs tests/typescript-shell-source.test.mjs
```

## Quando screenshot ainda é útil

Screenshot serve para apontar diferença visual e escolher quais elementos comparar. Ele não substitui a fixture. Se o screenshot mostra botão, menu ou lista diferente, a próxima ação canônica é recapturar os tokens dos elementos equivalentes e só então alterar o perfil.
