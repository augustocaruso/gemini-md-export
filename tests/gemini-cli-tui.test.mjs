import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { main } from '../bin/gemini-md-export.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('CLI usa timeout honesto e status visivel para readiness lenta', () => {
  const source = readFileSync(resolve(ROOT, 'bin', 'gemini-md-export.mjs'), 'utf-8');
  assert.match(source, /const DEFAULT_READY_REQUEST_TIMEOUT_MS = 60_000/);
  assert.match(source, /process\.env\.GEMINI_MD_EXPORT_READY_REQUEST_TIMEOUT_MS/);
  assert.match(source, /Ainda verificando Gemini Web\.\.\. \$\{formatDuration\(elapsedMs\)\} decorridos; sem fallback MCP/);
});

const captureStream = ({ isTTY = false, columns = 88 } = {}) => {
  let text = '';
  return {
    isTTY,
    columns,
    write(chunk) {
      text += String(chunk);
      return true;
    },
    text: () => text,
  };
};

const withServer = async (handler, fn) => {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname, searchParams: url.searchParams });
    handler(req, res, url);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const withEnv = async (patch, fn) => {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const getFreePort = async () => {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

const runningJob = {
  jobId: 'job-1',
  status: 'running',
  phase: 'exporting',
  requested: 2,
  completed: 1,
  loadedCount: 2,
  progressMessage: 'Baixando conversas novas (2/2): ECG',
  reportFile: '/tmp/gme-report.json',
  current: { title: 'ECG', chatId: 'abc123abc123' },
  decisionSummary: {
    fullHistoryRequested: true,
    fullHistoryVerified: false,
    totals: {
      geminiWebSeen: 2,
      existingInVault: 1,
      missingInVault: 1,
      downloadedNow: 1,
      skipped: 1,
      mediaWarnings: 0,
      failed: 0,
    },
  },
};

const completedJob = {
  ...runningJob,
  status: 'completed',
  phase: 'writing-report',
  completed: 2,
  progressMessage: 'Vault atualizado. 1 conversa nova salva.',
  decisionSummary: {
    ...runningJob.decisionSummary,
    fullHistoryVerified: true,
    reportFile: '/tmp/gme-report.json',
    nextAction: { code: 'done', message: 'Importação concluída.', command: null },
  },
};

const completedWithErrorsJob = {
  ...runningJob,
  status: 'completed_with_errors',
  phase: 'done',
  requested: 33,
  completed: 33,
  loadedCount: 33,
  successCount: 32,
  failureCount: 1,
  progressMessage: 'Não consegui confirmar o fim do histórico.',
  loadMoreTimedOut: true,
  loadMoreRoundsCompleted: 1,
  failures: [
    {
      index: 24,
      chatId: '3c1d9107303b754e',
      title: 'SurrealDB Roadmap',
      error: 'Esta aba do Gemini já está ocupada com outro comando pesado.',
    },
  ],
  decisionSummary: {
    fullHistoryRequested: true,
    fullHistoryVerified: false,
    reportFile: '/tmp/gme-report.json',
    nextAction: { code: 'resume_available', message: 'Retome pelo relatório.', command: null },
    totals: {
      geminiWebSeen: 33,
      existingInVault: 0,
      missingInVault: 1,
      downloadedNow: 32,
      skipped: 0,
      mediaWarnings: 0,
      failed: 1,
    },
  },
};

const mockSyncServer = ({ completedImmediately = false } = {}) => {
  let statusCalls = 0;
  return (req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/sync-vault') {
      sendJson(res, 202, completedImmediately ? completedJob : runningJob);
      return;
    }
    if (
      url.pathname === '/agent/export-recent-chats' ||
      url.pathname === '/agent/export-missing-chats' ||
      url.pathname === '/agent/reexport-chats' ||
      url.pathname === '/agent/export-notebook'
    ) {
      sendJson(res, 202, completedImmediately ? completedJob : runningJob);
      return;
    }
    if (url.pathname === '/agent/export-job-status') {
      statusCalls += 1;
      sendJson(res, 200, statusCalls >= 1 ? completedJob : runningJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  };
};

test('CLI --help na posicao inicial sai com sucesso', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(['--help'], { stdout, stderr });

  assert.equal(run.exitCode, 0);
  assert.match(stdout.text(), /Uso:/);
  assert.match(stdout.text(), /Exit codes:/);
  assert.match(stdout.text(), /--json/);
  assert.match(stdout.text(), /export missing/);
  assert.match(stdout.text(), /export reexport/);
  assert.match(stdout.text(), /export notebook/);
  assert.match(stdout.text(), /repair-vault/);
  assert.equal(stderr.text(), '');
});

test('CLI --version imprime versao sem tocar na bridge', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(['--version'], { stdout, stderr });

  assert.equal(run.exitCode, 0);
  assert.match(stdout.text(), /^gemini-md-export \d+\.\d+\.\d+/);
  assert.equal(stderr.text(), '');
});

test('CLI expõe ajuda contextual para comandos e subcomandos', async () => {
  const syncStdout = captureStream();
  const jobStdout = captureStream();

  assert.equal((await main(['sync', '--help'], { stdout: syncStdout })).exitCode, 0);
  assert.match(syncStdout.text(), /gemini-md-export sync/);
  assert.match(syncStdout.text(), /--resume-report-file/);
  assert.match(syncStdout.text(), /Contrato para agentes/);

  assert.equal((await main(['help', 'job', 'status'], { stdout: jobStdout })).exitCode, 0);
  assert.match(jobStdout.text(), /gemini-md-export job status/);
  assert.match(jobStdout.text(), /running/);
  assert.match(jobStdout.text(), /--jsonl/);

  const jobListStdout = captureStream();
  assert.equal((await main(['help', 'job', 'list'], { stdout: jobListStdout })).exitCode, 0);
  assert.match(jobListStdout.text(), /gemini-md-export job list/);
  assert.match(jobListStdout.text(), /--active/);

  const exportStdout = captureStream();
  assert.equal((await main(['export', 'missing', '--help'], { stdout: exportStdout })).exitCode, 0);
  assert.match(exportStdout.text(), /gemini-md-export export missing/);
  assert.match(exportStdout.text(), /--max-chats/);

  const reexportStdout = captureStream();
  assert.equal((await main(['export', 'reexport', '--help'], { stdout: reexportStdout })).exitCode, 0);
  assert.match(reexportStdout.text(), /gemini-md-export export reexport/);
  assert.match(reexportStdout.text(), /--chat-id/);

  const tabsStdout = captureStream();
  assert.equal((await main(['tabs', '--help'], { stdout: tabsStdout })).exitCode, 0);
  assert.match(tabsStdout.text(), /gemini-md-export tabs/);
  assert.match(tabsStdout.text(), /tabs claim/);

  const chatsStdout = captureStream();
  assert.equal((await main(['chats', '--help'], { stdout: chatsStdout })).exitCode, 0);
  assert.match(chatsStdout.text(), /gemini-md-export chats/);
  assert.match(chatsStdout.text(), /chats count/);
  assert.match(chatsStdout.text(), /Total confirmado/);
});

test('CLI doctor --plain nao imprime RESULT_JSON sem pedido explicito', async () => {
  const port = await getFreePort();
  const stdout = captureStream();
  const stderr = captureStream();
  const run = await main(
    [
      'doctor',
      '--bridge-url',
      `http://127.0.0.1:${port}`,
      '--no-start-bridge',
      '--plain',
    ],
    { stdout, stderr },
  );

  assert.equal(run.exitCode, 3);
  assert.match(stdout.text(), /NAO PRONTO:/);
  assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
});

test('CLI tabs list usa endpoint proprio sem preflight gemini_ready', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/tabs') {
      sendJson(res, 200, {
        ok: true,
        action: 'list',
        connectedTabCount: 1,
        connectedClientCount: 1,
        tabs: [
          {
            index: 1,
            clientId: 'client-1',
            tabId: 123,
            page: {
              url: 'https://gemini.google.com/app/abc123abc123',
              title: 'Chat - Gemini',
              chatId: 'abc123abc123',
              kind: 'chat',
              listedConversationCount: 42,
            },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['tabs', 'list', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });
    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /1 aba\(s\) Gemini conectada\(s\)/);
    assert.match(stdout.text(), /clientId=client-1/);
    assert.match(stdout.text(), /conversas_visiveis=42/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    assert.equal(run.result.tabs[0].clientId, 'client-1');
    assert.equal(run.result.tabs[0].listedConversationCount, 42);
    assert.equal(stderr.text(), '');
    assert.equal(requests.some((item) => item.pathname === '/agent/ready'), false);
  });
});

test('CLI chats count carrega ate o fim sem despejar lista no chat', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: 'GME Count',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 203,
        countSource: 'browser_dom_count_match',
        countConfidence: 'dom-counts-agree',
        knownLoadedCount: 203,
        minimumKnownCount: 203,
        pagination: {
          loadedCount: 203,
          reachedEnd: true,
          canLoadMore: false,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
          tabId: Number(url.searchParams.get('tabId')),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Bridge conectada/);
    assert.match(stdout.text(), /Carregando historico do Gemini/);
    assert.match(stdout.text(), /Total confirmado: 203 chat\(s\)/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    const result = run.result;
    assert.equal(result.totalKnown, true);
    assert.equal(result.totalCount, 203);
    assert.equal(result.countSource, 'browser_dom_count_match');
    assert.equal(result.countConfidence, 'dom-counts-agree');
    assert.equal(result.knownLoadedCount, 203);
    assert.equal(stderr.text(), '');

    const countRequest = requests.find((item) => item.pathname === '/agent/recent-chats');
    assert.equal(countRequest.searchParams.get('countOnly'), 'true');
    assert.equal(countRequest.searchParams.get('untilEnd'), 'true');
    assert.equal(countRequest.searchParams.get('preferActive'), 'true');
    assert.equal(countRequest.searchParams.get('limit'), '1');
    assert.equal(countRequest.searchParams.get('loadMoreTimeoutMs'), '900000');
    assert.equal(countRequest.searchParams.get('maxNoGrowthRounds'), '8');
    assert.equal(countRequest.searchParams.get('loadMoreBrowserRounds'), '12');
    assert.equal(countRequest.searchParams.get('loadMoreBrowserTimeoutMs'), '30000');
    assert.equal(countRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(countRequest.searchParams.get('tabId'), '101');
    assert.equal(countRequest.searchParams.get('autoClaim'), 'false');
    assert.equal(countRequest.searchParams.get('autoReleaseClaim'), 'false');
    const claimRequest = requests.find((item) => item.pathname === '/agent/tabs');
    assert.equal(claimRequest.searchParams.get('preferRecent'), 'true');
    assert.equal(claimRequest.searchParams.get('openIfMissing'), 'false');
    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(releaseRequest.searchParams.get('tabId'), '101');
  });
});

test('CLI chats count --result-json reativa RESULT_JSON explicitamente', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: 'GME Count',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--plain', '--result-json'],
      { stdout },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Total confirmado: 277 chat\(s\)/);
    assert.match(stdout.text(), /RESULT_JSON /);
  });
});

test('CLI chats count nao transforma contagem parcial em total', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: 'GME Count',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'incomplete',
        countIsTotal: false,
        totalKnown: false,
        totalCount: null,
        knownLoadedCount: 73,
        minimumKnownCount: 73,
        countWarning: 'Contagem parcial: nao informe como total.',
        loadMoreError: 'Esta aba do Gemini ja esta ocupada com outro comando pesado.',
        pagination: {
          loadedCount: 73,
          reachedEnd: false,
          canLoadMore: true,
        },
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, { ok: true, released: { claimId: url.searchParams.get('claimId') } });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 1);
    assert.match(stdout.text(), /Contagem parcial: pelo menos 73 chat\(s\)/);
    assert.match(stdout.text(), /aba do Gemini ja esta ocupada/);
    assert.doesNotMatch(stdout.text(), /RESULT_JSON/);
    const result = run.result;
    assert.equal(result.totalKnown, false);
    assert.equal(result.totalCount, null);
    assert.equal(result.minimumKnownCount, 73);
    assert.match(result.loadMoreError, /ocupada/);
    assert.match(result.warning, /parcial/);
    assert.equal(stderr.text(), '');
  });
});

test('CLI chats count libera claim explicita sem imprimir JSON extra', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['chats', 'count', '--bridge-url', bridgeUrl, '--claim-id', 'claim-123', '--plain'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Total confirmado: 277 chat\(s\)/);
    assert.equal(
      stdout.text().split(/\r?\n/).filter((line) => line.startsWith('RESULT_JSON ')).length,
      0,
      'count plain nao deve emitir RESULT_JSON',
    );
    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.ok(releaseRequest, 'deve liberar a claim depois da contagem');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'claim-123');
    assert.equal(releaseRequest.searchParams.get('reason'), 'cli-chats-count-finished');
    assert.equal(stderr.text(), '');
  });
});

test('CLI chats count libera claim propria quando a bridge cai durante a contagem', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/tabs' && url.searchParams.get('action') === 'claim') {
      sendJson(res, 200, {
        ok: true,
        claim: {
          claimId: 'count-claim',
          tabId: 101,
          label: 'GME Count',
        },
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      req.socket.destroy(new Error('simulated bridge drop'));
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 200, {
        ok: true,
        released: {
          claimId: url.searchParams.get('claimId'),
          tabId: Number(url.searchParams.get('tabId')),
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    await assert.rejects(
      () => main(['chats', 'count', '--bridge-url', bridgeUrl, '--plain'], { stdout, stderr }),
      /Conexao com a bridge caiu antes da resposta/,
    );

    const releaseRequest = requests.find((item) => item.pathname === '/agent/release-tab');
    assert.ok(releaseRequest, 'deve liberar a claim mesmo quando a contagem cai');
    assert.equal(releaseRequest.searchParams.get('claimId'), 'count-claim');
    assert.equal(releaseRequest.searchParams.get('tabId'), '101');
    assert.equal(stderr.text(), '');
  });
});

test('CLI --keep-claim preserva claim explicita', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/recent-chats') {
      sendJson(res, 200, {
        ok: true,
        countStatus: 'complete',
        countIsTotal: true,
        totalKnown: true,
        totalCount: 277,
        knownLoadedCount: 277,
        minimumKnownCount: 277,
        conversations: [],
      });
      return;
    }
    if (url.pathname === '/agent/release-tab') {
      sendJson(res, 500, { ok: false, error: 'nao deveria liberar' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'chats',
        'count',
        '--bridge-url',
        bridgeUrl,
        '--claim-id',
        'claim-123',
        '--keep-claim',
        '--plain',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
    assert.equal(stderr.text(), '');
  });
});

test('CLI diagnose page abre artefatos e pede liberação da claim no endpoint', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/diagnose-page') {
      sendJson(res, 200, {
        ok: true,
        page: {
          chatId: '46b61afe42a5956d',
          url: url.searchParams.get('url'),
          title: 'Artefato',
        },
        summary: {
          total: 1,
          launcherCount: 1,
          clickedLauncherCount: 1,
          htmlExtractable: 1,
        },
        launcherOpen: {
          close: { ok: true },
        },
        items: [
          {
            id: 'artifact-001',
            kind: 'gemini_code_immersive',
            srcKind: 'remote_usercontent_goog',
            htmlExtractable: true,
            recommendedExport: 'html_asset',
          },
        ],
        tabClaimRelease: {
          ok: true,
          released: { claimId: 'claim-123' },
        },
        artifactHtmlSave: {
          ok: true,
          captureCount: 1,
          savedCount: 1,
          outputDir: '/tmp/artifacts',
          manifestFile: '/tmp/artifacts/artifact-46b61afe42a5956d-manifest.json',
        },
      });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      [
        'diagnose',
        'page',
        'https://gemini.google.com/app/46b61afe42a5956d',
        '--bridge-url',
        bridgeUrl,
        '--claim-id',
        'claim-123',
        '--save-html',
        '--output-dir',
        '/tmp/artifacts',
        '--plain',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Botões candidatos: 1; abertos: 1/);
    assert.match(stdout.text(), /Captura HTML: ok; payloads: 1/);
    assert.match(stdout.text(), /HTML salvo: 1 arquivo\(s\) em \/tmp\/artifacts/);
    assert.match(stdout.text(), /Superfície aberta: fechada após o diagnóstico/);
    assert.match(stdout.text(), /Claim da aba: liberada/);
    const diagnoseRequest = requests.find((item) => item.pathname === '/agent/diagnose-page');
    assert.ok(diagnoseRequest);
    assert.equal(diagnoseRequest.searchParams.get('claimId'), 'claim-123');
    assert.equal(diagnoseRequest.searchParams.get('saveHtml'), 'true');
    assert.equal(diagnoseRequest.searchParams.get('outputDir'), '/tmp/artifacts');
    assert.equal(diagnoseRequest.searchParams.get('releaseClaimOnOperationEnd'), 'true');
    assert.equal(requests.some((item) => item.pathname === '/agent/release-tab'), false);
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync --plain emite progresso estavel e RESULT_JSON final', async () => {
  await withServer(mockSyncServer(), async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Conectando na bridge/);
    assert.match(stdout.text(), /running\/exporting/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');

    const resultLine = stdout
      .text()
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON '));
    const result = JSON.parse(resultLine.replace('RESULT_JSON ', ''));
    assert.equal(result.status, 'completed');
    assert.equal(result.downloadedCount, 1);
    assert.equal(result.fullHistoryVerified, true);

    const syncRequest = requests.find((item) => item.pathname === '/agent/sync-vault');
    assert.equal(syncRequest.searchParams.get('vaultDir'), '/vault/Gemini');
    assert.equal(syncRequest.searchParams.get('outputDir'), '/vault/Gemini');
  });
});

test('CLI sync --plain destaca historico incompleto e falhas no RESULT_JSON', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/ready') {
      sendJson(res, 200, {
        ready: true,
        mode: 'hot',
        connectedClientCount: 1,
        selectableTabCount: 1,
        commandReadyClientCount: 1,
      });
      return;
    }
    if (url.pathname === '/agent/sync-vault') {
      sendJson(res, 202, completedWithErrorsJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );
    assert.equal(run.exitCode, 1);

    assert.match(stdout.text(), /ATENCAO: o fim do historico nao foi confirmado/);
    assert.match(stdout.text(), /Falhas registradas:/);
    assert.match(stdout.text(), /3c1d9107303b754e/);
    const resultLine = stdout
      .text()
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON '));
    const result = JSON.parse(resultLine.replace('RESULT_JSON ', ''));
    assert.equal(result.status, 'completed_with_errors');
    assert.equal(result.fullHistoryVerified, false);
    assert.equal(result.failures[0].chatId, '3c1d9107303b754e');
    assert.equal(result.loadMoreTimedOut, true);
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync cancela job em timeout e libera claim visual da aba', async () => {
  const claimedRunningJob = {
    ...runningJob,
    jobId: 'job-timeout-sync',
    tabClaimId: 'claim-sync-timeout',
    tabClaim: {
      claimId: 'claim-sync-timeout',
      tabId: 12345,
      status: 'active',
    },
  };
  let cancelRequested = false;

  await withEnv({ GEMINI_MD_EXPORT_JOB_TIMEOUT_CLEANUP_MS: '250' }, async () => {
    await withServer((req, res, url) => {
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/sync-vault') {
        sendJson(res, 202, claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-status') {
        sendJson(res, 200, cancelRequested
          ? { ...claimedRunningJob, status: 'cancelled', phase: 'cancelled' }
          : claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-cancel') {
        cancelRequested = true;
        sendJson(res, 200, { ...claimedRunningJob, status: 'cancel_requested' });
        return;
      }
      if (url.pathname === '/agent/release-tab') {
        sendJson(res, 200, {
          ok: true,
          released: {
            claimId: url.searchParams.get('claimId'),
            tabId: Number(url.searchParams.get('tabId')),
          },
          visual: { ok: true },
        });
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl, requests) => {
      const stdout = captureStream();
      const stderr = captureStream();
      await assert.rejects(
        () =>
          main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--timeout-ms',
              '20',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          ),
        /Timeout aguardando job job-timeout-sync/,
      );

      assert.match(stdout.text(), /cancelando no navegador e liberando a aba/);
      assert.equal(stderr.text(), '');
      assert.equal(requests.some((item) => item.pathname === '/agent/export-job-cancel'), true);
      const release = requests.find((item) => item.pathname === '/agent/release-tab');
      assert.ok(release);
      assert.equal(release.searchParams.get('claimId'), 'claim-sync-timeout');
      assert.equal(release.searchParams.get('tabId'), '12345');
    });
  });
});

test('CLI export cancela job e libera claim ao receber SIGTERM externo', { timeout: 10000 }, async () => {
  const claimedRunningJob = {
    ...runningJob,
    jobId: 'job-sigterm',
    tabClaimId: 'claim-sigterm',
    tabClaim: {
      claimId: 'claim-sigterm',
      tabId: 4242,
      status: 'active',
    },
    traceFile: '/tmp/job-sigterm.trace.jsonl',
  };
  let cancelRequested = false;

  await withEnv({ GEMINI_MD_EXPORT_JOB_TIMEOUT_CLEANUP_MS: '1000' }, async () => {
    await withServer((req, res, url) => {
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/agent/ready') {
        sendJson(res, 200, {
          ready: true,
          mode: 'hot',
          connectedClientCount: 1,
          selectableTabCount: 1,
          commandReadyClientCount: 1,
        });
        return;
      }
      if (url.pathname === '/agent/export-recent-chats') {
        sendJson(res, 202, claimedRunningJob);
        return;
      }
      if (url.pathname === '/agent/export-job-status') {
        sendJson(
          res,
          200,
          cancelRequested
            ? { ...claimedRunningJob, status: 'cancelled', phase: 'cancelled' }
            : claimedRunningJob,
        );
        return;
      }
      if (url.pathname === '/agent/export-job-cancel') {
        cancelRequested = true;
        sendJson(res, 200, { ...claimedRunningJob, status: 'cancel_requested' });
        return;
      }
      if (url.pathname === '/agent/release-tab') {
        sendJson(res, 200, {
          ok: true,
          released: {
            claimId: url.searchParams.get('claimId'),
            tabId: Number(url.searchParams.get('tabId')),
          },
        });
        return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    }, async (bridgeUrl, requests) => {
      const child = spawn(
        process.execPath,
        [
          resolve(ROOT, 'bin', 'gemini-md-export.mjs'),
          'export',
          'recent',
          '--bridge-url',
          bridgeUrl,
          '--plain',
          '--poll-ms',
          '50',
          '--timeout-ms',
          '300000',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      let killed = false;
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (!killed && stdout.includes('Job iniciado: job-sigterm')) {
          killed = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const exit = await new Promise((resolveExit) => {
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });

      assert.equal(exit.code, 2);
      assert.equal(exit.signal, null);
      assert.match(stdout, /Interrupcao recebida \(SIGTERM\); cancelando job job-sigterm/);
      assert.match(stdout, /traceFile: \/tmp\/job-sigterm\.trace\.jsonl/);
      assert.equal(stderr, '');
      assert.equal(requests.some((item) => item.pathname === '/agent/export-job-cancel'), true);
      const release = requests.find((item) => item.pathname === '/agent/release-tab');
      assert.ok(release);
      assert.equal(release.searchParams.get('claimId'), 'claim-sigterm');
      assert.equal(release.searchParams.get('tabId'), '4242');
    });
  });
});

test('CLI sync acorda Gemini Web pela propria CLI antes de exportar', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-launch-'));
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            readyCalls += 1;
            const ready = readyCalls >= 2;
            sendJson(res, 200, {
              ready,
              mode: ready ? 'warm' : 'cold',
              connectedClientCount: ready ? 1 : 0,
              selectableTabCount: ready ? 1 : 0,
              commandReadyClientCount: ready ? 1 : 0,
              blockingIssue: ready ? null : 'no_connected_clients',
            });
            return;
          }
          if (url.pathname === '/agent/sync-vault') {
            sendJson(res, 202, completedJob);
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl, requests) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const run = await main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--ready-wait-ms',
              '300',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          );

          assert.equal(run.exitCode, 0);
          assert.match(stdout.text(), /Abrindo Gemini Web em background/);
          assert.match(stdout.text(), /Aguardando a extensao conectar \(1s\)/);
          assert.match(stdout.text(), /RESULT_JSON /);
          assert.equal(stderr.text(), '');

          const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
          assert.equal(readyRequests.length >= 2, true);
          assert.equal(readyRequests.every((item) => item.searchParams.get('wakeBrowser') === 'false'), true);
          assert.equal(readyRequests[0].searchParams.get('waitMs'), '0');
          assert.equal(readyRequests[1].searchParams.get('waitMs'), '300');

          const launchState = JSON.parse(readFileSync(resolve(tmpRoot, 'browser-launch.json'), 'utf-8'));
          assert.equal(launchState.source, 'cli');
          assert.equal(launchState.status, 'dry-run');
          assert.equal(launchState.launch.dryRun, true);
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI espera aba Gemini existente reconectar antes de abrir nova aba', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-existing-tab-'));
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MD_EXPORT_CLI_BROWSER_LAUNCH_DRY_RUN: 'true',
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '300',
      },
      async () => {
        await withServer((req, res, url) => {
          if (url.pathname === '/agent/ready') {
            readyCalls += 1;
            const ready = readyCalls >= 2;
            sendJson(res, 200, {
              ready,
              connectedClientCount: ready ? 1 : 0,
              selectableTabCount: ready ? 1 : 0,
              commandReadyClientCount: ready ? 1 : 0,
              blockingIssue: ready ? null : 'no_connected_clients',
            });
            return;
          }
          if (url.pathname === '/agent/sync-vault') {
            sendJson(res, 202, completedJob);
            return;
          }
          sendJson(res, 404, { error: `not found: ${url.pathname}` });
        }, async (bridgeUrl, requests) => {
          const stdout = captureStream();
          const stderr = captureStream();
          const run = await main(
            [
              'sync',
              '/vault/Gemini',
              '--bridge-url',
              bridgeUrl,
              '--plain',
              '--ready-wait-ms',
              '300',
              '--poll-ms',
              '10',
            ],
            { stdout, stderr },
          );

          assert.equal(run.exitCode, 0);
          assert.match(stdout.text(), /Aguardando aba Gemini existente reconectar \(1s\)/);
          assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
          assert.equal(existsSync(resolve(tmpRoot, 'browser-launch.json')), false);
          assert.equal(stderr.text(), '');

          const readyRequests = requests.filter((item) => item.pathname === '/agent/ready');
          assert.equal(readyRequests.length, 2);
          assert.equal(readyRequests[0].searchParams.get('waitMs'), '0');
          assert.equal(readyRequests[1].searchParams.get('waitMs'), '300');
        });
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI sync reaproveita estado legado de launch em andamento para evitar aba duplicada', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'gme-cli-launch-'));
  const legacyLaunchStatePath = resolve(tmpRoot, 'hook-browser-launch.json');
  writeFileSync(
    legacyLaunchStatePath,
    JSON.stringify({
      source: 'cli',
      launchId: 'existing-cli-launch',
      status: 'attempted',
      lastAttemptAt: Date.now(),
      expiresAt: Date.now() + 5000,
    }),
    'utf-8',
  );
  let readyCalls = 0;
  try {
    await withEnv(
      {
        GEMINI_MCP_BROWSER_LAUNCH_STATE_DIR: tmpRoot,
        GEMINI_MD_EXPORT_EXISTING_TAB_GRACE_MS: '0',
      },
      async () => {
      await withServer((req, res, url) => {
        if (url.pathname === '/agent/ready') {
          readyCalls += 1;
          const ready = readyCalls >= 2;
          sendJson(res, 200, {
            ready,
            connectedClientCount: ready ? 1 : 0,
            selectableTabCount: ready ? 1 : 0,
            commandReadyClientCount: ready ? 1 : 0,
            blockingIssue: ready ? null : 'no_connected_clients',
          });
          return;
        }
        if (url.pathname === '/agent/sync-vault') {
          sendJson(res, 202, completedJob);
          return;
        }
        sendJson(res, 404, { error: `not found: ${url.pathname}` });
      }, async (bridgeUrl) => {
        const stdout = captureStream();
        const stderr = captureStream();
        const run = await main(
          [
            'sync',
            '/vault/Gemini',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--ready-wait-ms',
            '300',
            '--poll-ms',
            '10',
          ],
          { stdout, stderr },
        );

        assert.equal(run.exitCode, 0);
        assert.match(stdout.text(), /Outra chamada ja esta abrindo Gemini Web/);
        assert.doesNotMatch(stdout.text(), /Abrindo Gemini Web em background/);
        assert.equal(stderr.text(), '');

        const launchState = JSON.parse(readFileSync(legacyLaunchStatePath, 'utf-8'));
        assert.equal(launchState.launchId, 'existing-cli-launch');
      });
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('CLI sync --tui renderiza painel ANSI quando usado com TTY', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream({ isTTY: true, columns: 100 });
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /\x1b\[\?25l/);
    assert.match(stdout.text(), /\x1b\[\?25h/);
    assert.match(stdout.text(), /Gemini Markdown Export/);
    assert.match(stdout.text(), /\[[=-]+]/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI sync --tui avisa e cai para plain sem TTY', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--tui', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.doesNotMatch(stdout.text(), /\x1b\[\?25l/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.match(stderr.text(), /--tui precisa de terminal interativo/);
  });
});

test('CLI sync --json preserva stdout como JSON puro', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['sync', '/vault/Gemini', '--bridge-url', bridgeUrl, '--json', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.reportFile, '/tmp/gme-report.json');
    assert.equal(stderr.text(), '');
  });
});

test('CLI job status considera job em andamento como consulta bem-sucedida', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-job-status') {
      sendJson(res, 200, runningJob);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['job', 'status', 'job-1', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /running/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI job list mostra jobs ativos em plain e json', async () => {
  const jobList = {
    ok: true,
    action: 'list',
    activeOnly: true,
    activeCount: 1,
    jobs: [
      {
        ...runningJob,
        traceFile: '/tmp/gme-job.trace.jsonl',
      },
    ],
  };
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-jobs') {
      assert.equal(url.searchParams.get('active'), 'true');
      assert.equal(url.searchParams.get('limit'), '5');
      sendJson(res, 200, jobList);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const plainStdout = captureStream();
    const plainStderr = captureStream();
    const plain = await main(
      ['job', 'list', '--active', '--limit', '5', '--bridge-url', bridgeUrl, '--plain'],
      { stdout: plainStdout, stderr: plainStderr },
    );

    assert.equal(plain.exitCode, 0);
    assert.match(plainStdout.text(), /job-1 running\/exporting/);
    assert.match(plainStdout.text(), /gemini-md-export job status job-1 --plain/);
    assert.match(plainStdout.text(), /gemini-md-export job cancel job-1 --plain/);
    assert.match(plainStdout.text(), /RESULT_JSON /);
    assert.equal(plainStderr.text(), '');

    const jsonStdout = captureStream();
    const json = await main(
      ['job', 'list', '--active', '--limit', '5', '--bridge-url', bridgeUrl, '--json'],
      { stdout: jsonStdout },
    );
    assert.equal(json.exitCode, 0);
    assert.equal(JSON.parse(jsonStdout.text()).jobs[0].jobId, 'job-1');
  });
});

test('CLI job trace consulta endpoint dedicado sem despejar MCP no chat', async () => {
  const traceResult = {
    ok: true,
    jobId: 'job-1',
    status: 'failed',
    trace: { filePath: '/tmp/job-1.trace.jsonl', retained: true },
    summary: { eventCount: 2, byType: { job_created: 1, job_error: 1 } },
    events: [
      { ts: '2026-05-02T00:00:00.000Z', type: 'job_created', data: { phase: 'queued' } },
      {
        ts: '2026-05-02T00:00:01.000Z',
        type: 'job_error',
        data: { error: 'Timeout', code: 'job_timeout', layer: 'job' },
      },
    ],
  };
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-job-trace') {
      sendJson(res, 200, traceResult);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(['job', 'trace', 'job-1', '--bridge-url', bridgeUrl, '--plain'], {
      stdout,
      stderr,
    });

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /Trace do job job-1/);
    assert.match(stdout.text(), /job_error/);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');
  });
});

test('CLI export missing inicia job com vaultDir e segue ate resultado final', async () => {
  await withServer(mockSyncServer(), async (bridgeUrl, requests) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const run = await main(
      ['export', 'missing', '/vault/Gemini', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 0);
    assert.match(stdout.text(), /RESULT_JSON /);
    assert.equal(stderr.text(), '');

    const exportRequest = requests.find((item) => item.pathname === '/agent/export-missing-chats');
    assert.equal(exportRequest.searchParams.get('vaultDir'), '/vault/Gemini');
    assert.equal(exportRequest.searchParams.get('outputDir'), '/vault/Gemini');
  });
});

test('CLI export reexport e notebook usam endpoints diretos da bridge', async () => {
  await withServer(mockSyncServer({ completedImmediately: true }), async (bridgeUrl, requests) => {
    const reexportStdout = captureStream();
    const notebookStdout = captureStream();

    assert.equal(
      (
        await main(
          [
            'export',
            'reexport',
            '--chat-id',
            'abc123abc123',
            '--output-dir',
            '/vault/staging',
            '--hydration-timeout-ms',
            '900000',
            '--hydration-stall-ms',
            '60000',
            '--export-browser-timeout-ms',
            '960000',
            '--bridge-url',
            bridgeUrl,
            '--plain',
            '--poll-ms',
            '10',
          ],
          { stdout: reexportStdout },
        )
      ).exitCode,
      0,
    );

    assert.equal(
      (
        await main(
          ['export', 'notebook', '--start-index', '2', '--bridge-url', bridgeUrl, '--plain', '--poll-ms', '10'],
          { stdout: notebookStdout },
        )
      ).exitCode,
      0,
    );

    const reexportRequest = requests.find((item) => item.pathname === '/agent/reexport-chats');
    assert.equal(reexportRequest.searchParams.get('chatId'), 'abc123abc123');
    assert.equal(reexportRequest.searchParams.get('outputDir'), '/vault/staging');
    assert.equal(reexportRequest.searchParams.get('hydrationMaxTotalMs'), '900000');
    assert.equal(reexportRequest.searchParams.get('hydrationStallTimeoutMs'), '60000');
    assert.equal(reexportRequest.searchParams.get('exportBrowserTimeoutMs'), '960000');

    const notebookRequest = requests.find((item) => item.pathname === '/agent/export-notebook');
    assert.equal(notebookRequest.searchParams.get('startIndex'), '2');
  });
});

test('CLI export-dir get e cleanup stale-processes usam endpoints da bridge', async () => {
  await withServer((req, res, url) => {
    if (url.pathname === '/agent/export-dir') {
      sendJson(res, 200, { outputDir: '/vault/Gemini', defaultExportDir: '/Downloads' });
      return;
    }
    if (url.pathname === '/agent/cleanup-stale-processes') {
      sendJson(res, 200, { ok: false, dryRun: true, wouldTerminate: [], message: 'Dry-run' });
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }, async (bridgeUrl, requests) => {
    const exportDirStdout = captureStream();
    const cleanupStdout = captureStream();

    assert.equal(
      (await main(['export-dir', 'get', '--bridge-url', bridgeUrl, '--plain'], { stdout: exportDirStdout })).exitCode,
      0,
    );
    assert.match(exportDirStdout.text(), /Diretorio de export/);
    assert.match(exportDirStdout.text(), /RESULT_JSON /);

    assert.equal(
      (
        await main(['cleanup', 'stale-processes', '--bridge-url', bridgeUrl, '--plain'], {
          stdout: cleanupStdout,
        })
      ).exitCode,
      0,
    );
    assert.match(cleanupStdout.text(), /Dry-run/);
    assert.equal(requests.some((item) => item.pathname === '/agent/cleanup-stale-processes'), true);
  });
});

test('CLI doctor consegue iniciar bridge-only local quando a bridge esta fora', async () => {
  const port = await getFreePort();
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const stdout = captureStream();
  const stderr = captureStream();
  let bridgePid = null;

  try {
    const run = await main(
      [
        'doctor',
        '--bridge-url',
        bridgeUrl,
        '--json',
        '--no-wake',
        '--no-self-heal',
        '--no-reload',
        '--ready-wait-ms',
        '0',
        '--bridge-start-wait-ms',
        '5000',
      ],
      { stdout, stderr },
    );

    assert.equal(run.exitCode, 4);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.ready, false);
    assert.equal(stderr.text(), '');

    const health = await fetch(`${bridgeUrl}/healthz`).then((response) => response.json());
    bridgePid = health.pid;
    assert.equal(health.bridgeOnly, true);
    assert.equal(health.process.bridgeOnly, true);
    assert.equal(health.idleLifecycle.enabled, true);
  } finally {
    if (bridgePid) {
      try {
        process.kill(bridgePid, 'SIGTERM');
      } catch {
        // Process may already have exited.
      }
      await sleep(150);
    }
  }
});

test('build publica binario CLI no bundle da extensao Gemini CLI', () => {
  assert.equal(
    existsSync(resolve(ROOT, 'dist', 'gemini-cli-extension', 'bin', 'gemini-md-export.mjs')),
    true,
  );
  assert.equal(existsSync(resolve(ROOT, 'src', 'bridge-server.js')), true);
});
