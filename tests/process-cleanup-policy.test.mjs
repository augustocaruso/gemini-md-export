import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProcessCleanupDecision,
  buildProcessLifecycleSummary,
  cleanupPlanReason,
} from '../build/ts/mcp/process-cleanup-policy.js';

test('process cleanup policy allows confirmed cleanup of incompatible primary MCP server', () => {
  assert.deepEqual(
    buildProcessCleanupDecision(
      {
        pid: 101,
        ppid: 10,
        isPortOwner: true,
        looksLikeExporter: true,
        looksLikeMcpServer: true,
        parentAlive: true,
      },
      { kind: 'version' },
      { pid: 101 },
    ),
    {
      eligible: true,
      reason: 'stale_primary_version',
      requiresConfirm: true,
    },
  );
});

test('process cleanup policy refuses active related MCP servers from live sessions', () => {
  assert.deepEqual(
    buildProcessCleanupDecision({
      pid: 202,
      ppid: 10,
      isPortOwner: false,
      looksLikeExporter: true,
      looksLikeMcpServer: true,
      parentAlive: true,
      listeningPorts: [],
    }),
    {
      eligible: false,
      reason: 'related_mcp_server_parent_active',
    },
  );
});

test('process cleanup policy allows orphan related MCP servers with no listening ports', () => {
  assert.deepEqual(
    buildProcessCleanupDecision({
      pid: 303,
      ppid: 1,
      isPortOwner: false,
      looksLikeExporter: true,
      looksLikeMcpServer: true,
      parentAlive: false,
      listeningPorts: [],
    }),
    {
      eligible: true,
      reason: 'orphan_related_mcp_server',
      requiresConfirm: true,
    },
  );
});

test('process cleanup policy does not kill CLI/native-host style exporter processes', () => {
  assert.deepEqual(
    buildProcessCleanupDecision({
      pid: 404,
      ppid: 1,
      isPortOwner: false,
      looksLikeExporter: true,
      looksLikeMcpServer: false,
      parentAlive: false,
      listeningPorts: [],
    }),
    {
      eligible: false,
      reason: 'related_exporter_process_not_mcp_server',
    },
  );
});

test('process cleanup plan reason distinguishes orphan cleanup from stale primary cleanup', () => {
  assert.equal(cleanupPlanReason([{ reason: 'orphan_related_mcp_server' }], []), 'safe_orphan_mcp_server_found');
  assert.equal(cleanupPlanReason([{ reason: 'stale_primary_version' }], []), 'safe_stale_primary_found');
  assert.equal(
    cleanupPlanReason([], [{ isPortOwner: true, cleanup: { reason: 'primary_healthy' } }]),
    'primary_healthy',
  );
});

test('process lifecycle summary groups operational process classes', () => {
  const summary = buildProcessLifecycleSummary({
    cleanupPlan: {
      eligible: true,
      targets: [{ pid: 44, reason: 'orphan_related_mcp_server' }],
      reason: 'safe_orphan_mcp_server_found',
    },
    processes: [
      {
        pid: 10,
        isCurrent: true,
        cleanup: { eligible: false, reason: 'current_process_protected' },
      },
      {
        pid: 20,
        cleanup: { eligible: false, reason: 'related_mcp_server_parent_active' },
      },
      {
        pid: 30,
        cleanup: { eligible: false, reason: 'related_exporter_process_not_mcp_server' },
      },
      {
        pid: 40,
        isPortOwner: true,
        state: 'primary_healthy',
        cleanup: { eligible: false, reason: 'primary_healthy' },
      },
      {
        pid: 44,
        cleanup: { eligible: true, reason: 'orphan_related_mcp_server' },
      },
    ],
  });

  assert.equal(summary.action, 'dry_run_available_then_confirm');
  assert.equal(summary.counts.activeSessionMcp, 2);
  assert.equal(summary.counts.nativeHost, 1);
  assert.equal(summary.counts.safeOrphan, 1);
  assert.equal(summary.counts.cleanupTargets, 1);
  assert.equal(summary.portOwner.pid, 40);
});
