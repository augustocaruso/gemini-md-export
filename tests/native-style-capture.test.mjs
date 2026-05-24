import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  REQUIRED_NATIVE_STYLE_TARGETS,
  nativeStyleProfileFromCapture,
  sanitizeNativeStyleCaptureManifest,
  validateNativeStyleCaptureManifest,
} from '../build/ts/browser/shared/native-style-capture.js';
import { GEMINI_LR26_NATIVE_STYLE_PROFILE } from '../build/ts/browser/shared/native-style-profile.js';

const fixturePath = new URL('./fixtures/native-style/gemini-lr26-dia-native.json', import.meta.url);

const loadFixture = async () => JSON.parse(await readFile(fixturePath, 'utf8'));

test('native style fixture is sanitized and produces the Gemini native profile', async () => {
  const fixture = await loadFixture();

  const validation = validateNativeStyleCaptureManifest(fixture);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.tokenCount, 59);
  assert.deepEqual(validation.missingTargets, []);
  assert.deepEqual(REQUIRED_NATIVE_STYLE_TARGETS, [
    'topbar.iconButton',
    'topbar.tooltip',
    'menu.panel',
    'menu.item',
    'menu.itemChecked',
    'modal.panel',
    'modal.list',
    'modal.checkbox',
  ]);

  const profile = nativeStyleProfileFromCapture(fixture);
  assert.equal(profile.name, 'gemini-lr26-dia-native');
  assert.equal(profile.version, 1);
  assert.equal(profile.source, 'native-style-capture:playwright-computed-style:2026-05-23T20:54:00.000Z');
  assert.deepEqual(profile, GEMINI_LR26_NATIVE_STYLE_PROFILE);
  assert.equal(profile.cssVars['--gmn-topbar-slot-size'], '40px');
  assert.equal(profile.cssVars['--gmn-menu-width'], '242px');
  assert.equal(profile.cssVars['--gmn-modal-list-flex'], '1 1 0');
  assert.equal(profile.cssVars['--gmn-modal-checkbox-size'], '18px');
});

test('native style sanitizer strips DOM/text/url payloads before versioning', async () => {
  const dirty = await loadFixture();
  dirty.targets[0].textContent = 'Nome de conversa privada';
  dirty.targets[0].outerHTML = '<button>Nome de conversa privada</button>';
  dirty.targets[0].href = 'https://gemini.google.com/app/deadbeefcafebabe';
  dirty.targets[0].states.base.tokens[0].sampleText = 'texto pessoal';

  const sanitized = sanitizeNativeStyleCaptureManifest(dirty);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /Nome de conversa privada|deadbeefcafebabe|outerHTML|textContent|sampleText/);
  assert.equal(validateNativeStyleCaptureManifest(sanitized).ok, true);
});

test('native style validation rejects missing targets and unmapped tokens', async () => {
  const fixture = await loadFixture();
  fixture.targets = fixture.targets.filter((target) => target.id !== 'menu.itemChecked');
  fixture.targets[0].states.base.tokens.push({
    property: 'width',
    value: '999px',
  });

  const validation = validateNativeStyleCaptureManifest(fixture);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /missing target: menu\.itemChecked/);
  assert.match(validation.errors.join('\n'), /missing cssVar/);
});

test('native style validation rejects non-gmn vars and sensitive fields', async () => {
  const fixture = await loadFixture();
  fixture.targets[0].states.base.tokens[0].cssVar = '--bad-token';
  fixture.targets[0].outerHTML = '<button>leak</button>';

  const validation = validateNativeStyleCaptureManifest(fixture);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /cssVar must start with --gmn-/);
  assert.match(validation.errors.join('\n'), /forbidden field: targets\.0\.outerHTML/);
});
