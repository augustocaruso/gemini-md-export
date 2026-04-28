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

const testConfig = {
  launchIfClosed: false,
  initialConnectTimeoutMs: 10,
  reloadTimeoutMs: 10,
  pollIntervalMs: 1,
  maxReloadAttempts: 1,
};

const baseDeps = (overrides = {}) => {
  const { config, ...rest } = overrides;
  return {
    expected,
    config: {
      ...testConfig,
      ...(config || {}),
    },
    getLiveClients: () => [client()],
    getChromeExtensionInfo: async () => info(),
    reloadChromeExtension: async () => ({ ok: true, reloading: true }),
    launchChromeForGemini: async () => ({ attempted: false, supported: false }),
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    ...rest,
  };
};

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

test('aguarda heartbeat atrasado antes de considerar a extensão inalcançável', async () => {
  let probes = 0;
  const ready = await ensureChromeExtensionReady(
    baseDeps({
      sleep: async () => {},
      getLiveClients: () => {
        probes += 1;
        return probes >= 3 ? [client('late-client')] : [];
      },
    }),
  );

  assert.equal(ready.client.clientId, 'late-client');
  assert.equal(ready.reloadAttempts, 0);
  assert.equal(probes >= 3, true);
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

test('erro claro quando nenhum navegador suportado é encontrado para launch automático', async () => {
  await assert.rejects(
    () =>
      ensureChromeExtensionReady(
        baseDeps({
          config: {
            launchIfClosed: true,
            reloadTimeoutMs: 2,
            pollIntervalMs: 1,
          },
          getLiveClients: () => [],
          launchChromeForGemini: async () => ({
            attempted: false,
            supported: true,
            reason: 'browser-not-found',
          }),
        }),
      ),
    /não encontrei Chrome\/Edge\/Brave\/Dia/i,
  );
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

test('recarrega quando o build stamp está antigo', async () => {
  const expectedWithBuild = {
    ...expected,
    buildStamp: '20260428-0021',
  };
  let reloadArgs = null;
  let currentInfo = info({ buildStamp: '20260428-0017' });
  const ready = await ensureChromeExtensionReady(
    baseDeps({
      expected: expectedWithBuild,
      getChromeExtensionInfo: async () => currentInfo,
      reloadChromeExtension: async (_client, args) => {
        reloadArgs = args;
        currentInfo = info({ buildStamp: expectedWithBuild.buildStamp });
        return { ok: true, reloading: true };
      },
    }),
  );

  assert.equal(ready.reloadAttempts, 1);
  assert.equal(ready.info.buildStamp, expectedWithBuild.buildStamp);
  assert.equal(reloadArgs.reason, 'build_mismatch');
  assert.equal(reloadArgs.expectedBuildStamp, expectedWithBuild.buildStamp);
});

test('depois do reload prefere cliente atualizado a heartbeat antigo da mesma aba', async () => {
  const expectedWithBuild = {
    ...expected,
    buildStamp: '20260428-0021',
  };
  let reloaded = false;
  const staleClient = {
    ...client('stale-client'),
    extensionVersion: expectedWithBuild.extensionVersion,
    protocolVersion: expectedWithBuild.protocolVersion,
    buildStamp: '20260428-0017',
  };
  const updatedClient = {
    ...client('updated-client'),
    extensionVersion: expectedWithBuild.extensionVersion,
    protocolVersion: expectedWithBuild.protocolVersion,
    buildStamp: expectedWithBuild.buildStamp,
  };

  const ready = await ensureChromeExtensionReady(
    baseDeps({
      expected: expectedWithBuild,
      getLiveClients: () => (reloaded ? [staleClient, updatedClient] : [staleClient]),
      getChromeExtensionInfo: async (selectedClient) =>
        info({ buildStamp: selectedClient.buildStamp }),
      reloadChromeExtension: async () => {
        reloaded = true;
        return { ok: true, reloading: true };
      },
    }),
  );

  assert.equal(ready.client.clientId, 'updated-client');
  assert.equal(ready.info.buildStamp, expectedWithBuild.buildStamp);
  assert.equal(ready.reloadAttempts, 1);
});

test('depois do reload continua aguardando quando só heartbeat antigo voltou', async () => {
  const expectedWithBuild = {
    ...expected,
    buildStamp: '20260428-0021',
  };
  let reloaded = false;
  let probesAfterReload = 0;
  const staleClient = {
    ...client('stale-client'),
    extensionVersion: expectedWithBuild.extensionVersion,
    protocolVersion: expectedWithBuild.protocolVersion,
    buildStamp: '20260428-0017',
  };
  const updatedClient = {
    ...client('updated-client'),
    extensionVersion: expectedWithBuild.extensionVersion,
    protocolVersion: expectedWithBuild.protocolVersion,
    buildStamp: expectedWithBuild.buildStamp,
  };

  const ready = await ensureChromeExtensionReady(
    baseDeps({
      expected: expectedWithBuild,
      getLiveClients: () => {
        if (!reloaded) return [staleClient];
        probesAfterReload += 1;
        return probesAfterReload >= 3 ? [staleClient, updatedClient] : [staleClient];
      },
      getChromeExtensionInfo: async (selectedClient) =>
        info({ buildStamp: selectedClient.buildStamp }),
      reloadChromeExtension: async () => {
        reloaded = true;
        return { ok: true, reloading: true };
      },
    }),
  );

  assert.equal(ready.client.clientId, 'updated-client');
  assert.equal(ready.info.buildStamp, expectedWithBuild.buildStamp);
  assert.equal(probesAfterReload >= 3, true);
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
