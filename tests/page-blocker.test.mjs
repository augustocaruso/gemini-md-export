import test from 'node:test';
import assert from 'node:assert/strict';

import { detectGooglePageBlocker } from '../build/ts/browser/shared/page-blocker.js';

test('detecta tela Google Sorry por URL', () => {
  const blocker = detectGooglePageBlocker({
    url: 'https://www.google.com/sorry/index?continue=https://gemini.google.com/app&q=blocked',
    title: 'Sorry',
  });

  assert.equal(blocker.code, 'google_verification_required');
  assert.equal(blocker.kind, 'google_sorry');
  assert.equal(blocker.terminal, true);
});

test('detecta login do Google por URL', () => {
  const blocker = detectGooglePageBlocker({
    url: 'https://accounts.google.com/signin/v2/identifier?continue=https://gemini.google.com/app',
    title: 'Fazer login',
  });

  assert.equal(blocker.code, 'google_login_required');
  assert.equal(blocker.kind, 'google_login');
});

test('detecta verificacao por texto visivel quando a URL ainda parece Google generica', () => {
  const blocker = detectGooglePageBlocker({
    url: 'https://www.google.com/',
    title: 'Google',
    bodyText: 'Our systems have detected unusual traffic from your computer network.',
  });

  assert.equal(blocker.code, 'google_verification_required');
  assert.equal(blocker.kind, 'google_verification_text');
});

test('nao bloqueia uma conversa normal do Gemini', () => {
  assert.equal(
    detectGooglePageBlocker({
      url: 'https://gemini.google.com/app/88a98a108cdcfb61',
      title: 'Conversa - Google Gemini',
      bodyText: 'Pergunta Resposta',
    }),
    null,
  );
});

test('nao bloqueia conversa Gemini que menciona captcha no proprio conteudo', () => {
  assert.equal(
    detectGooglePageBlocker({
      url: 'https://gemini.google.com/app/88a98a108cdcfb61',
      title: 'Conversa sobre seguranca',
      bodyText:
        'O usuario perguntou por que alguns sites mostram a mensagem nao e um robo e trafego incomum.',
    }),
    null,
  );
});
