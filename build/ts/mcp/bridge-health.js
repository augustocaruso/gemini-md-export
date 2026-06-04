const originForClient = (client) => {
    try {
        return new URL(client.page?.url || '').origin;
    }
    catch {
        return null;
    }
};
const clientIsActivity = (client) => client.kind === 'activity' ||
    client.page?.kind === 'activity' ||
    originForClient(client) === 'https://myactivity.google.com';
const clientKind = (client) => client.kind || client.page?.kind || (clientIsActivity(client) ? 'activity' : 'gemini');
const timestampAge = (timestamp, now) => {
    if (timestamp === null || timestamp === undefined || timestamp === '')
        return null;
    const numeric = Number(timestamp);
    return Number.isFinite(numeric) ? now - numeric : null;
};
const runtimeSignalAge = (client, now) => {
    const heartbeatAt = Number(client.lastHeartbeatAt || 0);
    const snapshotAt = Number(client.lastSnapshotAt || 0);
    const signalAt = Math.max(Number.isFinite(heartbeatAt) ? heartbeatAt : 0, Number.isFinite(snapshotAt) ? snapshotAt : 0);
    return signalAt > 0 ? now - signalAt : null;
};
export const clientPageBlockerCode = (client) => {
    const code = String(client.page?.blocker?.code || '').trim();
    if (code)
        return code;
    return client.page?.blocker?.terminal === true ? 'google_page_blocked' : null;
};
export const clientHasPageBlocker = (client) => client.page?.blocker?.terminal === true;
export const evaluateBridgeHealth = (client, options) => {
    const now = Number(options.now ?? Date.now());
    const heartbeatAgeMs = timestampAge(client.lastHeartbeatAt, now);
    const runtimeSignalAgeMs = runtimeSignalAge(client, now);
    const eventStreamConnected = options.eventStreamConnected === true;
    const longPollConnected = options.longPollConnected === true;
    const pagePolling = options.pagePolling ?? null;
    const queuedCommands = Number(options.queuedCommands || 0);
    let status = 'healthy';
    let blockingIssue = null;
    let action = 'ok';
    if (runtimeSignalAgeMs === null || runtimeSignalAgeMs > options.staleAfterMs) {
        status = 'stale';
        blockingIssue = 'stale_client';
        action =
            'Recarregue a aba do Gemini ou chame gemini_ready { action: "status", diagnostic: true } para reconectar.';
    }
    else if (clientHasPageBlocker(client)) {
        status = 'blocked';
        blockingIssue = clientPageBlockerCode(client);
        action =
            client.page?.blocker?.nextAction || 'Resolva o bloqueio no navegador e tente novamente.';
    }
    else if (!options.versionMatches) {
        status = 'version_mismatch';
        blockingIssue = 'extension_version_mismatch';
        action =
            'Rode gemini_ready { action: "status", diagnostic: true } para tentar recarregar a extensão automaticamente.';
    }
    else if (!eventStreamConnected && !longPollConnected && pagePolling !== true) {
        status = 'command_channel_stuck';
        blockingIssue = 'command_channel_stuck';
        action =
            'Use gemini_tabs { action: "reload", intent: "tab_management" } se a aba estiver aberta mas não aceitar comandos.';
    }
    else if (options.recentCommandFailure === true) {
        status = 'command_channel_stuck';
        blockingIssue = 'command_timeout_recent';
        action =
            'Esta aba acabou de ignorar um comando; a CLI deve preferir outra aba Gemini saudável.';
    }
    else if (runtimeSignalAgeMs > options.degradedHeartbeatMs) {
        status = 'degraded';
        blockingIssue = 'runtime_signal_delayed';
        action =
            'Aguarde alguns segundos; se persistir, rode gemini_ready { action: "status", diagnostic: true }.';
    }
    return {
        status,
        blockingIssue,
        action,
        clientKind: clientKind(client),
        heartbeatAgeMs,
        runtimeSignalAgeMs,
        staleAfterMs: options.staleAfterMs,
        eventStreamConnected,
        longPollConnected,
        pagePolling,
        queuedCommands,
    };
};
