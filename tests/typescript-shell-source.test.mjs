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
  assert.match(buildSource, /build['"], ['"]ts['"], ['"]browser['"], ['"]navigation['"], ['"]hydration-progress\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]userscript-shell\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]activity-content-script\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]extension-background\.js/);
  assert.doesNotMatch(buildSource, /src['"], ['"]progress-dock-ui\.mjs/);
  assert.match(tsconfigSource, /"allowJs": false/);
  assert.match(tsconfigSource, /"src\/userscript-shell\.js"/);
  assert.match(tsconfigSource, /"src\/activity-content-script\.js"/);
});

test('instrucoes do repo tratam TypeScript como fonte canonica', () => {
  for (const fileName of ['CLAUDE.md', 'AGENTS.md']) {
    const source = readFileSync(resolve(ROOT, fileName), 'utf-8');
    assert.match(source, /Fonte canônica(?::|\s+é)\s+TypeScript/);
    assert.match(source, /Não recriar\s+`src\/userscript-shell\.js`/);
    assert.match(source, /não criar\s+`src\/userscript-shell\.js`/);
    assert.match(source, /UI não deve ser cérebro do produto/);
    assert.match(source, /My Activity e Takeout/);
    assert.doesNotMatch(source, /fonte TypeScript transitória/);
    assert.doesNotMatch(source, /CTA primária verde/);
  }
});
