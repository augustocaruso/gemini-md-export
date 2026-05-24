import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

test('content script sources sao TypeScript e o build usa JS gerado pelo tsc', () => {
  assert.equal(existsSync(resolve(ROOT, 'src', 'userscript-shell.ts')), true);
  assert.equal(existsSync(resolve(ROOT, 'src', 'activity-content-script.ts')), true);
  assert.equal(existsSync(resolve(ROOT, 'src', 'extension-background.ts')), true);
  assert.equal(existsSync(resolve(ROOT, 'src', 'userscript-shell.js')), false);
  assert.equal(existsSync(resolve(ROOT, 'src', 'activity-content-script.js')), false);
  assert.equal(existsSync(resolve(ROOT, 'src', 'extension-background.js')), false);

  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');
  const tsconfigSource = readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8');
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]userscript-shell\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]activity-content-script\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]extension-background\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]shared['"], ['"]progress-dock-ui\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]shared['"], ['"]progress-state\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]shared['"], ['"]host-palette\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]shared['"], ['"]native-style-profile\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]shared['"], ['"]modal-virtual-list\.js/);
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]navigation['"], ['"]hydration-progress\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]userscript-shell\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]activity-content-script\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]extension-background\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]progress-dock-ui\.mjs/);
  assert.match(tsconfigSource, /"allowJs": false/);
  assert.match(tsconfigSource, /"src\/userscript-shell\.js"/);
  assert.match(tsconfigSource, /"src\/activity-content-script\.js"/);
});

test('scroll virtual do modal tem helper TypeScript tipado', () => {
  const helperPath = resolve(ROOT, 'src', 'browser', 'shared', 'modal-virtual-list.ts');
  assert.equal(existsSync(helperPath), true);

  const helperSource = readFileSync(helperPath, 'utf-8');
  const shellSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');

  assert.match(helperSource, /export type ModalVirtualListMetrics/);
  assert.match(helperSource, /export type ModalWheelScrollResult/);
  assert.match(helperSource, /computeModalVirtualScrollRange/);
  assert.match(helperSource, /computeModalWheelScroll/);
  assert.match(helperSource, /virtualItemCount/);
  assert.match(buildSource, /inlineableModalVirtualList/);
  assert.match(shellSource, /computeModalWheelScroll/);
  assert.match(shellSource, /handleModalPanelWheel/);
});

test('estilo nativo fica em perfil plugavel separado do shell', () => {
  const profilePath = resolve(ROOT, 'src', 'browser', 'shared', 'native-style-profile.ts');
  const capturePath = resolve(ROOT, 'src', 'browser', 'shared', 'native-style-capture.ts');
  const captureCliPath = resolve(ROOT, 'src', 'cli', 'capture-native-style.ts');
  assert.equal(existsSync(profilePath), true);
  assert.equal(existsSync(capturePath), true);
  assert.equal(existsSync(captureCliPath), true);

  const profileSource = readFileSync(profilePath, 'utf-8');
  const captureSource = readFileSync(capturePath, 'utf-8');
  const captureCliSource = readFileSync(captureCliPath, 'utf-8');
  const docsSource = readFileSync(resolve(ROOT, 'docs', 'reference', 'native-style-capture.md'), 'utf-8');
  const shellSource = readFileSync(resolve(ROOT, 'src', 'userscript-shell.ts'), 'utf-8');
  const buildSource = readFileSync(resolve(ROOT, 'scripts', 'build.mjs'), 'utf-8');
  const packageSource = readFileSync(resolve(ROOT, 'package.json'), 'utf-8');

  assert.match(captureSource, /REQUIRED_NATIVE_STYLE_TARGETS/);
  assert.match(captureSource, /validateNativeStyleCaptureManifest/);
  assert.match(captureSource, /sanitizeNativeStyleCaptureManifest/);
  assert.match(captureSource, /nativeStyleProfileFromCapture/);
  assert.match(captureCliSource, /TARGET_SPECS/);
  assert.match(captureCliSource, /No visible native element found/);
  assert.match(profileSource, /GEMINI_NATIVE_STYLE_PROFILE_VERSION/);
  assert.match(profileSource, /GEMINI_LR26_NATIVE_STYLE_PROFILE/);
  assert.match(profileSource, /buildGeminiNativeStyleProfile/);
  assert.match(profileSource, /applyGeminiNativeStyleVars/);
  assert.match(profileSource, /--gmn-topbar-slot-size/);
  assert.match(profileSource, /--gmn-menu-item-min-height/);
  assert.match(profileSource, /--gmn-modal-list-flex/);
  assert.match(docsSource, /Captura de estilo nativo/);
  assert.match(docsSource, /tests\/fixtures\/native-style/);
  assert.match(docsSource, /capture:native-style/);

  assert.match(buildSource, /nativeStyleProfileBanner/);
  assert.match(buildSource, /inlineableNativeStyleProfile/);
  assert.match(packageSource, /"capture:native-style": "npm run build:ts && node build\/ts\/cli\/capture-native-style\.js"/);
  assert.match(shellSource, /buildGeminiNativeStyleProfile\(\{ documentRef: document, isDark: isDarkTheme\(\) \}\)/);
  assert.match(shellSource, /applyGeminiNativeStyleVars/);
  assert.match(shellSource, /dataset\.gmNativeStyleProfile/);
});

test('instrucoes do repo tratam TypeScript como fonte canonica', () => {
  for (const fileName of ['CLAUDE.md', 'AGENTS.md']) {
    const source = readFileSync(resolve(ROOT, fileName), 'utf-8');
    assert.match(source, /Fonte canônica(?::|\s+é)\s+TypeScript/);
    assert.match(source, /Não recriar\s+`src\/userscript-shell\.js`/);
    assert.match(source, /não criar\s+`src\/userscript-shell\.js`/);
    assert.match(source, /UI não deve ser cérebro do produto/);
    assert.match(source, /Estilo nativo é capturado, não estimado/);
    assert.match(source, /docs\/reference\/native-style-capture\.md/);
    assert.match(source, /My Activity e Takeout/);
    assert.doesNotMatch(source, /fonte TypeScript transitória/);
    assert.doesNotMatch(source, /CTA primária verde/);
  }
});
