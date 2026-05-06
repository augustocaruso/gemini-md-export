import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { main } from '../bin/gemini-md-export.mjs';
import {
  TELEMETRY_ENVELOPE_SCHEMA,
  enableTelemetry,
  previewEnvelope,
  recordTelemetryRun,
  redactSnippet,
  sendTelemetry,
  telemetryStatus,
} from '../src/telemetry.mjs';

const withTelemetryHome = async (fn) => {
  const previousHome = process.env.GEMINI_MD_EXPORT_HOME;
  const previousAllow = process.env.GEMINI_MD_EXPORT_TELEMETRY_ALLOW_NODE_TEST;
  const previousDisabled = process.env.GEMINI_MD_EXPORT_TELEMETRY_DISABLED;
  const previousDefaults = process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS;
  const previousDefaultsDisabled = process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED;
  process.env.GEMINI_MD_EXPORT_HOME = mkdtempSync(resolve(tmpdir(), 'gme-telemetry-'));
  process.env.GEMINI_MD_EXPORT_TELEMETRY_ALLOW_NODE_TEST = '1';
  process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED = '1';
  delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DISABLED;
  delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS;
  try {
    await fn(process.env.GEMINI_MD_EXPORT_HOME);
  } finally {
    if (previousHome === undefined) delete process.env.GEMINI_MD_EXPORT_HOME;
    else process.env.GEMINI_MD_EXPORT_HOME = previousHome;
    if (previousAllow === undefined) delete process.env.GEMINI_MD_EXPORT_TELEMETRY_ALLOW_NODE_TEST;
    else process.env.GEMINI_MD_EXPORT_TELEMETRY_ALLOW_NODE_TEST = previousAllow;
    if (previousDisabled === undefined) delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DISABLED;
    else process.env.GEMINI_MD_EXPORT_TELEMETRY_DISABLED = previousDisabled;
    if (previousDefaults === undefined) delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS;
    else process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS = previousDefaults;
    if (previousDefaultsDisabled === undefined) delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED;
    else process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED = previousDefaultsDisabled;
  }
};

test('telemetria fica desligada por padrao', async () => {
  await withTelemetryHome(async () => {
    const status = telemetryStatus();

    assert.equal(status.enabled, false);
    assert.equal(status.ready, false);
    assert.equal(status.outbox_count, 0);
  });
});

test('telemetria usa defaults de distribuicao sem opt-in manual', async () => {
  await withTelemetryHome(async (home) => {
    const defaultsPath = resolve(home, 'telemetry.defaults.json');
    writeFileSync(
      defaultsPath,
      JSON.stringify({
        schema: 'gemini-md-export.telemetry-defaults.v1',
        enabled: true,
        endpoint_url: 'https://example.test/v1/telemetry/workflow-runs',
        auth_token: 'default-token',
        payload_level: 'diagnostic_redacted',
      }),
      'utf-8',
    );
    delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED;
    process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS = defaultsPath;

    const status = telemetryStatus();

    assert.equal(status.enabled, true);
    assert.equal(status.ready, true);
    assert.equal(status.source, 'distribution_default');
    assert.ok(status.auto_enabled_at);
    assert.doesNotMatch(JSON.stringify(status), /default-token/);
  });
});

test('telemetry disable bloqueia defaults de distribuicao', async () => {
  await withTelemetryHome(async (home) => {
    const defaultsPath = resolve(home, 'telemetry.defaults.json');
    writeFileSync(
      defaultsPath,
      JSON.stringify({
        enabled: true,
        endpoint_url: 'https://example.test/v1/telemetry/workflow-runs',
        auth_token: 'default-token',
      }),
      'utf-8',
    );
    delete process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS_DISABLED;
    process.env.GEMINI_MD_EXPORT_TELEMETRY_DEFAULTS = defaultsPath;

    assert.equal(telemetryStatus().enabled, true);
    const stdout = stream();
    const disabled = await main(['telemetry', 'disable', '--json'], { stdout });
    const status = telemetryStatus();

    assert.equal(disabled.exitCode, 0);
    assert.equal(status.enabled, false);
    assert.ok(status.opt_out_at);
  });
});

test('telemetry enable/status/disable pela CLI nao imprime token', async () => {
  await withTelemetryHome(async () => {
    let stdout = stream();
    const enable = await main(
      [
        'telemetry',
        'enable',
        '--endpoint',
        'http://127.0.0.1:12345/v1/telemetry/workflow-runs',
        '--token',
        'secret-token',
        '--payload-level',
        'full_logs',
        '--json',
      ],
      { stdout },
    );
    assert.equal(enable.exitCode, 0);
    assert.equal(JSON.parse(stdout.value()).enabled, true);
    assert.doesNotMatch(stdout.value(), /secret-token/);

    stdout = stream();
    const status = await main(['telemetry', 'status', '--json'], { stdout });
    assert.equal(status.exitCode, 0);
    assert.equal(JSON.parse(stdout.value()).payload_level, 'full_logs');
    assert.doesNotMatch(stdout.value(), /secret-token/);

    stdout = stream();
    const disabled = await main(['telemetry', 'disable', '--json'], { stdout });
    assert.equal(disabled.exitCode, 0);
    assert.equal(JSON.parse(stdout.value()).enabled, false);
  });
});

test('telemetry status avisa quando endpoint aponta para receiver do Med Notes', async () => {
  await withTelemetryHome(async () => {
    enableTelemetry({
      endpointUrl: 'https://medical-notes-workbench-telemetry.example.workers.dev/v1/telemetry/workflow-runs',
      authToken: 'secret-token',
    });

    const status = telemetryStatus();

    assert.equal(status.endpoint_project, 'medical-notes-workbench');
    assert.equal(status.endpoint_warning, 'endpoint_points_to_med_notes_receiver');
  });
});

test('preview cria envelope redigido sem rede', async () => {
  await withTelemetryHome(async () => {
    await recordTelemetryRun({
      workflow: 'gemini-md-export:doctor',
      phase: 'doctor',
      exitCode: 4,
      command: 'gemini-md-export doctor --token cli-secret',
      error: new Error('bridge failed for user@example.com?api_key=abc123'),
    });

    const envelope = previewEnvelope({ since: '1d' });
    const serialized = JSON.stringify(envelope);

    assert.equal(envelope.schema, TELEMETRY_ENVELOPE_SCHEMA);
    assert.equal(envelope.records.length, 1);
    assert.doesNotMatch(serialized, /user@example.com/);
    assert.doesNotMatch(serialized, /cli-secret/);
  });
});

test('send envia runs para endpoint HTTP local e marca como enviados', async () => {
  await withTelemetryHome(async (home) => {
    const server = await telemetryServer();
    try {
      enableTelemetry({
        endpointUrl: `http://127.0.0.1:${server.port}/v1/telemetry/workflow-runs`,
        authToken: 'local-token',
      });
      await recordTelemetryRun({
        workflow: 'gemini-md-export:export:missing',
        phase: 'follow-job',
        exitCode: 5,
        result: {
          ok: false,
          status: 'failed',
          jobId: 'job-1',
          failedCount: 1,
          failures: [{ chatId: 'abc123abc123', error: 'timeout falando com bridge' }],
          nextAction: 'Abrir traceFile e corrigir retry.',
        },
      });

      const result = await sendTelemetry({ since: '1d' });
      const sent = JSON.parse(readFileSync(resolve(home, 'telemetry', 'telemetry-sent.json'), 'utf-8'));

      assert.equal(result.ok, true);
      assert.equal(server.requests.length >= 1, true);
      assert.equal(server.requests.at(-1).headers.authorization, 'Bearer local-token');
      assert.equal(server.requests.at(-1).body.schema, TELEMETRY_ENVELOPE_SCHEMA);
      assert.equal(sent.sent_run_ids.length, 1);
    } finally {
      await server.close();
    }
  });
});

test('redactSnippet remove emails, tokens e queries sensiveis', () => {
  const redacted = redactSnippet(
    'email user@example.com token re_FAKE_SECRET_FOR_REDACTION_TEST_123456 url https://x.test/a?api_key=abc&ok=1',
  );

  assert.doesNotMatch(redacted, /user@example.com/);
  assert.doesNotMatch(redacted, /FAKE_SECRET/);
  assert.doesNotMatch(redacted, /api_key=abc/);
});

const stream = () => {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
    },
    value() {
      return text;
    },
  };
};

const telemetryServer = () =>
  new Promise((resolveServer) => {
    const requests = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({
          path: req.url,
          headers: req.headers,
          body: JSON.parse(raw || '{}'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({
        port: server.address().port,
        requests,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
