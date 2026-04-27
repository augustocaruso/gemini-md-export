import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureChromeExtensionReady } from '../src/chrome-extension-guard.mjs';

const expected = {
  extensionVersion: '0.4.12',
  protocolVersion: 3,
};

const client = (id = 'client-1') => ({
  clientId: id,
  tabId: 10,
  windowId: 20,
  isActiveTab: true,
});

const info = (overrides = {}) => ({
  ok: true,
  extensionVersion: expected.extensionVersion,
  protocolVersion: expected.protocolVersion,
  ...overrides,
});

const baseDeps = (overrides = {}) => ({
  expected,
  config: {
    launchIfClosed: false,
    reloadTimeoutMs: 10,
    pollIntervalMs: 1,
    maxReloadAttempts: 1,
  },
  getLiveClients: () => [client()],
  getChromeExtensionInfo: async () => info(),
  reloadChromeExtension: async () => ({ ok: true, reloading: true }),
  launchChromeForGemini: async () => ({ attempted: false, supported: false }),
  sleep: async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
  ...overrides,
});

test('passa quando versão e protocolo batem', async () => {
  const ready = await ensureChromeExtensionReady(baseDeps());
  assert.equal(ready.info.extensionVersion, expected.extensionVersion);
  assert.equal(ready.info.protocolVersion, expected.protocolVersion);
  assert.equal(ready.reloadAttempts, 0);
});

test('falha quando extensão está inalcançável e launch está desabilitado', async () => {
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          getLiveClients: () => [],
        }),
      ),
    /extensão do Chrome não está acessível/i,
  );
});

test('tenta abrir Chrome quando extensão está inalcançável e launch está habilitado', async () => {
  let launched = false;
  const ready = await ensureChromeExtensionReady(
    baseDeps({
      config: {
        launchIfClosed: true,
        reloadTimeoutMs: 10,
        pollIntervalMs: 1,
        maxReloadAttempts: 1,
      },
      getLiveClients: () => (launched ? [client()] : []),
      launchChromeForGemini: async () => {
        launched = true;
        return { attempted: true, supported: true };
      },
    }),
  );

  assert.equal(ready.launchedChrome, true);
  assert.equal(ready.client.clientId, 'client-1');
});

test('recarrega extensão antiga e continua quando volta atualizada', async () => {
  let reloads = 0;
  let currentInfo = info({ extensionVersion: '0.4.11' });
  const ready = await ensureChromeExtensionReady(
    baseDeps({
      getChromeExtensionInfo: async () => currentInfo,
      reloadChromeExtension: async () => {
        reloads += 1;
        currentInfo = info();
        return { ok: true, reloading: true };
      },
    }),
  );

  assert.equal(reloads, 1);
  assert.equal(ready.reloadAttempts, 1);
  assert.equal(ready.info.extensionVersion, expected.extensionVersion);
});

test('erro claro quando reload acontece mas versão continua antiga', async () => {
  let reloads = 0;
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          getChromeExtensionInfo: async () => info({ extensionVersion: '0.4.11' }),
          reloadChromeExtension: async () => {
            reloads += 1;
            return { ok: true, reloading: true };
          },
        }),
      ),
    /ainda está antiga depois do reload/i,
  );
  assert.equal(reloads, 1);
});

test('erro de protocolo incompatível', async () => {
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          getChromeExtensionInfo: async () => info({ protocolVersion: 2 }),
        }),
        { allowReload: false },
      ),
    /protocolo da extensão do Chrome está incompatível/i,
  );
});

test('erro quando extensão não reconecta depois do reload', async () => {
  let reloaded = false;
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          config: {
            launchIfClosed: false,
            reloadTimeoutMs: 5,
            pollIntervalMs: 1,
            maxReloadAttempts: 1,
          },
          getLiveClients: () => (reloaded ? [] : [client()]),
          getChromeExtensionInfo: async () => info({ extensionVersion: '0.4.11' }),
          reloadChromeExtension: async () => {
            reloaded = true;
            return { ok: true, reloading: true };
          },
        }),
      ),
    /não voltou a conectar/i,
  );
});

test('não entra em loop infinito de reload', async () => {
  let reloads = 0;
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          getChromeExtensionInfo: async () => info({ extensionVersion: '0.4.11' }),
          reloadChromeExtension: async () => {
            reloads += 1;
            return { ok: true, reloading: true };
          },
        }),
      ),
    /ainda está antiga depois do reload/i,
  );
  assert.equal(reloads, 1);
});
