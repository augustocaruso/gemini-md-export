export type PrimaryBridgeMismatch = Readonly<{
  kind?: string | null;
} | null>;

export type ProcessCleanupCandidate = Readonly<{
  pid?: number | null;
  ppid?: number | null;
  isCurrent?: boolean;
  isParent?: boolean;
  isPortOwner?: boolean;
  looksLikeExporter?: boolean;
  looksLikeMcpServer?: boolean;
  parentAlive?: boolean;
  listeningPorts?: readonly number[];
}>;

export type ProcessCleanupDecision = Readonly<{
  eligible: boolean;
  reason: string;
  requiresConfirm?: true;
}>;

export const buildProcessCleanupDecision = (
  candidate: ProcessCleanupCandidate = {},
  mismatch: PrimaryBridgeMismatch = null,
  portOwner: Readonly<{ pid?: number | null } | null> = null,
): ProcessCleanupDecision => {
  if (candidate.isCurrent) {
    return { eligible: false, reason: 'current_process_protected' };
  }
  if (candidate.isParent) {
    return { eligible: false, reason: 'parent_process_protected' };
  }

  if (candidate.isPortOwner) {
    if (!mismatch) {
      return { eligible: false, reason: 'primary_healthy' };
    }
    if (mismatch.kind === 'name') {
      return { eligible: false, reason: 'port_owner_is_other_service' };
    }
    if (!portOwner?.pid) {
      return { eligible: false, reason: 'port_owner_unknown' };
    }
    if (!candidate.looksLikeExporter) {
      return { eligible: false, reason: 'process_not_recognized_as_exporter' };
    }
    if (!candidate.looksLikeMcpServer) {
      return { eligible: false, reason: 'port_owner_not_mcp_server' };
    }
    return {
      eligible: true,
      reason: `stale_primary_${mismatch.kind || 'unknown'}`,
      requiresConfirm: true,
    };
  }

  if (!candidate.looksLikeExporter) {
    return { eligible: false, reason: 'process_not_recognized_as_exporter' };
  }
  if (!candidate.looksLikeMcpServer) {
    return { eligible: false, reason: 'related_exporter_process_not_mcp_server' };
  }
  if ((candidate.listeningPorts || []).length > 0) {
    return { eligible: false, reason: 'related_mcp_server_has_listening_ports' };
  }
  if (candidate.ppid && candidate.ppid > 1 && candidate.parentAlive) {
    return { eligible: false, reason: 'related_mcp_server_parent_active' };
  }

  return {
    eligible: true,
    reason: 'orphan_related_mcp_server',
    requiresConfirm: true,
  };
};

export const cleanupPlanReason = (
  targets: readonly unknown[],
  processes: readonly { isPortOwner?: boolean; cleanup?: { reason?: string | null } }[],
): string => {
  if (targets.length > 0) {
    return targets.some((target) => {
      const reason = (target as { reason?: unknown } | null)?.reason;
      return reason === 'orphan_related_mcp_server';
    })
      ? 'safe_orphan_mcp_server_found'
      : 'safe_stale_primary_found';
  }
  return processes.find((item) => item.isPortOwner)?.cleanup?.reason || 'no_safe_target';
};

export type ProcessLifecycleSummaryInput = Readonly<{
  processes: readonly {
    pid?: number | null;
    isCurrent?: boolean;
    isPortOwner?: boolean;
    state?: unknown;
    cleanup?: { eligible?: boolean; reason?: string | null } | null;
  }[];
  cleanupPlan: Readonly<{
    eligible?: boolean;
    targets?: readonly unknown[];
    reason?: string | null;
  }>;
}>;

const cleanupReason = (process: ProcessLifecycleSummaryInput['processes'][number]): string =>
  String(process.cleanup?.reason || '');

export const buildProcessLifecycleSummary = ({
  processes,
  cleanupPlan,
}: ProcessLifecycleSummaryInput) => {
  const activeSessionMcp = processes.filter(
    (process) =>
      cleanupReason(process) === 'related_mcp_server_parent_active' ||
      cleanupReason(process) === 'current_process_protected' ||
      cleanupReason(process) === 'parent_process_protected',
  );
  const nativeHost = processes.filter(
    (process) => cleanupReason(process) === 'related_exporter_process_not_mcp_server',
  );
  const safeOrphan = processes.filter(
    (process) =>
      process.cleanup?.eligible === true && cleanupReason(process) === 'orphan_related_mcp_server',
  );
  const stalePrimary = processes.filter(
    (process) =>
      process.cleanup?.eligible === true && cleanupReason(process).startsWith('stale_primary_'),
  );
  const portOwner = processes.find((process) => process.isPortOwner) || null;
  const action = cleanupPlan.eligible
    ? 'dry_run_available_then_confirm'
    : portOwner
      ? 'no_cleanup_needed_or_no_safe_target'
      : 'no_port_owner_seen';

  return {
    action,
    counts: {
      total: processes.length,
      activeSessionMcp: activeSessionMcp.length,
      nativeHost: nativeHost.length,
      safeOrphan: safeOrphan.length,
      stalePrimary: stalePrimary.length,
      cleanupTargets: cleanupPlan.targets?.length || 0,
    },
    portOwner: portOwner
      ? {
          pid: portOwner.pid || null,
          state: String(portOwner.state || ''),
          cleanupReason: cleanupReason(portOwner) || null,
        }
      : null,
    message: cleanupPlan.eligible
      ? 'Ha alvo seguro para limpeza. Rode dry-run primeiro; confirme somente se os PIDs baterem.'
      : 'Nenhum processo seguro para encerrar automaticamente.',
  };
};
